import { describe, expect, it } from "vitest";
import { AGENT_CONTEXT_GRANT_KEYS } from "@paperclipai/shared";
import {
  DENY_ALL_EXECUTION_CONTEXT_MASK,
  resolveExecutionModeContextMask,
} from "../services/execution-mode-context-mask.js";

describe("execution-mode context attenuation", () => {
  it("fails closed for a low-trust execution policy", () => {
    const input = {
      taskExecutionPolicy: {
        reviewPreset: {
          id: "low_trust_review" as const,
          version: 1 as const,
          rawOutputDisposition: "quarantine" as const,
        },
        authorizationPolicy: {
          trustBoundary: {
            mode: "low_trust_review" as const,
            taskIds: ["task-1"],
          },
        },
      },
    };
    expect(resolveExecutionModeContextMask(input)).toEqual(
      DENY_ALL_EXECUTION_CONTEXT_MASK,
    );
    expect(
      AGENT_CONTEXT_GRANT_KEYS.every(
        (key) => resolveExecutionModeContextMask(input)?.[key] === false,
      ),
    ).toBe(true);
  });

  it("does not interpret retired preset locations as execution modes", () => {
    for (const taskExecutionPolicy of [
      { trustPreset: "low_trust_review" },
      {
        authorizationPolicy: {
          reviewPreset: {
            id: "low_trust_review",
            version: 1,
            rawOutputDisposition: "quarantine",
          },
        },
      },
      {
        authorizationPolicy: {
          trustBoundary: { mode: "low_trust_review", taskIds: ["task-1"] },
        },
      },
    ]) {
      expect(resolveExecutionModeContextMask({ taskExecutionPolicy })).toBeNull();
    }
  });

  it("uses identity for an ordinary execution", () => {
    expect(resolveExecutionModeContextMask({})).toBeNull();
  });
});
