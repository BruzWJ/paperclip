import * as t from "./task-execution-prompt-cycle-postgres.test-support.js";
const { describe, it, resolveBootstrapCycle, expect, promptIdentity } = t;
const { selectTransaction, taskExecutionSessions } = t;
const { nextCorrelationGeneration, taskExecutionAttempts, attemptRow } = t;
const { taskExecutionLeases, leaseRow, taskExecutionRunControls, controlRow } = t;
const { vi } = t;
const { runEnvelope, createPostgresTaskExecutionPromptCycleRepository } = t;

import "./task-execution-prompt-cycle-postgres.test-suite-04-awaits-each-canonical-row-lock.js";

describe("bootstrap native-session handoff", () => {
  it.each(["succeeded", "failed"] as const)("resolves a %s bootstrap once", async (outcome) => {
    const { runId, predecessor, correlation, result } = await resolveBootstrapCycle(outcome);
    expect(result).toEqual(
      outcome === "succeeded"
        ? {
            kind: "bootstrap_resume",
            correlation,
            predecessor: {
              runId,
              refId: predecessor.id,
              refOrdinal: 0,
            },
          }
        : { kind: "bootstrap_unavailable" },
    );
  });
});

describe("Postgres task-execution prompt-cycle generation", () => {
  it("allocates the exact successor of the persisted correlation", async () => {
    const identity = promptIdentity();
    const selectedTables: unknown[] = [];
    const lockedTables: unknown[] = [];
    const transaction = selectTransaction(
      new Map<unknown, readonly unknown[]>([[taskExecutionSessions, [{ generation: 7 }]]]),
      selectedTables,
      lockedTables,
    );

    await expect(
      nextCorrelationGeneration(transaction, { identity }),
    ).resolves.toBe(8);
    expect(selectedTables).toEqual([taskExecutionSessions]);
    expect(lockedTables).toEqual([taskExecutionSessions]);
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
