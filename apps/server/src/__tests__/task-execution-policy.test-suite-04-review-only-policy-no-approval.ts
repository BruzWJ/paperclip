import * as t from "./task-execution-policy.test-support.js";
const { describe, reviewOnlyPolicy, it, applyTaskExecutionPolicyTransition } = t;
const { qaAgentId, coderAgentId, expect, approvalOnlyPolicy, twoStagePolicy } = t;
const { boardUserId } = t;

describe("task execution policy transitions", () => {
  describe("review-only policy (no approval stage)", () => {
    const policy = reviewOnlyPolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer approval completes the policy", () => {
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          ownerAgentId: qaAgentId,
          executionState: t.reviewState(reviewStageId),
        }),
        requestedStatus: "done",
        actor: { agentId: qaAgentId },
        commentBody: "LGTM",
      });

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: [reviewStageId],
        lastDecisionOutcome: "approved",
      });
      expect(result.decision).toMatchObject({
        stageType: "review",
        outcome: "approved",
      });
    });
  });

  describe("approval-only policy (no review stage)", () => {
    const policy = approvalOnlyPolicy();

    it("executor completion routes directly to approval", () => {
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
        status: "pending",
        currentStageType: "approval",
      });
    });
  });

  describe("access control", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-participant cannot advance the active stage", () => {
      expect(() =>
        t.transition(policy, {
          task: t.policyTask(policy, {
            boardPresentationStatus: "in_review",
            ownerAgentId: qaAgentId,
            executionState: t.reviewState(reviewStageId),
          }),
          requestedStatus: "done",
          requestedOwnerPatch: { ownerUserId: boardUserId },
          actor: { agentId: coderAgentId },
          commentBody: "Trying to bypass review",
        }),
      ).toThrow("Only the active reviewer or approver can advance");
    });

    it("non-participant can still post non-advancing updates", () => {
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "in_review",
          ownerAgentId: qaAgentId,
          executionState: t.reviewState(reviewStageId),
        }),
        requestedStatus: undefined,
        actor: { agentId: coderAgentId },
        commentBody: "Just a note",
      });

      // No error — just no patch modifications
      expect(result.patch).toEqual({});
    });
  });

  describe("comment requirements", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("approval without comment throws", () => {
      expect(() =>
        t.transition(policy, {
          task: t.policyTask(policy, {
            boardPresentationStatus: "in_review",
            ownerAgentId: qaAgentId,
            executionState: t.reviewState(reviewStageId),
          }),
          requestedStatus: "done",
          actor: { agentId: qaAgentId },
          commentBody: "",
        }),
      ).toThrow("requires a comment");
    });

    it("changes requested without comment throws", () => {
      expect(() =>
        t.transition(policy, {
          task: t.policyTask(policy, {
            boardPresentationStatus: "in_review",
            ownerAgentId: qaAgentId,
            executionState: t.reviewState(reviewStageId),
          }),
          requestedStatus: "in_progress",
          actor: { agentId: qaAgentId },
          commentBody: null,
        }),
      ).toThrow("requires a comment");
    });

    it("whitespace-only comment is treated as empty", () => {
      expect(() =>
        t.transition(policy, {
          task: t.policyTask(policy, {
            boardPresentationStatus: "in_review",
            ownerAgentId: qaAgentId,
            executionState: t.reviewState(reviewStageId),
          }),
          requestedStatus: "done",
          actor: { agentId: qaAgentId },
          commentBody: "   ",
        }),
      ).toThrow("requires a comment");
    });
  });

  describe("policy removal mid-flow", () => {
    it("clears execution state when policy removed and returns to executor", () => {
      // Use a real UUID for currentStageId so parseTaskExecutionState succeeds
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = t.transition(null, {
        task: t.policyTask(null, {
          boardPresentationStatus: "in_review",
          ownerAgentId: qaAgentId,
          executionState: t.reviewState(stageId),
        }),
        requestedStatus: undefined,
        actor: { agentId: qaAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
    });

    it("clears execution state without owner change when not in_review", () => {
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = t.transition(null, {
        task: t.policyTask(null, {
          executionState: t.reviewState(stageId, {
            status: "changes_requested",
            lastDecisionOutcome: "changes_requested",
          }),
        }),
        requestedStatus: undefined,
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      // Not in_review, so no status/owner change
      expect(result.patch.status).toBeUndefined();
    });
  });

  describe("reopening from done/cancelled clears state", () => {
    it("reopening a done task clears execution state", () => {
      const policy = twoStagePolicy();
      const result = t.transition(policy, {
        task: t.policyTask(policy, {
          boardPresentationStatus: "done",
          executionState: {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [policy.stages[0].id, policy.stages[1].id],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        }),
        requestedStatus: "todo",
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toBeNull();
    });
  });
});
