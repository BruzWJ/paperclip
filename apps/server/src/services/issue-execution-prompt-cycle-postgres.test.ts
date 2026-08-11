import {
  issueBoardReopenCommands,
  issueExecutionAttempts,
  issueExecutionLeases,
  issueExecutionPromptCapabilities,
  issueExecutionRefs,
  issueExecutionRunControls,
  issueExecutionRunRefs,
  issueExecutionSessions,
  issues,
  type Db,
  type IssueExecutionAttempt,
  type IssueExecutionLease,
  type IssueExecutionRunControl,
} from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  IssueExecutionPromptAuthorityLost,
} from "./issue-execution-attempt-executor.js";
import type {
  IssueExecutionPromptIdentity,
  ResolvedIssueExecutionPrompt,
} from "./issue-execution-attempt-executor.js";
import {
  createPostgresIssueExecutionPromptCycleRepository,
  nextCorrelationGeneration,
  PostgresIssueExecutionPromptCycleRejected,
  resolveInitialPromptCycleInTransaction,
} from "./issue-execution-prompt-cycle-postgres.js";
import type { IssueExecutionRunEnvelope } from "./issue-execution-run-service.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";

const timestamp = new Date("2026-07-01T00:00:00.000Z");

function promptIdentity(): IssueExecutionPromptIdentity {
  return {
    companyId: "00000000-0000-4000-8000-000000000001",
    issueId: "00000000-0000-4000-8000-000000000002",
    sessionId: "session-1",
    runId: "00000000-0000-4000-8000-000000000003",
    attemptId: "00000000-0000-4000-8000-000000000004",
    leaseId: "00000000-0000-4000-8000-000000000005",
    leaseGeneration: 1,
    ownershipEpoch: 2,
    executionScopeId: "00000000-0000-4000-8000-000000000006",
    runBatchDigest: "a".repeat(64),
    runKind: "productive",
    promptKind: "base",
    refId: "00000000-0000-4000-8000-000000000007",
    refOrdinal: 0,
    segmentOrdinal: 0,
    attemptGeneration: 1,
    targetAgentId: "00000000-0000-4000-8000-000000000008",
    laneKind: "owner",
    issueExecutionAuthorityId:
      "00000000-0000-4000-8000-000000000009",
    consultExecutionId: null,
    adapterConfigRevisionId:
      "00000000-0000-4000-8000-000000000010",
    executionWorkspaceBindingId:
      "00000000-0000-4000-8000-000000000011",
  };
}

function selectTransaction(
  rowsByTable: ReadonlyMap<unknown, readonly unknown[]>,
  selectedTables: unknown[] = [],
  lockedTables: unknown[] = [],
  clockTimestamps: readonly Date[] = [timestamp],
): IssueSessionDbTransaction {
  let clockRead = 0;
  return {
    async execute() {
      const value =
        clockTimestamps[Math.min(clockRead, clockTimestamps.length - 1)];
      clockRead += 1;
      return [{ timestampMs: value.getTime() }];
    },
    select() {
      let table: unknown;
      const builder = {
        from(value: unknown) {
          table = value;
          selectedTables.push(value);
          return builder;
        },
        where() {
          return builder;
        },
        innerJoin() {
          return builder;
        },
        leftJoin() {
          return builder;
        },
        orderBy() {
          return builder;
        },
        limit() {
          return builder;
        },
        for() {
          lockedTables.push(table);
          return Promise.resolve(rowsByTable.get(table) ?? []);
        },
      };
      return builder;
    },
  } as unknown as IssueSessionDbTransaction;
}

function executionRef(
  overrides: Record<string, unknown> = {},
): typeof issueExecutionRefs.$inferSelect {
  const identity = promptIdentity();
  return {
    id: "00000000-0000-4000-8000-000000000013",
    companyId: identity.companyId, issueId: identity.issueId,
    sessionId: identity.sessionId, ownershipEpoch: identity.ownershipEpoch,
    previousOwnershipEpoch: null,
    executionScopeId: identity.executionScopeId,
    executionLineageId: "00000000-0000-4000-8000-000000000014",
    mode: identity.laneKind, sourceKind: "issue_request",
    sourceRecordId: identity.issueId, messageKind: "user",
    targetAgentId: identity.targetAgentId, laneOrdinal: 1,
    issueExecutionAuthorityId: identity.issueExecutionAuthorityId,
    consultExecutionId: identity.consultExecutionId,
    adapterConfigRevisionId: identity.adapterConfigRevisionId,
    contextEpoch: 0, counterpartIssueId: null,
    counterpartAuthorityId: null, counterpartOwnershipEpoch: null,
    consultCallerRefId: null, consultChainToken: null,
    disposition: "active",
    ...overrides,
  } as unknown as typeof issueExecutionRefs.$inferSelect;
}

