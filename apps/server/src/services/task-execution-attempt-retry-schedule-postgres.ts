import { randomUUID } from "node:crypto";
import {
  taskExecutionAttempts,
  taskExecutionAttemptRetrySchedules,
  taskExecutionPromptSegments,
  taskExecutionRunRefs,
  type Db,
  type TaskExecutionAttempt,
  type TaskExecutionAttemptRetrySchedule,
} from "@paperclipai/db";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import {
  lockTaskExecutionRunInTransaction,
  transitionTaskExecutionRunStatusInTransaction,
  type TaskExecutionRunEnvelope,
} from "./task-execution-run-service.js";

type TaskExecutionDbTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ScheduleTaskExecutionAttemptRetryInput {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly predecessorAttemptId: string;
  readonly reasonCode: "transport_transient";
  readonly retryAt: Date;
  readonly at: Date;
}

export interface ClaimTaskExecutionAttemptRetryInput {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly scheduleId: string;
  readonly at: Date;
}

export interface TaskExecutionRetryClaimScope {
  readonly transaction: TaskExecutionDbTransaction;
  readonly run: TaskExecutionRunEnvelope;
  readonly predecessor: TaskExecutionAttempt;
  readonly schedule: TaskExecutionAttemptRetrySchedule;
  readonly at: Date;
}

export interface ClaimedTaskExecutionAttemptRetry {
  readonly schedule: TaskExecutionAttemptRetrySchedule;
  readonly successor: TaskExecutionAttempt;
}

export class TaskExecutionAttemptRetryScheduleRejected extends Error {
  readonly code = "task_execution_attempt_retry_schedule_rejected";

  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionAttemptRetryScheduleRejected";
  }
}

function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) {
    throw new TaskExecutionAttemptRetryScheduleRejected(message);
  }
  return rows[0]!;
}

function exactIdentifier(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TaskExecutionAttemptRetryScheduleRejected(
      `${label} must be exact and non-empty`,
    );
  }
}

function exactDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TaskExecutionAttemptRetryScheduleRejected(
      `${label} must be a valid timestamp`,
    );
  }
}

function validateScheduleInput(
  input: ScheduleTaskExecutionAttemptRetryInput,
): void {
  exactIdentifier(input.companyId, "company id");
  exactIdentifier(input.taskId, "task id");
  exactIdentifier(input.runId, "run id");
  exactIdentifier(input.predecessorAttemptId, "predecessor attempt id");
  exactDate(input.at, "retry creation time");
  exactDate(input.retryAt, "retry due time");
  if (
    input.reasonCode !== "transport_transient" ||
    input.retryAt < input.at
  ) {
    throw new TaskExecutionAttemptRetryScheduleRejected(
      "retry schedule requires a closed reason and a non-past due time",
    );
  }
}

function validateClaimInput(
  input: ClaimTaskExecutionAttemptRetryInput,
): void {
  exactIdentifier(input.companyId, "company id");
  exactIdentifier(input.taskId, "task id");
  exactIdentifier(input.runId, "run id");
  exactIdentifier(input.scheduleId, "retry schedule id");
  exactDate(input.at, "retry claim time");
}

async function lockRun(
  transaction: TaskExecutionDbTransaction,
  input: { companyId: string; taskId: string; runId: string },
): Promise<TaskExecutionRunEnvelope> {
  return lockTaskExecutionRunInTransaction(transaction, input);
}

async function lockAttempt(
  transaction: TaskExecutionDbTransaction,
  input: {
    companyId: string;
    taskId: string;
    runId: string;
    attemptId: string;
  },
): Promise<TaskExecutionAttempt> {
  return exactlyOne(
    await transaction
      .select()
      .from(taskExecutionAttempts)
      .where(
        and(
          eq(taskExecutionAttempts.companyId, input.companyId),
          eq(taskExecutionAttempts.taskId, input.taskId),
          eq(taskExecutionAttempts.runId, input.runId),
          eq(taskExecutionAttempts.id, input.attemptId),
        ),
      )
      .limit(2)
      .for("update"),
    "retry transition requires one exact predecessor attempt",
  );
}

