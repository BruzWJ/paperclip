import * as t from "./ordinary-task-board-mutations-postgres.test-support.js";
const { describe, it, COMPANY_ID, TASK_ID, identityDigest, NOW, createMockDb } = t;
const { createRuntime, expect, mocks, sessionState } = t;

describe("ordinary task board mutations without a database", () => {
  it("replays one accepted agent reopen from its exact persisted ref", async () => {
    const input = {
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      actorUserId: "board-user",
      reason: "  Re-open with these exact bytes.  ",
      idempotencyKey: "reopen-key-1",
    };
    const command = {
      id: "reopen-command-1",
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      actorUserId: input.actorUserId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      identityDigest: identityDigest({
        contract: "ordinary-board-reopen/v2",
        companyId: COMPANY_ID,
        taskId: TASK_ID,
        actorUserId: input.actorUserId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      }),
      priorStatus: "done",
      priorDisposition: { message: "done" },
      ownershipEpoch: 1,
      branch: "agent_execution",
      preservedOwnerKind: "agent",
      continuityFenceGeneration: 2,
      creatorEdgeId: "edge-1",
      executionRefId: "ref-reopen-1",
      systemEscalationIdentityId: null,
      createdAt: NOW,
    };
    const task = {
      id: TASK_ID,
      companyId: COMPANY_ID,
      request: "  Preserve the original task request.  ",
    };
    const edge = { id: "edge-1", companyId: COMPANY_ID };
    const ref = {
      id: command.executionRefId,
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      sessionId: "ses_task_1",
      ownershipEpoch: 1,
      previousOwnershipEpoch: null,
      executionScopeId: "scope-1",
      executionLineageId: "lineage-1",
      mode: "owner",
      sourceKind: "task_reopen",
      sourceId: command.id,
      sourceRecordId: command.id,
      messageKind: "input",
      sourceMessageId: "message-1",
      exactMessage: task.request,
      deliveryIdempotencyKey: `board-reopen:${COMPANY_ID}:${input.idempotencyKey}`,
      targetAgentId: "owner-agent",
      laneOrdinal: 1,
      taskExecutionAuthorityId: "authority-owner",
      consultExecutionId: null,
      adapterConfigRevisionId: "revision-owner",
      contextEpoch: 3,
      historyViewId: null,
      admissionHighWaterSeq: 4,
      inputId: "input-1",
      admittedSeq: 4,
      promotedSeq: null,
      counterpartTaskId: null,
      counterpartAuthorityId: null,
      counterpartOwnershipEpoch: null,
      consultCallerRefId: null,
      consultChainToken: null,
      disposition: "pending",
    };
    const harness = createMockDb({
      execute: [[]],
      select: [[{ id: input.actorUserId }], [command], [task], [edge], [ref]],
    });

    const result = await createRuntime(harness).boardReopen(input);

    expect(result).toMatchObject({
      task,
      edge,
      command,
      retried: true,
      dispatch: {
        kind: "agent_execution",
        executionRef: { id: ref.id, exactMessage: task.request },
      },
    });
    expect(mocks.dispatchRef).toHaveBeenCalledOnce();
    expect(mocks.dispatchRef).toHaveBeenCalledWith(ref.id);
    expect(harness.remaining("select")).toBe(0);
  });

  it("fences the terminal epoch before admitting the one fresh reopen ref", async () => {
    const ownerAgentId = "owner-agent";
    const session = sessionState();
    const task = {
      id: TASK_ID,
      companyId: COMPANY_ID,
      request: "Resume from one fresh board command.",
      lifecycleStatus: "done",
      disposition: { message: "Previously completed" },
      ownershipEpoch: 1,
      ownerKind: "agent",
      ownerAgentId,
      ownerUserId: null,
      ownerAssignmentSource: null,
      creatorKind: "user/board",
      creatorUserId: "creator-user",
    };
    const reopened = {
      ...task,
      lifecycleStatus: "open",
      disposition: null,
    };
    const edge = {
      id: "edge-1",
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      ownershipEpoch: 1,
      creatorKind: "user/board",
      endpointKind: "user/board",
      endpointId: "creator-user",
      state: "receivable",
    };
    const authority = {
      id: "authority-owner",
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      sessionId: session.session.id,
      ownershipEpoch: 1,
      agentId: ownerAgentId,
      state: "current",
    };
    const ref = {
      id: "ref-reopen-fresh",
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      sessionId: session.session.id,
      ownershipEpoch: 1,
      mode: "owner",
      sourceKind: "task_reopen",
      exactMessage: task.request,
      targetAgentId: ownerAgentId,
      taskExecutionAuthorityId: authority.id,
      disposition: "active",
    };
    const command = {
      id: "reopen-command-fresh",
      companyId: COMPANY_ID,
      taskId: TASK_ID,
    };
    const cancellations = {
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      selector: { kind: "ownership_epoch", ownershipEpoch: 1 },
      reason: "board_reopen_continuity_fence",
      fence: { refIds: ["ref-stale"], correlationIds: [] },
      requests: [],
    };
    mocks.sessions.admitExecutionSource.mockResolvedValue({
      ref,
    });
    mocks.requestCancellations.mockResolvedValue(cancellations);
    const harness = createMockDb({
      execute: [[]],
      select: [[{ id: "board-user" }], [], [task], [session], [edge], [authority], [], [], []],
      update: [[], [reopened]],
      insert: [[command]],
    });

    const result = await createRuntime(harness).boardReopen({
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      actorUserId: "board-user",
      reason: "Resume cleanly",
      idempotencyKey: "reopen-fenced-1",
    });

    expect(mocks.requestCancellations).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      selector: { kind: "ownership_epoch", ownershipEpoch: 1 },
      reason: "board_reopen_continuity_fence",
      actor: { kind: "user", userId: "board-user" },
      now: NOW,
    });
    expect(mocks.reconcileCancellations).toHaveBeenCalledWith(cancellations);
    expect(mocks.dispatchRef).toHaveBeenCalledWith(ref.id);
    expect(result).not.toHaveProperty("cancellations");
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("requires an authenticated named board user before a reopen can mutate", async () => {
    const harness = createMockDb({ execute: [[]], select: [[]] });

    await expect(
      createRuntime(harness).boardReopen({
        companyId: COMPANY_ID,
        taskId: TASK_ID,
        actorUserId: "missing-user",
        reason: "Reopen",
        idempotencyKey: "reopen-key-2",
      }),
    ).rejects.toMatchObject({
      reason: "board_reopen_actor_invalid",
    });
    expect(
      harness.calls.filter((call) => ["insert", "update", "delete"].includes(call.operation)),
    ).toHaveLength(0);
    expect(mocks.dispatchRef).not.toHaveBeenCalled();
  });

  it("persists a terminal-task comment without dispatching from prose", async () => {
    const task = {
      id: TASK_ID,
      companyId: COMPANY_ID,
      lifecycleStatus: "done",
      ownershipEpoch: 1,
      ownerKind: "agent",
      ownerAgentId: "owner-agent",
    };
    const comment = {
      id: "comment-1",
      taskId: TASK_ID,
      runId: null,
    };
    const command = { id: "comment-command-1", commentId: comment.id };
    mocks.sessions.appendNonDispatchUserComment.mockResolvedValue({
      comment,
      input: null,
      ref: null,
      source: { messageId: "message-1" },
    });
    const harness = createMockDb({
      execute: [[]],
      select: [[], [task], [sessionState()]],
      insert: [[command]],
    });

    const result = await createRuntime(harness).userComment({
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      actorUserId: "commenter",
      message: "  @owner is only prose here.  ",
      idempotencyKey: "comment-key-1",
    });

    expect(result).toMatchObject({ comment, ref: null, retried: false });
    expect(mocks.sessions.appendNonDispatchUserComment).toHaveBeenCalledWith(
      expect.objectContaining({
        exactText: "  @owner is only prose here.  ",
        delivery: "queue",
        sourceKind: "human_comment",
      }),
      harness.db,
    );
    expect(mocks.sessions.admitExecutionSource).not.toHaveBeenCalled();
    expect(mocks.dispatchRef).not.toHaveBeenCalled();
  });

  it("locks the Session before requesting steering for a reply's run", async () => {
    const order: string[] = [];
    const task = {
      id: TASK_ID,
      companyId: COMPANY_ID,
      lifecycleStatus: "open",
      ownershipEpoch: 1,
      ownerKind: "agent",
      ownerAgentId: "owner-agent",
    };
    const replyParent = {
      id: "comment-parent",
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      runId: "run-parent",
      authorAgentId: "agent-parent",
    };
    const comment = { id: "comment-steering", taskId: TASK_ID };
    mocks.sessions.admitSteeringComment.mockImplementationOnce(async () => {
      order.push("admit-steering");
      return {
        comment,
        input: { id: "input-steering" },
        ref: null,
        source: { messageId: "message-steering" },
      };
    });
    mocks.requestSteering.mockImplementationOnce(async () => {
      order.push("request-steering");
      return undefined;
    });
    const harness = createMockDb({
      execute: [[]],
      select: [
        () => {
          order.push("read-command");
          return [];
        },
        () => {
          order.push("lock-task");
          return [task];
        },
        () => {
          order.push("lock-session");
          return [sessionState()];
        },
        () => {
          order.push("revalidate-reply");
          return [replyParent];
        },
      ],
      insert: [[{ id: "steering-command", commentId: comment.id }]],
    });

    await createRuntime(harness).userComment({
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      actorUserId: "commenter",
      message: "  Steer this exact run.  ",
      idempotencyKey: "comment-key-steering",
      replyToCommentId: replyParent.id,
    });

    expect(order).toEqual([
      "read-command",
      "lock-task",
      "lock-session",
      "revalidate-reply",
      "admit-steering",
      "request-steering",
    ]);
    expect(mocks.requestSteering).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({
        companyId: COMPANY_ID,
        taskId: TASK_ID,
        runId: replyParent.runId,
        targetAgentId: replyParent.authorAgentId,
      }),
    );
    expect(mocks.continuePendingSteeringForSource).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      sourceCommentId: comment.id,
    });
  });
});
