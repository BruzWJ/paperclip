import { describe, expect, it } from "vitest";
import type { ExecutionWorkspace, Issue } from "@paperclipai/shared";
import { buildSubIssueDefaults, buildSubIssueDefaultsForViewer } from "./subIssueDefaults";
import { createTestExecutionWorkspace, createTestIssue } from "../test-utils/issue";

function makeExecutionWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return createTestExecutionWorkspace({
    id: "workspace-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    name: "Parent workspace",
    cwd: "/tmp/workspace-1",
    branchName: "feature/pap-1",
    openedAt: new Date("2026-04-07T00:00:00.000Z"),
    lastUsedAt: new Date("2026-04-07T00:00:00.000Z"),
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    ...overrides,
  });
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return createTestIssue({
    identifier: "PAP-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    goalId: "goal-1",
    title: "Parent issue",
    executionWorkspacePreference: "shared_workspace",
    currentExecutionWorkspace: null,
    ...overrides,
  });
}

describe("buildSubIssueDefaults", () => {
  it("inherits the parent agent owner and workspace context", () => {
    const defaults = buildSubIssueDefaults(
      makeIssue({
        ownerAgentId: "agent-1",
        currentExecutionWorkspace: makeExecutionWorkspace(),
      }),
    );

    expect(defaults).toEqual({
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      projectId: "project-1",
      projectWorkspaceId: "project-workspace-1",
      goalId: "goal-1",
      executionWorkspaceId: "workspace-1",
      executionWorkspaceMode: "reuse_existing",
      parentExecutionWorkspaceLabel: "Parent workspace",
      ownerAgentId: "agent-1",
    });
  });

  it("does not copy an exceptional non-agent owner to an ordinary sub-issue", () => {
    const defaults = buildSubIssueDefaultsForViewer(makeIssue());

    expect(defaults).toEqual({
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      projectId: "project-1",
      projectWorkspaceId: "project-workspace-1",
      goalId: "goal-1",
      executionWorkspaceMode: "shared_workspace",
    });
  });
});
