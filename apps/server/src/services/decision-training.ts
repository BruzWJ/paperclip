import {
  and,
  asc,
  desc,
  eq,
  ilike,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  decisionTrainingExamples,
  executionWorkspaces,
  issueApprovals,
  issueComments,
  issueExecutionDecisions,
  issueExecutionWorkspaceBindings,
  issues,
  projectWorkspaces,
} from "@paperclipai/db";
import type {
  DecisionTrainingNotesHistoryEntry,
  DecisionTrainingSnapshotV1,
  DecisionTrainingSourceKind,
} from "@paperclipai/shared";
import { DECISION_TRAINING_RETENTION_POLICY } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import {
  listIssueExecutionRunsForIssue,
  type IssueExecutionRunListCursor,
} from "./issue-execution-run-service.js";

type CaptureInput = {
  companyId: string;
  sourceKind: DecisionTrainingSourceKind;
  sourceId: string;
  issueId: string;
};

type SourceDecision = {
  cutoffAt: Date;
  outcome: string | null;
  payload: Record<string, unknown>;
  actor: Record<string, unknown> | null;
};

type ListInput = {
  projectId?: string;
  kind?: DecisionTrainingSourceKind;
  author?: string;
  q?: string;
};

type ScrubDeletedCommentsInput = {
  companyId: string;
  issueId: string;
  commentIds: string[];
  deletedAt: Date;
};

