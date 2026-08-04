import { randomUUID } from "node:crypto";
import {
  issueExecutionAttempts,
  issueExecutionAttemptRetrySchedules,
  issueExecutionPromptSegments,
  issueExecutionRunRefs,
  type Db,
  type IssueExecutionAttempt,
  type IssueExecutionAttemptRetrySchedule,
} from "@paperclipai/db";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import {
  lockIssueExecutionRunInTransaction,
  transitionIssueExecutionRunStatusInTransaction,
  type IssueExecutionRunEnvelope,
} from "./issue-execution-run-service.js";
import {
  fenceCompanySkillMaterializationReferenceInTransaction,
} from "./company-skill-materialization-lifecycle.js";

type IssueExecutionDbTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

export const ISSUE_EXECUTION_SCHEDULED_RETRY_REASONS = [
  "process_loss",
  "transport_transient",
  "provider_quota",
] as const;

export type IssueExecutionScheduledRetryReason =
  (typeof ISSUE_EXECUTION_SCHEDULED_RETRY_REASONS)[number];

export interface ScheduleIssueExecutionAttemptRetryInput {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly predecessorAttemptId: string;
  readonly reasonCode: IssueExecutionScheduledRetryReason;
  readonly retryAt: Date;
  readonly at: Date;
}

export interface ClaimIssueExecutionAttemptRetryInput {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly scheduleId: string;
  readonly at: Date;
}

export interface IssueExecutionRetryClaimScope {
  readonly transaction: IssueExecutionDbTransaction;
  readonly run: IssueExecutionRunEnvelope;
  readonly predecessor: IssueExecutionAttempt;
  readonly schedule: IssueExecutionAttemptRetrySchedule;
  readonly at: Date;
}

export interface ClaimedIssueExecutionAttemptRetry {
  readonly schedule: IssueExecutionAttemptRetrySchedule;
  readonly successor: IssueExecutionAttempt;
}

export class IssueExecutionAttemptRetryScheduleRejected extends Error {
  readonly code = "issue_execution_attempt_retry_schedule_rejected";

  constructor(message: string) {
    super(message);
    this.name = "IssueExecutionAttemptRetryScheduleRejected";
  }
}

function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) {
    throw new IssueExecutionAttemptRetryScheduleRejected(message);
  }
  return rows[0]!;
}

function exactIdentifier(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new IssueExecutionAttemptRetryScheduleRejected(
      `${label} must be exact and non-empty`,
    );
  }
}

function exactDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new IssueExecutionAttemptRetryScheduleRejected(
      `${label} must be a valid timestamp`,
    );
  }
}

function validateScheduleInput(
  input: ScheduleIssueExecutionAttemptRetryInput,
): void {
  exactIdentifier(input.companyId, "company id");
  exactIdentifier(input.issueId, "issue id");
  exactIdentifier(input.runId, "run id");
  exactIdentifier(input.predecessorAttemptId, "predecessor attempt id");
  exactDate(input.at, "retry creation time");
  exactDate(input.retryAt, "retry due time");
  if (
    !ISSUE_EXECUTION_SCHEDULED_RETRY_REASONS.includes(input.reasonCode) ||
    input.retryAt < input.at
  ) {
    throw new IssueExecutionAttemptRetryScheduleRejected(
      "retry schedule requires a closed reason and a non-past due time",
    );
  }
}

function validateClaimInput(
  input: ClaimIssueExecutionAttemptRetryInput,
): void {
  exactIdentifier(input.companyId, "company id");
  exactIdentifier(input.issueId, "issue id");
  exactIdentifier(input.runId, "run id");
  exactIdentifier(input.scheduleId, "retry schedule id");
  exactDate(input.at, "retry claim time");
}

async function lockRun(
  transaction: IssueExecutionDbTransaction,
  input: { companyId: string; issueId: string; runId: string },
): Promise<IssueExecutionRunEnvelope> {
  return lockIssueExecutionRunInTransaction(transaction, input);
}

async function lockAttempt(
  transaction: IssueExecutionDbTransaction,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    attemptId: string;
  },
): Promise<IssueExecutionAttempt> {
  return exactlyOne(
    await transaction
      .select()
      .from(issueExecutionAttempts)
      .where(
        and(
          eq(issueExecutionAttempts.companyId, input.companyId),
          eq(issueExecutionAttempts.issueId, input.issueId),
          eq(issueExecutionAttempts.runId, input.runId),
          eq(issueExecutionAttempts.id, input.attemptId),
        ),
      )
      .limit(2)
      .for("update"),
    "retry transition requires one exact predecessor attempt",
  );
}

