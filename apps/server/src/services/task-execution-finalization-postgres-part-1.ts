import {
  activityLog,
  documentRevisions,
  runInterfaceToolCalls,
  taskDocuments,
  taskExecutionPromptCapabilities,
  taskExecutionRunLivenessFacts,
  taskExecutionRunRefs,
  taskSessionMessages,
  taskUpdates,
  taskWorkProducts,
  tasks,
  type Db,
} from "@paperclipai/db";
import type { TaskExecutionRunTerminalClassification } from "@paperclipai/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { classifyRunLiveness } from "./run-liveness.js";
import {
  type TaskExecutionFinalizationPromptDependency,
  type TaskExecutionFinalizationPromptIdentity,
} from "./task-execution-finalization.js";
import { taskSessionMessageFromRow } from "./task-session/projector.js";

export type TaskExecutionDbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface FinalizePostgresTaskExecutionRunInput {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly status: TaskExecutionRunTerminalClassification;
  readonly terminalReasonCode: string;
  readonly finishedAt: Date;
}

export interface FinalizedPostgresTaskExecutionRun {
  readonly finalizationId: string;
  readonly status: TaskExecutionRunTerminalClassification;
  readonly retried: boolean;
  readonly autoCaptureRefId: string | null;
}

export class PostgresTaskExecutionFinalizationRejected extends Error {
  readonly code = "postgres_task_execution_finalization_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresTaskExecutionFinalizationRejected";
  }
}

export function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) {
    throw new PostgresTaskExecutionFinalizationRejected(message);
  }
  return rows[0]!;
}

export function countValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function latestDate(...values: unknown[]): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    const parsed = dateValue(value);
    if (parsed && (!latest || parsed > latest)) latest = parsed;
  }
  return latest;
}

