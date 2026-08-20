import * as t from "./ordinary-task-board-mutations-postgres.test-support.js";
const { describe, it, TASK_ID, COMPANY_ID, mocks, createMockDb, sessionState } = t;
const { createRuntime, expect } = t;

describe("ordinary task board mutations without a database", () => {
  it.each(["open", "done"] as const)(
    "dispatches a mention on a %s task without a lifecycle update",
    async (lifecycleStatus) => {
      const replyToCommentId = lifecycleStatus === "open" ? "comment-parent" : undefined;
      const task = {
        id: TASK_ID,
        companyId: COMPANY_ID,
        lifecycleStatus,
        ownershipEpoch: 2,
        ownerKind: "agent",
        ownerAgentId: "owner-agent",
      };
      const authority = {
        id: "authority-owner",
        agentId: task.ownerAgentId,
        ownershipEpoch: task.ownershipEpoch,
      };
      const comment = { id: "comment-mention", taskId: TASK_ID };
      const ref = { id: "ref-mention" };
      const admission = {
        comment,
        input: { id: "input-mention" },
        ref,
        source: { messageId: "message-mention" },
      };
      mocks.sessions.admitExecutionSourceBatch.mockResolvedValue([
        { ref: { id: "ref-bootstrap" } },
        admission,
      ]);
      const harness = createMockDb({
        execute: [[]],
        select: [
          [],
          [task],
          [sessionState()],
          ...(replyToCommentId ? [[{ id: replyToCommentId }]] : []),
          [authority],
          [{ instruction: "Lead delivery." }],
          [task],
          [{ id: "workspace-binding" }],
          [],
          [],
          [],
        ],
        insert: [[{ id: "mention-command", commentId: comment.id }]],
      });

      await createRuntime(harness).userComment({
        companyId: COMPANY_ID,
        taskId: TASK_ID,
        actorUserId: "commenter",
        message: "  Continue with this exact context.  ",
        idempotencyKey: "comment-key-mention",
        mention: {
          targetAgentId: task.ownerAgentId,
          ownershipEpoch: task.ownershipEpoch,
        },
        replyToCommentId,
      });

      const batch = mocks.sessions.admitExecutionSourceBatch.mock.calls[0]![0];
      expect(batch.sources.map((source: { sourceKind: string }) => source.sourceKind)).toEqual([
        "task_request",
        "mention_agent",
      ]);
      expect(batch.sources[1]).toEqual(
        expect.objectContaining({
          targetAgentId: task.ownerAgentId,
          ownershipEpoch: task.ownershipEpoch,
          taskExecutionAuthorityId: authority.id,
          adapterConfigRevisionId: "revision-owner",
          sourceKind: "mention_agent",
          exactText: "  Continue with this exact context.  ",
          comment: expect.objectContaining({ replyToCommentId: replyToCommentId ?? null }),
        }),
      );
      expect(mocks.dispatchRef).toHaveBeenCalledOnce();
      expect(mocks.dispatchRef).toHaveBeenCalledWith(ref.id);
      expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
    },
  );

  it("rejects a non-positive mention epoch before opening a transaction", async () => {
    const harness = createMockDb();

    await expect(
      createRuntime(harness).userComment({
        companyId: COMPANY_ID,
        taskId: TASK_ID,
        actorUserId: "commenter",
        message: "Comment",
        idempotencyKey: "invalid-comment-key",
        mention: { targetAgentId: "owner-agent", ownershipEpoch: 0 },
      }),
    ).rejects.toMatchObject({ reason: "human_mention_epoch_invalid" });
    expect(harness.calls).toHaveLength(0);
  });

  it("persists an open-task reply as a non-dispatch comment", async () => {
    const task = {
      id: TASK_ID,
      companyId: COMPANY_ID,
      lifecycleStatus: "open",
      ownershipEpoch: 2,
      ownerKind: "agent",
      ownerAgentId: "owner-agent",
    };
    const replyToCommentId = "comment-from-active-run";
    const comment = { id: "comment-reply", taskId: TASK_ID };
    mocks.sessions.appendNonDispatchUserComment.mockResolvedValue({ comment, ref: null });
    const harness = createMockDb({
      execute: [[]],
      select: [
        [],
        [task],
        [sessionState()],
        [{ id: replyToCommentId, runId: "active-run", authorAgentId: task.ownerAgentId }],
      ],
      insert: [[{ id: "reply-command", commentId: comment.id, executionRefId: null }]],
    });

    const result = await createRuntime(harness).userComment({
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      actorUserId: "commenter",
      message: "This is only a threaded reply.",
      idempotencyKey: "comment-key-reply",
      replyToCommentId,
    });

    expect(mocks.sessions.appendNonDispatchUserComment).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "human_comment",
        comment: expect.objectContaining({ replyToCommentId }),
      }),
      harness.db,
    );
    expect(result).toMatchObject({ comment, ref: null, retried: false });
    expect(mocks.dispatchRef).not.toHaveBeenCalled();
  });

  it("revokes and reassigns a terminal agent-owned task without execution", async () => {
    const task = {
      id: TASK_ID,
      companyId: COMPANY_ID,
      request: "Historical task request.",
      lifecycleStatus: "done",
      ownerKind: "agent",
      ownerAgentId: "previous-owner",
      ownerUserId: null,
      ownershipEpoch: 3,
      creatorKind: "system",
      creatorSystemSourceKind: "recovery",
      creatorSystemSourceId: "system-escalation",
    };
    const reassigned = {
      ...task,
      ownerKind: "agent",
      ownerAgentId: "next-owner",
      ownerUserId: null,
      ownershipEpoch: 4,
    };
    const audit = {
      companyId: COMPANY_ID,
      entityId: TASK_ID,
      actorId: "board-user",
      action: "task.board_reassigned",
      details: {
        contract: "board-task-reassignment/v1",
        idempotencyKey: "board-reassign-terminal",
        ownerAgentId: "next-owner",
        executionRefId: null,
      },
    };
    const cancellations = { requestIds: ["cancel-previous-owner"] };
    mocks.revokeOwnership.mockResolvedValue({ escalationDispatchRefIds: [], cancellations });
    const harness = createMockDb({
      execute: [[], []],
      select: [[], [task], [sessionState()], [{ id: "previous-authority" }], [audit], [reassigned]],
      update: [[reassigned]],
      insert: [[], [{ id: "creator-edge" }]],
    });
    const runtime = createRuntime(harness);
    const input = {
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      ownerAgentId: "next-owner",
      actorUserId: "board-user",
      idempotencyKey: "board-reassign-terminal",
    };

    await expect(runtime.boardReassign(input)).resolves.toMatchObject({
      task: reassigned,
      ref: null,
      retried: false,
    });
    await expect(runtime.boardReassign(input)).resolves.toMatchObject({
      task: reassigned,
      ref: null,
      retried: true,
    });
    expect(mocks.sessions.admitExecutionSource).not.toHaveBeenCalled();
    expect(mocks.dispatchRef).not.toHaveBeenCalled();
    expect(mocks.revokeOwnership).toHaveBeenCalledWith(
      harness.db,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ ownershipEpoch: 3, authorityId: "previous-authority" }),
    );
    expect(mocks.reconcileCancellations).toHaveBeenCalledWith(cancellations);
    expect(mocks.reserveWorkspace).toHaveBeenCalledOnce();
    expect(mocks.persistActivity).toHaveBeenCalledOnce();
    expect(mocks.persistActivity.mock.calls[0]?.[1].details.executionRefId).toBeNull();
  });
});
