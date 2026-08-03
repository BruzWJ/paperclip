import type { IssueExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { collectLiveIssueIds, collectSubtreeLiveCounts } from "./liveIssueIds";

function run(
  id: string,
  issueId: string,
  status: IssueExecutionRunEnvelopeRecord["status"],
): IssueExecutionRunEnvelopeRecord {
  return {
    id,
    companyId: "company-1",
    issueId,
    sessionId: `session-${id}`,
    executionScopeId: `scope-${id}`,
    kind: "productive",
    status,
    ownershipEpoch: 1,
    targetAgentId: "agent-1",
    adapterConfigRevisionId: "revision-1",
    executionWorkspaceBindingId: "binding-1",
    executionMode: "owner",
    issueExecutionAuthorityId: null,
    consultExecutionId: null,
    compactionScopeKind: null,
    parentRunId: null,
    retryOfRunId: null,
    triggeredByRunId: null,
    currentAttemptId: null,
    currentLeaseId: null,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: status === "queued" ? null : "2026-07-31T12:00:00.000Z",
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    processExitCode: null,
    processSignal: null,
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
  };
}

describe("collectLiveIssueIds", () => {
  it("keeps only canonical active run envelopes", () => {
    expect(
      [...collectLiveIssueIds([
        run("run-1", "issue-1", "running"),
        run("run-2", "issue-2", "scheduled_retry"),
        run("run-3", "issue-3", "succeeded"),
      ])],
    ).toEqual(["issue-1", "issue-2"]);
  });
});

describe("collectSubtreeLiveCounts", () => {
  const tree = [
    { id: "root", parentId: null },
    { id: "child-a", parentId: "root" },
    { id: "child-b", parentId: "root" },
    { id: "grandchild", parentId: "child-a" },
  ];

  it("rolls live descendants up without crediting the issue itself", () => {
    const counts = collectSubtreeLiveCounts(tree, new Set(["grandchild"]));
    expect(counts.get("root")).toBe(1);
    expect(counts.get("child-a")).toBe(1);
    expect(counts.has("grandchild")).toBe(false);
  });

  it("ignores ids outside the loaded tree", () => {
    expect(
      collectSubtreeLiveCounts(tree, new Set(["not-loaded"])).size,
    ).toBe(0);
  });
});