async function assertPromptRemainedUnsent(
  transaction: TaskExecutionDbTransaction,
  attempt: TaskExecutionAttempt,
): Promise<void> {
  if (attempt.promptKind === "base") {
    const owner = exactlyOne(
      await transaction
        .select({
          attemptId: taskExecutionRunRefs.attemptId,
          phase: taskExecutionRunRefs.promptTransmissionPhase,
          settlement: taskExecutionRunRefs.protocolSettlementState,
        })
        .from(taskExecutionRunRefs)
        .where(
          and(
            eq(taskExecutionRunRefs.companyId, attempt.companyId),
            eq(taskExecutionRunRefs.taskId, attempt.taskId),
            eq(taskExecutionRunRefs.runId, attempt.runId),
            eq(taskExecutionRunRefs.refId, attempt.refId!),
            eq(taskExecutionRunRefs.refOrdinal, attempt.refOrdinal!),
          ),
        )
        .limit(2)
        .for("update"),
      "retry predecessor lost its exact base prompt owner",
    );
    if (
      owner.phase !== "not_transmitted" ||
      owner.settlement !== null ||
      (owner.attemptId !== null && owner.attemptId !== attempt.id)
    ) {
      throw new TaskExecutionAttemptRetryScheduleRejected(
        "retry predecessor base prompt was transmitted, settled, or rebound",
      );
    }
    return;
  }

  if (attempt.promptKind === "steering") {
    const owner = exactlyOne(
      await transaction
        .select({
          attemptId: taskExecutionPromptSegments.attemptId,
          phase: taskExecutionPromptSegments.promptTransmissionPhase,
          settlement: taskExecutionPromptSegments.protocolSettlementState,
        })
        .from(taskExecutionPromptSegments)
        .where(
          and(
            eq(taskExecutionPromptSegments.companyId, attempt.companyId),
            eq(taskExecutionPromptSegments.taskId, attempt.taskId),
            eq(taskExecutionPromptSegments.runId, attempt.runId),
            eq(taskExecutionPromptSegments.refId, attempt.refId!),
            eq(taskExecutionPromptSegments.refOrdinal, attempt.refOrdinal!),
            eq(
              taskExecutionPromptSegments.segmentOrdinal,
              attempt.segmentOrdinal!,
            ),
          ),
        )
        .limit(2)
        .for("update"),
      "retry predecessor lost its exact steering prompt owner",
    );
    if (
      owner.phase !== "not_transmitted" ||
      owner.settlement !== null ||
      (owner.attemptId !== null && owner.attemptId !== attempt.id)
    ) {
      throw new TaskExecutionAttemptRetryScheduleRejected(
        "retry predecessor steering prompt was transmitted, settled, or rebound",
      );
    }
    return;
  }

  throw new TaskExecutionAttemptRetryScheduleRejected(
    "retry predecessor has an unsupported prompt kind",
  );
}

function assertTerminalRetryablePredecessor(input: {
  run: TaskExecutionRunEnvelope;
  predecessor: TaskExecutionAttempt;
  at: Date;
}): void {
  const { run, predecessor, at } = input;
  if (
    run.kind !== predecessor.runKind ||
    !["queued", "running"].includes(run.status) ||
    run.finishedAt !== null ||
    run.terminalFinalizationId !== null ||
    run.currentAttemptId !== null ||
    run.currentLeaseId !== null ||
    run.cancellationIntentId !== null ||
    predecessor.state !== "failed" ||
    predecessor.finishedAt === null ||
    predecessor.finishedAt > at
  ) {
    throw new TaskExecutionAttemptRetryScheduleRejected(
      "retry creation requires one detached terminal pre-send predecessor on an active run",
    );
  }
}

