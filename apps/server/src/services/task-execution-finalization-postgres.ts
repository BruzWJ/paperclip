import { randomUUID } from "node:crypto";
import {
  activityLog,
  agentActionGrants,
  agentMentionReachGrants,
  agents,
  documentRevisions,
  taskCommentProjectionSources,
  taskComments,
  taskConsultExecutions,
  taskDocuments,
  taskExecutionFinalizationPromptDependencies,
  taskExecutionFinalizations,
  taskExecutionFinalizationUpdateDependencies,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunLivenessFacts,
  taskExecutionRunRefs,
  taskSessionEvents,
  taskSessionMessages,
  taskUpdates,
  taskWorkProducts,
  tasks,
  runInterfaceToolCalls,
  type Db,
} from "@paperclipai/db";
import type {
  TaskExecutionRunTerminalClassification,
} from "@paperclipai/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  buildTaskExecutionFinalizationPlan,
  type TaskExecutionFinalizationPromptDependency,
  type TaskExecutionFinalizationPromptIdentity,
} from "./task-execution-finalization.js";
import type { TaskExecutionRunService } from "./task-execution-run-service.js";
import {
  taskSessionMessageFromRow,
} from "./task-session/projector.js";
import { publishTaskSessionFinalCommentInTx } from "./task-session/publication.js";
import { classifyRunLiveness } from "./run-liveness.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import { mentionAgentInTransaction } from "./runtime-task-action-port.js";
import { resolveMentionReach } from "./mention-reach-resolver.js";

type TaskExecutionDbTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

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

function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) {
    throw new PostgresTaskExecutionFinalizationRejected(message);
  }
  return rows[0]!;
}

function countValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function latestDate(...values: unknown[]): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    const parsed = dateValue(value);
    if (parsed && (!latest || parsed > latest)) latest = parsed;
  }
  return latest;
}

function terminalAssistantText(
  row: typeof taskSessionMessages.$inferSelect | null,
): string {
  if (!row) return "";
  const message = taskSessionMessageFromRow(row);
  if (message.type !== "assistant" || !message.time.completed) return "";
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function activeRunStatus(
  value: string,
): value is "queued" | "scheduled_retry" | "running" {
  return (
    value === "queued" ||
    value === "scheduled_retry" ||
    value === "running"
  );
}

async function lockPromptFrontier(
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
    throw new PostgresTaskExecutionFinalizationRejected(
      "Run-ref finalization frontier is not contiguous",
    );
  }
  const segments = await transaction
    .select()
    .from(taskExecutionPromptSegments)
    .where(
      and(
        eq(taskExecutionPromptSegments.companyId, input.companyId),
        eq(taskExecutionPromptSegments.taskId, input.taskId),
        eq(taskExecutionPromptSegments.runId, input.runId),
      ),
    )
    .orderBy(
      asc(taskExecutionPromptSegments.refOrdinal),
      asc(taskExecutionPromptSegments.segmentOrdinal),
    )
    .for("update");
  const segmentsByRef = new Map<string, typeof segments>();
  for (const segment of segments) {
    const current = segmentsByRef.get(segment.refId) ?? [];
    current.push(segment);
    segmentsByRef.set(segment.refId, current);
  }
  const expected: TaskExecutionFinalizationPromptIdentity[] = [];
  const dependencies: TaskExecutionFinalizationPromptDependency[] = [];
  for (const ref of refs) {
    if (
      ref.protocolSettlementState === null ||
      ref.settlementVersion < 1
    ) {
      throw new PostgresTaskExecutionFinalizationRejected(
        "Run finalization encountered an unsettled base prompt",
      );
    }
    const base = {
      kind: "base" as const,
      refId: ref.refId,
      refOrdinal: ref.refOrdinal,
      segmentOrdinal: 0 as const,
    };
    expected.push(base);
    dependencies.push({
      ...base,
      protocolSettlementState: ref.protocolSettlementState,
      settlementVersion: ref.settlementVersion,
      accountingId: ref.accountingId,
      costEventId: ref.costEventId,
    });
    const refSegments = segmentsByRef.get(ref.refId) ?? [];
    for (const [index, segment] of refSegments.entries()) {
      if (
        segment.refOrdinal !== ref.refOrdinal ||
        segment.segmentOrdinal !== index + 1 ||
        segment.protocolSettlementState === null ||
        segment.settlementVersion < 1
      ) {
        throw new PostgresTaskExecutionFinalizationRejected(
          "Run finalization encountered a noncontiguous or unsettled steering segment",
        );
      }
      const steering = {
        kind: "steering" as const,
        refId: segment.refId,
        refOrdinal: segment.refOrdinal,
        segmentOrdinal: segment.segmentOrdinal,
      };
      expected.push(steering);
      dependencies.push({
        ...steering,
        protocolSettlementState: segment.protocolSettlementState,
        settlementVersion: segment.settlementVersion,
        accountingId: segment.accountingId,
        costEventId: segment.costEventId,
      });
    }
    segmentsByRef.delete(ref.refId);
  }
  if (segmentsByRef.size !== 0) {
    throw new PostgresTaskExecutionFinalizationRejected(
      "Steering finalization frontier contains a segment outside its run refs",
    );
  }
  return { expected, dependencies };
}