async function assertPromptRemainedUnsent(
  transaction: IssueExecutionDbTransaction,
  attempt: IssueExecutionAttempt,
): Promise<void> {
  if (attempt.promptKind === "base") {
    const owner = exactlyOne(
      await transaction
        .select({
          attemptId: issueExecutionRunRefs.attemptId,
          phase: issueExecutionRunRefs.promptTransmissionPhase,
          settlement: issueExecutionRunRefs.protocolSettlementState,
        })
        .from(issueExecutionRunRefs)
        .where(
          and(
            eq(issueExecutionRunRefs.companyId, attempt.companyId),
            eq(issueExecutionRunRefs.issueId, attempt.issueId),
            eq(issueExecutionRunRefs.runId, attempt.runId),
            eq(issueExecutionRunRefs.refId, attempt.refId!),
            eq(issueExecutionRunRefs.refOrdinal, attempt.refOrdinal!),
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
      throw new IssueExecutionAttemptRetryScheduleRejected(
        "retry predecessor base prompt was transmitted, settled, or rebound",
      );
    }
    return;
  }

  if (attempt.promptKind === "steering") {
    const owner = exactlyOne(
      await transaction
        .select({
          attemptId: issueExecutionPromptSegments.attemptId,
          phase: issueExecutionPromptSegments.promptTransmissionPhase,
          settlement: issueExecutionPromptSegments.protocolSettlementState,
        })
        .from(issueExecutionPromptSegments)
        .where(
          and(
            eq(issueExecutionPromptSegments.companyId, attempt.companyId),
            eq(issueExecutionPromptSegments.issueId, attempt.issueId),
            eq(issueExecutionPromptSegments.runId, attempt.runId),
            eq(issueExecutionPromptSegments.refId, attempt.refId!),
            eq(issueExecutionPromptSegments.refOrdinal, attempt.refOrdinal!),
            eq(
              issueExecutionPromptSegments.segmentOrdinal,
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
      throw new IssueExecutionAttemptRetryScheduleRejected(
        "retry predecessor steering prompt was transmitted, settled, or rebound",
      );
    }
    return;
  }

  throw new IssueExecutionAttemptRetryScheduleRejected(
    "retry predecessor has an unsupported prompt kind",
  );
}

function assertTerminalRetryablePredecessor(input: {
  run: IssueExecutionRunEnvelope;
  predecessor: IssueExecutionAttempt;
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
    throw new IssueExecutionAttemptRetryScheduleRejected(
      "retry creation requires one detached terminal pre-send predecessor on an active run",
    );
  }
}

export async function scheduleIssueExecutionAttemptRetryInTransaction(
  transaction: IssueExecutionDbTransaction,
  input: ScheduleIssueExecutionAttemptRetryInput & { readonly id: string },
): Promise<IssueExecutionAttemptRetrySchedule> {
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
      .insert(issueExecutionAttemptRetrySchedules)
      .values({
        id: input.id,
        companyId: input.companyId,
        issueId: input.issueId,
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
    throw new IssueExecutionAttemptRetryScheduleRejected(
      "retry schedule lost its exact active run transition",
    );
  }
  await transitionIssueExecutionRunStatusInTransaction(transaction, {
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.runId,
    expectedStatus: run.status,
    status: "scheduled_retry",
    at: input.at,
  });
  return schedule;
}

export async function claimIssueExecutionAttemptRetryInTransaction(
  transaction: IssueExecutionDbTransaction,
  input: ClaimIssueExecutionAttemptRetryInput & {
    readonly successorAttemptId: string;
    readonly revalidate: (scope: IssueExecutionRetryClaimScope) => Promise<void>;
  },
): Promise<ClaimedIssueExecutionAttemptRetry> {
  validateClaimInput(input);
  exactIdentifier(input.successorAttemptId, "successor attempt id");
  const run = await lockRun(transaction, input);
  const schedule = exactlyOne(
    await transaction
      .select()
      .from(issueExecutionAttemptRetrySchedules)
      .where(
        and(
          eq(issueExecutionAttemptRetrySchedules.id, input.scheduleId),
          eq(issueExecutionAttemptRetrySchedules.companyId, input.companyId),
          eq(issueExecutionAttemptRetrySchedules.issueId, input.issueId),
          eq(issueExecutionAttemptRetrySchedules.runId, input.runId),
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
    schedule.retryAt > input.at ||
    predecessor.state !== "failed" ||
    predecessor.finishedAt === null
  ) {
    throw new IssueExecutionAttemptRetryScheduleRejected(
      "retry schedule is not an exact due, unclaimed pre-send transition",
    );
  }
  await assertPromptRemainedUnsent(transaction, predecessor);
  const liveAttempts = await transaction
    .select({ id: issueExecutionAttempts.id })
    .from(issueExecutionAttempts)
    .where(
      and(
        eq(issueExecutionAttempts.companyId, input.companyId),
        eq(issueExecutionAttempts.issueId, input.issueId),
        eq(issueExecutionAttempts.runId, input.runId),
        inArray(issueExecutionAttempts.state, ["pending", "leased", "running"]),
      ),
    )
    .limit(1)
    .for("update");
  if (liveAttempts.length !== 0) {
    throw new IssueExecutionAttemptRetryScheduleRejected(
      "retry claim found another live attempt on the run",
    );
  }
  await input.revalidate({ transaction, run, predecessor, schedule, at: input.at });
  await fenceCompanySkillMaterializationReferenceInTransaction(
    transaction,
    {
      companyId: run.companyId,
      agentId: run.targetAgentId,
      adapterConfigRevisionId: run.adapterConfigRevisionId,
    },
  );

  const successor = exactlyOne(
    await transaction
      .insert(issueExecutionAttempts)
      .values({
        id: input.successorAttemptId,
        companyId: predecessor.companyId,
        issueId: predecessor.issueId,
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
      .update(issueExecutionAttemptRetrySchedules)
      .set({
        state: "claimed",
        successorAttemptId: successor.id,
        claimedAt: input.at,
      })
      .where(
        and(
          eq(issueExecutionAttemptRetrySchedules.id, schedule.id),
          eq(issueExecutionAttemptRetrySchedules.state, "scheduled"),
        ),
      )
      .returning(),
    "retry claim lost its exact scheduled row",
  );
  await transitionIssueExecutionRunStatusInTransaction(transaction, {
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.runId,
    expectedStatus: "scheduled_retry",
    status: "queued",
    at: input.at,
  });
  return { schedule: claimed, successor };
}

export function createPostgresIssueExecutionAttemptRetryScheduleService(
  database: Db,
  options: {
    readonly revalidateClaim: (
      scope: IssueExecutionRetryClaimScope,
    ) => Promise<void>;
    readonly idFactory?: () => string;
  },
) {
  const idFactory = options.idFactory ?? randomUUID;
  return {
    schedule(input: ScheduleIssueExecutionAttemptRetryInput) {
      return database.transaction((transaction) =>
        scheduleIssueExecutionAttemptRetryInTransaction(transaction, {
          ...input,
          id: idFactory(),
        }));
    },

    claim(input: ClaimIssueExecutionAttemptRetryInput) {
      return database.transaction((transaction) =>
        claimIssueExecutionAttemptRetryInTransaction(transaction, {
          ...input,
          successorAttemptId: idFactory(),
          revalidate: options.revalidateClaim,
        }));
    },

    async listDue(input: {
      readonly companyId: string;
      readonly at: Date;
      readonly limit: number;
    }): Promise<readonly IssueExecutionAttemptRetrySchedule[]> {
      exactIdentifier(input.companyId, "company id");
      exactDate(input.at, "retry due-list time");
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
        throw new IssueExecutionAttemptRetryScheduleRejected(
          "retry due-list limit must be an integer from 1 through 1000",
        );
      }
      return database
        .select()
        .from(issueExecutionAttemptRetrySchedules)
        .where(
          and(
            eq(issueExecutionAttemptRetrySchedules.companyId, input.companyId),
            eq(issueExecutionAttemptRetrySchedules.state, "scheduled"),
            lte(issueExecutionAttemptRetrySchedules.retryAt, input.at),
          ),
        )
        .orderBy(
          asc(issueExecutionAttemptRetrySchedules.retryAt),
          asc(issueExecutionAttemptRetrySchedules.id),
        )
        .limit(input.limit);
    },
  };
}

export type PostgresIssueExecutionAttemptRetryScheduleService = ReturnType<
  typeof createPostgresIssueExecutionAttemptRetryScheduleService
>;
