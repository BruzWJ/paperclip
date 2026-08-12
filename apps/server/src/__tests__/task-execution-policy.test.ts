import { describe, expect, it } from "vitest";
import { applyTaskExecutionPolicyTransition, normalizeTaskExecutionPolicy, parseTaskExecutionState } from "../services/task-execution-policy.ts";
import type { TaskExecutionPolicy, TaskExecutionState } from "@paperclipai/shared";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const qaAgentId = "22222222-2222-4222-8222-222222222222";
const ctoAgentId = "33333333-3333-4333-8333-333333333333";
const operatorUserId = "operator-user";
const boardUserId = "board-user";

function makePolicy(
  stages: Array<{ type: "review" | "approval"; participants: Array<{ type: "agent" | "user"; agentId?: string; userId?: string }> }>,
) {
  return normalizeTaskExecutionPolicy({ stages })!;
}

function twoStagePolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
    { type: "approval", participants: [{ type: "user", userId: operatorUserId }] },
  ]);
}

function reviewOnlyPolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
  ]);
}

function approvalOnlyPolicy() {
  return makePolicy([
    { type: "approval", participants: [{ type: "user", userId: operatorUserId }] },
  ]);
}

describe("normalizeTaskExecutionPolicy", () => {
  it("returns null for null/undefined input", () => {
    expect(normalizeTaskExecutionPolicy(null)).toBeNull();
    expect(normalizeTaskExecutionPolicy(undefined)).toBeNull();
  });

  it("returns null when stages are empty", () => {
    expect(normalizeTaskExecutionPolicy({ stages: [] })).toBeNull();
  });

  it("throws when all participants are invalid (missing agentId)", () => {
    expect(() =>
      normalizeTaskExecutionPolicy({
        stages: [{ type: "review", participants: [{ type: "agent" }] }],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("deduplicates participants within a stage", () => {
    const result = normalizeTaskExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ],
    });
    expect(result!.stages[0].participants).toHaveLength(1);
  });

  it("assigns UUIDs to stages and participants", () => {
    const result = normalizeTaskExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.stages[0].id).toBeDefined();
    expect(result!.stages[0].participants[0].id).toBeDefined();
  });

  it("always sets commentRequired to true", () => {
    const result = normalizeTaskExecutionPolicy({
      commentRequired: false,
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.commentRequired).toBe(true);
  });

  it("defaults mode to normal", () => {
    const result = normalizeTaskExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.mode).toBe("normal");
  });

  it("rejects approvalsNeeded values above 1", () => {
    expect(() =>
      normalizeTaskExecutionPolicy({
        stages: [
          {
            type: "review",
            approvalsNeeded: 2,
            participants: [{ type: "agent", agentId: qaAgentId }],
          },
        ],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("throws for invalid input", () => {
    expect(() => normalizeTaskExecutionPolicy({ stages: [{ type: "invalid_type" }] })).toThrow();
  });

  it("keeps monitor-only policies", () => {
    const result = normalizeTaskExecutionPolicy({
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        externalRef: "https://example.test/deploy?token=secret",
      },
      stages: [],
    });
    expect(result).toMatchObject({
      stages: [],
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        scheduledBy: "owner",
        externalRef: "[redacted]",
      },
    });
  });

  it("rejects padded monitor identities rather than aliasing them", () => {
    for (const monitor of [
      { serviceName: " deployments" },
      { externalRef: "deploy-42 " },
    ]) {
      expect(() => normalizeTaskExecutionPolicy({
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          ...monitor,
        },
        stages: [],
      })).toThrow("Invalid execution policy");
    }
  });
});

describe("parseTaskExecutionState", () => {
  it("returns null for null/undefined", () => {
    expect(parseTaskExecutionState(null)).toBeNull();
    expect(parseTaskExecutionState(undefined)).toBeNull();
  });

  it("returns null for invalid shape", () => {
    expect(parseTaskExecutionState({ status: "bogus" })).toBeNull();
  });

  it("parses a valid state", () => {
    const state = parseTaskExecutionState({
      status: "pending",
      currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      returnOwner: { type: "agent", agentId: coderAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });
    expect(state).not.toBeNull();
    expect(state!.status).toBe("pending");
  });
});

describe("task execution policy transitions", () => {
  describe("happy path: executor → review → approval → done", () => {
    const policy = twoStagePolicy();

    it("routes executor completion into review", () => {
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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
      const started = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });
      expect(started.patch).not.toHaveProperty("ownerKind");
      expect(started.patch).not.toHaveProperty("ownerAgentId");
      expect(started.patch).not.toHaveProperty("ownerUserId");

      const reviewState = parseTaskExecutionState(started.patch.executionState);
      const reviewed = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: reviewState,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "Review approved",
      });
      expect(reviewed.patch).not.toHaveProperty("ownerKind");
      expect(reviewed.patch).not.toHaveProperty("ownerAgentId");
      expect(reviewed.patch).not.toHaveProperty("ownerUserId");

      const approvalState = parseTaskExecutionState(reviewed.patch.executionState);
      const approved = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: approvalState,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the migration",
        reviewRequest: { instructions: reviewInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        reviewRequest: { instructions: reviewInstructions },
      });
    });

    it("clears loose review instructions with explicit null during a stage transition", () => {
      const reviewStageId = policy.stages[0].id;
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            reviewRequest: { instructions: "Old review request" },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_review",
        requestedOwnerPatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
        reviewRequest: null,
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        reviewRequest: null,
      });
    });

    it("reviewer approves → advances to approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: qaAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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
        currentParticipant: { type: "user", userId: operatorUserId },
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
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: qaAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            reviewRequest: { instructions: "Review the implementation details." },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
        reviewRequest: { instructions: approvalInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: operatorUserId },
        reviewRequest: { instructions: approvalInstructions },
      });
    });

    it("approver approves → marks completed (allows done)", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: operatorUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 1,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: operatorUserId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: qaAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedOwnerPatch: {},
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
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "changes_requested",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
          },
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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

  describe("review-only policy (no approval stage)", () => {
    const policy = reviewOnlyPolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer approval completes the policy", () => {
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: qaAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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
        applyTaskExecutionPolicyTransition({
          task: {
            boardPresentationStatus: "in_review",
            ownerKind: "agent",
            ownerAgentId: qaAgentId,
            ownerUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnOwner: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedOwnerPatch: { ownerUserId: boardUserId },
          actor: { agentId: coderAgentId },
          commentBody: "Trying to bypass review",
        }),
      ).toThrow("Only the active reviewer or approver can advance");
    });

    it("non-participant can still post non-advancing updates", () => {
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: qaAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: undefined,
        requestedOwnerPatch: {},
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
        applyTaskExecutionPolicyTransition({
          task: {
            boardPresentationStatus: "in_review",
            ownerKind: "agent",
            ownerAgentId: qaAgentId,
            ownerUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnOwner: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedOwnerPatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "",
        }),
      ).toThrow("requires a comment");
    });

    it("changes requested without comment throws", () => {
      expect(() =>
        applyTaskExecutionPolicyTransition({
          task: {
            boardPresentationStatus: "in_review",
            ownerKind: "agent",
            ownerAgentId: qaAgentId,
            ownerUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnOwner: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "in_progress",
          requestedOwnerPatch: {},
          actor: { agentId: qaAgentId },
          commentBody: null,
        }),
      ).toThrow("requires a comment");
    });

    it("whitespace-only comment is treated as empty", () => {
      expect(() =>
        applyTaskExecutionPolicyTransition({
          task: {
            boardPresentationStatus: "in_review",
            ownerKind: "agent",
            ownerAgentId: qaAgentId,
            ownerUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnOwner: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedOwnerPatch: {},
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
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: qaAgentId,
          ownerUserId: null,
          executionPolicy: null,
          executionState: {
            status: "pending",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: null,
        requestedStatus: undefined,
        requestedOwnerPatch: {},
        actor: { agentId: qaAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.ownerAgentId).toBeUndefined();
      expect(result.patch.ownerUserId).toBeUndefined();
    });

    it("clears execution state without owner change when not in_review", () => {
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: null,
          executionState: {
            status: "changes_requested",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
          },
        },
        policy: null,
        requestedStatus: undefined,
        requestedOwnerPatch: {},
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
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "done",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
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
        },
        policy,
        requestedStatus: "todo",
        requestedOwnerPatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toBeNull();
    });
  });

  describe("no-op transitions", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-done status change without review context is a no-op", () => {
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "blocked",
        requestedOwnerPatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("coerces a malformed executor in_review patch into the first policy stage", () => {
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "in_review",
        requestedOwnerPatch: { ownerUserId: boardUserId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnOwner: { type: "agent", agentId: coderAgentId },
        },
      });
    });

    it("reasserts the active stage when task status drifted out of in_review", () => {
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
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
          currentParticipant: { type: "agent", agentId: qaAgentId },
        },
      });
    });

    it("no policy and no state is a no-op", () => {
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: null,
          executionState: null,
        },
        policy: null,
        requestedStatus: "done",
        requestedOwnerPatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("does not auto-start workflow when policy is added to an already in_review task", () => {
      const reviewOnly = reviewOnlyPolicy();
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: boardUserId,
          executionPolicy: null,
          executionState: null,
        },
        policy: reviewOnly,
        requestedStatus: undefined,
        requestedOwnerPatch: {},
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

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
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

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: operatorUserId },
          returnOwner: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
    });
  });

  describe("final stage completion terminates the policy (#7893)", () => {
    function threeStagePolicy() {
      return makePolicy([
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
        { type: "review", participants: [{ type: "agent", agentId: ctoAgentId }] },
        { type: "approval", participants: [{ type: "user", userId: operatorUserId }] },
      ]);
    }

    it("final-stage approval completes even when earlier completedStageIds are stale", () => {
      const policy = threeStagePolicy();
      const approvalStageId = policy.stages[2].id;
      // completedStageIds reference stage ids from a previous version of the
      // embedded policy (stage ids regenerate when the policy is re-sent or
      // edited mid-flow); only the active final stage id still matches.
      const staleStageIds = [
        "99999999-9999-4999-8999-999999999991",
        "99999999-9999-4999-8999-999999999992",
      ];
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: operatorUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 2,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: operatorUserId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: staleStageIds,
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: qaAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: firstStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: operatorUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 2,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: operatorUserId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [policy.stages[0].id, policy.stages[1].id],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedOwnerPatch: {},
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
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: operatorUserId,
          executionPolicy: policy,
          executionState: {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [
              "99999999-9999-4999-8999-999999999991",
              "99999999-9999-4999-8999-999999999992",
              "99999999-9999-4999-8999-999999999993",
            ],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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
        applyTaskExecutionPolicyTransition({
          task: {
            boardPresentationStatus: "in_review",
            ownerKind: "agent",
            ownerAgentId: qaAgentId,
            ownerUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnOwner: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "in_progress",
          requestedOwnerPatch: {},
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
      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "user",
          ownerAgentId: null,
          ownerUserId: operatorUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 1,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: operatorUserId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedOwnerPatch: {},
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
        { type: "review", participants: [{ type: "user", userId: boardUserId }] },
      ]);

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
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

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: qaAgentId,
          ownerUserId: null,
          executionPolicy: reviewAndApproval,
          executionState: {
            status: "pending",
            currentStageId: reviewAndApproval.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: approvalOnly,
        requestedStatus: undefined,
        requestedOwnerPatch: {},
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

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_review",
          ownerKind: "agent",
          ownerAgentId: qaAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: policy.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnOwner: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: {
          ...updatedPolicy,
          stages: [{ ...updatedPolicy.stages[0], id: policy.stages[0].id }],
        },
        requestedStatus: undefined,
        requestedOwnerPatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: ctoAgentId },
          returnOwner: { type: "agent", agentId: coderAgentId },
        },
      });
    });
  });

  describe("monitor policy", () => {
    it("schedules a one-shot monitor on an active agent-owned task", () => {
      const policy = normalizeTaskExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      })!;

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: null,
          executionState: null,
          monitorAttemptCount: 0,
          monitorNextCheckAt: null,
          monitorLastTriggeredAt: null,
          monitorNotes: null,
          monitorScheduledBy: null,
        },
        policy,
        previousPolicy: null,
        requestedOwnerPatch: {},
        actor: { userId: boardUserId },
        monitorExplicitlyUpdated: true,
      });

      expect(result.patch.monitorNextCheckAt).toEqual(new Date("2026-04-11T12:30:00.000Z"));
      expect(result.patch.monitorScheduledBy).toBe("board");
      expect(result.patch.executionState).toMatchObject({
        status: "idle",
        monitor: {
          status: "scheduled",
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      });
    });

    it("auto-clears a scheduled monitor when the task moves to done", () => {
      const policy = normalizeTaskExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "owner",
        },
      })!;

      const result = applyTaskExecutionPolicyTransition({
        task: {
          boardPresentationStatus: "in_progress",
          ownerKind: "agent",
          ownerAgentId: coderAgentId,
          ownerUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "idle",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnOwner: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-04-11T12:30:00.000Z",
              lastTriggeredAt: null,
              attemptCount: 0,
              notes: "Check deployment",
              scheduledBy: "owner",
              clearedAt: null,
              clearReason: null,
            },
          },
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: "Check deployment",
          monitorScheduledBy: "owner",
        },
        policy,
        previousPolicy: policy,
        requestedStatus: "done",
        requestedOwnerPatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionPolicy).toBeNull();
      expect(result.patch.monitorNextCheckAt).toBeNull();
      expect(result.patch.executionState).toMatchObject({
        monitor: {
          status: "cleared",
          clearReason: "done",
        },
      });
    });

    it("rejects explicitly scheduling a monitor on an invalid task state", () => {
      const policy = normalizeTaskExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
        },
      })!;

      expect(() =>
        applyTaskExecutionPolicyTransition({
          task: {
            boardPresentationStatus: "blocked",
            ownerKind: "agent",
            ownerAgentId: coderAgentId,
            ownerUserId: null,
            executionPolicy: null,
            executionState: null,
          },
          policy,
          previousPolicy: null,
          requestedOwnerPatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor can only be scheduled");
    });

    it("validates monitor eligibility from the checked owner kind and identifiers", () => {
      const policy = normalizeTaskExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          notes: "Check deployment",
        },
      })!;

      expect(() =>
        applyTaskExecutionPolicyTransition({
          task: {
            boardPresentationStatus: "in_progress",
            ownerKind: "user",
            ownerAgentId: coderAgentId,
            ownerUserId: boardUserId,
            executionPolicy: null,
            executionState: null,
          },
          policy,
          previousPolicy: null,
          requestedOwnerPatch: {},
          actor: { userId: boardUserId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor can only be scheduled");
    });

    it("rejects explicitly re-arming a monitor after max attempts are exhausted", () => {
      const policy = normalizeTaskExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          maxAttempts: 1,
          scheduledBy: "owner",
        },
      })!;

      expect(() =>
        applyTaskExecutionPolicyTransition({
          task: {
            boardPresentationStatus: "in_review",
            ownerKind: "agent",
            ownerAgentId: coderAgentId,
            ownerUserId: null,
            executionPolicy: null,
            executionState: null,
            monitorAttemptCount: 1,
            monitorNextCheckAt: null,
            monitorLastTriggeredAt: null,
            monitorNotes: null,
            monitorScheduledBy: "owner",
          },
          policy,
          previousPolicy: null,
          requestedOwnerPatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor bounds are already exhausted");
    });
  });
});
