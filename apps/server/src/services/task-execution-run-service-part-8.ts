import {
  acpPromptAccounting,
  activityLog,
  costEvents,
  taskCommentProjectionSources,
  taskExecutionAttemptRetrySchedules,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionFinalizationPromptDependencies,
  taskExecutionFinalizationUpdateDependencies,
  taskExecutionFinalizations,
  taskExecutionLeases,
  taskExecutionRunControls,
  taskExecutionRunLivenessFacts,
  taskExecutionRunRefs,
  taskExecutionRuns,
  type Db,
} from "@paperclipai/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as runContracts from "./task-execution-run-service-part-1-section-1.js";
import {
  TaskExecutionRunInvariantViolation,
} from "./task-execution-run-service-part-1-section-1.js";
import { readTaskExecutionRun } from "./task-execution-run-service-part-2-section-1.js";
import { assertJoinedRunShape, boundedRecords } from "./task-execution-run-service-part-7.js";
import { redactTaskSessionPublicationValue } from "./task-session/publication.js";
import type { TaskSessionStore } from "./task-session/store.js";

/**
 * One bounded canonical join for REST, activity, and audit
 * projections. The caller owns authorization; this reader owns identical DB
 * bytes and structural redaction for every authorized consumer.
 */
export async function readJoinedTaskExecutionRunDetail(
  database: Db,
  taskSessionStore: TaskSessionStore,
  input: runContracts.ReadJoinedTaskExecutionRunDetailInput,
): Promise<runContracts.JoinedTaskExecutionRunDetail | null> {
  runContracts.assertRunIdentity(input);
  runContracts.assertPageLimit(input.limit, runContracts.MAX_RUN_DETAIL_OWNER_ROWS, "run detail owner limit");
  const run = await readTaskExecutionRun(database, input);
  if (!run) return null;

  const [
    controlRows,
    refRows,
    sessionEventPage,
    sessionMessagePage,
    attemptRows,
    retryScheduleRows,
    leaseRows,
    cancellationRows,
    accountingRows,
    costRows,
    activityRows,
    outputCommentRows,
    finalizationRows,
  ] = await Promise.all([
    database
      .select()
      .from(taskExecutionRunControls)
      .where(eq(taskExecutionRunControls.runId, input.runId))
      .limit(2),
    database
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
      .limit(input.limit + 1),
    taskSessionStore.pageEvents(
      {
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: run.sessionId,
        runId: input.runId,
        direction: "asc",
        projection: input.sessionProjection ?? "audit",
      },
      { cursor: input.sessionEventCursor, limit: input.limit },
    ),
    taskSessionStore.pageMessages(
      {
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: run.sessionId,
        runId: input.runId,
        direction: "asc",
        projection: input.sessionProjection ?? "audit",
      },
      { cursor: input.sessionMessageCursor, limit: input.limit },
    ),
    database
      .select()
      .from(taskExecutionAttempts)
      .where(
        and(
          eq(taskExecutionAttempts.companyId, input.companyId),
          eq(taskExecutionAttempts.taskId, input.taskId),
          eq(taskExecutionAttempts.runId, input.runId),
        ),
      )
      .orderBy(asc(taskExecutionAttempts.createdAt), asc(taskExecutionAttempts.id))
      .limit(input.limit + 1),
    database
      .select()
      .from(taskExecutionAttemptRetrySchedules)
      .where(
        and(
          eq(taskExecutionAttemptRetrySchedules.companyId, input.companyId),
          eq(taskExecutionAttemptRetrySchedules.taskId, input.taskId),
          eq(taskExecutionAttemptRetrySchedules.runId, input.runId),
        ),
      )
      .orderBy(asc(taskExecutionAttemptRetrySchedules.createdAt), asc(taskExecutionAttemptRetrySchedules.id))
      .limit(input.limit + 1),
    database
      .select()
      .from(taskExecutionLeases)
      .where(
        and(
          eq(taskExecutionLeases.companyId, input.companyId),
          eq(taskExecutionLeases.taskId, input.taskId),
          eq(taskExecutionLeases.runId, input.runId),
        ),
      )
      .orderBy(asc(taskExecutionLeases.createdAt), asc(taskExecutionLeases.id))
      .limit(input.limit + 1),
    database
      .select()
      .from(taskExecutionCancellationIntents)
      .where(
        and(
          eq(taskExecutionCancellationIntents.companyId, input.companyId),
          eq(taskExecutionCancellationIntents.taskId, input.taskId),
          eq(taskExecutionCancellationIntents.runId, input.runId),
        ),
      )
      .orderBy(asc(taskExecutionCancellationIntents.createdAt), asc(taskExecutionCancellationIntents.id))
      .limit(input.limit + 1),
    database
      .select()
      .from(acpPromptAccounting)
      .where(
        and(
          eq(acpPromptAccounting.companyId, input.companyId),
          eq(acpPromptAccounting.taskId, input.taskId),
          eq(acpPromptAccounting.runId, input.runId),
        ),
      )
      .orderBy(asc(acpPromptAccounting.createdAt), asc(acpPromptAccounting.id))
      .limit(input.limit + 1),
    database
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, input.companyId),
          eq(costEvents.taskId, input.taskId),
          eq(costEvents.runId, input.runId),
        ),
      )
      .orderBy(asc(costEvents.createdAt), asc(costEvents.id))
      .limit(input.limit + 1),
    database
      .select({
        id: activityLog.id,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        agentId: activityLog.agentId,
        responsibleUserId: activityLog.responsibleUserId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, input.companyId), eq(activityLog.runId, input.runId)))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
      .limit(input.limit + 1),
    database
      .select({
        commentId: taskCommentProjectionSources.commentId,
        messageId: taskCommentProjectionSources.messageId,
        sourceKind: taskCommentProjectionSources.sourceKind,
        projectedEventSeq: taskCommentProjectionSources.projectedEventSeq,
      })
      .from(taskCommentProjectionSources)
      .where(
        and(
          eq(taskCommentProjectionSources.companyId, input.companyId),
          eq(taskCommentProjectionSources.taskId, input.taskId),
          eq(taskCommentProjectionSources.runId, input.runId),
          inArray(taskCommentProjectionSources.sourceKind, ["run_output", "run_progress", "task_update"]),
        ),
      )
      .orderBy(
        asc(taskCommentProjectionSources.projectedEventSeq),
        asc(taskCommentProjectionSources.commentId),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(taskExecutionFinalizations)
      .where(
        and(
          eq(taskExecutionFinalizations.companyId, input.companyId),
          eq(taskExecutionFinalizations.runId, input.runId),
        ),
      )
      .limit(2),
  ]);

  if (finalizationRows.length > 1) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      "run joined detail found duplicate finalizations",
    );
  }
  const finalization = finalizationRows[0] ?? null;
  const [promptDependencies, updateDependencies, liveness] = finalization
    ? await Promise.all([
        database
          .select()
          .from(taskExecutionFinalizationPromptDependencies)
          .where(eq(taskExecutionFinalizationPromptDependencies.finalizationId, finalization.id))
          .orderBy(asc(taskExecutionFinalizationPromptDependencies.dependencyOrdinal))
          .limit(input.limit + 1),
        database
          .select()
          .from(taskExecutionFinalizationUpdateDependencies)
          .where(eq(taskExecutionFinalizationUpdateDependencies.finalizationId, finalization.id))
          .orderBy(asc(taskExecutionFinalizationUpdateDependencies.dependencyOrdinal))
          .limit(input.limit + 1),
        database
          .select()
          .from(taskExecutionRunLivenessFacts)
          .where(
            and(
              eq(taskExecutionRunLivenessFacts.companyId, input.companyId),
              eq(taskExecutionRunLivenessFacts.runId, input.runId),
            ),
          )
          .limit(2),
      ])
    : ([[], [], []] as const);
  if (liveness.length > 1) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      "run joined detail found duplicate liveness facts",
    );
  }
  const terminal = runContracts.TERMINAL_RUN_STATUSES.has(run.status);
  if (terminal !== (finalization !== null && finalization.id === run.terminalFinalizationId)) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      "run joined detail does not match its terminal finalization",
    );
  }
  if (finalization) {
    if (run.kind !== "productive") {
      if (finalization.runLivenessFactId !== null || liveness.length !== 0) {
        throw new runContracts.TaskExecutionRunInvariantViolation(
          "nonproductive finalization cannot carry productive-run liveness",
        );
      }
    } else {
      const livenessFact = liveness[0] ?? null;
      if (
        finalization.runLivenessFactId === null ||
        !livenessFact ||
        livenessFact.id !== finalization.runLivenessFactId ||
        livenessFact.runId !== run.runId ||
        livenessFact.companyId !== run.companyId
      ) {
        throw new runContracts.TaskExecutionRunInvariantViolation(
          "productive run finalization is missing its exact liveness fact",
        );
      }
    }
  }

  const refs = boundedRecords(refRows, input.limit);
  assertJoinedRunShape({
    run,
    controlRows,
    refRows: refs.items,
    refsTruncated: refs.truncated,
  });
  const redactedEvents = sessionEventPage.items.map(({ row }) => ({
    id: row.id,
    seq: row.seq,
    type: row.type,
    data: redactTaskSessionPublicationValue(row.data) as unknown as Record<string, unknown>,
    createdAt: row.createdAt,
  }));
  const redactedMessages = sessionMessagePage.items.map(({ row }) => ({
    id: row.id,
    seq: row.seq,
    modelStateSeq: row.modelStateSeq,
    type: row.type,
    data: redactTaskSessionPublicationValue(row.data) as unknown as Record<string, unknown>,
    timeCreated: row.timeCreated,
    timeUpdated: row.timeUpdated,
  }));
  const redactedActivity = activityRows.map((row) => redactTaskSessionPublicationValue(row));
  return {
    run,
    control: controlRows[0] ?? null,
    refs,
    sessionEvents: {
      items: redactedEvents,
      truncated: sessionEventPage.nextCursor !== null,
      nextCursor: sessionEventPage.nextCursor,
    },
    sessionMessages: {
      items: redactedMessages,
      truncated: sessionMessagePage.nextCursor !== null,
      nextCursor: sessionMessagePage.nextCursor,
    },
    attempts: boundedRecords(attemptRows, input.limit),
    retrySchedules: boundedRecords(retryScheduleRows, input.limit),
    leases: boundedRecords(leaseRows, input.limit),
    cancellations: boundedRecords(cancellationRows, input.limit),
    accounting: boundedRecords(accountingRows, input.limit),
    costs: boundedRecords(costRows, input.limit),
    activity: boundedRecords(redactedActivity, input.limit),
    outputComments: boundedRecords(
      outputCommentRows.map((row) => ({
        commentId: row.commentId,
        messageId: row.messageId,
        sourceKind: row.sourceKind as runContracts.TaskExecutionRunOutputCommentLink["sourceKind"],
        projectedEventSeq: Number(row.projectedEventSeq),
      })),
      input.limit,
    ),
    finalization: finalization
      ? {
          record: finalization,
          promptDependencies: boundedRecords(promptDependencies, input.limit),
          updateDependencies: boundedRecords(updateDependencies, input.limit),
          liveness: liveness[0] ?? null,
        }
      : null,
  };
}
