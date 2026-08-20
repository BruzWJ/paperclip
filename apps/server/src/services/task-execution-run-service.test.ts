import * as t from "./task-execution-run-service.test-support.js";
const { describe, it, createMockDb, persistedRunRow } = t;
const { transitionTaskExecutionRunStatusInTransaction, runTime, PgDialect, expect } = t;
const { computeTaskExecutionRunBatchDigest, TaskExecutionRunInvariantViolation } = t;
const { fixture, runSelectionTransaction, createTaskExecutionRunInTransaction } = t;

describe("canonical task-execution run transitions", () => {
  it("encodes a same-time start predicate through the timestamp column", async () => {
    const harness = createMockDb({
      update: [
        [
          persistedRunRow({
            id: "run",
            status: "running",
            terminalFinalizationId: null,
            finishedAt: null,
            terminalClassification: null,
            terminalReasonCode: null,
          }),
        ],
      ],
    });

    await transitionTaskExecutionRunStatusInTransaction(harness.db as never, {
      companyId: "company",
      taskId: "task",
      runId: "run",
      expectedStatus: "queued",
      status: "running",
      startedAt: runTime,
      at: runTime,
    });

    const where = harness.calls.find((call) => call.operation === "update" && call.method === "where");
    const query = new PgDialect().sqlToQuery(where!.args[0] as never);
    expect(query.params.some((param) => param instanceof Date)).toBe(false);
    expect(query.params).toContain(runTime.toISOString());
  });
});