async function resolveBootstrapCycle(outcome: "succeeded" | "failed") {
  const predecessor = executionRef({
    id: "00000000-0000-4000-8000-000000000015",
    ownershipEpoch: 1, messageKind: "synthetic", laneOrdinal: 0,
    disposition: "terminal",
  });
  const current = executionRef({ ownershipEpoch: 1 });
  const runId = "00000000-0000-4000-8000-000000000016";
  const correlation = outcome === "succeeded"
    ? {
        purpose: "active_run_steering", state: "current", laneKind: null,
        runId, currentRefId: predecessor.id, currentRefOrdinal: 0,
        currentSegmentOrdinal: 0, authorizedContextExposureDigest: null,
      }
    : null;
  const transaction = selectTransaction(new Map<unknown, readonly unknown[]>([
    [issueExecutionRefs, [predecessor, current]],
    [issueExecutionRunRefs, [{
      runId, refOrdinal: 0, outcome,
      protocolSettlementState: outcome === "succeeded" ? "settled" : "incomplete",
      correlation,
    }]],
  ]));
  return {
    predecessor,
    correlation,
    result: await resolveInitialPromptCycleInTransaction(transaction, {
      currentRef: current,
      executionWorkspaceBindingId: promptIdentity().executionWorkspaceBindingId,
    }),
  };
}

describe("bootstrap native-session handoff", () => {
  it.each(["succeeded", "failed"] as const)("resolves a %s bootstrap once", async (outcome) => {
    const { predecessor, correlation, result } = await resolveBootstrapCycle(outcome);
    expect(result).toEqual(outcome === "succeeded"
      ? {
          kind: "bootstrap_resume", correlation,
          predecessor: {
            runId: correlation!.runId, refId: predecessor.id, refOrdinal: 0,
          },
        }
      : { kind: "bootstrap_unavailable" });
  });
});

interface CapturedUpdate {
  readonly table: unknown;
  values?: unknown;
  where?: unknown;
}

