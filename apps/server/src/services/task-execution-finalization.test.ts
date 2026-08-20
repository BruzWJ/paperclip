import { describe, expect, it } from "vitest";
import {
  buildTaskExecutionFinalizationPlan,
  TaskExecutionFinalizationRejected,
  type BuildTaskExecutionFinalizationPlanInput,
} from "./task-execution-finalization.js";

const base = {
  kind: "base" as const,
  refId: "ref-1",
  refOrdinal: 0,
};

function productive(
  patch: Partial<BuildTaskExecutionFinalizationPlanInput> = {},
): BuildTaskExecutionFinalizationPlanInput {
  return {
    companyId: "company-1",
    taskId: "task-1",
    runId: "run-1",
    runKind: "productive",
    action: "comment_only",
    expectedPromptIdentities: [base],
    promptDependencies: [
      {
        ...base,
        protocolSettlementState: "settled",
        settlementVersion: 1,
        accountingId: "accounting-1",
        costEventId: "cost-1",
      },
    ],
    terminalSessionEventId: "event-1",
    terminalSessionMessageId: "message-1",
    progressCommentId: "comment-1",
    runLivenessFactId: "liveness-1",
    gatewayRevocationRequired: true,
    gatewayRevocation: {
      capabilityConnectionId: "connection-1",
      capabilityGeneration: 1,
    },
    updates: [],
    ...patch,
  };
}

describe("task-execution finalization frontier", () => {
  it("derives a stable text-free digest and ordered dependency rows", () => {
    const first = buildTaskExecutionFinalizationPlan(productive());
    const second = buildTaskExecutionFinalizationPlan(productive());
    expect(first.finalizationIdentityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.finalizationIdentityDigest).toBe(
      first.finalizationIdentityDigest,
    );
    expect(first.promptDependencies).toEqual([
      expect.objectContaining({ dependencyOrdinal: 0, refId: "ref-1" }),
    ]);
  });

  it("rejects a missing, reordered, or extra prompt dependency", () => {
    expect(() =>
      buildTaskExecutionFinalizationPlan(
        productive({ expectedPromptIdentities: [] }),
      ),
    ).toThrowError(TaskExecutionFinalizationRejected);
  });

  it("enforces accounting and cost together only for settled prompts", () => {
    expect(() =>
      buildTaskExecutionFinalizationPlan(
        productive({
          promptDependencies: [
            {
              ...base,
              protocolSettlementState: "incomplete",
              settlementVersion: 1,
              accountingId: "accounting-1",
              costEventId: null,
            },
          ],
        }),
      ),
    ).toThrowError(TaskExecutionFinalizationRejected);
  });

  it("records ordered task-update identities", () => {
    const plan = buildTaskExecutionFinalizationPlan(
      productive({
        action: "updates_committed",
        terminalSessionMessageId: null,
        updates: [
          { taskUpdateId: "update-1" },
          { taskUpdateId: "update-2" },
        ],
      }),
    );
    expect(plan.updateDependencies).toEqual([
      { dependencyOrdinal: 0, taskUpdateId: "update-1" },
      { dependencyOrdinal: 1, taskUpdateId: "update-2" },
    ]);
    expect(plan).not.toHaveProperty("deliveryDependencies");
  });

  it("rejects missing gateway revocation when a productive capability existed", () => {
    expect(() =>
      buildTaskExecutionFinalizationPlan(
        productive({ gatewayRevocation: null }),
      ),
    ).toThrowError(TaskExecutionFinalizationRejected);
  });
});
