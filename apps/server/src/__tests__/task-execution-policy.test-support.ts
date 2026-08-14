import { describe, expect, it } from "vitest";
import {
  applyTaskExecutionPolicyTransition,
  normalizeTaskExecutionPolicy,
  parseTaskExecutionState,
} from "../services/task-execution-policy.ts";
export const coderAgentId = "11111111-1111-4111-8111-111111111111";
export const qaAgentId = "22222222-2222-4222-8222-222222222222";
export const ctoAgentId = "33333333-3333-4333-8333-333333333333";
export const operatorUserId = "operator-user";
export const boardUserId = "board-user";

type PolicyTransitionInput = Parameters<typeof applyTaskExecutionPolicyTransition>[0];
type PolicyTask = PolicyTransitionInput["task"];

export function policyTask(
  executionPolicy: PolicyTask["executionPolicy"],
  overrides: Partial<PolicyTask> = {},
): PolicyTask {
  return {
    boardPresentationStatus: "in_progress",
    ownerKind: "agent",
    ownerAgentId: coderAgentId,
    ownerUserId: null,
    executionPolicy,
    executionState: null,
    ...overrides,
  };
}

export function reviewState(currentStageId: string, overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    currentStageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: qaAgentId },
    returnOwner: { type: "agent", agentId: coderAgentId },
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

export function transition(
  policy: PolicyTransitionInput["policy"],
  input: Omit<PolicyTransitionInput, "policy" | "requestedOwnerPatch"> & {
    requestedOwnerPatch?: PolicyTransitionInput["requestedOwnerPatch"];
  },
) {
  return applyTaskExecutionPolicyTransition({
    ...input,
    policy,
    requestedOwnerPatch: input.requestedOwnerPatch ?? {},
  });
}

export function makePolicy(
  stages: Array<{
    type: "review" | "approval";
    participants: Array<{
      type: "agent" | "user";
      agentId?: string;
      userId?: string;
    }>;
  }>,
) {
  return normalizeTaskExecutionPolicy({ stages })!;
}

export function twoStagePolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
    {
      type: "approval",
      participants: [{ type: "user", userId: operatorUserId }],
    },
  ]);
}

export function reviewOnlyPolicy() {
  return makePolicy([{ type: "review", participants: [{ type: "agent", agentId: qaAgentId }] }]);
}

export function approvalOnlyPolicy() {
  return makePolicy([
    {
      type: "approval",
      participants: [{ type: "user", userId: operatorUserId }],
    },
  ]);
}

export { describe, expect, it, applyTaskExecutionPolicyTransition };
export { normalizeTaskExecutionPolicy, parseTaskExecutionState };
