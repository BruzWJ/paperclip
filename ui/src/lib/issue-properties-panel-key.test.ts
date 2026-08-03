import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildIssuePropertiesPanelKey } from "./issue-properties-panel-key";
import { createTestExecutionWorkspace, createTestIssue } from "../test-utils/issue";

function createIssue(overrides: Partial<Issue> = {}) {
  return createTestIssue({
    boardPresentationStatus: "in_progress",
    ownerAgentId: "agent-1",
    projectId: "project-1",
    labelIds: ["label-1"],
    executionPolicy: null,
    executionState: null,
    currentExecutionWorkspace: null,
    blocks: [],
    blockedBy: [],
    ancestors: [],
    updatedAt: new Date("2026-04-12T12:00:00.000Z"),
    ...overrides,
  });
}

describe("buildIssuePropertiesPanelKey", () => {
  it("ignores plain updatedAt churn", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({ updatedAt: new Date("2026-04-12T12:05:00.000Z") }),
      [],
    );

    expect(second).toBe(first);
  });

  it("changes when a displayed property changes", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({ ownerAgentId: "agent-2" }),
      [],
    );

    expect(second).not.toBe(first);
  });

  it("changes when watchdog configuration changes", () => {
    const first = buildIssuePropertiesPanelKey(createIssue({ watchdog: null }), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({
        watchdog: {
          id: "watchdog-1",
          companyId: "company-1",
          issueId: "issue-1",
          status: "active",
          lastObservedFingerprint: null,
          lastTriggeredAt: null,
          triggerCount: 0,
          createdAt: new Date("2026-04-12T12:01:00.000Z"),
          updatedAt: new Date("2026-04-12T12:01:00.000Z"),
        },
      }),
      [],
    );

    expect(second).not.toBe(first);
  });

  it("changes when workspace detail hydrates after opening from a cached issue", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        currentExecutionWorkspace: createTestExecutionWorkspace({
          id: "workspace-1",
          projectId: "project-1",
          projectWorkspaceId: "project-workspace-1",
          sourceIssueId: "issue-1",
          name: "PAP-1 workspace",
          cwd: "/tmp/paperclip/PAP-1",
          baseRef: "master",
          branchName: "PAP-1-workspace",
          providerType: "git_worktree",
          providerRef: "/tmp/paperclip/PAP-1",
          lastUsedAt: new Date("2026-04-12T12:01:00.000Z"),
          openedAt: new Date("2026-04-12T12:01:00.000Z"),
          createdAt: new Date("2026-04-12T12:01:00.000Z"),
          updatedAt: new Date("2026-04-12T12:01:00.000Z"),
        }),
      }),
      [],
    );

    expect(second).not.toBe(first);
  });
});
