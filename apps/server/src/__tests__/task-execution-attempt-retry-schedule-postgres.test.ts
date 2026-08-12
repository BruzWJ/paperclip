import { describe, expect, it, vi } from "vitest";
import {
  agentAdapterConfigRevisions,
  taskExecutionAttempts,
  taskExecutionAttemptRetrySchedules,
  taskExecutionPromptSegments,
  taskExecutionRunRefs,
  taskExecutionRuns,
  type TaskExecutionAttempt,
  type TaskExecutionAttemptRetrySchedule,
  type TaskExecutionRun,
} from "@paperclipai/db";
import {
  claimTaskExecutionAttemptRetryInTransaction,
  scheduleTaskExecutionAttemptRetryInTransaction,
} from "../services/task-execution-attempt-retry-schedule-postgres.js";

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const finishedAt = new Date("2026-01-01T00:00:01.000Z");
const scheduledAt = new Date("2026-01-01T00:00:02.000Z");
const retryAt = new Date("2026-01-01T00:01:00.000Z");

function runRow(
  overrides: Partial<TaskExecutionRun> = {},
): TaskExecutionRun {
  return {
    id: "run-1",
    companyId: "company-1",
    taskId: "task-1",
    sessionId: "session-1",
    executionScopeId: "scope-1",
    kind: "productive",
    status: "running",
    ownershipEpoch: 1,
    targetAgentId: "agent-1",
    adapterConfigRevisionId: "revision-1",
    executionWorkspaceBindingId: "workspace-1",
    executionMode: "owner",
    taskExecutionAuthorityId: "authority-1",
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: null,
    currentLeaseId: null,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: createdAt,
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    createdAt,
    updatedAt: finishedAt,
    ...overrides,
  };
}

function attemptRow(
  overrides: Partial<TaskExecutionAttempt> = {},
): TaskExecutionAttempt {
  return {
    id: "attempt-1",
    companyId: "company-1",
    taskId: "task-1",
    sessionId: "session-1",
    runId: "run-1",
    runKind: "productive",
    promptKind: "base",
    sessionOperation: "resume",
    refId: "ref-1",
    refOrdinal: 0,
    segmentOrdinal: 0,
    attemptGeneration: 3,
    state: "failed",
    startedAt: createdAt,
    finishedAt,
    createdAt,
    ...overrides,
  };
}

function scheduleRow(
  overrides: Partial<TaskExecutionAttemptRetrySchedule> = {},
): TaskExecutionAttemptRetrySchedule {
  return {
    id: "schedule-1",
    companyId: "company-1",
    taskId: "task-1",
    runId: "run-1",
    predecessorAttemptId: "attempt-1",
    reasonCode: "transport_transient",
    retryAt,
    state: "scheduled",
    successorAttemptId: null,
    claimedAt: null,
    cancelledAt: null,
    createdAt: scheduledAt,
    ...overrides,
  };
}

function createTransaction(input: {
  run: TaskExecutionRun;
  predecessor: TaskExecutionAttempt;
  schedule?: TaskExecutionAttemptRetrySchedule | null;
  promptPhase?: "not_transmitted" | "transmitted";
}) {
  const state = {
    run: input.run,
    attempts: [input.predecessor],
    schedule: input.schedule ?? null,
    promptOwner: {
      attemptId: input.predecessor.id,
      phase: input.promptPhase ?? "not_transmitted",
      settlement: null,
    },
    inserts: [] as unknown[],
    updates: [] as unknown[],
  };

  const transaction = {
    select(selection?: Record<string, unknown>) {
      let table: unknown;
      const builder = {
        from(value: unknown) {
          table = value;
          return builder;
        },
        where() {
          return builder;
        },
        orderBy() {
          return builder;
        },
        limit() {
          if (table === agentAdapterConfigRevisions) {
            return Promise.resolve([{
              id: "revision-1",
              companyId: "company-1",
              agentId: "agent-1",
              acpConfiguration: {
                contractVersion: "acpx-runtime/v1",
                launchProfile: {
                  registryName: "fixture-agent",
                },
                sessionConfigSelections: [
                  { configId: "model", value: "fixture/model" },
                ],
                model: {
                  value: "fixture/model",
                  label: "Fixture model",
                },
              },
            }]);
          }
          return builder;
        },
        async for() {
          if (table === taskExecutionRuns) return [state.run];
          if (table === taskExecutionAttemptRetrySchedules) {
            return state.schedule ? [state.schedule] : [];
          }
          if (table === taskExecutionAttempts) {
            if (selection) {
              return state.attempts
                .filter((attempt) =>
                  ["pending", "leased", "running"].includes(attempt.state))
                .map((attempt) => ({ id: attempt.id }));
            }
            return [state.attempts[0]!];
          }
          if (
            table === taskExecutionRunRefs ||
            table === taskExecutionPromptSegments
          ) {
            return [state.promptOwner];
          }
          throw new Error("unexpected fake select table");
        },
      };
      return builder;
    },
    insert(table: unknown) {
      let values: Record<string, unknown>;
      return {
        values(inputValues: Record<string, unknown>) {
          values = inputValues;
          return {
            async returning() {
              state.inserts.push({ table, values });
              if (table === taskExecutionAttemptRetrySchedules) {
                state.schedule = values as unknown as TaskExecutionAttemptRetrySchedule;
                return [state.schedule];
              }
              if (table === taskExecutionAttempts) {
                const successor = values as unknown as TaskExecutionAttempt;
                state.attempts.push(successor);
                return [successor];
              }
              throw new Error("unexpected fake insert table");
            },
          };
        },
      };
    },
    update(table: unknown) {
      let values: Record<string, unknown>;
      const builder = {
        set(inputValues: Record<string, unknown>) {
          values = inputValues;
          return builder;
        },
        where() {
          return builder;
        },
        async returning() {
          state.updates.push({ table, values });
          if (table === taskExecutionRuns) {
            state.run = { ...state.run, ...values } as TaskExecutionRun;
            return [state.run];
          }
          if (table === taskExecutionAttemptRetrySchedules && state.schedule) {
            state.schedule = {
              ...state.schedule,
              ...values,
            } as TaskExecutionAttemptRetrySchedule;
            return [state.schedule];
          }
          return [];
        },
      };
      return builder;
    },
  };

  return {
    transaction: transaction as unknown as Parameters<
      typeof scheduleTaskExecutionAttemptRetryInTransaction
    >[0],
    state,
  };
}

