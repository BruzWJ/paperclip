import * as t from "./task-execution-policy.test-support.js";
const { describe, twoStagePolicy, it, applyTaskExecutionPolicyTransition } = t;
const { coderAgentId, expect, boardUserId, qaAgentId, reviewOnlyPolicy } = t;
const { makePolicy, ctoAgentId, operatorUserId } = t;

describe("task execution policy transitions", () => {
  describe("no-op transitions", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-done status change without review context is a no-op", () => {
      const result = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "blocked",
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("coerces a malformed executor in_review patch into the first policy stage", () => {
      const result = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "in_review",
        requestedOwnerPatch: { ownerUserId: boardUserId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: {
            type: "agent",
            agentId: qaAgentId,
          },
          returnOwner: { type: "agent", agentId: coderAgentId },
        },
      });
    });

    it("reasserts the active stage when task status drifted out of in_review", () => {
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          executionState: t.reviewState(reviewStageId),
        }),
        requestedStatus: "in_progress",
        requestedOwnerPatch: { ownerAgentId: coderAgentId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageType: "review",
          currentParticipant: {
            type: "agent",
            agentId: qaAgentId,
          },
        },
      });
    });

    it("no policy and no state is a no-op", () => {
      const result = t.transition(null, {
        task: t.policyTask(null),
        requestedStatus: "done",
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("does not auto-start workflow when policy is added to an already in_review task", () => {
      const reviewOnly = reviewOnlyPolicy();
      const result = t.transition(reviewOnly, {
        task: t.policyTask(null, {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: boardUserId,
        }),
        requestedStatus: undefined,
        actor: { userId: boardUserId },
      });

      expect(result.patch).toEqual({});
    });
  });

  describe("multi-participant stages", () => {
    it("does not reinterpret an owner patch as a stage-participant selection", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);

      const result = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "done",
        requestedOwnerPatch: { ownerAgentId: ctoAgentId },
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });

      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        currentParticipant: { type: "agent", agentId: qaAgentId },
      });
    });

    it("falls back to first participant when no preference given", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);

      const result = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "done",
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });

      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        currentParticipant: { type: "agent", agentId: qaAgentId },
      });
    });

    it("excludes the return owner from participant selection", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: coderAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ]);

      const result = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "done",
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      // coderAgentId is the returnOwner, so QA should be selected
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        currentParticipant: { type: "agent", agentId: qaAgentId },
      });
    });

    it("skips a self-review-only stage and completes the workflow", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
      ]);

      const result = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "done",
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        executionState: {
          status: "completed",
          currentStageType: null,
          currentParticipant: null,
          returnOwner: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
      expect(result.patch.status).toBeUndefined();
      expect(result.patch.ownerAgentId).toBeUndefined();
    });

    it("skips a self-review-only review stage and advances to approval", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
        {
          type: "approval",
          participants: [{ type: "user", userId: operatorUserId }],
        },
      ]);

      const result = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "done",
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageType: "approval",
          currentParticipant: {
            type: "user",
            userId: operatorUserId,
          },
          returnOwner: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
    });
  });
});
