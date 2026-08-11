import { describe, expect, it } from "vitest";
import {
  type LowTrustBoundary,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  LOW_TRUST_REVIEW_PRESET,
} from "@paperclipai/shared";
import { normalizeTaskExecutionPolicy } from "../services/task-execution-policy.js";
import {
  isTaskWithinLowTrustBoundary,
  resolveCoreTrustPreset,
} from "../services/trust-preset-resolver.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const projectA = "33333333-3333-4333-8333-333333333333";
const projectB = "44444444-4444-4444-8444-444444444444";
const projectC = "55555555-5555-4555-8555-555555555555";
const rootTaskId = "66666666-6666-4666-8666-666666666666";
const taskA = "77777777-7777-4777-8777-777777777777";
const taskB = "88888888-8888-4888-8888-888888888888";
const taskC = "99999999-9999-4999-8999-999999999999";
const agentA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentB = "bbbbbbbb-bbbb-8bbb-bbbb-bbbbbbbbbbbb";

function lowTrustBoundary(input: Partial<Omit<LowTrustBoundary, "mode">>): LowTrustBoundary {
  return {
    mode: LOW_TRUST_REVIEW_PRESET,
    companyId,
    ...input,
  };
}

describe("resolveCoreTrustPreset", () => {
  it("defaults to standard with no task or run policy", () => {
    expect(resolveCoreTrustPreset({ companyId })).toMatchObject({
      kind: "standard",
      preset: "standard",
      boundary: null,
    });
  });

  it("intersects low-trust task and run policy boundaries", () => {
    const result = resolveCoreTrustPreset({
      companyId,
      task: {
        companyId,
        executionPolicy: {
          trustPreset: LOW_TRUST_REVIEW_PRESET,
          authorizationPolicy: {
            managedBy: "core-trust-preset",
            trustBoundary: lowTrustBoundary({
              projectIds: [projectA, projectB],
              rootTaskId,
              taskIds: [taskA, taskB],
              allowedAgentIds: [agentA, agentB],
              allowedToolClasses: ["git.read", "tests.local"],
            }),
          },
        },
      },
      run: {
        companyId,
        executionPolicy: {
          authorizationPolicy: {
            trustBoundary: lowTrustBoundary({
              taskIds: [taskB],
              allowedToolClasses: ["git.read", "github.pr.read"],
            }),
          },
        },
      },
    });

    expect(result.kind).toBe("low_trust_review");
    if (result.kind !== "low_trust_review") throw new Error("expected low-trust result");
    expect(result.boundary).toMatchObject({
      companyId,
      mode: LOW_TRUST_REVIEW_PRESET,
      rootTaskId,
      projectIds: [projectA, projectB],
      taskIds: [taskB],
      allowedAgentIds: [agentA, agentB],
      allowedToolClasses: ["git.read"],
    });
    expect(isTaskWithinLowTrustBoundary(result.boundary, { companyId, id: taskB, projectId: projectB })).toBe(true);
    expect(isTaskWithinLowTrustBoundary(result.boundary, { companyId, id: taskC, projectId: projectC })).toBe(false);
  });

  it("fails closed for unknown task presets", () => {
    const result = resolveCoreTrustPreset({
      companyId,
      task: {
        companyId,
        executionPolicy: { trustPreset: "trusted_but_weird" },
      },
    });

    expect(result).toMatchObject({
      kind: "denied",
      reason: "unsupported_trust_preset",
      source: "task",
    });
  });

  it("fails closed when low-trust has no concrete task scope", () => {
    const result = resolveCoreTrustPreset({
      companyId,
      task: {
        companyId,
        executionPolicy: {
          trustPreset: LOW_TRUST_REVIEW_PRESET,
          authorizationPolicy: {
            trustBoundary: lowTrustBoundary({ allowedToolClasses: ["git.read"] }),
          },
        },
      },
    });

    expect(result).toMatchObject({
      kind: "denied",
      reason: "missing_low_trust_boundary_scope",
    });
  });

  it("denies cross-company task policy boundaries", () => {
    const result = resolveCoreTrustPreset({
      companyId,
      task: {
        companyId,
        executionPolicy: {
          authorizationPolicy: {
            trustBoundary: {
              mode: LOW_TRUST_REVIEW_PRESET,
              companyId: otherCompanyId,
              rootTaskId,
            },
          },
        },
      },
    });
    expect(result).toMatchObject({
      kind: "denied",
      reason: "cross_company_boundary",
      source: "task",
    });
  });

  it("normalizes and preserves task trust policy JSON", () => {
    const executionPolicy = normalizeTaskExecutionPolicy({
      reviewPreset: {
        id: LOW_TRUST_REVIEW_PRESET,
        version: 1,
        rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
      },
      authorizationPolicy: {
        managedBy: "core-trust-preset",
        customEeField: { mode: "visualized" },
        trustBoundary: lowTrustBoundary({ rootTaskId }),
      },
    });

    expect(executionPolicy).toMatchObject({
      stages: [],
      reviewPreset: {
        id: LOW_TRUST_REVIEW_PRESET,
        rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
      },
      authorizationPolicy: {
        managedBy: "core-trust-preset",
        customEeField: { mode: "visualized" },
        trustBoundary: { rootTaskId },
      },
    });
  });
});
