import * as t from "./task-execution-policy.test-support.js";
const { describe, makePolicy, qaAgentId, ctoAgentId, operatorUserId, it } = t;
const { applyTaskExecutionPolicyTransition, coderAgentId, expect, twoStagePolicy } = t;
const { boardUserId, approvalOnlyPolicy } = t;

describe("task execution policy transitions", () => {
  describe("final stage completion terminates the policy (#7893)", () => {
    function threeStagePolicy() {
      return makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: qaAgentId }],
        },
        {
          type: "review",
          participants: [{ type: "agent", agentId: ctoAgentId }],
        },
        {
          type: "approval",
          participants: [{ type: "user", userId: operatorUserId }],
        },
      ]);
    }

    it("final-stage approval completes even when earlier completedStageIds are stale", () => {
      const policy = threeStagePolicy();
      const approvalStageId = policy.stages[2].id;
      // completedStageIds reference stage ids from a previous version of the
      // embedded policy (stage ids regenerate when the policy is re-sent or
      // edited mid-flow); only the active final stage id still matches.
      const staleStageIds = ["99999999-9999-4999-8999-999999999991", "99999999-9999-4999-8999-999999999992"];
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: operatorUserId,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 2,
            currentStageType: "approval",
            currentParticipant: {
              type: "user",
              userId: operatorUserId,
            },
            returnOwner: {
              type: "agent",
              agentId: coderAgentId,
            },
            completedStageIds: staleStageIds,
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        }),
        requestedStatus: "done",
        actor: { userId: operatorUserId },
        commentBody: "Approved, ship it",
      });

      // Must terminate the policy, not wrap around to the first stage.
      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: expect.arrayContaining([...staleStageIds, approvalStageId]),
        lastDecisionOutcome: "approved",
      });
      expect(result.patch.status).toBeUndefined();
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "approved",
      });
    });

    it("non-final stage approval still advances forward to the next stage", () => {
      const policy = threeStagePolicy();
      const firstStageId = policy.stages[0].id;
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          ownerAgentId: qaAgentId,
          executionState: t.reviewState(firstStageId),
        }),
        requestedStatus: "done",
        actor: { agentId: qaAgentId },
        commentBody: "QA pass",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: policy.stages[1].id,
        currentStageIndex: 1,
        completedStageIds: [firstStageId],
      });
    });

    it("final-stage changes requested still returns to the executor", () => {
      const policy = threeStagePolicy();
      const approvalStageId = policy.stages[2].id;
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: operatorUserId,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 2,
            currentStageType: "approval",
            currentParticipant: {
              type: "user",
              userId: operatorUserId,
            },
            returnOwner: {
              type: "agent",
              agentId: coderAgentId,
            },
            completedStageIds: [policy.stages[0].id, policy.stages[1].id],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        }),
        requestedStatus: "in_progress",
        actor: { userId: operatorUserId },
        commentBody: "Needs rework before release",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageId: approvalStageId,
        lastDecisionOutcome: "changes_requested",
      });
    });

    it("a completed execution state does not restart the workflow on done", () => {
      const policy = threeStagePolicy();
      // Completed state whose stage ids no longer match the current policy
      // (e.g. policy re-sent with regenerated ids after the chain finished).
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: operatorUserId,
          executionState: {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnOwner: {
              type: "agent",
              agentId: coderAgentId,
            },
            completedStageIds: [
              "99999999-9999-4999-8999-999999999991",
              "99999999-9999-4999-8999-999999999992",
              "99999999-9999-4999-8999-999999999993",
            ],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        }),
        requestedStatus: "done",
        actor: { userId: operatorUserId },
        commentBody: "Closing out",
      });

      // No rewind to the first stage — the caller's done is allowed through.
      expect(result.patch).toEqual({});
    });
  });

  describe("changes requested with no return owner", () => {
    it("throws when requesting changes with no return owner", () => {
      const policy = twoStagePolicy();
      const reviewStageId = policy.stages[0].id;
      expect(() =>
        t.transition(policy, {
          task: t.policyTask(policy, {
            boardPresentationStatus: "in_review",
            ownerAgentId: qaAgentId,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: {
                type: "agent",
                agentId: qaAgentId,
              },
              returnOwner: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          }),
          requestedStatus: "in_progress",
          actor: { agentId: qaAgentId },
          commentBody: "Changes needed",
        }),
      ).toThrow("no return owner");
    });
  });

  describe("approval stage changes requested → bounces back to executor", () => {
    it("approver requests changes during approval stage", () => {
      const policy = twoStagePolicy();
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
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        }),
        requestedStatus: "in_progress",
        actor: { userId: operatorUserId },
        commentBody: "Not happy with the approach, needs rework",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageType: "approval",
        lastDecisionOutcome: "changes_requested",
      });
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "changes_requested",
      });
    });
  });

  describe("user participants", () => {
    it("handles user-type reviewer participant correctly", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "user", userId: boardUserId }],
        },
      ]);

      const result = t.transition(policy, {
        task: t.policyTask(policy),
        requestedStatus: "done",
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
      expect(result.patch.executionState).toMatchObject({
        currentParticipant: { type: "user", userId: boardUserId },
      });
    });
  });

  describe("policy edits while a stage is active", () => {
    it("clears the active execution state when its stage is removed from the policy", () => {
      const reviewAndApproval = twoStagePolicy();
      const approvalOnly = approvalOnlyPolicy();

      const result = t.transition(approvalOnly, {
        task: t.policyTask(reviewAndApproval, {
          boardPresentationStatus: "in_review",
          ownerAgentId: qaAgentId,
          executionState: t.reviewState(reviewAndApproval.stages[0].id),
        }),
        requestedStatus: undefined,
        actor: { userId: boardUserId },
      });

      expect(result.patch).toMatchObject({
        status: "in_progress",
        executionState: null,
      });
    });

    it("selects a new active stage participant when the current participant is removed", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);
      const updatedPolicy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: ctoAgentId }],
        },
      ]);

      const result = t.transition(
        {
          ...updatedPolicy,
          stages: [{ ...updatedPolicy.stages[0], id: policy.stages[0].id }],
        },
        {
          task: t.policyTask(policy, {
            boardPresentationStatus: "in_review",
            ownerAgentId: qaAgentId,
            executionState: t.reviewState(policy.stages[0].id),
          }),
          requestedStatus: undefined,
          actor: { userId: boardUserId },
        },
      );

      expect(result.patch).toMatchObject({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageType: "review",
          currentParticipant: {
            type: "agent",
            agentId: ctoAgentId,
          },
          returnOwner: { type: "agent", agentId: coderAgentId },
        },
      });
    });
  });
});