function deferredRows() {
  let resolve!: (rows: readonly unknown[]) => void;
  const promise = new Promise<readonly unknown[]>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renewalTransaction(input: {
  rowsByTable: ReadonlyMap<unknown, readonly unknown[]>;
  returningByTable?: ReadonlyMap<unknown, readonly unknown[]>;
  clockTimestamps?: readonly Date[];
}) {
  const selectedTables: unknown[] = [];
  const lockedTables: unknown[] = [];
  const updates: CapturedUpdate[] = [];
  const transaction = selectTransaction(
    input.rowsByTable,
    selectedTables,
    lockedTables,
    input.clockTimestamps,
  );
  const update = vi.fn((table: unknown) => {
    const update: CapturedUpdate = { table };
    updates.push(update);
    const builder = {
      set(values: unknown) {
        update.values = values;
        return builder;
      },
      where(where: unknown) {
        update.where = where;
        return builder;
      },
      returning() {
        return Promise.resolve(input.returningByTable?.get(table) ?? []);
      },
    };
    return builder;
  });
  const completedTransaction = Object.assign(transaction, { update }) as
    unknown as IssueSessionDbTransaction;
  return {
    transaction: completedTransaction,
    selectedTables,
    lockedTables,
    updates,
  };
}

function runEnvelope(
  identity: IssueExecutionPromptIdentity,
): IssueExecutionRunEnvelope {
  return {
    companyId: identity.companyId,
    issueId: identity.issueId,
    runId: identity.runId,
    sessionId: identity.sessionId,
    executionScopeId: identity.executionScopeId,
    kind: identity.runKind,
    status: "running",
    ownershipEpoch: identity.ownershipEpoch,
    targetAgentId: identity.targetAgentId,
    adapterConfigRevisionId: identity.adapterConfigRevisionId,
    executionWorkspaceBindingId: identity.executionWorkspaceBindingId,
    executionMode: identity.laneKind,
    issueExecutionAuthorityId: identity.issueExecutionAuthorityId,
    consultExecutionId: identity.consultExecutionId,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: identity.attemptId,
    currentLeaseId: identity.leaseId,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: timestamp,
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function attemptRow(
  identity: IssueExecutionPromptIdentity,
): IssueExecutionAttempt {
  return {
    id: identity.attemptId,
    companyId: identity.companyId,
    issueId: identity.issueId,
    sessionId: identity.sessionId,
    runId: identity.runId,
    runKind: identity.runKind,
    promptKind: identity.promptKind,
    sessionOperation: "new",
    refId: identity.refId,
    refOrdinal: identity.refOrdinal,
    segmentOrdinal: identity.segmentOrdinal,
    steeringSegmentOrdinal: null,
    attemptGeneration: identity.attemptGeneration,
    state: "running",
    startedAt: timestamp,
    finishedAt: null,
    createdAt: timestamp,
  };
}

function leaseRow(identity: IssueExecutionPromptIdentity): IssueExecutionLease {
  return {
    id: identity.leaseId,
    companyId: identity.companyId,
    issueId: identity.issueId,
    runId: identity.runId,
    attemptId: identity.attemptId,
    leaseGeneration: identity.leaseGeneration,
    workerId: "worker-1",
    state: "active",
    acquiredAt: timestamp,
    renewedAt: null,
    expiresAt: new Date("2026-07-01T00:01:00.000Z"),
    releasedAt: null,
    createdAt: timestamp,
  };
}

function controlRow(
  identity: IssueExecutionPromptIdentity,
): IssueExecutionRunControl {
  return {
    runId: identity.runId,
    currentRefId: identity.refId,
    currentOrdinal: identity.refOrdinal,
    currentSegmentOrdinal: identity.segmentOrdinal,
  };
}

function liveCapabilityRow(
  identity: IssueExecutionPromptIdentity,
  expiresAt = new Date("2026-07-01T00:00:30.000Z"),
) {
  return {
    companyId: identity.companyId,
    issueId: identity.issueId,
    runId: identity.runId,
    runBatchDigest: identity.runBatchDigest,
    refId: identity.refId,
    refOrdinal: identity.refOrdinal,
    segmentOrdinal: identity.segmentOrdinal,
    attemptId: identity.attemptId,
    leaseId: identity.leaseId,
    leaseGeneration: identity.leaseGeneration,
    capabilityConnectionId: "00000000-0000-4000-8000-000000000012",
    capabilityGeneration: 1,
    state: "active",
    expiresAt,
  } as const;
}

function renewalRepository(input: {
  identity: IssueExecutionPromptIdentity;
  lease?: IssueExecutionLease;
  capability?: ReturnType<typeof liveCapabilityRow>;
  leaseReturning?: readonly unknown[];
  capabilityReturning?: readonly unknown[];
  clockTimestamps?: readonly Date[];
}) {
  const lease = input.lease ?? leaseRow(input.identity);
  const capability = input.capability ?? liveCapabilityRow(input.identity);
  const runtime = renewalTransaction({
    rowsByTable: new Map<unknown, readonly unknown[]>([
      [issueExecutionAttempts, [attemptRow(input.identity)]],
      [issueExecutionLeases, [lease]],
      [issueExecutionRunControls, [controlRow(input.identity)]],
      [issueExecutionPromptCapabilities, [capability]],
    ]),
    returningByTable: new Map<unknown, readonly unknown[]>([
      [
        issueExecutionLeases,
        input.leaseReturning ?? [{ id: input.identity.leaseId }],
      ],
      [
        issueExecutionPromptCapabilities,
        input.capabilityReturning ?? [{
          capabilityConnectionId: capability.capabilityConnectionId,
        }],
      ],
    ]),
    clockTimestamps: input.clockTimestamps,
  });
  const database = {
    transaction: vi.fn(
      async (work: (tx: IssueSessionDbTransaction) => unknown) =>
        work(runtime.transaction),
    ),
  } as unknown as Db;
  return {
    ...runtime,
    capability,
    repository: createPostgresIssueExecutionPromptCycleRepository({
      database,
      runService: {
        lockRun: vi.fn(async () => runEnvelope(input.identity)),
      },
      compiler: {
        resolve: vi.fn(() => {
          throw new Error("authority renewal must not compile an interface");
        }),
      },
      capabilityEndpoint: "http://127.0.0.1:3210/",
      leaseTtlMs: 120_000,
      capabilityTtlMs: 30_000,
    }),
  };
}

describe("Postgres issue-execution prompt-cycle continuity fence", () => {
  it("prepares a generation above the persisted reopen fence without a prior correlation", async () => {
    const identity = promptIdentity();
    const selectedTables: unknown[] = [];
    const lockedTables: unknown[] = [];
    const transaction = selectTransaction(
      new Map<unknown, readonly unknown[]>([
        [issueExecutionSessions, []],
        [issueBoardReopenCommands, [{ generation: 7 }]],
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
    expect(selectedTables).toEqual([
      issueExecutionSessions,
      issueBoardReopenCommands,
    ]);
    expect(lockedTables).toEqual([
      issueExecutionSessions,
      issueBoardReopenCommands,
    ]);
  });

  it("rejects activation when a prepared generation does not clear the latest locked reopen fence", async () => {
    const identity = promptIdentity();
    const selectedTables: unknown[] = [];
    const lockedTables: unknown[] = [];
    const transaction = selectTransaction(
      new Map<unknown, readonly unknown[]>([
        [issueExecutionAttempts, [attemptRow(identity)]],
        [issueExecutionLeases, [leaseRow(identity)]],
        [issueExecutionRunControls, [controlRow(identity)]],
        [issueExecutionPromptCapabilities, [liveCapabilityRow(identity)]],
        [issues, [{ id: identity.issueId }]],
        [issueBoardReopenCommands, [{ generation: 9 }]],
      ]),
      selectedTables,
      lockedTables,
    ) as IssueSessionDbTransaction & {
      insert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    transaction.insert = vi.fn(() => {
      throw new Error("stale activation must not insert");
    });
    transaction.update = vi.fn(() => {
      throw new Error("stale activation must not update");
    });
    const database = {
      transaction: vi.fn(async (work: (tx: IssueSessionDbTransaction) => unknown) =>
        work(transaction)),
    } as unknown as Db;
    const lockRun = vi.fn(async () => runEnvelope(identity));
    const repository = createPostgresIssueExecutionPromptCycleRepository({
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
        issueId: identity.issueId,
        ownershipEpoch: identity.ownershipEpoch,
        targetAgentId: identity.targetAgentId,
        adapterConfigIdentity: identity.adapterConfigRevisionId,
        workspaceIdentity: identity.executionWorkspaceBindingId,
        targetFingerprint: "b".repeat(64),
        correlationGeneration: 9,
        laneKind: identity.laneKind,
        authorizedContextExposureDigest: "c".repeat(64),
      },
    } as unknown as ResolvedIssueExecutionPrompt;

    const activationError = await repository
      .activatePrompt({
        prompt,
        capability: {
          capabilityConnectionId:
            "00000000-0000-4000-8000-000000000012",
          capabilityGeneration: 1,
        },
        correlation: {
          envelopeVersion: "issue-execution-native/v1",
          codecKind: "acp-session/v1",
          ciphertext: "pcnc.v1.fixture",
          digest: "d".repeat(64),
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(activationError).toBeInstanceOf(
      PostgresIssueExecutionPromptCycleRejected,
    );
    expect(activationError).toHaveProperty(
      "message",
      "prompt activation correlation does not clear the latest board-reopen continuity fence",
    );
    expect(lockRun).toHaveBeenCalledOnce();
    expect(selectedTables.slice(-3)).toEqual([
      issueExecutionPromptCapabilities,
      issues,
      issueBoardReopenCommands,
    ]);
    expect(lockedTables.slice(-3)).toEqual([
      issueExecutionPromptCapabilities,
      issues,
      issueBoardReopenCommands,
    ]);
    expect(transaction.insert).not.toHaveBeenCalled();
    expect(transaction.update).not.toHaveBeenCalled();
  });
});

describe("Postgres prompt closure lock order", () => {
  it("locks company, issue, and Session before the canonical run", async () => {
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
          order.push("issue");
          return [{ id: promptIdentity().issueId }];
        }
        order.push("session");
        return [{ projectedEventSeq: 0 }];
      }),
    } as unknown as IssueSessionDbTransaction;
    const repository = createPostgresIssueExecutionPromptCycleRepository({
      database: {
        transaction: vi.fn(
          async (work: (tx: IssueSessionDbTransaction) => unknown) =>
            work(transaction),
        ),
      } as unknown as Db,
      runService: {
        lockRun: vi.fn(async () => {
          order.push("run");
          throw stop;
        }),
      },
      compiler: { resolve: vi.fn() } as never,
      capabilityEndpoint: "http://127.0.0.1:3210/",
    });

    await expect(repository.closePrompt({
      prompt: { identity: promptIdentity() } as ResolvedIssueExecutionPrompt,
      capability: {} as never,
      outcome: {} as never,
    })).rejects.toBe(stop);
    expect(order).toEqual(["company", "issue", "session", "run"]);
  });
});

describe("Postgres issue-execution prompt authority renewal", () => {
  it("awaits each canonical row lock before requesting the next lock", async () => {
    const identity = promptIdentity();
    const lockOrder: unknown[] = [];
    const gates = new Map<unknown, ReturnType<typeof deferredRows>>([
      [issueExecutionRunControls, deferredRows()],
      [issueExecutionAttempts, deferredRows()],
      [issueExecutionLeases, deferredRows()],
      [issueExecutionPromptCapabilities, deferredRows()],
    ]);
    const transaction = {
      async execute() {
        return [{ timestampMs: timestamp.getTime() }];
      },
      select() {
        let table: unknown;
        const builder = {
          from(value: unknown) {
            table = value;
            return builder;
          },
          where() {
            return builder;
          },
          limit() {
            return builder;
          },
          for() {
            lockOrder.push(table);
            return gates.get(table)!.promise;
          },
        };
        return builder;
      },
      update(table: unknown) {
        const builder = {
          set() {
            return builder;
          },
          where() {
            return builder;
          },
          returning() {
            return Promise.resolve(
              table === issueExecutionLeases
                ? [{ id: identity.leaseId }]
                : [{ capabilityConnectionId: liveCapabilityRow(identity).capabilityConnectionId }],
            );
          },
        };
        return builder;
      },
    } as unknown as IssueSessionDbTransaction;
    const repository = createPostgresIssueExecutionPromptCycleRepository({
      database: {
        transaction: vi.fn(
          async (work: (tx: IssueSessionDbTransaction) => unknown) =>
            work(transaction),
        ),
      } as unknown as Db,
      runService: {
        lockRun: vi.fn(async () => {
          lockOrder.push("run");
          return runEnvelope(identity);
        }),
      },
      compiler: {
        resolve: vi.fn(() => {
          throw new Error("authority renewal must not compile");
        }),
      },
      capabilityEndpoint: "http://127.0.0.1:3210/",
      leaseTtlMs: 120_000,
      capabilityTtlMs: 30_000,
    });

    const renewal = repository.renewPromptAuthority({
      identity,
    } as ResolvedIssueExecutionPrompt);
    await vi.waitFor(() => expect(lockOrder).toEqual([
      "run",
      issueExecutionRunControls,
    ]));
    gates.get(issueExecutionRunControls)!.resolve([controlRow(identity)]);
    await vi.waitFor(() => expect(lockOrder).toEqual([
      "run",
      issueExecutionRunControls,
      issueExecutionAttempts,
    ]));
    gates.get(issueExecutionAttempts)!.resolve([attemptRow(identity)]);
    await vi.waitFor(() => expect(lockOrder).toEqual([
      "run",
      issueExecutionRunControls,
      issueExecutionAttempts,
      issueExecutionLeases,
    ]));
    gates.get(issueExecutionLeases)!.resolve([leaseRow(identity)]);
    await vi.waitFor(() => expect(lockOrder).toEqual([
      "run",
      issueExecutionRunControls,
      issueExecutionAttempts,
      issueExecutionLeases,
      issueExecutionPromptCapabilities,
    ]));
    gates.get(issueExecutionPromptCapabilities)!.resolve([
      liveCapabilityRow(identity),
    ]);

    await expect(renewal).resolves.toBeUndefined();
  });

  it("renews the exact active lease by CAS and fences capability expiry to the shorter TTL", async () => {
    const identity = promptIdentity();
    const runtime = renewalRepository({ identity });

    await expect(
      runtime.repository.renewPromptAuthority({
        identity,
      } as ResolvedIssueExecutionPrompt),
    ).resolves.toBeUndefined();

    expect(runtime.selectedTables).toEqual([
      issueExecutionRunControls,
      issueExecutionAttempts,
      issueExecutionLeases,
      issueExecutionPromptCapabilities,
    ]);
    expect(runtime.lockedTables).toEqual(runtime.selectedTables);
    expect(runtime.updates).toHaveLength(2);
    expect(runtime.updates[0]).toMatchObject({
      table: issueExecutionLeases,
      values: {
        renewedAt: timestamp,
        expiresAt: new Date("2026-07-01T00:02:00.000Z"),
      },
    });
    expect(runtime.updates[0]!.where).toBeDefined();
    expect(runtime.updates[1]).toMatchObject({
      table: issueExecutionPromptCapabilities,
      values: {
        expiresAt: new Date("2026-07-01T00:00:30.000Z"),
      },
    });
    expect(runtime.updates[1]!.where).toBeDefined();
    const dialect = new PgDialect();
    for (const update of runtime.updates) {
      const params = dialect.sqlToQuery(update.where as never).params;
      expect(params.some((param) => param instanceof Date)).toBe(false);
      expect(params).toContain(timestamp.toISOString());
    }
  });

  it("fails closed when the exact lease CAS loses its active unexpired generation", async () => {
    const identity = promptIdentity();
    const runtime = renewalRepository({
      identity,
      leaseReturning: [],
    });

    const renewal = runtime.repository.renewPromptAuthority({
      identity,
    } as ResolvedIssueExecutionPrompt);
    await expect(renewal).rejects.toBeInstanceOf(
      IssueExecutionPromptAuthorityLost,
    );
    await expect(renewal).rejects.toMatchObject({
      code: "issue_execution_prompt_authority_lost",
      lease: {
        companyId: identity.companyId,
        issueId: identity.issueId,
        runId: identity.runId,
        attemptId: identity.attemptId,
        leaseId: identity.leaseId,
        leaseGeneration: identity.leaseGeneration,
      },
      cause: expect.any(PostgresIssueExecutionPromptCycleRejected),
    });
    expect(runtime.updates).toHaveLength(1);
    expect(runtime.updates[0]!.table).toBe(issueExecutionLeases);
  });

  it("fails closed when the exact capability CAS loses its live generation", async () => {
    const identity = promptIdentity();
    const runtime = renewalRepository({
      identity,
      capabilityReturning: [],
    });

    await expect(
      runtime.repository.renewPromptAuthority({
        identity,
      } as ResolvedIssueExecutionPrompt),
    ).rejects.toThrow(
      "prompt capability renewal lost its compare-and-set fence",
    );
    expect(runtime.updates.map(({ table }) => table)).toEqual([
      issueExecutionLeases,
      issueExecutionPromptCapabilities,
    ]);
  });

  it("never revives a capability whose persisted expiry has already elapsed", async () => {
    const identity = promptIdentity();
    const runtime = renewalRepository({
      identity,
      capability: liveCapabilityRow(identity, timestamp),
    });

    await expect(
      runtime.repository.renewPromptAuthority({
        identity,
      } as ResolvedIssueExecutionPrompt),
    ).rejects.toThrow(
      "prompt authority renewal cannot revive an expired capability",
    );
    expect(runtime.updates).toEqual([]);
  });

  it("uses a fresh database instant after capability-lock contention", async () => {
    const identity = promptIdentity();
    const expiredAfterWait = new Date("2026-07-01T00:00:00.050Z");
    const runtime = renewalRepository({
      identity,
      capability: liveCapabilityRow(identity, expiredAfterWait),
      clockTimestamps: [
        timestamp,
        new Date("2026-07-01T00:00:00.100Z"),
      ],
    });

    await expect(
      runtime.repository.renewPromptAuthority({
        identity,
      } as ResolvedIssueExecutionPrompt),
    ).rejects.toThrow(
      "prompt authority renewal cannot revive an expired capability",
    );
    expect(runtime.updates).toEqual([]);
  });

  it("never revives an expired lease before looking up or extending capability authority", async () => {
    const identity = promptIdentity();
    const runtime = renewalRepository({
      identity,
      lease: {
        ...leaseRow(identity),
        expiresAt: timestamp,
      },
    });

    await expect(
      runtime.repository.renewPromptAuthority({
        identity,
      } as ResolvedIssueExecutionPrompt),
    ).rejects.toThrow(
      "prompt crossed its canonical run, attempt, lease, or control",
    );
    expect(runtime.selectedTables).not.toContain(
      issueExecutionPromptCapabilities,
    );
    expect(runtime.updates).toEqual([]);
  });
});
