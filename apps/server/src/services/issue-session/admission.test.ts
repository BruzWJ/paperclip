import { describe, expect, it } from "vitest";
import type { IssueSessionDbTransaction } from "./event-store.js";
import {
  isExactIssueUpdateCrossIssueProducer,
  previousOwnershipEpochForDispatchSource,
  reserveIssueExecutionLaneOrdinalInTransaction,
  resolveIssueCommentReplyProjection,
  v2MessageKindForExecutionSource,
  type IssueSessionExecutionSource,
} from "./admission.js";

const scope = {
  companyId: "11111111-1111-4111-8111-111111111111",
  issueId: "22222222-2222-4222-8222-222222222222",
  sessionId: "ses_reply_projection",
};

function transactionReturning(rows: unknown[]): IssueSessionDbTransaction {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async () => rows,
          }),
        }),
      }),
    }),
  } as unknown as IssueSessionDbTransaction;
}

describe("Issue Session reply admission", () => {
  it("keeps all captured fields null for a top-level comment", async () => {
    await expect(
      resolveIssueCommentReplyProjection({} as IssueSessionDbTransaction, scope, null),
    ).resolves.toEqual({
      replyToCommentId: null,
      replyToProjectedEventSeq: null,
      threadRootCommentId: null,
      threadRootProjectedEventSeq: null,
    });
  });

  it("locks a top-level parent and freezes it as the direct reply root", async () => {
    const parentId = "33333333-3333-4333-8333-333333333333";
    await expect(
      resolveIssueCommentReplyProjection(
        transactionReturning([{
          id: parentId,
          projectedEventSeq: 7,
          replyToCommentId: null,
          replyToProjectedEventSeq: null,
          threadRootCommentId: null,
          threadRootProjectedEventSeq: null,
        }]),
        scope,
        parentId,
      ),
    ).resolves.toEqual({
      replyToCommentId: parentId,
      replyToProjectedEventSeq: 7,
      threadRootCommentId: parentId,
      threadRootProjectedEventSeq: 7,
    });
  });

  it("copies a nested parent's immutable root tuple", async () => {
    const parentId = "33333333-3333-4333-8333-333333333333";
    const rootId = "44444444-4444-4444-8444-444444444444";
    await expect(
      resolveIssueCommentReplyProjection(
        transactionReturning([{
          id: parentId,
          projectedEventSeq: 12,
          replyToCommentId: rootId,
          replyToProjectedEventSeq: 4,
          threadRootCommentId: rootId,
          threadRootProjectedEventSeq: 4,
        }]),
        scope,
        parentId,
      ),
    ).resolves.toEqual({
      replyToCommentId: parentId,
      replyToProjectedEventSeq: 12,
      threadRootCommentId: rootId,
      threadRootProjectedEventSeq: 4,
    });
  });

  it("fails closed for a missing or cross-scope parent", async () => {
    await expect(
      resolveIssueCommentReplyProjection(
        transactionReturning([]),
        scope,
        "33333333-3333-4333-8333-333333333333",
      ),
    ).rejects.toThrow("Reply parent is missing from the canonical issue Session");
  });
});

function laneReservationTransaction(input: {
  nextOrdinal: number | null;
  capture: {
    values?: Record<string, unknown>;
    targetNames?: string[];
    set?: Record<string, unknown>;
    setWhere?: unknown;
  };
}): IssueSessionDbTransaction {
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        input.capture.values = values;
        return {
          onConflictDoUpdate: (conflict: {
            target: Array<{ name: string }>;
            set: Record<string, unknown>;
            setWhere?: unknown;
          }) => {
            input.capture.targetNames = conflict.target.map(
              (column) => column.name,
            );
            input.capture.set = conflict.set;
            input.capture.setWhere = conflict.setWhere;
            return {
              returning: async () => input.nextOrdinal === null
                ? []
                : [{ nextOrdinal: input.nextOrdinal }],
            };
          },
        };
      },
    }),
  } as unknown as IssueSessionDbTransaction;
}

