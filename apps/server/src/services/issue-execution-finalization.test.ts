import { describe, expect, it } from "vitest";
import {
  buildIssueExecutionFinalizationPlan,
  IssueExecutionFinalizationRejected,
  type BuildIssueExecutionFinalizationPlanInput,
} from "./issue-execution-finalization.js";
import {
  resolveMentionResponseDirectParent,
} from "./issue-execution-finalization-postgres.js";

const base = {
  kind: "base" as const,
  refId: "ref-1",
  refOrdinal: 0,
  segmentOrdinal: 0 as const,
};

function productive(
  patch: Partial<BuildIssueExecutionFinalizationPlanInput> = {},
): BuildIssueExecutionFinalizationPlanInput {
  return {
    companyId: "company-1",
    issueId: "issue-1",
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

describe("issue-execution finalization frontier", () => {
  it("routes mention responses exactly one parent hop toward the issue owner", () => {
    const hierarchy = [
      { id: "owner", reportsTo: null },
      { id: "manager", reportsTo: "owner" },
      { id: "leaf", reportsTo: "manager" },
      { id: "other-root", reportsTo: null },
    ];

    expect(
      resolveMentionResponseDirectParent(hierarchy, "leaf", "owner"),
    ).toBe("manager");
    expect(
      resolveMentionResponseDirectParent(hierarchy, "manager", "owner"),
    ).toBe("owner");
    expect(
      resolveMentionResponseDirectParent(hierarchy, "owner", "owner"),
    ).toBeNull();
    expect(
      resolveMentionResponseDirectParent(hierarchy, "leaf", "other-root"),
    ).toBeNull();
  });

  it("derives a stable text-free digest and ordered dependency rows", () => {
    const first = buildIssueExecutionFinalizationPlan(productive());
    const second = buildIssueExecutionFinalizationPlan(productive());
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
      buildIssueExecutionFinalizationPlan(
        productive({ expectedPromptIdentities: [] }),
      ),
    ).toThrowError(IssueExecutionFinalizationRejected);
  });

  it("enforces accounting and cost together only for settled prompts", () => {
    expect(() =>
      buildIssueExecutionFinalizationPlan(
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
    ).toThrowError(IssueExecutionFinalizationRejected);
  });

  it("requires one delivery identity for every updates-committed dependency", () => {
    const plan = buildIssueExecutionFinalizationPlan(
      productive({
        action: "updates_committed",
        terminalSessionMessageId: null,
        updates: [
          { issueUpdateId: "update-1", creatorDeliveryId: "delivery-1" },
          { issueUpdateId: "update-2", creatorDeliveryId: "delivery-2" },
        ],
      }),
    );
    expect(plan.updateDependencies.map((row) => row.issueUpdateId)).toEqual([
      "update-1",
      "update-2",
    ]);
    expect(
      plan.deliveryDependencies.map((row) => row.creatorDeliveryId),
    ).toEqual(["delivery-1", "delivery-2"]);
  });

  it("rejects missing gateway revocation when a productive capability existed", () => {
    expect(() =>
      buildIssueExecutionFinalizationPlan(
        productive({ gatewayRevocation: null }),
      ),
    ).toThrowError(IssueExecutionFinalizationRejected);
  });
});
