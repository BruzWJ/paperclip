import * as t from "./task-execution-prompt-cycle-postgres.test-support.js";
const { describe, it, promptIdentity, taskExecutionRunControls, deferredRows } = t;
const { taskExecutionAttempts, taskExecutionLeases } = t;
const { taskExecutionPromptCapabilities, timestamp, liveCapabilityRow } = t;
const { createPostgresTaskExecutionPromptCycleRepository, vi, runEnvelope, expect } = t;
const { controlRow, attemptRow, leaseRow, renewalRepository, PgDialect } = t;
const { TaskExecutionPromptAuthorityLost } = t;
const { PostgresTaskExecutionPromptCycleRejected } = t;

describe("Postgres task-execution prompt authority renewal", () => {
  it("awaits each canonical row lock before requesting the next lock", async () => {
    const identity = promptIdentity();
    const lockOrder: unknown[] = [];
    const gates = new Map<unknown, t.DeferredRows>([
      [taskExecutionRunControls, deferredRows()],
      [taskExecutionAttempts, deferredRows()],
      [taskExecutionLeases, deferredRows()],
      [taskExecutionPromptCapabilities, deferredRows()],
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
              table === taskExecutionLeases
                ? [{ id: identity.leaseId }]
                : [
                    {
                      capabilityConnectionId: liveCapabilityRow(identity).capabilityConnectionId,
                    },
                  ],
            );
          },
        };
        return builder;
      },
    } as unknown as t.TaskSessionDbTransaction;
    const repository = createPostgresTaskExecutionPromptCycleRepository({
      database: {
        transaction: vi.fn(async (work: (tx: t.TaskSessionDbTransaction) => unknown) => work(transaction)),
      } as unknown as t.Db,
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
    } as t.ResolvedTaskExecutionPrompt);
    await vi.waitFor(() => expect(lockOrder).toEqual(["run", taskExecutionRunControls]));
    gates.get(taskExecutionRunControls)!.resolve([controlRow(identity)]);
    await vi.waitFor(() =>
      expect(lockOrder).toEqual(["run", taskExecutionRunControls, taskExecutionAttempts]),
    );
    gates.get(taskExecutionAttempts)!.resolve([attemptRow(identity)]);
    await vi.waitFor(() =>
      expect(lockOrder).toEqual([
        "run",
        taskExecutionRunControls,
        taskExecutionAttempts,
        taskExecutionLeases,
      ]),
    );
    gates.get(taskExecutionLeases)!.resolve([leaseRow(identity)]);
    await vi.waitFor(() =>
      expect(lockOrder).toEqual([
        "run",
        taskExecutionRunControls,
        taskExecutionAttempts,
        taskExecutionLeases,
        taskExecutionPromptCapabilities,
      ]),
    );
    gates.get(taskExecutionPromptCapabilities)!.resolve([liveCapabilityRow(identity)]);

    await expect(renewal).resolves.toBeUndefined();
  });

  it("renews the exact active lease by CAS and fences capability expiry to the shorter TTL", async () => {
    const identity = promptIdentity();
    const runtime = renewalRepository({ identity });

    await expect(
      runtime.repository.renewPromptAuthority({
        identity,
      } as t.ResolvedTaskExecutionPrompt),
    ).resolves.toBeUndefined();

    expect(runtime.selectedTables).toEqual([
      taskExecutionRunControls,
      taskExecutionAttempts,
      taskExecutionLeases,
      taskExecutionPromptCapabilities,
    ]);
    expect(runtime.lockedTables).toEqual(runtime.selectedTables);
    expect(runtime.updates).toHaveLength(2);
    expect(runtime.updates[0]).toMatchObject({
      table: taskExecutionLeases,
      values: {
        renewedAt: timestamp,
        expiresAt: new Date("2026-07-01T00:02:00.000Z"),
      },
    });
    expect(runtime.updates[0]!.where).toBeDefined();
    expect(runtime.updates[1]).toMatchObject({
      table: taskExecutionPromptCapabilities,
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
    } as t.ResolvedTaskExecutionPrompt);
    await expect(renewal).rejects.toBeInstanceOf(TaskExecutionPromptAuthorityLost);
    await expect(renewal).rejects.toMatchObject({
      code: "task_execution_prompt_authority_lost",
      lease: {
        companyId: identity.companyId,
        taskId: identity.taskId,
        runId: identity.runId,
        attemptId: identity.attemptId,
        leaseId: identity.leaseId,
        leaseGeneration: identity.leaseGeneration,
      },
      cause: expect.any(PostgresTaskExecutionPromptCycleRejected),
    });
    expect(runtime.updates).toHaveLength(1);
    expect(runtime.updates[0]!.table).toBe(taskExecutionLeases);
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
      } as t.ResolvedTaskExecutionPrompt),
    ).rejects.toThrow("prompt capability renewal lost its compare-and-set fence");
    expect(runtime.updates.map(({ table }) => table)).toEqual([
      taskExecutionLeases,
      taskExecutionPromptCapabilities,
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
      } as t.ResolvedTaskExecutionPrompt),
    ).rejects.toThrow("prompt authority renewal cannot revive an expired capability");
    expect(runtime.updates).toEqual([]);
  });

  it("uses a fresh database instant after capability-lock contention", async () => {
    const identity = promptIdentity();
    const expiredAfterWait = new Date("2026-07-01T00:00:00.050Z");
    const runtime = renewalRepository({
      identity,
      capability: liveCapabilityRow(identity, expiredAfterWait),
      clockTimestamps: [timestamp, new Date("2026-07-01T00:00:00.100Z")],
    });

    await expect(
      runtime.repository.renewPromptAuthority({
        identity,
      } as t.ResolvedTaskExecutionPrompt),
    ).rejects.toThrow("prompt authority renewal cannot revive an expired capability");
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
      } as t.ResolvedTaskExecutionPrompt),
    ).rejects.toThrow("prompt crossed its canonical run, attempt, lease, or control");
    expect(runtime.selectedTables).not.toContain(taskExecutionPromptCapabilities);
    expect(runtime.updates).toEqual([]);
  });
});