function jsonCopy(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function loadSourceDecision(db: Db, input: CaptureInput, capturedAt: Date): Promise<SourceDecision> {
  if (input.sourceKind === "approval") {
    const rows = await db
      .select({ approval: approvals })
      .from(approvals)
      .innerJoin(issueApprovals, and(
        eq(issueApprovals.approvalId, approvals.id),
        eq(issueApprovals.issueId, input.issueId),
        eq(issueApprovals.companyId, input.companyId),
      ))
      .where(and(eq(approvals.id, input.sourceId), eq(approvals.companyId, input.companyId)))
      .limit(1);
    const row = rows[0]?.approval;
    if (!row) throw notFound("Decision approval not found");
    const resolved = row.decidedAt != null && row.status !== "pending";
    return {
      cutoffAt: resolved ? row.decidedAt! : capturedAt,
      outcome: resolved ? row.status : null,
      payload: jsonCopy({ type: row.type, payload: row.payload, decisionNote: resolved ? row.decisionNote : null }),
      actor: jsonCopy(resolved
        ? { userId: row.decidedByUserId }
        : { userId: row.requestedByUserId, agentId: row.requestedByAgentId }),
    };
  }

  const row = await db.query.issueExecutionDecisions.findFirst({
    where: and(
      eq(issueExecutionDecisions.id, input.sourceId),
      eq(issueExecutionDecisions.companyId, input.companyId),
      eq(issueExecutionDecisions.issueId, input.issueId),
    ),
  });
  if (!row) throw notFound("Execution decision not found");
  return {
    cutoffAt: row.createdAt,
    outcome: row.outcome,
    payload: jsonCopy({ stageId: row.stageId, stageType: row.stageType, body: row.body }),
    actor: jsonCopy({ userId: row.actorUserId, agentId: row.actorAgentId }),
  };
}

async function listRunsAtDecisionCutoff(
  db: Db,
  input: Pick<CaptureInput, "companyId" | "issueId">,
  cutoffAt: Date,
) {
  const runs = [];
  let cursor: IssueExecutionRunListCursor | null = null;
  do {
    const page = await listIssueExecutionRunsForIssue(db, {
      companyId: input.companyId,
      issueId: input.issueId,
      cursor,
      limit: 200,
    });
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return runs
    .filter((run) =>
      run.startedAt !== null &&
      run.startedAt <= cutoffAt &&
      run.updatedAt <= cutoffAt
    )
    .sort((left, right) => {
      const byStart = left.startedAt!.getTime() - right.startedAt!.getTime();
      return byStart !== 0 ? byStart : left.runId.localeCompare(right.runId);
    })
    .map((run) => ({
      id: run.runId,
      companyId: run.companyId,
      issueId: run.issueId,
      agentId: run.targetAgentId,
      kind: run.kind,
      status: run.status,
      ownershipEpoch: run.ownershipEpoch,
      adapterConfigRevisionId: run.adapterConfigRevisionId,
      executionWorkspaceBindingId: run.executionWorkspaceBindingId,
      executionMode: run.executionMode,
      parentRunId: run.parentRunId,
      retryOfRunId: run.retryOfRunId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      terminalClassification: run.terminalClassification,
      terminalReasonCode: run.terminalReasonCode,
      processExitCode: run.processExitCode,
      processSignal: run.processSignal,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }));
}

export async function captureDecisionSnapshot(
  db: Db,
  input: CaptureInput,
  capturedAt = new Date(),
): Promise<{ cutoffAt: Date; decisionOutcome: string | null; snapshot: DecisionTrainingSnapshotV1 }> {
  const issue = await db.query.issues.findFirst({
    where: and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)),
  });
  if (!issue) throw notFound("Issue not found");

  const decision = await loadSourceDecision(db, input, capturedAt);
  const comments = await db
    .select()
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.issueId),
      lte(issueComments.createdAt, decision.cutoffAt),
    ))
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const runs = await listRunsAtDecisionCutoff(
    db,
    input,
    decision.cutoffAt,
  );

  const [projectWorkspace] = issue.projectId
    ? await db
      .select()
      .from(projectWorkspaces)
      .where(and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, issue.projectId),
        lte(projectWorkspaces.createdAt, decision.cutoffAt),
        lte(projectWorkspaces.updatedAt, decision.cutoffAt),
      ))
      .orderBy(desc(projectWorkspaces.updatedAt), desc(projectWorkspaces.id))
      .limit(1)
    : [];
  const [executionWorkspace] = await db
    .select({ workspace: executionWorkspaces })
    .from(issueExecutionWorkspaceBindings)
    .innerJoin(
      executionWorkspaces,
      and(
        eq(executionWorkspaces.companyId, issueExecutionWorkspaceBindings.companyId),
        eq(executionWorkspaces.id, issueExecutionWorkspaceBindings.executionWorkspaceId),
      ),
    )
    .where(and(
      eq(issueExecutionWorkspaceBindings.companyId, input.companyId),
      eq(issueExecutionWorkspaceBindings.issueId, input.issueId),
      lte(issueExecutionWorkspaceBindings.createdAt, decision.cutoffAt),
      lte(executionWorkspaces.createdAt, decision.cutoffAt),
      lte(executionWorkspaces.lastUsedAt, decision.cutoffAt),
    ))
    .orderBy(
      desc(issueExecutionWorkspaceBindings.ownershipEpoch),
      desc(executionWorkspaces.lastUsedAt),
      desc(executionWorkspaces.id),
    )
    .limit(1);

  return {
    cutoffAt: decision.cutoffAt,
    decisionOutcome: decision.outcome,
    snapshot: {
      version: 1,
      retention: {
        policy: DECISION_TRAINING_RETENTION_POLICY,
        commentDeletion: "redact",
        issueDeletion: "cascade",
      },
      capturedAt: capturedAt.toISOString(),
      cutoff: {
        at: decision.cutoffAt.toISOString(),
        lastCommentId: comments.at(-1)?.id ?? null,
        commentCount: comments.length,
      },
      issue: jsonCopy(issue),
      comments: comments.map(jsonCopy),
      runs: runs.map(jsonCopy),
      decision: {
        kind: input.sourceKind,
        payload: decision.payload,
        actor: decision.actor,
        outcome: decision.outcome,
      },
      code: {
        repoUrl: executionWorkspace?.workspace.repoUrl ?? projectWorkspace?.repoUrl ?? null,
        ref: executionWorkspace?.workspace.branchName ?? null,
        commitSha: null,
        resolution: "none",
      },
    },
  };
}

