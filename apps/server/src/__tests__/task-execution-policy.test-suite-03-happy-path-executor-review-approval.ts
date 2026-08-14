import * as t from "./task-execution-policy.test-support.js";
const { describe, twoStagePolicy, it, applyTaskExecutionPolicyTransition } = t;
const { coderAgentId, expect, parseTaskExecutionState, qaAgentId, operatorUserId } = t;

describe("task execution policy transitions", () => {
  describe("happy path: executor → review → approval → done", () => {
    const policy = twoStagePolicy();

    it("routes executor completion into review", () => {
      const result = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "done",
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the feature",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        returnOwner: { type: "agent", agentId: coderAgentId },
      });
      expect(result.decision).toBeUndefined();
    });

    it("keeps the canonical task owner unchanged across every board-side stage", () => {
      const started = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "done",
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });
      expect(started.patch).not.toHaveProperty("ownerKind");
      expect(started.patch).not.toHaveProperty("ownerAgentId");
      expect(started.patch).not.toHaveProperty("ownerUserId");

      const reviewState = parseTaskExecutionState(started.patch.executionState);
      const reviewed = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          executionState: reviewState,
        }),
        requestedStatus: "done",
        actor: { agentId: qaAgentId },
        commentBody: "Review approved",
      });
      expect(reviewed.patch).not.toHaveProperty("ownerKind");
      expect(reviewed.patch).not.toHaveProperty("ownerAgentId");
      expect(reviewed.patch).not.toHaveProperty("ownerUserId");

      const approvalState = parseTaskExecutionState(reviewed.patch.executionState);
      const approved = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          executionState: approvalState,
        }),
        requestedStatus: "done",
        actor: { userId: operatorUserId },
        commentBody: "Approved",
      });
      expect(approved.patch).not.toHaveProperty("ownerKind");
      expect(approved.patch).not.toHaveProperty("ownerAgentId");
      expect(approved.patch).not.toHaveProperty("ownerUserId");
      expect(approved.decision).toMatchObject({
        stageType: "approval",
        outcome: "approved",
      });
    });

    it("carries loose review instructions on the pending stage", () => {
      const reviewInstructions = [
        "Please focus on whether the migration path is reversible.",
        "",
        "- Check failure handling",
        "- Call out any unclear operator instructions",
      ].join("\n");

      const result = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "done",
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the migration",
        reviewRequest: { instructions: reviewInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: qaAgentId,
        },
        reviewRequest: { instructions: reviewInstructions },
      });
    });

    it("clears loose review instructions with explicit null during a stage transition", () => {
      const reviewStageId = policy.stages[0].id;
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          executionState: t.reviewState(reviewStageId, {
            reviewRequest: { instructions: "Old review request" },
          }),
        }),
        requestedStatus: "in_review",
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
        reviewRequest: null,
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: qaAgentId,
        },
        reviewRequest: null,
      });
    });

    it("reviewer approves → advances to approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          ownerAgentId: qaAgentId,
          executionState: t.reviewState(reviewStageId),
        }),
        requestedStatus: "done",
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        completedStageIds: [reviewStageId],
        currentParticipant: {
          type: "user",
          userId: operatorUserId,
        },
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "approved",
      });
    });

    it("lets a reviewer provide loose instructions for the next approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalInstructions = "Please decide whether this is ready to ship, with any launch caveats.";
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          ownerAgentId: qaAgentId,
          executionState: t.reviewState(reviewStageId, {
            reviewRequest: {
              instructions: "Review the implementation details.",
            },
          }),
        }),
        requestedStatus: "done",
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
        reviewRequest: { instructions: approvalInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        currentParticipant: {
          type: "user",
          userId: operatorUserId,
        },
        reviewRequest: { instructions: approvalInstructions },
      });
    });

    it("approver approves → marks completed (allows done)", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: operatorUserId,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 1,
            currentStageType: "approval",
            currentParticipant: {
              type: "user",
              userId: operatorUserId,
            },
            returnOwner: {
              type: "agent",
              agentId: coderAgentId,
            },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        }),
        requestedStatus: "done",
        actor: { userId: operatorUserId },
        commentBody: "Approved, ship it",
      });

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: expect.arrayContaining([reviewStageId, approvalStageId]),
        lastDecisionOutcome: "approved",
      });
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "approved",
      });
      // status should NOT be overridden — caller can set done
      expect(result.patch.status).toBeUndefined();
    });
  });

  describe("changes requested flow", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer requests changes → returns to executor", () => {
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          ownerAgentId: qaAgentId,
          executionState: t.reviewState(reviewStageId),
        }),
        requestedStatus: "in_progress",
        actor: { agentId: qaAgentId },
        commentBody: "Needs another pass on edge cases",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageType: "review",
        returnOwner: { type: "agent", agentId: coderAgentId },
        lastDecisionOutcome: "changes_requested",
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "changes_requested",
      });
    });

    it("executor re-submits after changes → returns to same review stage", () => {
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          executionState: t.reviewState(reviewStageId, {
            status: "changes_requested",
            lastDecisionOutcome: "changes_requested",
          }),
        }),
        requestedStatus: "done",
        actor: { agentId: coderAgentId },
        commentBody: "Fixed edge cases",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: reviewStageId,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
      });
    });
  });
});
