import type { Task } from "@paperclipai/shared";

export type TestTaskOverrides = {
  [Key in keyof Task]?: Task[Key];
};

type TestTaskOwnerKey =
  | "ownerKind"
  | "ownerAgentId"
  | "ownerUserId";

type TestTaskCreatorKey =
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

type TestTaskOwner =
  | Pick<Extract<Task, { ownerKind: "agent" }>, TestTaskOwnerKey>
  | Pick<Extract<Task, { ownerKind: "user" }>, TestTaskOwnerKey>
  | Pick<Extract<Task, { ownerKind: "board" }>, TestTaskOwnerKey>;

type TestTaskCreator =
  | Pick<Extract<Task, { creatorKind: "agent-execution" }>, TestTaskCreatorKey>
  | Pick<Extract<Task, { creatorKind: "user/board" }>, TestTaskCreatorKey>
  | Pick<Extract<Task, { creatorKind: "plugin" }>, TestTaskCreatorKey>
  | Pick<Extract<Task, { creatorKind: "routine" }>, TestTaskCreatorKey>
  | Pick<Extract<Task, { creatorKind: "system" }>, TestTaskCreatorKey>;

type TestTaskBase = Omit<
  Task,
  TestTaskOwnerKey | TestTaskCreatorKey
>;

function composeTestTask<
  Owner extends TestTaskOwner,
  Creator extends TestTaskCreator,
>(
  base: TestTaskBase,
  owner: Owner,
  creator: Creator,
): Task {
  return { ...base, ...owner, ...creator };
}

function lifecycleStatusFor(
  boardPresentationStatus: Task["boardPresentationStatus"],
): Task["lifecycleStatus"] {
  if (
    boardPresentationStatus === "done" ||
    boardPresentationStatus === "cancelled" ||
    boardPresentationStatus === "blocked"
  ) {
    return boardPresentationStatus;
  }
  return "open";
}

function ownerFields(overrides: TestTaskOverrides): TestTaskOwner {
  if (overrides.ownerAgentId) {
    return {
      ownerKind: "agent",
      ownerAgentId: overrides.ownerAgentId,
      ownerUserId: null,
    };
  }
  if (overrides.ownerUserId) {
    return {
      ownerKind: "user",
      ownerAgentId: null,
      ownerUserId: overrides.ownerUserId,
    };
  }
  return {
    ownerKind: "board",
    ownerAgentId: null,
    ownerUserId: null,
  };
}

function creatorFields(overrides: TestTaskOverrides): TestTaskCreator {
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
        creatorCallbackKey: overrides.creatorCallbackKey ?? "create-task",
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

export function createTestTask(overrides: TestTaskOverrides = {}): Task {
  const boardPresentationStatus =
    overrides.boardPresentationStatus ?? "todo";
  const base: TestTaskBase = {
    id: "task-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Test task",
    request: "",
    responsibleUserId: null,
    taskNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
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
  return composeTestTask(
    base,
    ownerFields(overrides),
    creatorFields(overrides),
  );
}
