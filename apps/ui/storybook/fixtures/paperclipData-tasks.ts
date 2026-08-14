import { type Task, type TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { labelsFor, recent, storybookProjects } from "./paperclipData-foundation.js";

type StorybookTaskOwner =
  { kind: "agent"; agentId: string } | { kind: "user"; userId: string } | { kind: "board" };

type StorybookTaskOverrides = Partial<
  Omit<
    Task,
    | "ownerKind"
    | "ownerAgentId"
    | "ownerUserId"
    | "ownerAssignmentSource"
    | "ownershipEpoch"
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
    | "creatorSystemSourceId"
  >
> & {
  owner?: StorybookTaskOwner;
};

export function createTask(overrides: StorybookTaskOverrides = {}): Task {
  const { owner = { kind: "agent", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" }, ...taskOverrides } =
    overrides;
  const boardPresentationStatus = taskOverrides.boardPresentationStatus ?? "in_progress";
  const lifecycleStatus =
    taskOverrides.lifecycleStatus ??
    (boardPresentationStatus === "done" || boardPresentationStatus === "cancelled"
      ? boardPresentationStatus
      : boardPresentationStatus === "blocked"
        ? "blocked"
        : "open");
  const ownerFields =
    owner.kind === "agent"
      ? {
          ownerKind: "agent" as const,
          ownerAgentId: owner.agentId,
          ownerUserId: null,
          ownerAssignmentSource: null,
        }
      : owner.kind === "user"
        ? {
            ownerKind: "user" as const,
            ownerAgentId: null,
            ownerUserId: owner.userId,
            ownerAssignmentSource: "user_creator_withdrawal" as const,
          }
        : {
            ownerKind: "board" as const,
            ownerAgentId: null,
            ownerUserId: null,
            ownerAssignmentSource: null,
          };

  return {
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd001",
    companyId: "11111111-1111-4111-8111-111111111111",
    projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    projectWorkspaceId: null,
    goalId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    parentId: null,
    title: "Create super-detailed storybooks for the project",
    request: "Set up Storybook and move UX review surfaces into stories.",
    priority: "high",
    ownershipEpoch: 1,
    ...ownerFields,
    responsibleUserId: null,
    creatorKind: "user/board",
    creatorAuthorityId: null,
    creatorAdapterConfigRevisionId: null,
    creatorUserId: "a7000000-0000-4000-8000-000000000002",
    creatorPluginInstallationId: null,
    creatorPluginKey: null,
    creatorCallbackKey: null,
    creatorCallbackVersion: null,
    creatorRoutineId: null,
    creatorRoutineDispatchId: null,
    creatorSystemSourceKind: null,
    creatorSystemSourceId: null,
    taskNumber: 1641,
    identifier: "PAP-1641",
    requestDepth: 0,
    billingCode: "product",
    startedAt: recent(28),
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labelIds: ["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000002"],
    labels: labelsFor(["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000002"]),
    blockedBy: [],
    blocks: [],
    planDocument: null,
    documentSummaries: [],
    project: storybookProjects[0]!,
    goal: null,
    workProducts: [],
    mentionedProjects: [],
    myLastTouchAt: recent(8),
    lastExternalCommentAt: recent(70),
    lastActivityAt: recent(3),
    isUnreadForMe: true,
    createdAt: recent(90),
    updatedAt: recent(3),
    ...taskOverrides,
    boardPresentationStatus,
    lifecycleStatus,
    workMode: taskOverrides.workMode ?? "standard",
  };
}

export const storybookTasks: Task[] = [
  createTask(),
  createTask({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd002",
    title: "Add budget hard-stop incident review",
    request: "Trace why a hard stop paused the agent and add a board-facing incident summary.",
    boardPresentationStatus: "blocked",
    priority: "critical",
    owner: { kind: "agent", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2" },
    startedAt: null,
    identifier: "PAP-1528",
    taskNumber: 1528,
    billingCode: "reliability",
    projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
    labelIds: ["a1000000-0000-4000-8000-000000000004", "a1000000-0000-4000-8000-000000000003"],
    labels: labelsFor(["a1000000-0000-4000-8000-000000000004", "a1000000-0000-4000-8000-000000000003"]),
    blockedBy: [
      {
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddd007",
        taskNumber: 1591,
        identifier: "PAP-1591",
        title: "Confirm project budget override policy",
        boardPresentationStatus: "in_review",
        priority: "high",
        ownerAgentId: null,
        ownerUserId: "a7000000-0000-4000-8000-000000000002",
      },
    ],
    lastActivityAt: recent(18),
  }),
  createTask({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd003",
    title: "QA invite flow on authenticated private mode",
    boardPresentationStatus: "in_review",
    priority: "medium",
    owner: { kind: "user", userId: "a7000000-0000-4000-8000-000000000002" },
    identifier: "PAP-1602",
    taskNumber: 1602,
    completedAt: null,
    lastActivityAt: recent(49),
    isUnreadForMe: false,
  }),
  createTask({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd004",
    parentId: "dddddddd-dddd-4ddd-8ddd-ddddddddd001",
    title: "Extract task row density fixtures",
    request: "Create fixture-backed rows for unread, selected, nested, and grouped task management views.",
    boardPresentationStatus: "todo",
    priority: "medium",
    startedAt: null,
    identifier: "PAP-1668",
    taskNumber: 1668,
    labelIds: ["a1000000-0000-4000-8000-000000000001"],
    labels: labelsFor(["a1000000-0000-4000-8000-000000000001"]),
    lastActivityAt: recent(31),
    isUnreadForMe: true,
  }),
  createTask({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd005",
    parentId: "dddddddd-dddd-4ddd-8ddd-ddddddddd001",
    title: "Review document editor empty states",
    request: "Validate plan and notes documents in task detail before handing the Storybook preview to QA.",
    boardPresentationStatus: "done",
    priority: "low",
    owner: { kind: "agent", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2" },
    completedAt: recent(22),
    identifier: "PAP-1669",
    taskNumber: 1669,
    labelIds: ["a1000000-0000-4000-8000-000000000002"],
    labels: labelsFor(["a1000000-0000-4000-8000-000000000002"]),
    lastActivityAt: recent(22),
    isUnreadForMe: false,
  }),
  createTask({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd006",
    title: "Publish static Storybook preview",
    request: "Build the static preview and attach the generated artifact to the parent task.",
    boardPresentationStatus: "todo",
    priority: "high",
    owner: { kind: "board" },
    startedAt: null,
    identifier: "PAP-1670",
    taskNumber: 1670,
    labelIds: ["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000004"],
    labels: labelsFor(["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000004"]),
    lastActivityAt: recent(64),
    isUnreadForMe: false,
  }),
  createTask({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd007",
    title: "Confirm project budget override policy",
    request:
      "Board review needed before increasing the project budget for long-running browser verification.",
    boardPresentationStatus: "in_review",
    priority: "high",
    owner: { kind: "user", userId: "a7000000-0000-4000-8000-000000000002" },
    startedAt: null,
    identifier: "PAP-1591",
    taskNumber: 1591,
    billingCode: "governance",
    projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
    labelIds: ["a1000000-0000-4000-8000-000000000004"],
    labels: labelsFor(["a1000000-0000-4000-8000-000000000004"]),
    lastActivityAt: recent(85),
    isUnreadForMe: false,
  }),
  createTask({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd008",
    title: "Clean up release smoke artifacts",
    request: "Remove release smoke artifacts after static preview review.",
    boardPresentationStatus: "blocked",
    priority: "medium",
    startedAt: recent(260),
    identifier: "PAP-1608",
    taskNumber: 1608,
    projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    labelIds: ["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000004"],
    labels: labelsFor(["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000004"]),
    lastActivityAt: recent(120),
    isUnreadForMe: false,
  }),
];

export function createTaskExecutionRun(
  overrides: Partial<TaskExecutionRunEnvelopeRecord> = {},
): TaskExecutionRunEnvelopeRecord {
  const id = overrides.id ?? "90000000-0000-4000-8000-000000000001";
  const taskId = overrides.taskId ?? "dddddddd-dddd-4ddd-8ddd-ddddddddd001";
  const createdAt = overrides.createdAt ?? recent(28).toISOString();
  return {
    id,
    companyId: "11111111-1111-4111-8111-111111111111",
    taskId,
    sessionId: `session-${id}`,
    executionScopeId: `scope-${taskId}`,
    kind: "productive",
    status: "running",
    ownershipEpoch: 1,
    targetAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    adapterConfigRevisionId: "b1000000-0000-4000-8000-000000000001",
    executionMode: "owner",
    taskExecutionAuthorityId: "b2000000-0000-4000-8000-000000000001",
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: `attempt-${id}`,
    currentLeaseId: `lease-${id}`,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: createdAt,
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

export const storybookTaskRuns: TaskExecutionRunEnvelopeRecord[] = [
  createTaskExecutionRun(),
  createTaskExecutionRun({
    id: "90000000-0000-4000-8000-000000000003",
    status: "succeeded",
    targetAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    currentAttemptId: null,
    currentLeaseId: null,
    startedAt: recent(110).toISOString(),
    finishedAt: recent(94).toISOString(),
    terminalClassification: "succeeded",
    terminalFinalizationId: "93000000-0000-4000-8000-000000000003",
    createdAt: recent(110).toISOString(),
    updatedAt: recent(94).toISOString(),
  }),
  createTaskExecutionRun({
    id: "90000000-0000-4000-8000-000000000002",
    status: "succeeded",
    currentAttemptId: null,
    currentLeaseId: null,
    startedAt: recent(210).toISOString(),
    finishedAt: recent(196).toISOString(),
    terminalClassification: "succeeded",
    terminalFinalizationId: "93000000-0000-4000-8000-000000000002",
    createdAt: recent(210).toISOString(),
    updatedAt: recent(196).toISOString(),
  }),
];
