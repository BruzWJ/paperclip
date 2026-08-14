import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentMentionHref, buildProjectMentionHref, MAX_TASK_REQUEST_DEPTH } from "@paperclipai/shared";
import { InvokableTaskOwnerRejected } from "../services/agent-invokability.js";
import { deriveTaskUserContext, taskService, parseStatusFilter } from "../services/tasks.js";
import { createMockDb } from "./helpers/mock-db.js";
const hoistedDependencies = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  defaultGoal: vi.fn(),
  invokableOwner: vi.fn(),
  syncTask: vi.fn(),
  currentOwnerRunLinkages: vi.fn(),
}));
export const dependencies = hoistedDependencies;

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: hoistedDependencies.getGeneral,
  }),
}));

vi.mock("../services/goals.js", () => ({
  getDefaultCompanyGoal: hoistedDependencies.defaultGoal,
}));

vi.mock("../services/agent-invokability.js", async () => ({
  ...(await vi.importActual<typeof import("../services/agent-invokability.js")>(
    "../services/agent-invokability.js",
  )),
  resolveInvokableTaskOwnerFromDb: hoistedDependencies.invokableOwner,
}));

vi.mock("../services/task-references.js", () => ({
  syncTask: hoistedDependencies.syncTask,
}));

vi.mock("../services/productive-run-linkage.js", () => ({
  resolveCurrentTaskOwnerRunLinkages: hoistedDependencies.currentOwnerRunLinkages,
}));

export const companyId = "00000000-0000-4000-8000-000000000001";
export const taskId = "00000000-0000-4000-8000-000000000002";
export const ownerAgentId = "00000000-0000-4000-8000-000000000003";
export const goalId = "00000000-0000-4000-8000-000000000004";
export const now = new Date("2026-07-30T18:00:00.000Z");

export function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: taskId,
    companyId,
    taskNumber: 42,
    identifier: "PC-42",
    title: "Canonical task",
    request: "Canonical task request",
    requestDepth: 0,
    lifecycleStatus: "open",
    boardPresentationStatus: "todo",
    disposition: null,
    priority: "medium",
    parentId: null,
    parentOwnershipEpoch: null,
    projectId: null,
    goalId,
    ownerKind: "user",
    ownerAgentId: null,
    ownerUserId: "user-1",
    ownerAssignmentSource: "user_creator_withdrawal",
    ownershipEpoch: 1,
    creatorKind: "user/board",
    creatorAuthorityId: null,
    creatorAdapterConfigRevisionId: null,
    creatorUserId: "user-1",
    creatorPluginInstallationId: null,
    creatorPluginKey: null,
    creatorCallbackKey: null,
    creatorCallbackVersion: null,
    creatorRoutineId: null,
    creatorRoutineDispatchId: null,
    creatorSystemSourceKind: null,
    creatorSystemSourceId: null,
    originKind: null,
    originId: null,
    hiddenAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function setValues(calls: ReturnType<typeof createMockDb>["calls"]) {
  return calls
    .filter((call) => call.operation === "update" && call.method === "set")
    .map((call) => call.args[0] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
  dependencies.defaultGoal.mockResolvedValue({ id: goalId });
  dependencies.invokableOwner.mockResolvedValue({
    owner: {},
    revision: {},
    revisionId: "revision-1",
  });
  dependencies.syncTask.mockResolvedValue(undefined);
  dependencies.currentOwnerRunLinkages.mockResolvedValue(new Map());
});

export { beforeEach, describe, expect, it, vi, buildAgentMentionHref };