export async function scheduleTaskExecutionAttemptRetryInTransaction(
  transaction: TaskExecutionDbTransaction,
  input: ScheduleTaskExecutionAttemptRetryInput & { readonly id: string },
): Promise<TaskExecutionAttemptRetrySchedule> {
  validateScheduleInput(input);
  exactIdentifier(input.id, "retry schedule id");
  const run = await lockRun(transaction, input);
  const predecessor = await lockAttempt(transaction, {
    ...input,
    attemptId: input.predecessorAttemptId,
  });
  assertTerminalRetryablePredecessor({ run, predecessor, at: input.at });
  await assertPromptRemainedUnsent(transaction, predecessor);

  const schedule = exactlyOne(
    await transaction
      .insert(taskExecutionAttemptRetrySchedules)
      .values({
        id: input.id,
        companyId: input.companyId,
        taskId: input.taskId,
        runId: input.runId,
        predecessorAttemptId: input.predecessorAttemptId,
        reasonCode: input.reasonCode,
        retryAt: input.retryAt,
        state: "scheduled",
        successorAttemptId: null,
        claimedAt: null,
        cancelledAt: null,
        createdAt: input.at,
      })
      .returning(),
    "retry schedule insert did not return one row",
  );
  if (run.status !== "queued" && run.status !== "running") {
    throw new TaskExecutionAttemptRetryScheduleRejected(
      "retry schedule lost its exact active run transition",
    );
  }
  await transitionTaskExecutionRunStatusInTransaction(transaction, {
    companyId: input.companyId,
    taskId: input.taskId,
    runId: input.runId,
    expectedStatus: run.status,
    status: "scheduled_retry",
    at: input.at,
  });
  return schedule;
}

export async function claimTaskExecutionAttemptRetryInTransaction(
  transaction: TaskExecutionDbTransaction,
  input: ClaimTaskExecutionAttemptRetryInput & {
    readonly successorAttemptId: string;
    readonly revalidate: (scope: TaskExecutionRetryClaimScope) => Promise<void>;
  },
): Promise<ClaimedTaskExecutionAttemptRetry> {
  validateClaimInput(input);
  exactIdentifier(input.successorAttemptId, "successor attempt id");
  const run = await lockRun(transaction, input);
  const schedule = exactlyOne(
    await transaction
      .select()
      .from(taskExecutionAttemptRetrySchedules)
      .where(
        and(
          eq(taskExecutionAttemptRetrySchedules.id, input.scheduleId),
          eq(taskExecutionAttemptRetrySchedules.companyId, input.companyId),
          eq(taskExecutionAttemptRetrySchedules.taskId, input.taskId),
          eq(taskExecutionAttemptRetrySchedules.runId, input.runId),
        ),
      )
      .limit(2)
      .for("update"),
    "retry claim requires one exact schedule",
  );
  const predecessor = await lockAttempt(transaction, {
    ...input,
    attemptId: schedule.predecessorAttemptId,
  });
  if (
    run.status !== "scheduled_retry" ||
    run.currentAttemptId !== null ||
    run.currentLeaseId !== null ||
    run.finishedAt !== null ||
    schedule.state !== "scheduled" ||
    schedule.successorAttemptId !== null ||
    schedule.claimedAt !== null ||
    schedule.cancelledAt !== null ||
    schedule.reasonCode !== "transport_transient" ||
    schedule.retryAt > input.at ||
    predecessor.state !== "failed" ||
    predecessor.finishedAt === null
  ) {
    throw new TaskExecutionAttemptRetryScheduleRejected(
      "retry schedule is not an exact due, unclaimed pre-send transition",
    );
  }
  await assertPromptRemainedUnsent(transaction, predecessor);
  const liveAttempts = await transaction
    .select({ id: taskExecutionAttempts.id })
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.companyId, input.companyId),
        eq(taskExecutionAttempts.taskId, input.taskId),
        eq(taskExecutionAttempts.runId, input.runId),
        inArray(taskExecutionAttempts.state, ["pending", "leased", "running"]),
      ),
    )
    .limit(1)
    .for("update");
  if (liveAttempts.length !== 0) {
    throw new TaskExecutionAttemptRetryScheduleRejected(
      "retry claim found another live attempt on the run",
    );
  }
  await input.revalidate({ transaction, run, predecessor, schedule, at: input.at });

  const successor = exactlyOne(
    await transaction
      .insert(taskExecutionAttempts)
      .values({
        id: input.successorAttemptId,
        companyId: predecessor.companyId,
        taskId: predecessor.taskId,
        sessionId: predecessor.sessionId,
        runId: predecessor.runId,
        runKind: predecessor.runKind,
        promptKind: predecessor.promptKind,
        sessionOperation: predecessor.sessionOperation,
        refId: predecessor.refId,
        refOrdinal: predecessor.refOrdinal,
        segmentOrdinal: predecessor.segmentOrdinal,
        steeringSegmentOrdinal: predecessor.steeringSegmentOrdinal,
        attemptGeneration: predecessor.attemptGeneration + 1,
        state: "pending",
        startedAt: null,
        finishedAt: null,
        createdAt: input.at,
      })
      .returning(),
    "retry claim did not create one successor attempt",
  );
  const claimed = exactlyOne(
    await transaction
      .update(taskExecutionAttemptRetrySchedules)
      .set({
        state: "claimed",
        successorAttemptId: successor.id,
        claimedAt: input.at,
      })
      .where(
        and(
          eq(taskExecutionAttemptRetrySchedules.id, schedule.id),
          eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
        ),
      )
      .returning(),
    "retry claim lost its exact scheduled row",
  );
  await transitionTaskExecutionRunStatusInTransaction(transaction, {
    companyId: input.companyId,
    taskId: input.taskId,
    runId: input.runId,
    expectedStatus: "scheduled_retry",
    status: "queued",
    at: input.at,
  });
  return { schedule: claimed, successor };
}