describe("canonical PostgreSQL attempt retry schedules", () => {
  it("schedules only one detached terminal pre-send predecessor", async () => {
    const harness = createTransaction({
      run: runRow(),
      predecessor: attemptRow(),
    });

    const schedule = await scheduleTaskExecutionAttemptRetryInTransaction(
      harness.transaction,
      {
        id: "schedule-1",
        companyId: "company-1",
        taskId: "task-1",
        runId: "run-1",
        predecessorAttemptId: "attempt-1",
        reasonCode: "transport_transient",
        retryAt,
        at: scheduledAt,
      },
    );

    expect(schedule).toMatchObject({
      id: "schedule-1",
      state: "scheduled",
      successorAttemptId: null,
    });
    expect(harness.state.run.status).toBe("scheduled_retry");
    expect(harness.state.inserts).toHaveLength(1);
  });

  it("rejects a transmitted predecessor before creating a schedule", async () => {
    const harness = createTransaction({
      run: runRow(),
      predecessor: attemptRow(),
      promptPhase: "transmitted",
    });

    await expect(
      scheduleTaskExecutionAttemptRetryInTransaction(harness.transaction, {
        id: "schedule-1",
        companyId: "company-1",
        taskId: "task-1",
        runId: "run-1",
        predecessorAttemptId: "attempt-1",
        reasonCode: "transport_transient",
        retryAt,
        at: scheduledAt,
      }),
    ).rejects.toThrow("base prompt was transmitted, settled, or rebound");
    expect(harness.state.inserts).toEqual([]);
    expect(harness.state.run.status).toBe("running");
  });

  it("claims a due schedule into generation plus one after mandatory revalidation", async () => {
    const predecessor = attemptRow();
    const harness = createTransaction({
      run: runRow({ status: "scheduled_retry" }),
      predecessor,
      schedule: scheduleRow(),
    });
    const revalidate = vi.fn(async () => {});

    const claimed = await claimTaskExecutionAttemptRetryInTransaction(
      harness.transaction,
      {
        companyId: "company-1",
        taskId: "task-1",
        runId: "run-1",
        scheduleId: "schedule-1",
        successorAttemptId: "attempt-2",
        at: retryAt,
        revalidate,
      },
    );

    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(claimed.successor).toMatchObject({
      id: "attempt-2",
      attemptGeneration: 4,
      sessionOperation: predecessor.sessionOperation,
      promptKind: predecessor.promptKind,
      state: "pending",
    });
    expect(claimed.schedule).toMatchObject({
      state: "claimed",
      successorAttemptId: "attempt-2",
      claimedAt: retryAt,
    });
    expect(harness.state.run.status).toBe("queued");
    expect(harness.state.run.startedAt).toEqual(createdAt);
  });

  it("fails closed before revalidation when a schedule is not due", async () => {
    const harness = createTransaction({
      run: runRow({ status: "scheduled_retry" }),
      predecessor: attemptRow(),
      schedule: scheduleRow(),
    });
    const revalidate = vi.fn(async () => {});

    await expect(
      claimTaskExecutionAttemptRetryInTransaction(harness.transaction, {
        companyId: "company-1",
        taskId: "task-1",
        runId: "run-1",
        scheduleId: "schedule-1",
        successorAttemptId: "attempt-2",
        at: scheduledAt,
        revalidate,
      }),
    ).rejects.toThrow("not an exact due, unclaimed pre-send transition");
    expect(revalidate).not.toHaveBeenCalled();
    expect(harness.state.inserts).toEqual([]);
  });
});
