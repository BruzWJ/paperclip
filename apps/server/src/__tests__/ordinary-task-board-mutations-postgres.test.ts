import "./ordinary-task-board-mutations-postgres.test-suite-01-replays-one-accepted-agent-reopen.js";
import * as t from "./ordinary-task-board-mutations-postgres.test-support.js";
const { describe, it, TASK_ID, COMPANY_ID, mocks, createMockDb, sessionState } = t;
const { createRuntime, expect, RuntimeTaskActionDenied } = t;

describe("ordinary task board mutations without a database", () => {
  it("dispatches only an explicit mention of the exact current owner epoch", async () => {
    const task = {
      id: TASK_ID,
      companyId: COMPANY_ID,
      lifecycleStatus: "open",
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
    mocks.sessions.admitExecutionSource.mockResolvedValue({
      comment,
      input: { id: "input-mention" },
      ref,
      source: { messageId: "message-mention" },
    });
    const harness = createMockDb({
      execute: [[]],
      select: [[], [task], [sessionState()], [authority]],
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
    });

    expect(mocks.sessions.admitExecutionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAgentId: task.ownerAgentId,
        ownershipEpoch: task.ownershipEpoch,
        taskExecutionAuthorityId: authority.id,
        adapterConfigRevisionId: "revision-owner",
        sourceKind: "mention_agent",
        exactText: "  Continue with this exact context.  ",
      }),
      harness.db,
    );
    expect(mocks.dispatchRef).toHaveBeenCalledOnce();
    expect(mocks.dispatchRef).toHaveBeenCalledWith(ref.id);
  });

  it.each([
    {
      label: "mention plus reply",
      input: {
        mention: { targetAgentId: "owner-agent", ownershipEpoch: 1 },
        replyToCommentId: "comment-parent",
      },
      reason: "human_comment_target_conflict",
    },
    {
      label: "non-positive mention epoch",
      input: {
        mention: { targetAgentId: "owner-agent", ownershipEpoch: 0 },
      },
      reason: "human_mention_epoch_invalid",
    },
  ])("rejects $label before opening a transaction", async ({ input, reason }) => {
    const harness = createMockDb();

    await expect(
      createRuntime(harness).userComment({
        companyId: COMPANY_ID,
        taskId: TASK_ID,
        actorUserId: "commenter",
        message: "Comment",
        idempotencyKey: "invalid-comment-key",
        ...input,
      }),
    ).rejects.toMatchObject({ reason });
    expect(harness.calls).toHaveLength(0);
  });

  it("delegates creator-form admission and translates a denied authority", async () => {
    const harness = createMockDb();
    const runtime = createRuntime(harness);
    const authority = {
      kind: "user/board" as const,
      companyId: COMPANY_ID,
      userId: "creator-user",
      gatewayInvocationId: "gateway-1",
    };
    const accepted = {
      task: { id: TASK_ID },
      delivery: { id: "delivery-1" },
    };
    mocks.taskForms.commitCreatorFormUpdate.mockResolvedValueOnce(accepted);

    await expect(
      runtime.commitCreatorFormUpdate(TASK_ID, "  Exact creator response.  ", authority),
    ).resolves.toBe(accepted);
    expect(mocks.taskForms.commitCreatorFormUpdate).toHaveBeenCalledWith(
      TASK_ID,
      "  Exact creator response.  ",
      authority,
    );

    mocks.taskForms.commitCreatorFormUpdate.mockRejectedValueOnce(
      new RuntimeTaskActionDenied("Wrong creator", "creator_not_authorized"),
    );
    await expect(runtime.commitCreatorFormUpdate(TASK_ID, "Denied", authority)).rejects.toEqual(
      expect.objectContaining({
        name: "OrdinaryTaskRuntimeRejected",
        reason: "creator_not_authorized",
      }),
    );
    expect(harness.calls).toHaveLength(0);
  });

  it("allows only the exact named creator to enter withdrawal self-assignment", async () => {
    const task = {
      id: TASK_ID,
      companyId: COMPANY_ID,
      ownershipEpoch: 1,
      lifecycleStatus: "open",
      creatorKind: "user/board",
      creatorUserId: "different-user",
      ownerKind: "agent",
      ownerAgentId: "owner-agent",
    };
    const harness = createMockDb({
      execute: [[]],
      select: [[], [task]],
    });

    await expect(
      createRuntime(harness).userCreatorWithdrawalSelfAssign({
        companyId: COMPANY_ID,
        taskId: TASK_ID,
        actorUserId: "creator-user",
        idempotencyKey: "withdrawal-key-1",
      }),
    ).rejects.toMatchObject({
      reason: "withdrawal_self_assignment_target_invalid",
    });
    expect(
      harness.calls.filter((call) => ["insert", "update", "delete"].includes(call.operation)),
    ).toHaveLength(0);
    expect(mocks.dispatchRef).not.toHaveBeenCalled();
  });
});
