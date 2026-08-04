import { describe, expect, it } from "vitest";
import { AGENT_CONTEXT_GRANT_KEYS } from "@paperclipai/shared";
import {
  DENY_ALL_EXECUTION_CONTEXT_MASK,
  resolveExecutionModeContextMask,
} from "../services/execution-mode-context-mask.js";

describe("execution-mode context attenuation", () => {
  it.each([
    { workMode: "skill_test" },
    { harnessKind: "skill_test" },
    { originKind: "task_bridge" },
    { agentGovernance: { trustPreset: "low_trust_review" } },
    {
      agentGovernance: {
        authorizationPolicy: {
          reviewPreset: { id: "low_trust_review" },
        },
      },
    },
    {
      issueExecutionPolicy: {
        authorizationPolicy: {
          trustBoundary: {
            mode: "low_trust_review",
            issueIds: ["issue-1"],
          },
        },
      },
    },
  ])("fails closed for a restricted execution mode", (input) => {
    expect(resolveExecutionModeContextMask(input)).toEqual(
      DENY_ALL_EXECUTION_CONTEXT_MASK,
    );
    expect(
      AGENT_CONTEXT_GRANT_KEYS.every(
        (key) => resolveExecutionModeContextMask(input)?.[key] === false,
      ),
    ).toBe(true);
  });

  it("uses identity for an ordinary execution", () => {
    expect(
      resolveExecutionModeContextMask({
        workMode: "standard",
        harnessKind: null,
        originKind: "manual",
        agentGovernance: { trustPreset: "standard" },
      }),
    ).toBeNull();
  });

  it("does not accept a renamed issue_bridge alias", () => {
    expect(
      resolveExecutionModeContextMask({
        originKind: "issue_bridge",
      }),
    ).toBeNull();
  });
});
