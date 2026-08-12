import { afterEach, describe, expect, it, vi } from "vitest";
import {
  taskExecutionPolicySchema,
  type TaskExecutionPolicy,
} from "@paperclipai/shared";
import { buildExecutionPolicy } from "./task-execution-policy";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("buildExecutionPolicy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates schema-valid UUIDs when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });

    const policy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:00000000-0000-4000-8000-000000000002"],
    });

    expect(policy).not.toBeNull();
    expect(taskExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy?.stages).toHaveLength(2);

    for (const stage of policy?.stages ?? []) {
      expect(stage.id).toMatch(UUID_PATTERN);
      expect(stage.participants).toHaveLength(1);
      expect(stage.participants[0]?.id).toMatch(UUID_PATTERN);
    }
  });

  it("preserves the canonical low-trust policy while editing review stages", () => {
    const existingPolicy: TaskExecutionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [],
      reviewPreset: {
        id: "low_trust_review",
        version: 1,
        rawOutputDisposition: "quarantine",
      },
      authorizationPolicy: {
        managedBy: "permissions-extension",
        trustBoundary: {
          mode: "low_trust_review",
          rootTaskId: "00000000-0000-4000-8000-000000000003",
        },
      },
    };

    const policy = buildExecutionPolicy({
      existingPolicy,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: [],
    });

    expect(policy?.reviewPreset).toEqual(existingPolicy.reviewPreset);
    expect(policy?.authorizationPolicy).toEqual(
      existingPolicy.authorizationPolicy,
    );
    expect(taskExecutionPolicySchema.safeParse(policy).success).toBe(true);
  });
});
