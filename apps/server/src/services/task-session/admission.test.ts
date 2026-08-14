import * as t from "./admission.test-support.js";
const { describe, it, expect, resolveTaskCommentReplyProjection, scope } = t;
const { transactionReturning, reserveTaskExecutionLaneOrdinalInTransaction } = t;
const { laneReservationTransaction, isExactTaskUpdateCrossTaskProducer } = t;
const { sequentialSelectTransaction, exactCreatorChild, exactCreatorProducerRun } = t;
const { exactCreatorUpdateScope, exactCreatorUpdateComment, childAuthorityId } = t;
const { creatorParentTaskId } = t;

import "./admission.test-suite-03-exhaustively-derives-every-execution-source.js";

describe("Task Session reply admission", () => {
  it("keeps all captured fields null for a top-level comment", async () => {
    await expect(
      resolveTaskCommentReplyProjection({} as t.TaskSessionDbTransaction, scope, null),
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
      resolveTaskCommentReplyProjection(
        transactionReturning([
          {
            id: parentId,
            projectedEventSeq: 7,
            replyToCommentId: null,
            replyToProjectedEventSeq: null,
            threadRootCommentId: null,
            threadRootProjectedEventSeq: null,
          },
        ]),
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
      resolveTaskCommentReplyProjection(
        transactionReturning([
          {
            id: parentId,
            projectedEventSeq: 12,
            replyToCommentId: rootId,
            replyToProjectedEventSeq: 4,
            threadRootCommentId: rootId,
            threadRootProjectedEventSeq: 4,
          },
        ]),
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
      resolveTaskCommentReplyProjection(
        transactionReturning([]),
        scope,
        "33333333-3333-4333-8333-333333333333",
      ),
    ).rejects.toThrow("Reply parent is missing from the canonical task Session");
  });
});

describe("Task Session target-agent FIFO admission", () => {
  it("atomically reserves ordinal zero when it creates the lane", async () => {
    const capture: t.LaneReservationTransactionInput["capture"] = {};
    const now = new Date("2026-07-31T00:00:00.000Z");

    await expect(
      reserveTaskExecutionLaneOrdinalInTransaction(
        laneReservationTransaction({ nextOrdinal: 1, capture }),
        {
          companyId: scope.companyId,
          taskId: scope.taskId,
          ownershipEpoch: 3,
          targetAgentId: "55555555-5555-4555-8555-555555555555",
        },
        now,
      ),
    ).resolves.toBe(0);

    expect(capture.values).toMatchObject({
      companyId: scope.companyId,
      taskId: scope.taskId,
      ownershipEpoch: 3,
      targetAgentId: "55555555-5555-4555-8555-555555555555",
      nextOrdinal: 1,
      activeOrdinal: null,
      activeLeaseGeneration: null,
      activeLeaseId: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(capture.targetNames).toEqual(["company_id", "task_id", "ownership_epoch", "target_agent_id"]);
    expect(capture.set).toMatchObject({ updatedAt: now });
    expect(capture.setWhere).toBeDefined();
  });

  it("returns the prior next ordinal from the same conflict update", async () => {
    const capture: t.LaneReservationTransactionInput["capture"] = {};
    await expect(
      reserveTaskExecutionLaneOrdinalInTransaction(
        laneReservationTransaction({ nextOrdinal: 8, capture }),
        {
          companyId: scope.companyId,
          taskId: scope.taskId,
          ownershipEpoch: 3,
          targetAgentId: "55555555-5555-4555-8555-555555555555",
        },
        new Date("2026-07-31T00:00:00.000Z"),
      ),
    ).resolves.toBe(7);
  });

  it("fails closed when PostgreSQL does not return a positive next ordinal", async () => {
    const capture: t.LaneReservationTransactionInput["capture"] = {};
    await expect(
      reserveTaskExecutionLaneOrdinalInTransaction(
        laneReservationTransaction({ nextOrdinal: 0, capture }),
        {
          companyId: scope.companyId,
          taskId: scope.taskId,
          ownershipEpoch: 3,
          targetAgentId: "55555555-5555-4555-8555-555555555555",
        },
        new Date("2026-07-31T00:00:00.000Z"),
      ),
    ).rejects.toThrow("Task execution lane did not reserve one canonical FIFO ordinal");
  });

  it("fails closed when the lane high-water cannot advance safely", async () => {
    const capture: t.LaneReservationTransactionInput["capture"] = {};
    await expect(
      reserveTaskExecutionLaneOrdinalInTransaction(
        laneReservationTransaction({
          nextOrdinal: null,
          capture,
        }),
        {
          companyId: scope.companyId,
          taskId: scope.taskId,
          ownershipEpoch: 3,
          targetAgentId: "55555555-5555-4555-8555-555555555555",
        },
        new Date("2026-07-31T00:00:00.000Z"),
      ),
    ).rejects.toThrow("Task execution lane did not reserve one canonical FIFO ordinal");
  });
});

describe("creator-update cross-task comment provenance", () => {
  it("accepts only the exact parent creator authority and producing run", async () => {
    await expect(
      isExactTaskUpdateCrossTaskProducer(
        sequentialSelectTransaction([[{}], [exactCreatorChild()], [{}], [exactCreatorProducerRun()]]),
        exactCreatorUpdateScope,
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(true);
  });

  it("rejects a generic cross-task source before reading any provenance", async () => {
    await expect(
      isExactTaskUpdateCrossTaskProducer(
        sequentialSelectTransaction([]),
        {
          ...exactCreatorUpdateScope,
          sourceKind: "task_request",
        },
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(false);
    await expect(
      isExactTaskUpdateCrossTaskProducer(
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
      isExactTaskUpdateCrossTaskProducer(
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
      isExactTaskUpdateCrossTaskProducer(
        sequentialSelectTransaction([
          [{}],
          [
            exactCreatorChild({
              creatorAuthorityId: childAuthorityId,
            }),
          ],
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
      taskId: creatorParentTaskId,
      sessionId: "ses_parent_creator",
      actor: {
        ...exactCreatorUpdateScope.actor,
        authorityId: childAuthorityId,
      },
      counterpartTaskId: scope.taskId,
      counterpartAuthorityId: childAuthorityId,
      counterpartOwnershipEpoch: 1,
    };
    await expect(
      isExactTaskUpdateCrossTaskProducer(
        sequentialSelectTransaction([
          [{}],
          [{ ownershipEpoch: 3 }],
          [
            {
              parentId: creatorParentTaskId,
              parentOwnershipEpoch: 3,
              ownershipEpoch: 1,
            },
          ],
          [
            exactCreatorProducerRun({
              taskId: scope.taskId,
              sessionId: scope.sessionId,
              ownershipEpoch: 1,
              taskExecutionAuthorityId: childAuthorityId,
            }),
          ],
        ]),
        parentScope,
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(true);
  });

  it("rejects a missing counterpart authority or a run outside its exact tuple", async () => {
    await expect(
      isExactTaskUpdateCrossTaskProducer(
        sequentialSelectTransaction([[]]),
        exactCreatorUpdateScope,
        exactCreatorUpdateComment,
      ),
    ).rejects.toThrow("Counterpart authority");
    await expect(
      isExactTaskUpdateCrossTaskProducer(
        sequentialSelectTransaction([
          [{}],
          [exactCreatorChild()],
          [{}],
          [
            exactCreatorProducerRun({
              taskExecutionAuthorityId: childAuthorityId,
            }),
          ],
        ]),
        exactCreatorUpdateScope,
        exactCreatorUpdateComment,
      ),
    ).resolves.toBe(false);
  });
});