export function createPostgresTaskExecutionAttemptRetryScheduleService(
  database: Db,
  options: {
    readonly revalidateClaim: (
      scope: TaskExecutionRetryClaimScope,
    ) => Promise<void>;
    readonly idFactory?: () => string;
  },
) {
  const idFactory = options.idFactory ?? randomUUID;
  return {
    schedule(input: ScheduleTaskExecutionAttemptRetryInput) {
      return database.transaction((transaction) =>
        scheduleTaskExecutionAttemptRetryInTransaction(transaction, {
          ...input,
          id: idFactory(),
        }));
    },

    claim(input: ClaimTaskExecutionAttemptRetryInput) {
      return database.transaction((transaction) =>
        claimTaskExecutionAttemptRetryInTransaction(transaction, {
          ...input,
          successorAttemptId: idFactory(),
          revalidate: options.revalidateClaim,
        }));
    },

    async listDue(input: {
      readonly companyId: string;
      readonly at: Date;
      readonly limit: number;
    }): Promise<readonly TaskExecutionAttemptRetrySchedule[]> {
      exactIdentifier(input.companyId, "company id");
      exactDate(input.at, "retry due-list time");
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
        throw new TaskExecutionAttemptRetryScheduleRejected(
          "retry due-list limit must be an integer from 1 through 1000",
        );
      }
      return database
        .select()
        .from(taskExecutionAttemptRetrySchedules)
        .where(
          and(
            eq(taskExecutionAttemptRetrySchedules.companyId, input.companyId),
            eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
            lte(taskExecutionAttemptRetrySchedules.retryAt, input.at),
          ),
        )
        .orderBy(
          asc(taskExecutionAttemptRetrySchedules.retryAt),
          asc(taskExecutionAttemptRetrySchedules.id),
        )
        .limit(input.limit);
    },
  };
}

export type PostgresTaskExecutionAttemptRetryScheduleService = ReturnType<
  typeof createPostgresTaskExecutionAttemptRetryScheduleService
>;