export function terminalAssistantText(row: typeof taskSessionMessages.$inferSelect | null): string {
  if (!row) return "";
  const message = taskSessionMessageFromRow(row);
  if (message.type !== "assistant" || !message.time.completed) return "";
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export function activeRunStatus(value: string): value is "queued" | "scheduled_retry" | "running" {
  return value === "queued" || value === "scheduled_retry" || value === "running";
}

export async function lockPromptFrontier(
  transaction: TaskExecutionDbTransaction,
  input: { companyId: string; taskId: string; runId: string },
): Promise<{
  expected: TaskExecutionFinalizationPromptIdentity[];
  dependencies: TaskExecutionFinalizationPromptDependency[];
}> {
  const refs = await transaction
    .select()
    .from(taskExecutionRunRefs)
    .where(
      and(
        eq(taskExecutionRunRefs.companyId, input.companyId),
        eq(taskExecutionRunRefs.taskId, input.taskId),
        eq(taskExecutionRunRefs.runId, input.runId),
      ),
    )
    .orderBy(asc(taskExecutionRunRefs.refOrdinal))
    .for("update");
  if (refs.length === 0) {
    throw new PostgresTaskExecutionFinalizationRejected(
      "Productive and consult finalization requires a nonempty run-ref frontier",
    );
  }
  if (refs.some((ref, ordinal) => ref.refOrdinal !== ordinal)) {
    throw new PostgresTaskExecutionFinalizationRejected("Run-ref finalization frontier is not contiguous");
  }
  const expected: TaskExecutionFinalizationPromptIdentity[] = [];
  const dependencies: TaskExecutionFinalizationPromptDependency[] = [];
  for (const ref of refs) {
    if (ref.protocolSettlementState === null || ref.settlementVersion < 1) {
      throw new PostgresTaskExecutionFinalizationRejected(
        "Run finalization encountered an unsettled base prompt",
      );
    }
    const identity = {
      refId: ref.refId,
      refOrdinal: ref.refOrdinal,
    };
    expected.push(identity);
    dependencies.push({
      ...identity,
      protocolSettlementState: ref.protocolSettlementState,
      settlementVersion: ref.settlementVersion,
      accountingId: ref.accountingId,
      costEventId: ref.costEventId,
    });
  }
  return { expected, dependencies };
}

export async function lockRunUpdates(
  transaction: TaskExecutionDbTransaction,
  input: { companyId: string; runId: string },
): Promise<Array<{ taskUpdateId: string; updateTargetTaskId: string }>> {
  // Creator-form updates are persisted under the child task even though the
  // producing run belongs to its parent. Same-task updates signal that the
  // agent already directed output there; cross-task updates still need the
  // current task's final response published.
  const updates = await transaction
    .select({
      id: taskUpdates.id,
      taskId: taskUpdates.taskId,
    })
    .from(taskUpdates)
    .where(and(eq(taskUpdates.companyId, input.companyId), eq(taskUpdates.runId, input.runId)))
    .orderBy(asc(taskUpdates.runSequence))
    .for("update");
  return updates.map((update) => ({
    taskUpdateId: update.id,
    updateTargetTaskId: update.taskId,
  }));
}

export async function insertProductiveLivenessFact(
  transaction: TaskExecutionDbTransaction,
  input: FinalizePostgresTaskExecutionRunInput,
): Promise<string> {
  const [taskLifecycle, assistantRows, documentStats, workProductStats, activityStats, toolStats] =
    await Promise.all([
      transaction
        .select({
          taskLifecycleStatus: tasks.lifecycleStatus,
        })
        .from(tasks)
        .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      transaction
        .select()
        .from(taskSessionMessages)
        .where(
          and(
            eq(taskSessionMessages.companyId, input.companyId),
            eq(taskSessionMessages.taskId, input.taskId),
            eq(taskSessionMessages.runId, input.runId),
            eq(taskSessionMessages.type, "assistant"),
          ),
        )
        .orderBy(asc(taskSessionMessages.seq), asc(taskSessionMessages.id))
        .limit(501),
      transaction
        .select({
          count: sql<number>`count(*)::int`,
          planCount: sql<number>`count(*) filter (where ${taskDocuments.key} = 'plan')::int`,
          latestAt: sql<Date | null>`max(${documentRevisions.createdAt})`,
        })
        .from(documentRevisions)
        .innerJoin(taskDocuments, eq(documentRevisions.documentId, taskDocuments.documentId))
        .where(
          and(
            eq(documentRevisions.companyId, input.companyId),
            eq(documentRevisions.createdByRunId, input.runId),
            eq(taskDocuments.companyId, input.companyId),
            eq(taskDocuments.taskId, input.taskId),
          ),
        )
        .then((rows) => rows[0]),
      transaction
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${taskWorkProducts.createdAt})`,
        })
        .from(taskWorkProducts)
        .where(
          and(
            eq(taskWorkProducts.companyId, input.companyId),
            eq(taskWorkProducts.taskId, input.taskId),
            eq(taskWorkProducts.createdByRunId, input.runId),
          ),
        )
        .then((rows) => rows[0]),
      transaction
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, input.companyId), eq(activityLog.runId, input.runId)))
        .then((rows) => rows[0]),
      transaction
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${runInterfaceToolCalls.createdAt})`,
        })
        .from(runInterfaceToolCalls)
        .innerJoin(
          taskExecutionPromptCapabilities,
          and(
            eq(
              runInterfaceToolCalls.capabilityConnectionId,
              taskExecutionPromptCapabilities.capabilityConnectionId,
            ),
            eq(
              runInterfaceToolCalls.capabilityGeneration,
              taskExecutionPromptCapabilities.capabilityGeneration,
            ),
          ),
        )
        .where(
          and(
            eq(runInterfaceToolCalls.companyId, input.companyId),
            eq(taskExecutionPromptCapabilities.companyId, input.companyId),
            eq(taskExecutionPromptCapabilities.runId, input.runId),
          ),
        )
        .then((rows) => rows[0]),
    ]);
  if (!taskLifecycle) {
    throw new PostgresTaskExecutionFinalizationRejected("Productive finalization lost its canonical task");
  }
  if (assistantRows.length > 500) {
    throw new PostgresTaskExecutionFinalizationRejected(
      "Productive liveness exceeded its bounded canonical Session assistant view",
    );
  }
  const assistants = assistantRows.map((row) => {
    const message = taskSessionMessageFromRow(row);
    if (message.type !== "assistant") {
      throw new PostgresTaskExecutionFinalizationRejected(
        "Productive liveness selected a non-assistant Session row",
      );
    }
    return message;
  });
  const completedAssistants = assistants.filter((assistant) => assistant.time.completed !== undefined);
  const assistantTextParts = completedAssistants.flatMap((assistant) =>
    assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
  const assistantErrors = completedAssistants.flatMap((assistant) =>
    assistant.error ? [{ type: assistant.error.type }] : [],
  );
  const classification = classifyRunLiveness({
    runStatus: input.status,
    taskLifecycleStatus: taskLifecycle.taskLifecycleStatus,
    assistantTextParts,
    failureFacts: {
      terminalReasonCode: input.terminalReasonCode,
      assistantErrors,
    },
    continuationAttempt: 0,
    evidence: {
      documentRevisionsCreated: countValue(documentStats?.count),
      planDocumentRevisionsCreated: countValue(documentStats?.planCount),
      workProductsCreated: countValue(workProductStats?.count),
      activityEventsCreated: countValue(activityStats?.count),
      toolOrActionEventsCreated: countValue(toolStats?.count),
      latestEvidenceAt: latestDate(
        documentStats?.latestAt,
        workProductStats?.latestAt,
        activityStats?.latestAt,
        toolStats?.latestAt,
      ),
    },
  });
  const id = randomUUID();
  await transaction.insert(taskExecutionRunLivenessFacts).values({
    id,
    companyId: input.companyId,
    runId: input.runId,
    livenessState: classification.livenessState,
    livenessReason: classification.livenessReason,
    continuationAttempt: classification.continuationAttempt,
    lastUsefulActionAt: classification.lastUsefulActionAt,
    nextAction: classification.nextAction,
  });
  return id;
}
