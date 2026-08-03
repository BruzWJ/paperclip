import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllIssueExecutionRunProgresses,
  clearIssueExecutionRunProgress,
  getIssueExecutionRunProgress,
  MAX_ISSUE_EXECUTION_RUN_PROGRESS_MESSAGE_CHARS,
  setIssueExecutionRunProgress,
  sweepExpiredIssueExecutionRunProgresses,
  touchIssueExecutionRunProgress,
} from "./issue-execution-run-progress.js";

describe("issue execution run progress store", () => {
  afterEach(() => {
    clearAllIssueExecutionRunProgresses();
  });

  it("stores scoped ephemeral status and expires stale entries", () => {
    const updatedAt = new Date("2026-06-24T00:00:00.000Z");
    const status = setIssueExecutionRunProgress({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      phase: "config_sync",
      message: `Syncing workspace with apiKey: "sk-test-secret" ${"x".repeat(300)}`,
      currentToolName: `bash apiKey: "sk-tool-secret" ${"x".repeat(120)}`,
      lastAssistantSnippet: `Reading apiKey: "sk-snippet-secret" ${"x".repeat(300)}`,
      lastEventAt: new Date("2026-06-24T00:00:05.000Z"),
      updatedAt,
    });

    expect(status?.message).toContain("***REDACTED***");
    expect(status?.message.length).toBeLessThanOrEqual(MAX_ISSUE_EXECUTION_RUN_PROGRESS_MESSAGE_CHARS);
    expect(status?.currentToolName).toContain("***REDACTED***");
    expect(status?.lastAssistantSnippet).toContain("***REDACTED***");
    expect(status?.lastEventAt).toEqual(new Date("2026-06-24T00:00:05.000Z"));
    expect(getIssueExecutionRunProgress("run-1", {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      now: new Date("2026-06-24T00:00:30.000Z"),
    })).toMatchObject({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      phase: "config_sync",
      currentToolName: expect.stringContaining("***REDACTED***"),
      lastAssistantSnippet: expect.stringContaining("***REDACTED***"),
      lastEventAt: new Date("2026-06-24T00:00:05.000Z"),
    });
    expect(getIssueExecutionRunProgress("run-1", { companyId: "other-company" })).toBeNull();
    expect(getIssueExecutionRunProgress("run-1", {
      companyId: "company-1",
      now: new Date("2026-06-24T00:02:00.001Z"),
    })).toBeNull();
    expect(getIssueExecutionRunProgress("run-1")).toBeNull();
  });

  it("clears status explicitly", () => {
    setIssueExecutionRunProgress({
      companyId: "company-1",
      issueId: null,
      agentId: "agent-1",
      runId: "run-1",
      phase: "finalize",
      message: "Finalizing sandbox workspace",
    });

    expect(clearIssueExecutionRunProgress("run-1")).toBe(true);
    expect(getIssueExecutionRunProgress("run-1")).toBeNull();
  });

  it("touch refreshes timestamps while preserving the existing status context", () => {
    setIssueExecutionRunProgress({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      phase: "run_activity",
      message: "Using Bash",
      currentToolName: "Bash",
      lastAssistantSnippet: "Running the tests",
      updatedAt: new Date("2026-06-24T00:00:00.000Z"),
      lastEventAt: new Date("2026-06-24T00:00:00.000Z"),
    });

    const touched = touchIssueExecutionRunProgress({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      at: new Date("2026-06-24T00:00:45.000Z"),
    });

    expect(touched).toMatchObject({
      runId: "run-1",
      phase: "run_activity",
      message: "Using Bash",
      currentToolName: "Bash",
      lastAssistantSnippet: "Running the tests",
      updatedAt: new Date("2026-06-24T00:00:45.000Z"),
      lastEventAt: new Date("2026-06-24T00:00:45.000Z"),
    });
    expect(getIssueExecutionRunProgress("run-1", {
      companyId: "company-1",
      now: new Date("2026-06-24T00:02:00.000Z"),
    })).toMatchObject({ message: "Using Bash" });
  });

  it("touch does not move timestamps backwards", () => {
    setIssueExecutionRunProgress({
      companyId: "company-1",
      issueId: null,
      agentId: "agent-1",
      runId: "run-1",
      phase: "run_activity",
      message: "Using Bash",
      updatedAt: new Date("2026-06-24T00:01:00.000Z"),
      lastEventAt: new Date("2026-06-24T00:01:00.000Z"),
    });

    const touched = touchIssueExecutionRunProgress({
      companyId: "company-1",
      issueId: null,
      agentId: "agent-1",
      runId: "run-1",
      at: new Date("2026-06-24T00:00:30.000Z"),
    });

    expect(touched).toMatchObject({
      updatedAt: new Date("2026-06-24T00:01:00.000Z"),
      lastEventAt: new Date("2026-06-24T00:01:00.000Z"),
    });
  });

  it("touch creates a fallback run_activity status when none is live", () => {
    const created = touchIssueExecutionRunProgress({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      at: new Date("2026-06-24T00:00:00.000Z"),
    });

    expect(created).toMatchObject({
      runId: "run-1",
      phase: "run_activity",
      message: "Receiving agent output",
      updatedAt: new Date("2026-06-24T00:00:00.000Z"),
      lastEventAt: new Date("2026-06-24T00:00:00.000Z"),
    });

    // An expired entry is replaced with a fresh fallback rather than revived.
    const expiredTouch = touchIssueExecutionRunProgress({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      at: new Date("2026-06-24T00:05:00.000Z"),
    });
    expect(expiredTouch).toMatchObject({
      phase: "run_activity",
      message: "Receiving agent output",
      updatedAt: new Date("2026-06-24T00:05:00.000Z"),
    });
  });

  it("sweeps expired statuses without touching fresh entries", () => {
    setIssueExecutionRunProgress({
      companyId: "company-1",
      issueId: null,
      agentId: "agent-1",
      runId: "stale-run",
      phase: "git_sync",
      message: "Syncing stale workspace",
      updatedAt: new Date("2026-06-24T00:00:00.000Z"),
    });
    setIssueExecutionRunProgress({
      companyId: "company-1",
      issueId: null,
      agentId: "agent-1",
      runId: "fresh-run",
      phase: "git_sync",
      message: "Syncing fresh workspace",
      updatedAt: new Date("2026-06-24T00:01:00.000Z"),
    });

    const now = new Date("2026-06-24T00:01:31.000Z");
    expect(sweepExpiredIssueExecutionRunProgresses(now)).toBe(1);
    expect(getIssueExecutionRunProgress("stale-run")).toBeNull();
    expect(getIssueExecutionRunProgress("fresh-run", { now })).toMatchObject({ runId: "fresh-run" });
  });
});