describe("Issue Session target-agent FIFO admission", () => {
  it("atomically reserves ordinal zero when it creates the lane", async () => {
    const capture: Parameters<typeof laneReservationTransaction>[0]["capture"] = {};
    const now = new Date("2026-07-31T00:00:00.000Z");

    await expect(
      reserveIssueExecutionLaneOrdinalInTransaction(
        laneReservationTransaction({ nextOrdinal: 1, capture }),
        {
          companyId: scope.companyId,
          issueId: scope.issueId,
          ownershipEpoch: 3,
          targetAgentId: "55555555-5555-4555-8555-555555555555",
        },
        now,
      ),
    ).resolves.toBe(0);

    expect(capture.values).toMatchObject({
      companyId: scope.companyId,
      issueId: scope.issueId,
      ownershipEpoch: 3,
      targetAgentId: "55555555-5555-4555-8555-555555555555",
      nextOrdinal: 1,
      activeOrdinal: null,
      activeLeaseGeneration: null,
      activeLeaseId: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(capture.targetNames).toEqual([
      "company_id",
      "issue_id",
      "ownership_epoch",
      "target_agent_id",
    ]);
    expect(capture.set).toMatchObject({ updatedAt: now });
    expect(capture.setWhere).toBeDefined();
  });

  it("returns the prior next ordinal from the same conflict update", async () => {
    const capture: Parameters<typeof laneReservationTransaction>[0]["capture"] = {};
    await expect(
      reserveIssueExecutionLaneOrdinalInTransaction(
        laneReservationTransaction({ nextOrdinal: 8, capture }),
        {
          companyId: scope.companyId,
          issueId: scope.issueId,
          ownershipEpoch: 3,
          targetAgentId: "55555555-5555-4555-8555-555555555555",
        },
        new Date("2026-07-31T00:00:00.000Z"),
      ),
    ).resolves.toBe(7);
  });

  it("fails closed when PostgreSQL does not return a positive next ordinal", async () => {
    const capture: Parameters<typeof laneReservationTransaction>[0]["capture"] = {};
    await expect(
      reserveIssueExecutionLaneOrdinalInTransaction(
        laneReservationTransaction({ nextOrdinal: 0, capture }),
        {
          companyId: scope.companyId,
          issueId: scope.issueId,
          ownershipEpoch: 3,
          targetAgentId: "55555555-5555-4555-8555-555555555555",
        },
        new Date("2026-07-31T00:00:00.000Z"),
      ),
    ).rejects.toThrow(
      "Issue execution lane did not reserve one canonical FIFO ordinal",
    );
  });

  it("fails closed when the lane high-water cannot advance safely", async () => {
    const capture: Parameters<typeof laneReservationTransaction>[0]["capture"] = {};
    await expect(
      reserveIssueExecutionLaneOrdinalInTransaction(
        laneReservationTransaction({ nextOrdinal: null, capture }),
        {
          companyId: scope.companyId,
          issueId: scope.issueId,
          ownershipEpoch: 3,
          targetAgentId: "55555555-5555-4555-8555-555555555555",
        },
        new Date("2026-07-31T00:00:00.000Z"),
      ),
    ).rejects.toThrow(
      "Issue execution lane did not reserve one canonical FIFO ordinal",
    );
  });
});

describe("Issue Session canonical source authorship", () => {
  const userActor = {
    kind: "user/board",
    userId: "55555555-5555-4555-8555-555555555555",
  } as const;
  const agentActor = {
    kind: "agent-execution",
    agentId: "66666666-6666-4666-8666-666666666666",
    authorityId: "77777777-7777-4777-8777-777777777777",
  } as const;
  const routineActor = {
    kind: "routine",
    routineId: "88888888-8888-4888-8888-888888888888",
    routineDispatchId: "99999999-9999-4999-8999-999999999999",
  } as const;
  const systemActor = {
    kind: "system",
    sourceKind: "liveness",
    sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  } as const;

  const sourceCases = {
    issue_request: {
      source: { sourceKind: "issue_request", actor: agentActor },
      expected: "user",
    },
    issue_reassignment: {
      source: { sourceKind: "issue_reassignment", actor: agentActor },
      expected: "user",
    },
    issue_reopen: {
      source: { sourceKind: "issue_reopen", actor: userActor },
      expected: "user",
    },
    human_comment_mention: {
      source: { sourceKind: "human_comment_mention", actor: userActor },
      expected: "user",
    },
    routine_dispatch: {
      source: { sourceKind: "routine_dispatch", actor: routineActor },
      expected: "user",
    },
    issue_update: {
      source: { sourceKind: "issue_update", actor: agentActor },
      expected: "synthetic",
    },
    consult_mention: {
      source: { sourceKind: "consult_mention", actor: agentActor },
      expected: "synthetic",
    },
    system_nudge: {
      source: { sourceKind: "system_nudge", actor: systemActor },
      expected: "synthetic",
    },
    termination_recovery: {
      source: { sourceKind: "termination_recovery", actor: systemActor },
      expected: "synthetic",
    },
    agent_liveness_followup: {
      source: {
        sourceKind: "agent_liveness_followup",
        actor: systemActor,
      },
      expected: "synthetic",
    },
    human_active_run_steering: {
      source: {
        sourceKind: "human_active_run_steering",
        actor: userActor,
      },
      expected: "user",
    },
    agent_active_run_steering: {
      source: {
        sourceKind: "agent_active_run_steering",
        actor: agentActor,
      },
      expected: "synthetic",
    },
  } satisfies Record<
    IssueSessionExecutionSource["sourceKind"],
    {
      source: IssueSessionExecutionSource;
      expected: "user" | "synthetic";
    }
  >;

  it("exhaustively derives every execution-source kind", () => {
    for (const { source, expected } of Object.values(sourceCases)) {
      expect(v2MessageKindForExecutionSource(source)).toBe(expected);
    }
  });

  it("derives creator-update kind only from immutable actor provenance", () => {
    expect(
      v2MessageKindForExecutionSource({
        sourceKind: "issue_update",
        actor: userActor,
      }),
    ).toBe("user");
    for (const actor of [
      agentActor,
      {
        kind: "plugin",
        pluginInstallationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        pluginKey: "example.plugin",
      } as const,
      routineActor,
      systemActor,
    ]) {
      expect(
        v2MessageKindForExecutionSource({
          sourceKind: "issue_update",
          actor,
        }),
      ).toBe("synthetic");
    }
  });

  it("rejects producer overrides, unknown sources, and invalid actor pairs", () => {
    expect(() =>
      v2MessageKindForExecutionSource({
        sourceKind: "agent_liveness_followup",
        actor: systemActor,
        eventKind: "system",
      } as IssueSessionExecutionSource),
    ).toThrow("cannot override Session admission lowering");
    expect(() =>
      v2MessageKindForExecutionSource({
        sourceKind: "future_source",
        actor: systemActor,
      } as unknown as IssueSessionExecutionSource),
    ).toThrow("Unclassified execution source");
    expect(() =>
      v2MessageKindForExecutionSource({
        sourceKind: "agent_liveness_followup",
        actor: userActor,
      } as unknown as IssueSessionExecutionSource),
    ).toThrow("does not match its immutable source kind");
  });

  it("requires the exact outgoing epoch only for reassignment refs", () => {
    expect(
      previousOwnershipEpochForDispatchSource({
        sourceKind: "issue_reassignment",
        ownershipEpoch: 4,
        previousOwnershipEpoch: 3,
      }),
    ).toBe(3);
    expect(
      previousOwnershipEpochForDispatchSource({
        sourceKind: "issue_request",
        ownershipEpoch: 1,
      }),
    ).toBeNull();
    expect(() =>
      previousOwnershipEpochForDispatchSource({
        sourceKind: "issue_reassignment",
        ownershipEpoch: 4,
      }),
    ).toThrow("exact immediately previous ownership epoch");
    expect(() =>
      previousOwnershipEpochForDispatchSource({
        sourceKind: "issue_request",
        ownershipEpoch: 1,
        previousOwnershipEpoch: 1,
      }),
    ).toThrow("Only issue reassignment");
  });
});

const creatorParentIssueId = "33333333-3333-4333-8333-333333333333";
const creatorAuthorityId = "44444444-4444-4444-8444-444444444444";
const creatorAgentId = "55555555-5555-4555-8555-555555555555";
const childAuthorityId = "66666666-6666-4666-8666-666666666666";
const creatorRunId = "77777777-7777-4777-8777-777777777777";
const creatorRevisionId = "88888888-8888-4888-8888-888888888888";
const creatorRunScopeId = "99999999-9999-4999-8999-999999999999";
const creatorWorkspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const creatorAttemptId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const creatorLeaseId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function sequentialSelectTransaction(
  responses: readonly unknown[][],
): IssueSessionDbTransaction {
  let next = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(responses[next++] ?? []),
        }),
      }),
    }),
  } as unknown as IssueSessionDbTransaction;
}

