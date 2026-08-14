import * as t from "./task-execution-run-service.test-support.js";
const { describe, it, fixture, expect, requested, steeringSource } = t;
const { TaskExecutionSteeringRejected, TaskExecutionRunInvariantViolation } = t;

describe("canonical task-execution run steering", () => {
  it("commits only the exact run selector and preserves message bytes", async () => {
    const { service, repository } = fixture();
    const transaction = {} as never;
    const input = {
      companyId: "company",
      taskId: "task",
      ownershipEpoch: 3,
      runId: "run",
      targetAgentId: "agent",
      exactMessage: "  exact steering message\n",
      sourceCommentId: "comment",
      sourceMessageId: "input",
      sourceInputId: "input",
      actor: { kind: "user" as const, userId: "user" },
    };

    await expect(service.requestSteeringInTransaction(transaction, input)).resolves.toBe(requested);
    expect(repository.requestInTransaction).toHaveBeenCalledWith(transaction, input);
  });

  it("still fences through durable settlement when natural completion wins the signal race", async () => {
    const fixtureValue = fixture();
    fixtureValue.cancellation.signalAttemptCancellation.mockImplementation(() => {
      fixtureValue.order.push("cancel");
      return false;
    });
    await fixtureValue.service.continuePendingSteeringForSource(steeringSource);
    expect(fixtureValue.order).toEqual([
      "cancel",
      "signal_recorded",
      "settled",
      "rebound",
      "resume_ready",
      "resume",
    ]);
  });

  it("keeps an unsettled durable request pending without publishing failure", async () => {
    const fixtureValue = fixture();
    fixtureValue.cancellation.signalAttemptCancellation.mockImplementation(() => {
      fixtureValue.order.push("cancel");
      return false;
    });
    fixtureValue.repository.awaitCancellationSettlement.mockResolvedValue({
      kind: "pending",
      cancellationIntentId: requested.cancellationIntentId,
    });

    await expect(fixtureValue.service.continuePendingSteeringForSource(steeringSource)).resolves.toEqual({
      kind: "still_pending",
    });
    expect(fixtureValue.repository.rebindAfterCancellation).not.toHaveBeenCalled();
    expect(fixtureValue.repository.markAmbiguous).not.toHaveBeenCalled();
    expect(fixtureValue.steeringResults.publish).not.toHaveBeenCalled();
  });

  it("fails closed on ambiguous cancellation without rebound or resume", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.awaitCancellationSettlement.mockResolvedValue({
      kind: "ambiguous",
      cancellationIntentId: requested.cancellationIntentId,
      reason: "old prompt transmission ordering is unknown",
    });

    await expect(fixtureValue.service.continuePendingSteeringForSource(steeringSource)).rejects.toMatchObject(
      {
        reason: "cancellation_ambiguous",
      },
    );
    expect(fixtureValue.repository.markAmbiguous).toHaveBeenCalledOnce();
    expect(fixtureValue.repository.rebindAfterCancellation).not.toHaveBeenCalled();
    expect(fixtureValue.resume.resumeSteering).not.toHaveBeenCalled();
  });

  it("rejects a rebound that changes any canonical run/ref/segment identity", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.rebindAfterCancellation.mockResolvedValue({
      companyId: requested.companyId,
      taskId: requested.taskId,
      ownershipEpoch: requested.ownershipEpoch,
      runId: "different-run",
      targetAgentId: requested.targetAgentId,
      refId: requested.refId,
      refOrdinal: requested.refOrdinal,
      segmentOrdinal: requested.segmentOrdinal,
    });

    await expect(
      fixtureValue.service.continuePendingSteeringForSource(steeringSource),
    ).rejects.toBeInstanceOf(TaskExecutionSteeringRejected);
    expect(fixtureValue.repository.markAmbiguous).toHaveBeenCalledOnce();
    expect(fixtureValue.resume.resumeSteering).not.toHaveBeenCalled();
  });

  it("rejects missing identities and empty messages before persistence", async () => {
    const { service, repository } = fixture();
    await expect(
      service.requestSteeringInTransaction({} as never, {
        companyId: "company",
        taskId: "task",
        ownershipEpoch: 3,
        runId: "run",
        targetAgentId: "agent",
        exactMessage: "",
        sourceCommentId: "comment",
        sourceMessageId: "synthetic",
        sourceInputId: null,
        actor: { kind: "agent", agentId: "agent" },
      }),
    ).rejects.toMatchObject({ reason: "invalid_request" });
    expect(repository.requestInTransaction).not.toHaveBeenCalled();
  });

  it("continues a durable requested segment from its source comment", async () => {
    const fixtureValue = fixture();
    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        taskId: requested.taskId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).resolves.toEqual({
      kind: "continued_requested",
      rebound: expect.objectContaining({
        runId: requested.runId,
        segmentOrdinal: requested.segmentOrdinal,
      }),
    });
    expect(fixtureValue.repository.findPendingForSource).toHaveBeenCalledWith({
      companyId: requested.companyId,
      taskId: requested.taskId,
      sourceCommentId: requested.sourceCommentId,
    });
    expect(fixtureValue.order).toEqual([
      "cancel",
      "signal_recorded",
      "settled",
      "rebound",
      "resume_ready",
      "resume",
    ]);
  });

  it("accepts exact durable convergence when another continuation wins rebind", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.findPendingForSource
      .mockResolvedValueOnce({
        kind: "requested",
        request: requested,
      })
      .mockResolvedValueOnce({ kind: "resumed" });
    fixtureValue.repository.rebindAfterCancellation.mockRejectedValue(
      new TaskExecutionRunInvariantViolation("another continuation already cleared the old attempt"),
    );

    await expect(fixtureValue.service.continuePendingSteeringForSource(steeringSource)).resolves.toEqual({
      kind: "already_resumed",
    });
    expect(fixtureValue.repository.findPendingForSource).toHaveBeenCalledTimes(2);
    expect(fixtureValue.steeringResults.publish).not.toHaveBeenCalled();
    expect(fixtureValue.resume.resumeSteering).not.toHaveBeenCalled();
  });

  it("accepts exact durable convergence when another continuation wins resume readiness", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.findPendingForSource
      .mockResolvedValueOnce({
        kind: "requested",
        request: requested,
      })
      .mockResolvedValueOnce({ kind: "resumed" });
    fixtureValue.repository.markResumeReady.mockRejectedValue(
      new TaskExecutionSteeringRejected(
        "another continuation already marked the segment resumable",
        "invalid_request",
      ),
    );

    await expect(fixtureValue.service.continuePendingSteeringForSource(steeringSource)).resolves.toEqual({
      kind: "already_resumed",
    });
    expect(fixtureValue.repository.findPendingForSource).toHaveBeenCalledTimes(2);
    expect(fixtureValue.steeringResults.publish).not.toHaveBeenCalled();
    expect(fixtureValue.resume.resumeSteering).not.toHaveBeenCalled();
  });

  it("re-fences and schedules an already rebound segment without cancelling again", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.findPendingForSource.mockResolvedValue({
      kind: "rebound",
      rebound: {
        companyId: requested.companyId,
        taskId: requested.taskId,
        ownershipEpoch: requested.ownershipEpoch,
        runId: requested.runId,
        targetAgentId: requested.targetAgentId,
        refId: requested.refId,
        refOrdinal: requested.refOrdinal,
        segmentOrdinal: requested.segmentOrdinal,
      },
    });

    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        taskId: requested.taskId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).resolves.toMatchObject({ kind: "continued_rebound" });
    expect(fixtureValue.order).toEqual(["resume_ready", "resume"]);
    expect(fixtureValue.cancellation.signalAttemptCancellation).not.toHaveBeenCalled();
  });

  it("settles a waiting selector result when durable rebound resume fails", async () => {
    const fixtureValue = fixture();
    const rebound = {
      companyId: requested.companyId,
      taskId: requested.taskId,
      ownershipEpoch: requested.ownershipEpoch,
      runId: requested.runId,
      targetAgentId: requested.targetAgentId,
      refId: requested.refId,
      refOrdinal: requested.refOrdinal,
      segmentOrdinal: requested.segmentOrdinal,
    };
    fixtureValue.repository.findPendingForSource.mockResolvedValue({
      kind: "rebound",
      rebound,
    });
    fixtureValue.resume.resumeSteering.mockRejectedValue(new Error("native resume rejected"));

    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        taskId: requested.taskId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).rejects.toThrow("native resume rejected");
    expect(fixtureValue.steeringResults.publish).toHaveBeenCalledWith({
      companyId: rebound.companyId,
      taskId: rebound.taskId,
      runId: rebound.runId,
      refId: rebound.refId,
      refOrdinal: rebound.refOrdinal,
      segmentOrdinal: rebound.segmentOrdinal,
      outcome: "failed",
      response: "",
      reason: "native resume rejected",
    });
  });

  it("returns a typed in-flight result for an already resumed source", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.findPendingForSource.mockResolvedValue({
      kind: "resumed",
    });
    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        taskId: requested.taskId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).resolves.toEqual({ kind: "already_resumed" });
    expect(fixtureValue.order).toEqual([]);
  });

  it("replays a canonical already-settled steering result", async () => {
    const fixtureValue = fixture();
    const result = {
      companyId: requested.companyId,
      taskId: requested.taskId,
      runId: requested.runId,
      refId: requested.refId,
      refOrdinal: requested.refOrdinal,
      segmentOrdinal: requested.segmentOrdinal,
      outcome: "succeeded" as const,
      response: "settled response",
      reason: null,
    };
    fixtureValue.repository.findPendingForSource.mockResolvedValue({
      kind: "terminal",
      result,
    });
    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        taskId: requested.taskId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).resolves.toEqual({ kind: "already_settled", result });
    expect(fixtureValue.order).toEqual([]);
  });

  it("fails closed for an ambiguous durable source state", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.findPendingForSource.mockResolvedValue({
      kind: "ambiguous",
      reason: "persisted segment lifecycle is incomplete",
    });
    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        taskId: requested.taskId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).rejects.toMatchObject({ reason: "persisted_ambiguous" });
    expect(fixtureValue.order).toEqual([]);
  });

  it("feeds only recoverable source identities through the canonical continuation", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.listRecoverableSources.mockResolvedValue([steeringSource]);

    await expect(fixtureValue.service.reconcilePendingSteering()).resolves.toEqual({
      discovered: 1,
      continued: 1,
      pending: 0,
      sourceCommentIds: [requested.sourceCommentId],
    });
    expect(fixtureValue.repository.findPendingForSource).toHaveBeenCalledOnce();
    expect(fixtureValue.order).toEqual([
      "cancel",
      "signal_recorded",
      "settled",
      "rebound",
      "resume_ready",
      "resume",
    ]);
  });
});
