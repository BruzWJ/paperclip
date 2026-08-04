import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documentRevisions,
  documents,
  issues,
  projectWorkspaces,
  projects,
  routines,
  summarySlots,
} from "@paperclipai/db";
import {
  type RefreshSummarySlotResponse,
  type GetSummarySlotResponse,
  type IssueStatus,
  type ListSummarySlotRevisionsResponse,
  type SummarySlot,
  type SummarySlotDocument,
  type SummarySlotIssueRef,
  type SummarySlotRevision,
  type SummarySlotScopeKind,
  type SummarySlotScopeSelector,
  summarySlotScopeSelectorSchema,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { OrdinaryIssueRuntime } from "./ordinary-issue-runtime.js";
import {
  routineService,
  type RoutineMutationActor,
} from "./routines.js";

const TERMINAL_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);
const SUMMARY_SLOT_REVISION_LIMIT = 20;
const SUMMARY_ROUTINE_ORIGIN_KIND = "summary_slot";

export interface SummarySlotSelectorInput {
  companyId: string;
  scopeKind: string;
  slotKey: string;
  scopeId?: string | null;
}

export interface SummarySlotRefreshInput extends SummarySlotSelectorInput {
  /** Required only while configuring a slot that has no stable routine. */
  ownerAgentId?: string | null;
}

export type SummaryRefreshActor = RoutineMutationActor;

type ResolvedSelector = SummarySlotScopeSelector & {
  companyId: string;
  scopeId: string | null;
};

type SummarySlotRow = typeof summarySlots.$inferSelect;
type RoutineRow = typeof routines.$inferSelect;