function exactCreatorProducerRun(
  overrides: Record<string, unknown> = {},
) {
  const now = new Date("2026-08-06T12:00:00.000Z");
  return {
    id: creatorRunId,
    companyId: scope.companyId,
    issueId: creatorParentIssueId,
    sessionId: "ses_parent_creator",
    executionScopeId: creatorRunScopeId,
    kind: "productive",
    status: "running",
    ownershipEpoch: 3,
    targetAgentId: creatorAgentId,
    adapterConfigRevisionId: creatorRevisionId,
    executionWorkspaceBindingId: creatorWorkspaceId,
    executionMode: "owner",
    issueExecutionAuthorityId: creatorAuthorityId,
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: creatorAttemptId,
    currentLeaseId: creatorLeaseId,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: now,
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    processExitCode: null,
    processSignal: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const exactCreatorUpdateScope = {
  companyId: scope.companyId,
  issueId: scope.issueId,
  sessionId: scope.sessionId,
  sourceKind: "issue_update",
  actor: {
    kind: "agent-execution",
    agentId: creatorAgentId,
    authorityId: creatorAuthorityId,
  },
  counterpartIssueId: creatorParentIssueId,
  counterpartAuthorityId: creatorAuthorityId,
  counterpartOwnershipEpoch: 3,
  mode: "owner",
  issueExecutionAuthorityId: childAuthorityId,
  consultExecutionId: null,
} as const;

const exactCreatorUpdateComment = {
  author: { kind: "agent", agentId: creatorAgentId },
  producingRun: {
    runId: creatorRunId,
    adapterConfigRevisionId: creatorRevisionId,
  },
} as const;

function exactCreatorChild(overrides: Record<string, unknown> = {}) {
  return {
    parentId: creatorParentIssueId,
    parentOwnershipEpoch: 3,
    creatorKind: "agent-execution",
    creatorAuthorityId,
    creatorAdapterConfigRevisionId: creatorRevisionId,
    ...overrides,
  };
}

describe("creator-update cross-issue comment provenance", () => {
  it("accepts only the exact parent creator authority and producing run", async () => {
    await expect(
      isExactIssueUpdateCrossIssueProducer(
        sequentialSelectTransaction([
          [{}],
          [exactCreatorChild()],
          [{}],
          [exactCreatorProducerRun()],
        ]),
        exactCreatorUpdateScope,
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(true);
  });

  it("rejects a generic cross-issue source before reading any provenance", async () => {
    await expect(
      isExactIssueUpdateCrossIssueProducer(
        sequentialSelectTransaction([]),
        { ...exactCreatorUpdateScope, sourceKind: "issue_request" },
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(false);
    await expect(
      isExactIssueUpdateCrossIssueProducer(
        sequentialSelectTransaction([]),
        {
          ...exactCreatorUpdateScope,
          actor: {
            ...exactCreatorUpdateScope.actor,
            authorityId: childAuthorityId,
          },
        },
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(false);
  });

  it("rejects a target outside the immediate parent relationship", async () => {
    await expect(
      isExactIssueUpdateCrossIssueProducer(
        sequentialSelectTransaction([
          [{}],
          [exactCreatorChild({ parentOwnershipEpoch: 2 })],
          [{}],
          [exactCreatorProducerRun()],
        ]),
        exactCreatorUpdateScope,
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(false);
    await expect(
      isExactIssueUpdateCrossIssueProducer(
        sequentialSelectTransaction([
          [{}],
          [exactCreatorChild({ creatorAuthorityId: childAuthorityId })],
          [{}],
          [exactCreatorProducerRun()],
        ]),
        exactCreatorUpdateScope,
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(false);
  });

  it("accepts a child-owner update in its direct parent Session", async () => {
    const parentScope = {
      ...exactCreatorUpdateScope,
      issueId: creatorParentIssueId,
      sessionId: "ses_parent_creator",
      actor: {
        ...exactCreatorUpdateScope.actor,
        authorityId: childAuthorityId,
      },
      counterpartIssueId: scope.issueId,
      counterpartAuthorityId: childAuthorityId,
      counterpartOwnershipEpoch: 1,
    };
    await expect(
      isExactIssueUpdateCrossIssueProducer(
        sequentialSelectTransaction([
          [{}],
          [{ ownershipEpoch: 3 }],
          [{
            parentId: creatorParentIssueId,
            parentOwnershipEpoch: 3,
            ownershipEpoch: 1,
          }],
          [exactCreatorProducerRun({
            issueId: scope.issueId,
            sessionId: scope.sessionId,
            ownershipEpoch: 1,
            issueExecutionAuthorityId: childAuthorityId,
          })],
        ]),
        parentScope,
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(true);
  });

  it("rejects a missing counterpart authority or a run outside its exact tuple", async () => {
    await expect(
      isExactIssueUpdateCrossIssueProducer(
        sequentialSelectTransaction([[]]),
        exactCreatorUpdateScope,
        exactCreatorUpdateComment,
      ),
    ).rejects.toThrow("Counterpart authority");
    await expect(
      isExactIssueUpdateCrossIssueProducer(
        sequentialSelectTransaction([
          [{}],
          [exactCreatorChild()],
          [{}],
          [exactCreatorProducerRun({ issueExecutionAuthorityId: childAuthorityId })],
        ]),
        exactCreatorUpdateScope,
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(false);
  });
});
