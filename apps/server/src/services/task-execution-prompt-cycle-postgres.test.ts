import * as t from "./task-execution-prompt-cycle-postgres.test-support.js";
const { describe, it, resolveBootstrapCycle, expect, promptIdentity } = t;
const { selectTransaction, taskExecutionSessions, taskBoardReopenCommands } = t;
const { nextCorrelationGeneration, taskExecutionAttempts, attemptRow } = t;
const { taskExecutionLeases, leaseRow, taskExecutionRunControls, controlRow } = t;
const { taskExecutionPromptCapabilities, liveCapabilityRow, tasks, vi } = t;
const { runEnvelope, createPostgresTaskExecutionPromptCycleRepository } = t;
const { PostgresTaskExecutionPromptCycleRejected } = t;

import "./task-execution-prompt-cycle-postgres.test-suite-04-awaits-each-canonical-row-lock.js";

describe("bootstrap native-session handoff", () => {
  it.each(["succeeded", "failed"] as const)("resolves a %s bootstrap once", async (outcome) => {
    const { predecessor, correlation, result } = await resolveBootstrapCycle(outcome);
    expect(result).toEqual(
      outcome === "succeeded"
        ? {
            kind: "bootstrap_resume",
            correlation,
            predecessor: {
              runId: correlation!.runId,
              refId: predecessor.id,
              refOrdinal: 0,
            },
          }
        : { kind: "bootstrap_unavailable" },
    );
  });
});

describe("Postgres task-execution prompt-cycle continuity fence", () => {
  it("prepares a generation above the persisted reopen fence without a prior correlation", async () => {
    const identity = promptIdentity();
    const selectedTables: unknown[] = [];
    const lockedTables: unknown[] = [];
    const transaction = selectTransaction(
      new Map<unknown, readonly unknown[]>([
        [taskExecutionSessions, []],
        [taskBoardReopenCommands, [{ generation: 7 }]],
      ]),
      selectedTables,
      lockedTables,
    );

    await expect(
      nextCorrelationGeneration(transaction, {
        identity,
        carryContext: true,
      }),
    ).resolves.toBe(8);
    expect(selectedTables).toEqual([taskExecutionSessions, taskBoardReopenCommands]);
    expect(lockedTables).toEqual([taskExecutionSessions, taskBoardReopenCommands]);
  });

  it("rejects activation when a prepared generation does not clear the latest locked reopen fence", async () => {
    const identity = promptIdentity();
    const selectedTables: unknown[] = [];
    const lockedTables: unknown[] = [];
    const transaction = selectTransaction(
      new Map<unknown, readonly unknown[]>([
        [taskExecutionAttempts, [attemptRow(identity)]],
        [taskExecutionLeases, [leaseRow(identity)]],
        [taskExecutionRunControls, [controlRow(identity)]],
        [taskExecutionPromptCapabilities, [liveCapabilityRow(identity)]],
        [tasks, [{ id: identity.taskId }]],
        [taskBoardReopenCommands, [{ generation: 9 }]],
      ]),
      selectedTables,
      lockedTables,
    ) as t.TaskSessionDbTransaction & {
      insert: ReturnType<typeof t.vi.fn>;
      update: ReturnType<typeof t.vi.fn>;
    };
    transaction.insert = vi.fn(() => {
      throw new Error("stale activation must not insert");
    });
    transaction.update = vi.fn(() => {
      throw new Error("stale activation must not update");
    });
    const database = {
      transaction: vi.fn(async (work: (tx: t.TaskSessionDbTransaction) => unknown) => work(transaction)),
    } as unknown as t.Db;
    const lockRun = vi.fn(async () => runEnvelope(identity));
    const repository = createPostgresTaskExecutionPromptCycleRepository({
      database,
      runService: { lockRun },
      compiler: {
        resolve: vi.fn(() => {
          throw new Error("activation must not compile");
        }),
      },
      capabilityEndpoint: "http://127.0.0.1:3210/",
    });
    const prompt = {
      identity,
      activationCorrelationScope: {
        purpose: "carry",
        companyId: identity.companyId,
        taskId: identity.taskId,
        ownershipEpoch: identity.ownershipEpoch,
        targetAgentId: identity.targetAgentId,
        adapterConfigIdentity: identity.adapterConfigRevisionId,
        workspaceIdentity: identity.executionWorkspaceBindingId,
        targetFingerprint: "b".repeat(64),
        correlationGeneration: 9,
        laneKind: identity.laneKind,
        authorizedContextExposureDigest: "c".repeat(64),
      },
    } as unknown as t.ResolvedTaskExecutionPrompt;

    const activationError = await repository
      .activatePrompt({
        prompt,
        capability: {
          capabilityConnectionId: "00000000-0000-4000-8000-000000000012",
          capabilityGeneration: 1,
        },
        correlation: {
          envelopeVersion: "task-execution-native/v1",
          codecKind: "acp-session/v1",
          ciphertext: "pcnc.v1.fixture",
          digest: "d".repeat(64),
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(activationError).toBeInstanceOf(PostgresTaskExecutionPromptCycleRejected);
    expect(activationError).toHaveProperty(
      "message",
      "prompt activation correlation does not clear the latest board-reopen continuity fence",
    );
    expect(lockRun).toHaveBeenCalledOnce();
    expect(selectedTables.slice(-3)).toEqual([
      taskExecutionPromptCapabilities,
      tasks,
      taskBoardReopenCommands,
    ]);
    expect(lockedTables.slice(-3)).toEqual([taskExecutionPromptCapabilities, tasks, taskBoardReopenCommands]);
    expect(transaction.insert).not.toHaveBeenCalled();
    expect(transaction.update).not.toHaveBeenCalled();
  });
});

describe("Postgres prompt closure lock order", () => {
  it("locks company, task, and Session before the canonical run", async () => {
    const order: string[] = [];
    const stop = new Error("stop after observing run lock");
    let rootLock = 0;
    const transaction = {
      execute: vi.fn(async () => {
        rootLock += 1;
        if (rootLock === 1) {
          order.push("company");
          return [{ id: promptIdentity().companyId }];
        }
        if (rootLock === 2) {
          order.push("task");
          return [{ id: promptIdentity().taskId }];
        }
        order.push("session");
        return [{ projectedEventSeq: 0 }];
      }),
    } as unknown as t.TaskSessionDbTransaction;
    const repository = createPostgresTaskExecutionPromptCycleRepository({
      database: {
        transaction: vi.fn(async (work: (tx: t.TaskSessionDbTransaction) => unknown) => work(transaction)),
      } as unknown as t.Db,
      runService: {
        lockRun: vi.fn(async () => {
          order.push("run");
          throw stop;
        }),
      },
      compiler: { resolve: vi.fn() } as never,
      capabilityEndpoint: "http://127.0.0.1:3210/",
    });

    await expect(
      repository.closePrompt({
        prompt: {
          identity: promptIdentity(),
        } as t.ResolvedTaskExecutionPrompt,
        capability: {} as never,
        outcome: {} as never,
      }),
    ).rejects.toBe(stop);
    expect(order).toEqual(["company", "task", "session", "run"]);
  });
});