function mapSlot(row: SummarySlotRow): SummarySlot {
  return {
    id: row.id,
    companyId: row.companyId,
    scopeKind: row.scopeKind,
    scopeId: row.scopeId ?? null,
    slotKey: row.slotKey,
    routineId: row.routineId ?? null,
    documentId: row.documentId ?? null,
    status: row.status,
    failureReason: row.failureReason ?? null,
    generatingIssueId: row.generatingIssueId ?? null,
    lastGeneratedAt: row.lastGeneratedAt ?? null,
    lastGeneratedByAgentId: row.lastGeneratedByAgentId ?? null,
    lastModel: row.lastModel ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapDocument(row: typeof documents.$inferSelect): SummarySlotDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title ?? null,
    format: row.format as SummarySlotDocument["format"],
    body: row.latestBody,
    latestRevisionId: row.latestRevisionId ?? null,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRevision(row: typeof documentRevisions.$inferSelect): SummarySlotRevision {
  return {
    id: row.id,
    companyId: row.companyId,
    documentId: row.documentId,
    revisionNumber: row.revisionNumber,
    title: row.title ?? null,
    format: row.format as SummarySlotRevision["format"],
    body: row.body,
    changeSummary: row.changeSummary ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdByRunId: row.createdByRunId ?? null,
    sourceIssueCommentId: row.sourceIssueCommentId ?? null,
    createdAt: row.createdAt,
  };
}

function scopeLabel(scopeKind: SummarySlotScopeKind): string {
  if (scopeKind === "project") return "project";
  if (scopeKind === "project_workspace") return "workspace";
  return "workspaces overview";
}

function summaryRoutineTitle(sel: ResolvedSelector): string {
  return `Refresh ${scopeLabel(sel.scopeKind)} summary`;
}

/**
 * This is the board-owned routine request. It is deliberately a minimal,
 * immutable work request: no eager issue snapshot, hidden slot state, REST
 * writer protocol, static skill, issue key, or provider-streaming sentinel.
 */
function summaryRoutineRequest(sel: ResolvedSelector): string {
  const target = sel.scopeId
    ? `${scopeLabel(sel.scopeKind)} \`${sel.scopeId}\``
    : "the company workspaces overview";
  return [
    `Refresh the board summary for ${target}.`,
    "",
    "Use only the retrieval tools granted to this ordinary issue execution, and ground every claim in context you actually retrieve.",
    "",
    "Write a short, colloquial Markdown summary. Open with a `**Decide:**` block containing at most two bullets; each bullet must give context, a relevant issue link, and an `**I suggest:**` recommendation. If nothing needs a decision, say `**Nothing to decide right now.**` and use a `**Review:**` block with at most two triage bullets. Follow with one or two short paragraphs about the one or two things that matter most. End with a `**Recent work:**` block of at most two one-line bullets. Reference no more than four issues and do not produce an issue list or link dump.",
    "",
    "Complete this ordinary issue once. Put the finished Markdown summary in the normal terminal `issue_update` message with status `done`, producing no additional output.",
  ].join("\n");
}

export function summarySlotService(
  db: Db,
  deps: { ordinaryIssues: OrdinaryIssueRuntime },
) {
  const routinesSvc = routineService(db, {
    ordinaryIssues: deps.ordinaryIssues,
  });

  function resolveSelector(input: SummarySlotSelectorInput): ResolvedSelector {
    const parsed = summarySlotScopeSelectorSchema.safeParse({
      scopeKind: input.scopeKind,
      slotKey: input.slotKey,
      scopeId: input.scopeId ?? undefined,
    });
    if (!parsed.success) {
      throw unprocessable("Invalid summary slot selector", parsed.error.issues);
    }
    return {
      ...parsed.data,
      companyId: input.companyId,
      scopeId: parsed.data.scopeId ?? null,
    };
  }

  async function assertTargetVisible(sel: ResolvedSelector): Promise<void> {
    if (sel.scopeKind === "workspaces_overview") return;
    if (!sel.scopeId) throw unprocessable(`${sel.scopeKind} summary slots require scopeId`);
    if (sel.scopeKind === "project") {
      const target = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, sel.scopeId), eq(projects.companyId, sel.companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!target) throw notFound("Summary target not found");
      return;
    }
    const target = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.id, sel.scopeId),
          eq(projectWorkspaces.companyId, sel.companyId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!target) throw notFound("Summary target not found");
  }

  function findSlotRow(sel: ResolvedSelector) {
    return db
      .select()
      .from(summarySlots)
      .where(
        and(
          eq(summarySlots.companyId, sel.companyId),
          eq(summarySlots.scopeKind, sel.scopeKind),
          eq(summarySlots.slotKey, sel.slotKey),
          sel.scopeId === null
            ? isNull(summarySlots.scopeId)
            : eq(summarySlots.scopeId, sel.scopeId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function upsertSlot(
    sel: ResolvedSelector,
    patch: Partial<typeof summarySlots.$inferInsert> = {},
  ): Promise<SummarySlotRow> {
    const now = new Date();
    const [slot] = await db
      .insert(summarySlots)
      .values({
        companyId: sel.companyId,
        scopeKind: sel.scopeKind,
        scopeId: sel.scopeId,
        slotKey: sel.slotKey,
        status: "idle",
        createdAt: now,
        updatedAt: now,
        ...patch,
      })
      .onConflictDoUpdate({
        target: [
          summarySlots.companyId,
          summarySlots.scopeKind,
          summarySlots.scopeId,
          summarySlots.slotKey,
        ],
        set: { ...patch, updatedAt: now },
      })
      .returning();
    return slot;
  }

  async function loadDocument(companyId: string, documentId: string | null) {
    if (!documentId) return null;
    return db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function loadIssueRef(companyId: string, issueId: string | null): Promise<{
    ref: SummarySlotIssueRef | null;
    row: typeof issues.$inferSelect | null;
  }> {
    if (!issueId) return { ref: null, row: null };
    const row = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) return { ref: null, row: null };
    return {
      row,
      ref: {
        id: row.id,
        identifier: row.identifier ?? null,
        title: row.title,
        boardPresentationStatus: row.boardPresentationStatus as IssueStatus,
        ownerAgentId: row.ownerAgentId ?? null,
      },
    };
  }

  function isIssueActive(row: typeof issues.$inferSelect | null): boolean {
    return (
      !!row &&
      !TERMINAL_ISSUE_STATUSES.has(
        row.boardPresentationStatus as IssueStatus,
      )
    );
  }

  async function getSlot(input: SummarySlotSelectorInput): Promise<GetSummarySlotResponse> {
    const sel = resolveSelector(input);
    await assertTargetVisible(sel);
    const slot = await findSlotRow(sel);
    if (!slot) return { slot: null, document: null, generatingIssue: null };
    const [document, generation] = await Promise.all([
      loadDocument(sel.companyId, slot.documentId ?? null),
      loadIssueRef(sel.companyId, slot.generatingIssueId ?? null),
    ]);
    return {
      slot: mapSlot(slot),
      document: document ? mapDocument(document) : null,
      generatingIssue: generation.ref,
    };
  }

  async function listRevisions(
    input: SummarySlotSelectorInput,
  ): Promise<ListSummarySlotRevisionsResponse> {
    const sel = resolveSelector(input);
    await assertTargetVisible(sel);
    const slot = await findSlotRow(sel);
    if (!slot?.documentId) {
      return { slot: slot ? mapSlot(slot) : null, revisions: [] };
    }
    const revisions = await db
      .select()
      .from(documentRevisions)
      .where(
        and(
          eq(documentRevisions.documentId, slot.documentId),
          eq(documentRevisions.companyId, sel.companyId),
        ),
      )
      .orderBy(desc(documentRevisions.revisionNumber))
      .limit(SUMMARY_SLOT_REVISION_LIMIT);
    return { slot: mapSlot(slot), revisions: revisions.map(mapRevision) };
  }

  async function resolveGenerationTarget(sel: ResolvedSelector): Promise<{
    projectId: string | null;
    projectWorkspaceId: string | null;
  }> {
    if (sel.scopeKind === "project") {
      return { projectId: sel.scopeId, projectWorkspaceId: null };
    }
    if (sel.scopeKind === "project_workspace" && sel.scopeId) {
      const workspace = await db
        .select({ projectId: projectWorkspaces.projectId })
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, sel.scopeId),
            eq(projectWorkspaces.companyId, sel.companyId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        projectId: workspace?.projectId ?? null,
        projectWorkspaceId: sel.scopeId,
      };
    }
    return { projectId: null, projectWorkspaceId: null };
  }

  async function createOrLoadConfiguredRoutine(
    sel: ResolvedSelector,
    slot: SummarySlotRow,
    input: SummarySlotRefreshInput,
    actor: SummaryRefreshActor,
  ): Promise<RoutineRow> {
    const stableRoutineId = slot.routineId ?? slot.id;
    let routine = await routinesSvc.get(stableRoutineId);
    if (!routine) {
      if (!input.ownerAgentId) {
        throw unprocessable(
          "Configure an ordinary agent owner before refreshing this summary",
          { code: "summary_routine_not_configured", slotId: slot.id },
        );
      }
      try {
        routine = await routinesSvc.create(
          sel.companyId,
          {
            projectId: sel.scopeKind === "project" ? sel.scopeId : null,
            folderId: null,
            goalId: null,
            parentIssueId: null,
            title: summaryRoutineTitle(sel),
            description: summaryRoutineRequest(sel),
            assigneeAgentId: input.ownerAgentId,
            priority: "medium",
            status: "active",
            concurrencyPolicy: "coalesce_if_active",
            catchUpPolicy: "skip_missed",
            variables: [],
            env: null,
          },
          actor,
          {
            id: stableRoutineId,
            originKind: SUMMARY_ROUTINE_ORIGIN_KIND,
            originId: slot.id,
          },
        ) as RoutineRow;
      } catch (error) {
        // Concurrent setup converges on the same reserved routine id. Any
        // unrelated failure is rethrown after checking the canonical row.
        routine = await routinesSvc.get(stableRoutineId);
        if (!routine) throw error;
      }
    }
    if (
      routine.companyId !== sel.companyId ||
      routine.originKind !== SUMMARY_ROUTINE_ORIGIN_KIND ||
      routine.originId !== slot.id
    ) {
      throw conflict("Summary slot routine binding is invalid", {
        code: "summary_routine_binding_invalid",
        slotId: slot.id,
        routineId: routine.id,
      });
    }
    if (routine.status !== "active") {
      throw conflict("Summary routine is paused; resume its board configuration before refreshing", {
        code: "summary_routine_paused",
        slotId: slot.id,
        routineId: routine.id,
      });
    }
    if (!routine.assigneeAgentId) {
      throw unprocessable("Summary routine has no configured owner", {
        code: "summary_routine_owner_missing",
        slotId: slot.id,
        routineId: routine.id,
      });
    }
    if (slot.routineId !== routine.id) {
      const linked = await upsertSlot(sel, { routineId: routine.id });
      if (linked.routineId !== routine.id) {
        throw conflict("Summary routine could not be bound to its slot");
      }
    }
    return routine;
  }

  async function dispatchRefresh(
    input: SummarySlotRefreshInput,
    actor: SummaryRefreshActor,
  ): Promise<RefreshSummarySlotResponse> {
    const sel = resolveSelector(input);
    await assertTargetVisible(sel);

    let slot = await findSlotRow(sel);
    if (slot?.status === "generating" && slot.generatingIssueId) {
      const active = await loadIssueRef(sel.companyId, slot.generatingIssueId);
      if (isIssueActive(active.row) && active.ref) {
        return {
          slot: mapSlot(slot),
          generatingIssue: active.ref,
          alreadyGenerating: true,
        };
      }
    }

    slot ??= await upsertSlot(sel);
    const routine = await createOrLoadConfiguredRoutine(sel, slot, input, actor);
    slot = (await findSlotRow(sel)) ?? slot;
    const { projectId, projectWorkspaceId } = await resolveGenerationTarget(sel);
    const generationVersion =
      slot.generatingIssueId ??
      slot.lastGeneratedAt?.toISOString() ??
      (slot.status === "failed" ? slot.updatedAt.toISOString() : "initial");
    const run = await routinesSvc.runRoutine(
      routine.id,
      {
        source: "manual",
        projectId,
        projectWorkspaceId,
        idempotencyKey: `summary-slot-refresh:${slot.id}:${generationVersion}`,
      },
      actor,
    );
    if (!run.linkedIssueId) {
      throw unprocessable("Summary routine did not create an execution issue", {
        code: "summary_routine_dispatch_failed",
        slotId: slot.id,
        routineId: routine.id,
        failureReason: run.failureReason ?? null,
      });
    }
    const generation = await loadIssueRef(sel.companyId, run.linkedIssueId);
    if (!generation.ref) {
      throw conflict("Summary routine execution issue is missing");
    }
    const linkedSlot = await findSlotRow(sel);
    if (
      !linkedSlot ||
      linkedSlot.routineId !== routine.id ||
      linkedSlot.generatingIssueId !== generation.ref.id
    ) {
      throw conflict("Summary routine execution was not atomically linked to its slot");
    }
    return {
      slot: mapSlot(linkedSlot),
      generatingIssue: generation.ref,
      alreadyGenerating: run.status === "coalesced" || run.status === "skipped",
    };
  }

  return {
    getSlot,
    listRevisions,
    dispatchRefresh,
  };
}