export function decisionTrainingService(db: Db) {
  return {
    // Capture the snapshot the way create() would, but without persisting it, so
    // the drawer's create state can preview exactly what will be frozen before
    // the user commits.
    preview: async (input: CaptureInput) => captureDecisionSnapshot(db, input),
    create: async (input: CaptureInput & { notes: string; createdByUserId: string }) => {
      const captured = await captureDecisionSnapshot(db, input);
      const rows = await db
        .insert(decisionTrainingExamples)
        .values({
          companyId: input.companyId,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          issueId: input.issueId,
          cutoffAt: captured.cutoffAt,
          notes: input.notes,
          notesHistory: [],
          decisionOutcome: captured.decisionOutcome,
          retentionPolicy: DECISION_TRAINING_RETENTION_POLICY,
          snapshot: captured.snapshot,
          createdByUserId: input.createdByUserId,
        })
        .onConflictDoNothing({
          target: [
            decisionTrainingExamples.sourceKind,
            decisionTrainingExamples.sourceId,
            decisionTrainingExamples.createdByUserId,
          ],
        })
        .returning();
      if (!rows[0]) throw conflict("This decision is already trained by this user");
      return rows[0];
    },
    list: async (companyId: string, input: ListInput = {}) => {
      const filters: SQL[] = [eq(decisionTrainingExamples.companyId, companyId)];
      if (input.projectId) filters.push(eq(issues.projectId, input.projectId));
      if (input.kind) filters.push(eq(decisionTrainingExamples.sourceKind, input.kind));
      if (input.author) filters.push(eq(decisionTrainingExamples.createdByUserId, input.author));
      if (input.q) {
        const query = `%${input.q}%`;
        filters.push(or(
          ilike(decisionTrainingExamples.notes, query),
          ilike(issues.title, query),
          ilike(issues.identifier, query),
        )!);
      }
      return db
        .select({ example: decisionTrainingExamples, issueTitle: issues.title, issueIdentifier: issues.identifier })
        .from(decisionTrainingExamples)
        .innerJoin(issues, eq(decisionTrainingExamples.issueId, issues.id))
        .where(and(...filters))
        .orderBy(desc(decisionTrainingExamples.createdAt), desc(decisionTrainingExamples.id));
    },
    getById: async (id: string) => db.query.decisionTrainingExamples.findFirst({
      where: eq(decisionTrainingExamples.id, id),
    }),
    updateNotes: async (id: string, author: string, notes: string) => db.transaction(async (tx) => {
      const row = await tx.query.decisionTrainingExamples.findFirst({
        where: eq(decisionTrainingExamples.id, id),
      });
      if (!row) return null;
      if (notes === row.notes) return row;
      const history: DecisionTrainingNotesHistoryEntry[] = [
        ...(row.notesHistory ?? []),
        { author, at: new Date().toISOString(), body: row.notes },
      ];
      const [updated] = await tx
        .update(decisionTrainingExamples)
        .set({ notes, notesHistory: history, updatedAt: new Date() })
        .where(eq(decisionTrainingExamples.id, id))
        .returning();
      return updated ?? null;
    }),
    scrubDeletedComments: async (
      input: ScrubDeletedCommentsInput,
      dbOrTx: any = db,
    ) => {
      if (input.commentIds.length === 0) return { updatedCount: 0 };
      const commentIds = new Set(input.commentIds);
      const rows = await dbOrTx
        .select({ id: decisionTrainingExamples.id, snapshot: decisionTrainingExamples.snapshot })
        .from(decisionTrainingExamples)
        .where(and(
          eq(decisionTrainingExamples.companyId, input.companyId),
          eq(decisionTrainingExamples.issueId, input.issueId),
        ));
      let updatedCount = 0;
      for (const row of rows) {
        let changed = false;
        const comments = row.snapshot.comments.map((comment: Record<string, unknown>) => {
          if (typeof comment.id !== "string" || !commentIds.has(comment.id)) return comment;
          changed = true;
          return {
            id: comment.id,
            issueId: input.issueId,
            body: "",
            presentation: null,
            metadata: null,
            deletedAt: input.deletedAt.toISOString(),
            retentionRedaction: {
              reason: "source_comment_deleted",
              policy: DECISION_TRAINING_RETENTION_POLICY,
            },
          };
        });
        if (!changed) continue;
        await dbOrTx
          .update(decisionTrainingExamples)
          .set({
            retentionPolicy: DECISION_TRAINING_RETENTION_POLICY,
            snapshot: {
              ...row.snapshot,
              retention: {
                policy: DECISION_TRAINING_RETENTION_POLICY,
                commentDeletion: "redact",
                issueDeletion: "cascade",
              },
              comments,
            },
            updatedAt: input.deletedAt,
          })
          .where(eq(decisionTrainingExamples.id, row.id));
        updatedCount += 1;
      }
      return { updatedCount };
    },
    delete: async (id: string) => db
      .delete(decisionTrainingExamples)
      .where(eq(decisionTrainingExamples.id, id))
      .returning({ id: decisionTrainingExamples.id }),
  };
}
