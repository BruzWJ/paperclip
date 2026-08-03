import type { ExecutionWorkspace, Issue } from "@paperclipai/shared";

export type TestIssueOverrides = {
  [Key in keyof Issue]?: Issue[Key];
};

type TestIssueOwnerKey =
  | "ownerKind"
  | "ownerAgentId"
  | "ownerUserId"
  | "ownerAssignmentSource";

type TestIssueCreatorKey =
  | "creatorKind"
  | "creatorAuthorityId"
  | "creatorAdapterConfigRevisionId"
  | "creatorUserId"
  | "creatorPluginInstallationId"
  | "creatorPluginKey"
  | "creatorCallbackKey"
  | "creatorCallbackVersion"
  | "creatorRoutineId"
  | "creatorRoutineDispatchId"
  | "creatorSystemSourceKind"
  | "creatorSystemSourceId";

type TestIssueOwner =
  | Pick<Extract<Issue, { ownerKind: "agent" }>, TestIssueOwnerKey>
  | Pick<Extract<Issue, { ownerKind: "user" }>, TestIssueOwnerKey>
  | Pick<Extract<Issue, { ownerKind: "board" }>, TestIssueOwnerKey>;

type TestIssueCreator =
  | Pick<Extract<Issue, { creatorKind: "agent-execution" }>, TestIssueCreatorKey>
  | Pick<Extract<Issue, { creatorKind: "user/board" }>, TestIssueCreatorKey>
  | Pick<Extract<Issue, { creatorKind: "plugin" }>, TestIssueCreatorKey>
  | Pick<Extract<Issue, { creatorKind: "routine" }>, TestIssueCreatorKey>
  | Pick<Extract<Issue, { creatorKind: "system" }>, TestIssueCreatorKey>;

type TestIssueBase = Omit<
  Issue,
  TestIssueOwnerKey | TestIssueCreatorKey
>;

function composeTestIssue<
  Owner extends TestIssueOwner,
  Creator extends TestIssueCreator,
>(
  base: TestIssueBase,
  owner: Owner,
  creator: Creator,
): Issue {
  return { ...base, ...owner, ...creator };
}

function lifecycleStatusFor(
  boardPresentationStatus: Issue["boardPresentationStatus"],
): Issue["lifecycleStatus"] {
  if (
    boardPresentationStatus === "done" ||
    boardPresentationStatus === "cancelled" ||
    boardPresentationStatus === "blocked"
  ) {
    return boardPresentationStatus;
  }
  return "open";
}

function ownerFields(overrides: TestIssueOverrides): TestIssueOwner {
  if (overrides.ownerAgentId) {
    return {
      ownerKind: "agent",
      ownerAgentId: overrides.ownerAgentId,
      ownerUserId: null,
      ownerAssignmentSource: null,
    };
  }
  if (overrides.ownerUserId) {
    return {
      ownerKind: "user",
      ownerAgentId: null,
      ownerUserId: overrides.ownerUserId,
      ownerAssignmentSource: overrides.ownerAssignmentSource === "user_creator_withdrawal"
        ? "user_creator_withdrawal"
        : null,
    };
  }
  return {
    ownerKind: "board",
    ownerAgentId: null,
    ownerUserId: null,
    ownerAssignmentSource: null,
  };
}

function creatorFields(overrides: TestIssueOverrides): TestIssueCreator {
  switch (overrides.creatorKind) {
    case "agent-execution":
      return {
        creatorKind: "agent-execution",
        creatorAuthorityId: overrides.creatorAuthorityId ?? "agent-creator",
        creatorAdapterConfigRevisionId: overrides.creatorAdapterConfigRevisionId ?? "adapter-revision-1",
        creatorUserId: null,
        creatorPluginInstallationId: null,
        creatorPluginKey: null,
        creatorCallbackKey: null,
        creatorCallbackVersion: null,
        creatorRoutineId: null,
        creatorRoutineDispatchId: null,
        creatorSystemSourceKind: null,
        creatorSystemSourceId: null,
      };
    case "plugin":
      return {
        creatorKind: "plugin",
        creatorAuthorityId: null,
        creatorAdapterConfigRevisionId: null,
        creatorUserId: null,
        creatorPluginInstallationId: overrides.creatorPluginInstallationId ?? "plugin-installation-1",
        creatorPluginKey: overrides.creatorPluginKey ?? "test-plugin",
        creatorCallbackKey: overrides.creatorCallbackKey ?? "create-issue",
        creatorCallbackVersion: overrides.creatorCallbackVersion ?? "1",
        creatorRoutineId: null,
        creatorRoutineDispatchId: null,
        creatorSystemSourceKind: null,
        creatorSystemSourceId: null,
      };
    case "routine":
      return {
        creatorKind: "routine",
        creatorAuthorityId: null,
        creatorAdapterConfigRevisionId: null,
        creatorUserId: null,
        creatorPluginInstallationId: null,
        creatorPluginKey: null,
        creatorCallbackKey: null,
        creatorCallbackVersion: null,
        creatorRoutineId: overrides.creatorRoutineId ?? "routine-1",
        creatorRoutineDispatchId: overrides.creatorRoutineDispatchId ?? "routine-dispatch-1",
        creatorSystemSourceKind: null,
        creatorSystemSourceId: null,
      };
    case "system":
      return {
        creatorKind: "system",
        creatorAuthorityId: null,
        creatorAdapterConfigRevisionId: null,
        creatorUserId: null,
        creatorPluginInstallationId: null,
        creatorPluginKey: null,
        creatorCallbackKey: null,
        creatorCallbackVersion: null,
        creatorRoutineId: null,
        creatorRoutineDispatchId: null,
        creatorSystemSourceKind: overrides.creatorSystemSourceKind ?? "liveness",
        creatorSystemSourceId: overrides.creatorSystemSourceId ?? "system-source-1",
      };
    default:
      return {
        creatorKind: "user/board",
        creatorAuthorityId: null,
        creatorAdapterConfigRevisionId: null,
        creatorUserId: overrides.creatorUserId ?? "user-1",
        creatorPluginInstallationId: null,
        creatorPluginKey: null,
        creatorCallbackKey: null,
        creatorCallbackVersion: null,
        creatorRoutineId: null,
        creatorRoutineDispatchId: null,
        creatorSystemSourceKind: null,
        creatorSystemSourceId: null,
      };
  }
}

export function createTestIssue(overrides: TestIssueOverrides = {}): Issue {
  const boardPresentationStatus =
    overrides.boardPresentationStatus ?? "todo";
  const base: TestIssueBase = {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Test issue",
    request: "",
    responsibleUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
    boardPresentationStatus,
    lifecycleStatus:
      overrides.lifecycleStatus ??
      lifecycleStatusFor(boardPresentationStatus),
    workMode: overrides.workMode ?? "standard",
    priority: overrides.priority ?? "medium",
    ownershipEpoch: overrides.ownershipEpoch ?? 1,
  };
  return composeTestIssue(
    base,
    ownerFields(overrides),
    creatorFields(overrides),
  );
}

export function createTestExecutionWorkspace(
  overrides: Partial<ExecutionWorkspace> = {},
): ExecutionWorkspace {
  return {
    id: "execution-workspace-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Test workspace",
    status: "active",
    cwd: "/tmp/paperclip-test-workspace",
    repoUrl: null,
    baseRef: null,
    branchName: null,
    providerType: "local_fs",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-01-01T00:00:00.000Z"),
    openedAt: new Date("2026-01-01T00:00:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    runtimeServices: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