describe("canonical task-execution run envelope", () => {
  it("derives a stable text-free digest from ordered ref admission identities", () => {
    const members = [
      {
        refId: "ref-a",
        messageKind: "user",
        sourceMessageId: "input-a",
        admissionOrder: 3,
        admissionVersion: 10,
      },
      {
        refId: "ref-b",
        messageKind: "synthetic",
        sourceMessageId: "synthetic-b",
        admissionOrder: 4,
        admissionVersion: 11,
      },
    ] as const;
    expect(computeTaskExecutionRunBatchDigest(members)).toBe(computeTaskExecutionRunBatchDigest(members));
    expect(computeTaskExecutionRunBatchDigest(members)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      computeTaskExecutionRunBatchDigest([members[0], { ...members[1], admissionVersion: 12 }]),
    ).not.toBe(computeTaskExecutionRunBatchDigest(members));
  });

  it("rejects a negative admission version for every message kind", () => {
    for (const messageKind of ["user", "synthetic"] as const) {
      expect(() =>
        computeTaskExecutionRunBatchDigest([
          {
            refId: `${messageKind}-ref`,
            messageKind,
            sourceMessageId: `${messageKind}-message`,
            admissionOrder: 0,
            admissionVersion: -1,
          },
        ]),
      ).toThrow(TaskExecutionRunInvariantViolation);
    }
  });

  it("rejects empty, duplicate, and non-monotonic run batches", () => {
    expect(() => computeTaskExecutionRunBatchDigest([])).toThrow(TaskExecutionRunInvariantViolation);
    expect(() =>
      computeTaskExecutionRunBatchDigest([
        {
          refId: "ref",
          messageKind: "user",
          sourceMessageId: "input-a",
          admissionOrder: 2,
          admissionVersion: 2,
        },
        {
          refId: "ref",
          messageKind: "user",
          sourceMessageId: "input-b",
          admissionOrder: 3,
          admissionVersion: 3,
        },
      ]),
    ).toThrow(TaskExecutionRunInvariantViolation);
    expect(() =>
      computeTaskExecutionRunBatchDigest([
        {
          refId: "ref-a",
          messageKind: "user",
          sourceMessageId: "input-a",
          admissionOrder: 3,
          admissionVersion: 2,
        },
        {
          refId: "ref-b",
          messageKind: "user",
          sourceMessageId: "input-b",
          admissionOrder: 2,
          admissionVersion: 3,
        },
      ]),
    ).toThrow(TaskExecutionRunInvariantViolation);
  });

  it("rejects an empty productive batch before sending a database query", async () => {
    const { service } = fixture();
    await expect(
      service.createRun({} as never, {
        companyId: "company",
        taskId: "task",
        sessionId: "session",
        executionScopeId: "scope",
        ownershipEpoch: 1,
        adapterConfigRevisionId: "revision",
        executionWorkspaceBindingId: "workspace",
        at: new Date("2026-01-01T00:00:00.000Z"),
        kind: "productive",
        targetAgentId: "agent",
        taskExecutionAuthorityId: "authority",
        orderedRefIds: [],
      }),
    ).rejects.toBeInstanceOf(TaskExecutionRunInvariantViolation);
  });

  it("rejects a productive retry whose source has a different authority", async () => {
    const { transaction, select } = runSelectionTransaction([
      persistedRunRow({
        taskExecutionAuthorityId: "other-authority",
      }),
    ]);
    await expect(
      createTaskExecutionRunInTransaction(transaction, {
        companyId: "company",
        taskId: "task",
        sessionId: "session",
        executionScopeId: "scope",
        ownershipEpoch: 1,
        adapterConfigRevisionId: "revision",
        executionWorkspaceBindingId: "workspace",
        retryOfRunId: "retry-source",
        at: runTime,
        kind: "productive",
        targetAgentId: "agent",
        taskExecutionAuthorityId: "authority",
        orderedRefIds: ["ref"],
      }),
    ).rejects.toThrow("retry run is not a terminal run of the exact same kind and scope");
    expect(select).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "consult execution",
      change: { consultExecutionId: "other-consult" },
    },
    { label: "parent run", change: { parentRunId: "other-parent" } },
  ])("rejects a consult retry with a different $label", async ({ change }) => {
    const activeParent = persistedRunRow({
      id: "parent",
      status: "running",
      terminalFinalizationId: null,
      finishedAt: null,
      terminalClassification: null,
      terminalReasonCode: null,
    });
    const retrySource = persistedRunRow({
      id: "retry-source",
      kind: "consult",
      executionMode: "consult",
      taskExecutionAuthorityId: null,
      consultExecutionId: "consult",
      parentRunId: "parent",
      ...change,
    });
    const { transaction, select } = runSelectionTransaction([activeParent, retrySource]);
    await expect(
      createTaskExecutionRunInTransaction(transaction, {
        companyId: "company",
        taskId: "task",
        sessionId: "session",
        executionScopeId: "scope",
        ownershipEpoch: 1,
        adapterConfigRevisionId: "revision",
        executionWorkspaceBindingId: "workspace",
        retryOfRunId: "retry-source",
        at: runTime,
        kind: "consult",
        targetAgentId: "agent",
        consultExecutionId: "consult",
        parentRunId: "parent",
        orderedRefIds: ["ref"],
      }),
    ).rejects.toThrow("retry run is not a terminal run of the exact same kind and scope");
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("rejects unbounded list/detail reads before touching the database", async () => {
    const { service } = fixture();
    await expect(
      service.listForTask({
        companyId: "company",
        taskId: "task",
        limit: 201,
      }),
    ).rejects.toBeInstanceOf(TaskExecutionRunInvariantViolation);
    await expect(
      service.readJoinedRunDetail({
        companyId: "company",
        taskId: "task",
        runId: "run",
        limit: 501,
      }),
    ).rejects.toBeInstanceOf(TaskExecutionRunInvariantViolation);
  });

  it("rejects empty, duplicate, and open-ended run status filters before querying", async () => {
    const { service } = fixture();
    for (const statuses of [[], ["running", "running"], ["unknown"]] as const) {
      await expect(
        service.listForActivity({
          companyId: "company",
          statuses: statuses as never,
          limit: 20,
        }),
      ).rejects.toBeInstanceOf(TaskExecutionRunInvariantViolation);
    }
  });
});