async function lockRunUpdates(
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
    .where(
      and(
        eq(taskUpdates.companyId, input.companyId),
        eq(taskUpdates.runId, input.runId),
      ),
    )
    .orderBy(asc(taskUpdates.runSequence))
    .for("update");
  return updates.map((update) => ({
    taskUpdateId: update.id,
    updateTargetTaskId: update.taskId,
  }));
}

async function insertProductiveLivenessFact(
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
        .where(
          and(
            eq(tasks.companyId, input.companyId),
            eq(tasks.id, input.taskId),
          ),
        )
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
        .innerJoin(
          taskDocuments,
          eq(documentRevisions.documentId, taskDocuments.documentId),
        )
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
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.runId, input.runId),
          ),
        )
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
    throw new PostgresTaskExecutionFinalizationRejected(
      "Productive finalization lost its canonical task",
    );
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
  const completedAssistants = assistants.filter(
    (assistant) => assistant.time.completed !== undefined,
  );
  const assistantTextParts = completedAssistants.flatMap((assistant) =>
    assistant.content.flatMap((part) =>
      part.type === "text" ? [part.text] : []
    )
  );
  const assistantErrors = completedAssistants.flatMap((assistant) =>
    assistant.error
      ? [{ type: assistant.error.type }]
      : []
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

/**
 * Sole productive/consult finalization transaction owner. It derives every
 * dependency from locked canonical rows; callers provide only the run's
 * terminal classification and bounded reason, never output bytes or a
 * caller-assembled prompt frontier.
 */
export function createPostgresTaskExecutionFinalizationWriter(options: {
  readonly database: Db;
  readonly runService: Pick<TaskExecutionRunService, "lockRun" | "attachFinalization">;
}) {
  async function closeMentionExecutionInTransaction(
    transaction: TaskExecutionDbTransaction,
    input: {
      companyId: string;
      taskId: string;
      runId: string;
      targetAgentId: string;
      consultExecutionId: string;
      status: TaskExecutionRunTerminalClassification;
      at: Date;
    },
  ): Promise<void> {
    const incomingRows = await transaction
      .select({ ref: taskExecutionRefs })
      .from(taskExecutionRunRefs)
      .innerJoin(
        taskExecutionRefs,
        eq(taskExecutionRefs.id, taskExecutionRunRefs.refId),
      )
      .where(
        and(
          eq(taskExecutionRunRefs.companyId, input.companyId),
          eq(taskExecutionRunRefs.taskId, input.taskId),
          eq(taskExecutionRunRefs.runId, input.runId),
          eq(
            taskExecutionRefs.consultExecutionId,
            input.consultExecutionId,
          ),
        ),
      )
      .limit(2)
      .for("update");
    if (incomingRows.length !== 1) {
      throw new PostgresTaskExecutionFinalizationRejected(
        "Mention run lost its exact incoming ref",
      );
    }
    const incomingRef = incomingRows[0]!.ref;
    if (
      incomingRef.mode !== "consult" ||
      incomingRef.sourceKind !== "consult_mention" ||
      incomingRef.targetAgentId !== input.targetAgentId ||
      incomingRef.consultChainToken === null
    ) {
      return;
    }

    const closed = await transaction
      .update(taskConsultExecutions)
      .set({
        state: input.status === "succeeded" ? "completed" : "cancelled",
        closeReason:
          input.status === "succeeded"
            ? "mention_completed"
            : `mention_${input.status}`,
        closedAt: input.at,
      })
      .where(
        and(
          eq(taskConsultExecutions.id, input.consultExecutionId),
          eq(taskConsultExecutions.state, "active"),
        ),
      )
      .returning({ id: taskConsultExecutions.id });
    if (closed.length !== 1) {
      throw new PostgresTaskExecutionFinalizationRejected(
        "Mention run could not close its consult authority",
      );
    }
  }

  async function maybeAutoCaptureMentionResponse(
    transaction: TaskExecutionDbTransaction,
    input: FinalizePostgresTaskExecutionRunInput,
    run: Awaited<ReturnType<typeof options.runService.lockRun>>,
    finalText: string,
  ): Promise<string | null> {
    if (
      run.kind !== "consult" ||
      !run.consultExecutionId ||
      input.status !== "succeeded" ||
      finalText.length === 0
    ) {
      return null;
    }

    const consult = await transaction
      .select({
        taskId: taskConsultExecutions.taskId,
        sourceRunId: taskConsultExecutions.sourceRunId,
      })
      .from(taskConsultExecutions)
      .where(eq(taskConsultExecutions.id, run.consultExecutionId))
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!consult) return null;

    const sourceRun = await options.runService.lockRun(transaction, {
      companyId: input.companyId,
      taskId: consult.taskId,
      runId: consult.sourceRunId,
    });

    const finishingRef = await transaction
      .select({
        id: taskExecutionRefs.id,
        executionLineageId: taskExecutionRefs.executionLineageId,
        executionScopeId: taskExecutionRefs.executionScopeId,
      })
      .from(taskExecutionRefs)
      .innerJoin(
        taskExecutionRunRefs,
        and(
          eq(taskExecutionRunRefs.refId, taskExecutionRefs.id),
          eq(taskExecutionRunRefs.runId, input.runId),
          eq(taskExecutionRunRefs.companyId, input.companyId),
        ),
      )
      .where(
        and(
          eq(taskExecutionRefs.companyId, input.companyId),
          eq(taskExecutionRefs.taskId, input.taskId),
          eq(taskExecutionRefs.sessionId, run.sessionId),
          eq(taskExecutionRefs.mode, "consult"),
        ),
      )
      .orderBy(asc(taskExecutionRefs.id))
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!finishingRef) return null;

    const companyAgents = await transaction
      .select()
      .from(agents)
      .where(eq(agents.companyId, input.companyId));

    const taskTree = await transaction
      .select({
        id: tasks.id,
        parentId: tasks.parentId,
        ownerKind: tasks.ownerKind,
        ownerAgentId: tasks.ownerAgentId,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, input.companyId),
          eq(tasks.id, input.taskId),
        ),
      );

    const mentionReachRows = await transaction
      .select({ key: agentMentionReachGrants.key })
      .from(agentMentionReachGrants)
      .where(
        and(
          eq(agentMentionReachGrants.companyId, input.companyId),
          eq(agentMentionReachGrants.agentId, run.targetAgentId),
        ),
      );

    const mentionReach = Object.fromEntries(
      mentionReachRows.map((r) => [r.key, true]),
    );

    const resolution = resolveMentionReach({
      sourceAgentId: run.targetAgentId,
      companyAgents,
      taskTree,
      mentionReach,
    });

    if (resolution.targetAgentIds.size > 0) return null;

    const mentionBoardRow = await transaction
      .select({ id: agentActionGrants.id })
      .from(agentActionGrants)
      .where(
        and(
          eq(agentActionGrants.companyId, input.companyId),
          eq(agentActionGrants.agentId, run.targetAgentId),
          eq(agentActionGrants.key, "mention_board"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (mentionBoardRow) return null;

    const sourceAgent = companyAgents.find(
      (a) => a.id === sourceRun.targetAgentId,
    );
    if (!sourceAgent) return null;

    const finishingAgent = companyAgents.find(
      (a) => a.id === run.targetAgentId,
    );

    const consultId = randomUUID();
    await transaction.insert(taskConsultExecutions).values({
      id: consultId,
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: run.sessionId,
      ownershipEpoch: run.ownershipEpoch,
      sourceRunId: input.runId,
      sourceRefId: finishingRef.id,
      callerExecutionScopeId: finishingRef.executionScopeId,
      targetAgentId: sourceAgent.id,
      adapterConfigRevisionId: sourceRun.adapterConfigRevisionId,
      chainToken: `consult_chain:auto_capture:${input.runId}`,
      state: "active",
      createdAt: input.finishedAt,
    });

    const sessionAdmission = createTaskSessionAdmissionService(
      transaction as unknown as Db,
    );

    const admission = await mentionAgentInTransaction(
      sessionAdmission,
      transaction,
      {
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: run.sessionId,
        ownershipEpoch: run.ownershipEpoch,
        targetAgentId: sourceAgent.id,
        taskExecutionAuthorityId: null,
        consultExecutionId: consultId,
        adapterConfigRevisionId: sourceRun.adapterConfigRevisionId,
        contextEpoch: 0,
        mode: "consult",
        executionLineageId: finishingRef.executionLineageId,
        consultCallerRefId: finishingRef.id,
        consultChainToken: `consult_chain:auto_capture:${input.runId}`,
        sourceKind: "consult_mention",
        actor: {
          kind: "agent-execution",
          agentId: run.targetAgentId,
          authorityId: run.taskExecutionAuthorityId ?? "",
        },
        immutableSourceKey: `auto-capture:${input.runId}`,
        sourceRecordId: consultId,
        idempotencyKey: `auto-capture:${input.runId}`,
        prompt: {
          toolName: "mention_agent",
          arguments: {
            agentId: sourceAgent.id,
            message: finalText,
          },
          context: {
            task: { id: input.taskId },
            from: {
              id: run.targetAgentId,
              name: finishingAgent?.name ?? "Agent",
            },
            to: {
              id: sourceAgent.id,
              name: sourceAgent.name,
            },
          },
        },
        comment: {
          author: { kind: "agent", agentId: run.targetAgentId },
          producingRun: {
            runId: input.runId,
            adapterConfigRevisionId: run.adapterConfigRevisionId,
          },
        },
      },
    );

    if (!admission.ref) return null;
    return admission.ref.id;
  }

  async function finalizeInTransaction(
    transaction: TaskExecutionDbTransaction,
    input: FinalizePostgresTaskExecutionRunInput,
  ): Promise<FinalizedPostgresTaskExecutionRun> {
      if (
        input.terminalReasonCode.length === 0 ||
        input.terminalReasonCode !== input.terminalReasonCode.trim() ||
        input.terminalReasonCode.length > 200 ||
        !Number.isFinite(input.finishedAt.getTime())
      ) {
        throw new PostgresTaskExecutionFinalizationRejected(
          "Run finalization has an invalid terminal reason or timestamp",
        );
      }
        const run = await options.runService.lockRun(transaction, input);
        if (run.terminalFinalizationId !== null) {
          const finalization = exactlyOne(
            await transaction
              .select()
              .from(taskExecutionFinalizations)
              .where(
                and(
                  eq(taskExecutionFinalizations.companyId, input.companyId),
                  eq(taskExecutionFinalizations.runId, input.runId),
                  eq(taskExecutionFinalizations.id, run.terminalFinalizationId),
                ),
              )
              .limit(2)
              .for("update"),
            "Terminal run lost its exact finalization",
          );
          if (
            run.status !== input.status ||
            run.terminalReasonCode !== input.terminalReasonCode ||
            run.finishedAt?.getTime() !== input.finishedAt.getTime() ||
            finalization.finalizedAt.getTime() !== input.finishedAt.getTime()
          ) {
            throw new PostgresTaskExecutionFinalizationRejected(
              "Finalization retry changed immutable terminal input",
            );
          }
          return {
            finalizationId: finalization.id,
            status: input.status,
            retried: true,
            autoCaptureRefId: null,
          };
        }
        if (!activeRunStatus(run.status)) {
          throw new PostgresTaskExecutionFinalizationRejected(
            "Only an active run can be finalized",
          );
        }
        const control = exactlyOne(
          await transaction
            .select()
            .from(taskExecutionRunControls)
            .where(eq(taskExecutionRunControls.runId, input.runId))
            .limit(2)
            .for("update"),
          "Productive or consult run lost its current-prompt control",
        );
        if (
          control.currentRefId !== null ||
          control.currentOrdinal !== null ||
          control.currentSegmentOrdinal !== null
        ) {
          throw new PostgresTaskExecutionFinalizationRejected(
            "Run cannot finalize while a prompt is current",
          );
        }
        const frontier = await lockPromptFrontier(transaction, input);
        const updates = await lockRunUpdates(transaction, input);
        const progressSources = await transaction
          .select({
            source: taskCommentProjectionSources,
            comment: taskComments,
          })
          .from(taskCommentProjectionSources)
          .innerJoin(
            taskComments,
            eq(taskComments.id, taskCommentProjectionSources.commentId),
          )
          .where(
            and(
              eq(taskCommentProjectionSources.companyId, input.companyId),
              eq(taskCommentProjectionSources.taskId, input.taskId),
              eq(taskCommentProjectionSources.sessionId, run.sessionId),
              eq(taskCommentProjectionSources.sourceKind, "run_progress"),
              eq(taskCommentProjectionSources.runId, input.runId),
            ),
          )
          .limit(2)
          .for("update");
        const progress = exactlyOne(
          progressSources,
          "Run finalization requires one stable run-progress comment",
        );
        const terminalEvents = await transaction
          .select()
          .from(taskSessionEvents)
          .where(
            and(
              eq(taskSessionEvents.companyId, input.companyId),
              eq(taskSessionEvents.taskId, input.taskId),
              eq(taskSessionEvents.sessionId, run.sessionId),
              eq(taskSessionEvents.runId, input.runId),
              eq(taskSessionEvents.type, "session.next.step.ended.3"),
            ),
          )
          .orderBy(desc(taskSessionEvents.seq))
          .limit(1)
          .for("update");
        const terminalEvent = terminalEvents[0] ?? null;
        const terminalMessages = await transaction
          .select()
          .from(taskSessionMessages)
          .where(
            and(
              eq(taskSessionMessages.companyId, input.companyId),
              eq(taskSessionMessages.taskId, input.taskId),
              eq(taskSessionMessages.sessionId, run.sessionId),
              eq(taskSessionMessages.runId, input.runId),
              eq(taskSessionMessages.type, "assistant"),
            ),
          )
          .orderBy(desc(taskSessionMessages.seq))
          .limit(1)
          .for("update");
        const terminalMessage = terminalMessages[0] ?? null;
        const finalText = terminalAssistantText(terminalMessage);
        const mentionToolCallRows = await transaction
          .select({ toolName: runInterfaceToolCalls.toolName })
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
              eq(runInterfaceToolCalls.classification, "validated_mention"),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const hadMentionComment = mentionToolCallRows !== null;
        const sameTaskUpdates = updates.filter(
          (u) => u.updateTargetTaskId === input.taskId,
        );
        const action = hadMentionComment || sameTaskUpdates.length > 0
          ? "updates_committed" as const
          : updates.length > 0
            ? (finalText.length > 0 ? "comment_only" as const : "no_conversational_output" as const)
            : finalText.length > 0
              ? "comment_only" as const
              : "no_conversational_output" as const;
        if (
          (action !== "no_conversational_output" && !terminalEvent) ||
          (action === "comment_only" && !terminalMessage)
        ) {
          throw new PostgresTaskExecutionFinalizationRejected(
            "Conversational finalization is missing its terminal Session dependency",
          );
        }
        const revokedAt = input.finishedAt;
        await transaction
          .update(taskExecutionPromptCapabilities)
          .set({
            state: "revoked",
            revocationReason: "run_terminal",
            revokedAt,
          })
          .where(
            and(
              eq(taskExecutionPromptCapabilities.companyId, input.companyId),
              eq(taskExecutionPromptCapabilities.taskId, input.taskId),
              eq(taskExecutionPromptCapabilities.runId, input.runId),
              inArray(taskExecutionPromptCapabilities.state, [
                "pending_setup",
                "active",
              ]),
            ),
          );
        const capabilities = await transaction
          .select()
          .from(taskExecutionPromptCapabilities)
          .where(
            and(
              eq(taskExecutionPromptCapabilities.companyId, input.companyId),
              eq(taskExecutionPromptCapabilities.taskId, input.taskId),
              eq(taskExecutionPromptCapabilities.runId, input.runId),
            ),
          )
          .orderBy(desc(taskExecutionPromptCapabilities.capabilityGeneration))
          .for("update");
        const gateway = capabilities[0] ?? null;
        if (capabilities.some((capability) => capability.state !== "revoked")) {
          throw new PostgresTaskExecutionFinalizationRejected(
            "Run finalization could not prove complete capability revocation",
          );
        }
        const livenessId = run.kind === "productive"
          ? await insertProductiveLivenessFact(transaction, {
              ...input,
            })
          : null;
        const finalizationId = randomUUID();
        const plan = buildTaskExecutionFinalizationPlan({
          companyId: input.companyId,
          taskId: input.taskId,
          runId: input.runId,
          runKind: run.kind,
          action,
          expectedPromptIdentities: frontier.expected,
          promptDependencies: frontier.dependencies,
          terminalSessionEventId:
            action === "no_conversational_output" ? null : terminalEvent!.id,
          terminalSessionMessageId:
            action === "comment_only" ? terminalMessage!.id : null,
          progressCommentId: progress.comment.id,
          runLivenessFactId: livenessId,
          gatewayRevocationRequired: gateway !== null,
          gatewayRevocation: gateway
            ? {
                capabilityConnectionId: gateway.capabilityConnectionId,
                capabilityGeneration: gateway.capabilityGeneration,
              }
            : null,
          updates,
        });
        if (action === "comment_only") {
          const folded = await publishTaskSessionFinalCommentInTx(
            transaction,
            {
              eventId: terminalEvent!.id,
              progressCommentId: progress.comment.id,
            },
          );
          if (folded.id !== progress.comment.id || folded.body !== finalText) {
            throw new PostgresTaskExecutionFinalizationRejected(
              "Stable progress comment did not fold to the exact terminal assistant",
            );
          }
        }
        await transaction.insert(taskExecutionFinalizations).values({
          id: finalizationId,
          companyId: input.companyId,
          runId: input.runId,
          finalizationIdentityDigest: plan.finalizationIdentityDigest,
          action,
          terminalSessionEventId:
            action === "no_conversational_output" ? null : terminalEvent!.id,
          terminalSessionMessageId:
            action === "comment_only" ? terminalMessage!.id : null,
          progressCommentId: progress.comment.id,
          gatewayCapabilityConnectionId:
            gateway?.capabilityConnectionId ?? null,
          gatewayCapabilityGeneration:
            gateway?.capabilityGeneration ?? null,
          runLivenessFactId: livenessId,
          finalizedAt: input.finishedAt,
          createdAt: input.finishedAt,
        });
        if (run.kind === "consult" && run.consultExecutionId) {
          await closeMentionExecutionInTransaction(transaction, {
            companyId: input.companyId,
            taskId: input.taskId,
            runId: input.runId,
            targetAgentId: run.targetAgentId,
            consultExecutionId: run.consultExecutionId,
            status: input.status,
            at: input.finishedAt,
          });
        }
        await transaction
          .insert(taskExecutionFinalizationPromptDependencies)
          .values(
            plan.promptDependencies.map((dependency) => ({
              companyId: input.companyId,
              taskId: input.taskId,
              runId: input.runId,
              finalizationId,
              dependencyOrdinal: dependency.dependencyOrdinal,
              promptKind: dependency.kind,
              refId: dependency.refId,
              refOrdinal: dependency.refOrdinal,
              segmentOrdinal: dependency.segmentOrdinal,
              protocolSettlementState: dependency.protocolSettlementState,
              settlementVersion: dependency.settlementVersion,
              accountingId: dependency.accountingId,
              costEventId: dependency.costEventId,
            })),
          );
        if (plan.updateDependencies.length > 0) {
          await transaction
            .insert(taskExecutionFinalizationUpdateDependencies)
            .values(
              plan.updateDependencies.map((dependency) => ({
                companyId: input.companyId,
                runId: input.runId,
                finalizationId,
                dependencyOrdinal: dependency.dependencyOrdinal,
                taskUpdateId: dependency.taskUpdateId,
              })),
            );
        }
        await options.runService.attachFinalization(transaction, {
          companyId: input.companyId,
          taskId: input.taskId,
          runId: input.runId,
          expectedStatus: run.status as "queued" | "scheduled_retry" | "running",
          finalizationId,
          status: input.status,
          terminalReasonCode: input.terminalReasonCode,
          finishedAt: input.finishedAt,
          at: input.finishedAt,
        });
        const autoCaptureRefId = await maybeAutoCaptureMentionResponse(
          transaction,
          input,
          run,
          finalText,
        );
        return {
          finalizationId,
          status: input.status,
          retried: false,
          autoCaptureRefId: autoCaptureRefId ?? null,
        };
  }

  return {
    finalizeInTransaction,
    async finalize(
      input: FinalizePostgresTaskExecutionRunInput,
    ): Promise<FinalizedPostgresTaskExecutionRun> {
      return options.database.transaction((transaction) =>
        finalizeInTransaction(transaction, input));
    },
  };
}

export type PostgresTaskExecutionFinalizationWriter = ReturnType<
  typeof createPostgresTaskExecutionFinalizationWriter
>;
