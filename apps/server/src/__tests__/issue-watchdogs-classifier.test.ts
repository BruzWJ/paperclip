import { describe, expect, it } from "vitest";
import { classifyIssueWatchdogSubtree, type IssueWatchdogClassifierIssue } from "../services/issue-watchdogs.ts";

const companyId = "company-1";
const sourceId = "source-1";
const childId = "child-1";
const watchdogId = "watchdog-1";

function issue(overrides: Partial<IssueWatchdogClassifierIssue> = {}): IssueWatchdogClassifierIssue {
  return {
    id: sourceId,
    companyId,
    identifier: "PAP-1",
    title: "Source",
    boardPresentationStatus: "todo",
    parentId: null,
    ownerAgentId: "agent-1",
    ownerUserId: null,
    originKind: "manual",
    updatedAt: new Date("2026-06-17T20:00:00.000Z"),
    ...overrides,
  };
}

function classify(overrides: Partial<Parameters<typeof classifyIssueWatchdogSubtree>[0]> = {}) {
  return classifyIssueWatchdogSubtree({
    watchdog: {
      companyId,
      issueId: sourceId,
    },
    issues: [issue()],
    ...overrides,
  });
}

describe("task safeguard subtree classifier", () => {
  it("suppresses safeguard nudges while watched subtree work has a live path", () => {
    const result = classify({
      issues: [
        issue(),
        issue({
          id: childId,
          identifier: "PAP-2",
          parentId: sourceId,
          boardPresentationStatus: "in_progress",
        }),
      ],
      activeRuns: [{ companyId, issueId: childId, agentId: "agent-1", status: "running" }],
    });

    expect(result).toMatchObject({
      state: "live",
      liveIssueIds: [childId],
    });
  });

  it("treats terminal and waiting leaves as stopped work that needs verification", () => {
    const result = classify({
      issues: [
        issue({ boardPresentationStatus: "done" }),
        issue({
          id: childId,
          identifier: "PAP-2",
          parentId: sourceId,
          boardPresentationStatus: "in_review",
        }),
      ],
      pendingApprovals: [{ companyId, issueId: childId, id: "approval-1", status: "pending" }],
    });

    expect(result.state).toBe("stopped");
    if (result.state !== "stopped") return;
    expect(result.stopFingerprint).toMatch(/^issue_watchdog_stop:/);
    expect(result.stoppedLeaves).toEqual([
      expect.objectContaining({
        issueId: childId,
        boardPresentationStatus: "in_review",
        pendingApprovalIds: ["approval-1"],
      }),
    ]);
  });

  it("classifies every visible descendant without origin-kind exclusions", () => {
    const result = classify({
      issues: [
        issue({ boardPresentationStatus: "done" }),
        issue({
          id: watchdogId,
          identifier: "PAP-3",
          title: "Watchdog",
          parentId: sourceId,
          originKind: "issue_watchdog",
          boardPresentationStatus: "in_progress",
        }),
        issue({
          id: "watchdog-child-1",
          identifier: "PAP-4",
          title: "Nested watchdog work",
          parentId: watchdogId,
          originKind: "manual",
          boardPresentationStatus: "in_progress",
        }),
      ],
      activeRuns: [{ companyId, issueId: "watchdog-child-1", agentId: "agent-1", status: "running" }],
    });

    expect(result).toMatchObject({
      state: "live",
      includedIssueIds: [sourceId, watchdogId, "watchdog-child-1"],
      liveIssueIds: ["watchdog-child-1"],
    });
  });

  it("defers a stopped verdict for an issue created inside the first-run grace window", () => {
    const createdAt = new Date("2026-06-18T16:32:45.731Z");
    const result = classify({
      issues: [issue({ boardPresentationStatus: "todo", createdAt })],
      // Evaluation races the issue's own assignment run ~100ms after creation.
      evaluatedAt: new Date("2026-06-18T16:32:45.835Z"),
      firstRunGraceMs: 15_000,
    });

    expect(result.state).toBe("pending_first_run");
    if (result.state !== "pending_first_run") return;
    expect(result.pendingIssueIds).toEqual([sourceId]);
  });

  it("does not defer when a recently-created issue already completed a run", () => {
    const createdAt = new Date("2026-06-18T16:32:45.731Z");
    const result = classify({
      issues: [issue({ boardPresentationStatus: "blocked", createdAt })],
      evaluatedAt: new Date("2026-06-18T16:32:48.000Z"),
      firstRunGraceMs: 15_000,
      completedRunIssueIds: [sourceId],
    });

    expect(result.state).toBe("stopped");
  });

  it("treats a queued assignment run inside the create-race window as live", () => {
    const createdAt = new Date("2026-06-18T16:32:45.731Z");
    const result = classify({
      issues: [issue({ boardPresentationStatus: "todo", createdAt })],
      activeRuns: [{ companyId, issueId: sourceId, agentId: "agent-1", status: "queued" }],
      evaluatedAt: new Date("2026-06-18T16:32:45.835Z"),
      firstRunGraceMs: 15_000,
    });

    expect(result).toMatchObject({ state: "live", liveIssueIds: [sourceId] });
  });

  it("treats a pending persisted dispatch ref inside the create-race window as live", () => {
    const createdAt = new Date("2026-06-18T16:32:45.731Z");
    const result = classify({
      issues: [issue({ boardPresentationStatus: "todo", createdAt })],
      pendingDispatchRefs: [{ companyId, issueId: sourceId, agentId: "agent-1", status: "available" }],
      evaluatedAt: new Date("2026-06-18T16:32:45.835Z"),
      firstRunGraceMs: 15_000,
    });

    expect(result).toMatchObject({ state: "live", liveIssueIds: [sourceId] });
  });

  it("triggers a genuinely idle assigned issue once the grace window has elapsed", () => {
    const createdAt = new Date("2026-06-18T16:32:45.731Z");
    const result = classify({
      issues: [issue({ boardPresentationStatus: "todo", createdAt })],
      // 60s later: no run, no wake, past the grace window.
      evaluatedAt: new Date("2026-06-18T16:33:45.731Z"),
      firstRunGraceMs: 15_000,
    });

    expect(result.state).toBe("stopped");
  });

  it("reports a missing watched source as not applicable", () => {
    const result = classify({
      watchdog: {
        companyId,
        issueId: watchdogId,
      },
      issues: [issue()],
    });

    expect(result.state).toBe("not_applicable");
  });
});
