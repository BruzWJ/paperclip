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
    {
      taskExecutionPolicy: {
        authorizationPolicy: {
          trustBoundary: {
            mode: "low_trust_review",
            taskIds: ["task-1"],
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
      }),
    ).toBeNull();
  });
});
