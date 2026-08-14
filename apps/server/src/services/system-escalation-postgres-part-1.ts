import {
  agentAdapterConfigRevisions,
  agents,
  taskExecutionAuthorities,
  tasks,
  type systemEscalationIdentities,
  type taskCreatorEdgeReceivability,
} from "@paperclipai/db";
import {
  decodeTaskCreatorEdgeTerminalReason,
  type SystemCreatorSourceKind,
  type TaskCreatorEdgeTerminalReason,
} from "@paperclipai/shared";
import { and, asc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { evaluateAgentInvokability } from "./agent-invokability.js";
import { TaskExecutionWorkspaceReservationRejected } from "./execution-workspaces.js";
import { resolveTaskExecutionRunIdentityById } from "./task-execution-run-service.js";
import { type TaskSessionAdmissionService } from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export type TaskRow = typeof tasks.$inferSelect;

export type EdgeRow = typeof taskCreatorEdgeReceivability.$inferSelect;

export type SystemEscalationOwner =
  { kind: "agent"; agentId: string } | { kind: "user"; userId: string } | { kind: "board" };

export interface EnsureSystemEscalationInput {
  companyId: string;
  affectedTaskId: string;
  affectedOwnershipEpoch: number;
  terminalCreatorEdgeId: string;
  systemSource: SystemCreatorSourceKind;
  triggeringRunId: string | null;
  causalSourceId: string;
}

export interface TerminalizeCreatorEdgeInput {
  companyId: string;
  taskId: string;
  ownershipEpoch: number;
  creatorEdgeId: string;
  reason: TaskCreatorEdgeTerminalReason;
  sourceKind: string;
  sourceId: string;
  systemSource: SystemCreatorSourceKind;
  triggeringRunId: string | null;
  endpointTombstone?: Record<string, unknown> | null;
  audit?: Record<string, unknown> | null;
}

export interface SystemEscalationTransactionResult {
  identity: typeof systemEscalationIdentities.$inferSelect;
  task: TaskRow;
  owner: SystemEscalationOwner;
  dispatchRefId: string | null;
  created: boolean;
}

export interface PostgresSystemEscalationOptions {
  clock?: () => Date;
  dispatchRef(refId: string): Promise<void>;
}

export const NONTERMINAL_STATUSES = new Set(["open", "blocked"]);

export const MAX_ESCALATION_TITLE_CHARS = 180;

export const MAX_ESCALATION_REQUEST_CHARS = 720;

export { deterministicUuid } from "./deterministic-uuid.js";

export function stableSessionId(key: string): string {
  return `ses_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

export async function withEscalationWorkspaceReservationErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TaskExecutionWorkspaceReservationRejected) {
      throw new PostgresSystemEscalationConflict(error.message, error.reason);
    }
    throw error;
  }
}

export function bounded(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return value.slice(0, maximum);
  return `${value.slice(0, maximum - 1)}…`;
}

export function stableAffectedLabel(task: TaskRow): string {
  const identifier = task.identifier;
  const title = task.title?.trim();
  return title ? `${identifier} (${bounded(title, 160)})` : identifier;
}

export function escalationTitle(task: TaskRow): string {
  return bounded(`Escalation for ${task.identifier}`, MAX_ESCALATION_TITLE_CHARS);
}

export function escalationRequest(
  task: TaskRow,
  source: SystemCreatorSourceKind,
  reason: TaskCreatorEdgeTerminalReason,
): string {
  return bounded(
    `System ${source} safeguard for ${stableAffectedLabel(task)}: the immutable creator endpoint is permanently unreceivable (${reason}). Review the affected task and decide the next board action.`,
    MAX_ESCALATION_REQUEST_CHARS,
  );
}

export function terminalReason(value: string | null): TaskCreatorEdgeTerminalReason {
  try {
    return decodeTaskCreatorEdgeTerminalReason(value);
  } catch {
    throw new PostgresSystemEscalationConflict(
      "Creator edge is not terminal for a canonical structural-loss or exhaustion reason",
      "creator_edge_reason_not_escalating",
    );
  }
}

export function sourceAuthor(source: SystemCreatorSourceKind) {
  return { kind: "system" as const, source };
}

export class PostgresSystemEscalationConflict extends Error {
  readonly code = "postgres_system_escalation_conflict";

  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "PostgresSystemEscalationConflict";
  }
}

export async function loadCompanyAgents(tx: TaskSessionDbTransaction, companyId: string) {
  return tx.select().from(agents).where(eq(agents.companyId, companyId)).orderBy(asc(agents.id)).for("share");
}

export function liveAgent(
  agentId: string | null | undefined,
  companyAgents: Awaited<ReturnType<typeof loadCompanyAgents>>,
) {
  if (!agentId) return null;
  const candidate = companyAgents.find((agent) => agent.id === agentId) ?? null;
  return evaluateAgentInvokability(candidate, companyAgents).invokable ? candidate : null;
}

/**
 * Resolve only the goal's task-tree ladder. The full company agent set is
 * loaded solely to evaluate reporting-chain health; it is never an owner
 * candidate catalog.
 */
export async function resolveSystemEscalationOwnerInTransaction(
  tx: TaskSessionDbTransaction,
  affected: TaskRow,
): Promise<SystemEscalationOwner> {
  const [companyAgents, companyTasks] = await Promise.all([
    loadCompanyAgents(tx, affected.companyId),
    tx
      .select({
        id: tasks.id,
        parentId: tasks.parentId,
        ownerKind: tasks.ownerKind,
        ownerAgentId: tasks.ownerAgentId,
        creatorKind: tasks.creatorKind,
        creatorUserId: tasks.creatorUserId,
      })
      .from(tasks)
      .where(eq(tasks.companyId, affected.companyId))
      .for("share"),
  ]);

  if (affected.creatorKind === "agent-execution" && affected.creatorAuthorityId) {
    const creatorAuthority = await tx
      .select({ agentId: taskExecutionAuthorities.agentId })
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(taskExecutionAuthorities.companyId, affected.companyId),
          eq(taskExecutionAuthorities.id, affected.creatorAuthorityId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const creatorAgent = liveAgent(creatorAuthority?.agentId, companyAgents);
    if (creatorAgent) {
      return { kind: "agent", agentId: creatorAgent.id };
    }
  }

  const taskById = new Map(companyTasks.map((task) => [task.id, task]));
  const visited = new Set<string>([affected.id]);
  let cursorId = affected.parentId;
  let root = taskById.get(affected.id) ?? {
    id: affected.id,
    parentId: affected.parentId,
    ownerKind: affected.ownerKind,
    ownerAgentId: affected.ownerAgentId,
    creatorKind: affected.creatorKind,
    creatorUserId: affected.creatorUserId,
  };
  while (cursorId) {
    if (visited.has(cursorId)) {
      return { kind: "board" };
    }
    visited.add(cursorId);
    const ancestor = taskById.get(cursorId);
    if (!ancestor) {
      return { kind: "board" };
    }
    root = ancestor;
    if (ancestor.ownerKind === "agent") {
      const ancestorOwner = liveAgent(ancestor.ownerAgentId, companyAgents);
      if (ancestorOwner) {
        return { kind: "agent", agentId: ancestorOwner.id };
      }
    }
    cursorId = ancestor.parentId;
  }

  if (root.creatorKind === "user/board" && root.creatorUserId?.trim()) {
    return { kind: "user", userId: root.creatorUserId };
  }
  return { kind: "board" };
}

export async function requireSelectedAgentRevision(
  tx: TaskSessionDbTransaction,
  companyId: string,
  agentId: string,
) {
  const companyAgents = await loadCompanyAgents(tx, companyId);
  const owner = liveAgent(agentId, companyAgents);
  if (!owner) {
    throw new PostgresSystemEscalationConflict(
      "The ladder-selected escalation owner is no longer invokable",
      "selected_owner_not_invokable",
    );
  }
  if (!owner.currentAdapterConfigRevisionId) {
    throw new PostgresSystemEscalationConflict(
      "The ladder-selected escalation owner has no current adapter revision",
      "selected_owner_revision_missing",
    );
  }
  const revision = await tx
    .select()
    .from(agentAdapterConfigRevisions)
    .where(
      and(
        eq(agentAdapterConfigRevisions.companyId, companyId),
        eq(agentAdapterConfigRevisions.agentId, owner.id),
        eq(agentAdapterConfigRevisions.id, owner.currentAdapterConfigRevisionId),
      ),
    )
    .for("share")
    .then((rows) => rows[0] ?? null);
  if (!revision) {
    throw new PostgresSystemEscalationConflict(
      "The ladder-selected escalation owner adapter revision is missing",
      "selected_owner_revision_missing",
    );
  }
  return { owner, revision };
}

export async function validateTriggeringRun(
  tx: TaskSessionDbTransaction,
  companyId: string,
  triggeringRunId: string | null,
): Promise<void> {
  if (!triggeringRunId) return;
  const run = await resolveTaskExecutionRunIdentityById(tx, triggeringRunId);
  if (!run || run.companyId !== companyId) {
    throw new PostgresSystemEscalationConflict(
      "Escalation triggeringRunId must identify the persisted causal run",
      "triggering_run_missing",
    );
  }
}

export async function appendAffectedCrossLink(
  sessions: TaskSessionAdmissionService,
  tx: TaskSessionDbTransaction,
  input: EnsureSystemEscalationInput,
  affected: TaskRow,
  affectedSessionId: string,
  identity: typeof systemEscalationIdentities.$inferSelect,
  escalationTask: TaskRow,
): Promise<void> {
  const affectedLabel = affected.identifier;
  const escalationLabel = escalationTask.identifier;
  await sessions.appendNonDispatchControlNotice(
    {
      companyId: input.companyId,
      taskId: affected.id,
      sessionId: affectedSessionId,
      sourceKind: "system_escalation_crosslink",
      immutableSourceKey: identity.id,
      sourceRecordId: identity.id,
      exactText: `System escalation ${escalationLabel} was opened for ${affectedLabel} because the immutable creator endpoint is permanently unreceivable (${identity.immutableSource.reason as string}).`,
      comment: {
        author: sourceAuthor(identity.systemSource),
        producingRun: null,
      },
      allowTerminal: false,
    },
    tx,
  );
}
