import { randomUUID as randomUUIDImport } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb as createMockDbImport } from "./helpers/mock-db.js";
import { taskTreeControlService as taskTreeControlServiceImport } from "../services/task-tree-control.js";

export const randomUUID = randomUUIDImport;
export const createMockDb = createMockDbImport;
export const taskTreeControlService = taskTreeControlServiceImport;
const hoistedServiceMocks = vi.hoisted(() => ({
  recordNamedBoardLifecycleCommandInTransaction: vi.fn(async () => undefined),
  resolveCurrentTaskOwnerRunLinkages: vi.fn(async () => new Map()),
  requestRunningTaskInterruptionsInTransaction: vi.fn(),
  reconcileRequestedCancellations: vi.fn(),
  requestScopeCancellationsInTransaction: vi.fn(),
}));
export const serviceMocks = hoistedServiceMocks;

vi.mock("../services/task-board-lifecycle-command.js", () => ({
  recordNamedBoardLifecycleCommandInTransaction:
    hoistedServiceMocks.recordNamedBoardLifecycleCommandInTransaction,
}));

vi.mock("../services/productive-run-linkage.js", () => ({
  resolveCurrentTaskOwnerRunLinkages: hoistedServiceMocks.resolveCurrentTaskOwnerRunLinkages,
}));

export const companyId = "00000000-0000-4000-8000-000000000001";
export const boardUserId = "board-user";
export const baseTime = new Date("2026-04-21T10:00:00.000Z");

export function task(input: {
  id?: string;
  taskNumber?: number | null;
  parentId?: string | null;
  title?: string;
  status?: string;
  lifecycleStatus?: "open" | "blocked" | "done" | "cancelled";
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  createdAt?: Date;
}) {
  const id = input.id ?? randomUUID();
  return {
    id,
    companyId,
    taskNumber: input.taskNumber ?? 1,
    identifier: `TST-${id.slice(0, 4)}`,
    title: input.title ?? "Task",
    parentId: input.parentId ?? null,
    boardPresentationStatus: input.status ?? "todo",
    lifecycleStatus:
      input.lifecycleStatus ??
      (input.status === "done" || input.status === "cancelled"
        ? input.status
        : input.status === "blocked"
          ? "blocked"
          : "open"),
    ownerAgentId: input.ownerAgentId ?? null,
    ownerUserId: input.ownerUserId ?? null,
    ownershipEpoch: 1,
    createdAt: input.createdAt ?? baseTime,
    updatedAt: input.createdAt ?? baseTime,
  };
}

export function hold(input: {
  id?: string;
  rootTaskId: string;
  mode?: "pause" | "resume" | "cancel" | "restore";
  status?: "active" | "released";
  actorType?: "user" | "agent" | "system";
}) {
  return {
    id: input.id ?? randomUUID(),
    companyId,
    rootTaskId: input.rootTaskId,
    mode: input.mode ?? "pause",
    status: input.status ?? "active",
    reason: "operator requested control",
    releasePolicy: { strategy: "manual" },
    createdByActorType: input.actorType ?? "user",
    createdByAgentId: null,
    createdByUserId: (input.actorType ?? "user") === "user" ? boardUserId : null,
    createdByRunId: null,
    releasedAt: null,
    releasedByActorType: null,
    releasedByAgentId: null,
    releasedByUserId: null,
    releasedByRunId: null,
    releaseReason: null,
    releaseMetadata: null,
    createdAt: baseTime,
    updatedAt: baseTime,
  };
}

export function member(input: {
  holdId: string;
  taskId: string;
  status?: string;
  skipped?: boolean;
  skipReason?: string | null;
  parentTaskId?: string | null;
}) {
  return {
    id: randomUUID(),
    companyId,
    holdId: input.holdId,
    taskId: input.taskId,
    parentTaskId: input.parentTaskId ?? null,
    depth: input.parentTaskId ? 1 : 0,
    taskIdentifier: `TST-${input.taskId.slice(0, 4)}`,
    taskTitle: "Task",
    taskStatus: input.status ?? "todo",
    ownerAgentId: null,
    ownerUserId: boardUserId,
    activeRunId: null,
    activeRunStatus: null,
    skipped: input.skipped ?? false,
    skipReason: input.skipReason ?? null,
    createdAt: baseTime,
  };
}

export function registerSuiteSetup() {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveCurrentTaskOwnerRunLinkages.mockResolvedValue(new Map());
    serviceMocks.requestRunningTaskInterruptionsInTransaction.mockResolvedValue({
      companyId,
      taskId: "task",
      ownershipEpoch: 1,
      reason: "active_subtree_pause_hold",
      requests: [],
    });
    serviceMocks.requestScopeCancellationsInTransaction.mockResolvedValue({
      companyId,
      taskId: "task",
      selector: { kind: "ownership_epoch", ownershipEpoch: 1 },
      reason: "task_tree_cancelled",
      fence: { refIds: [], correlationIds: [] },
      requests: [],
    });
    serviceMocks.reconcileRequestedCancellations.mockResolvedValue([]);
  });
}

export { describe, expect, it };
