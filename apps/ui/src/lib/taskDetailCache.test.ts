import { QueryClient } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tasksApi } from "@/api/tasks";
import {
  fetchTaskDetail,
  getCachedTaskDetail,
  prefetchTaskDetail,
  seedTaskDetailCache,
} from "./taskDetailCache";
import { queryKeys } from "./queryKeys";
import { createTestTask } from "../test-utils/task";

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    get: vi.fn(),
  },
}));

function createTask(overrides: Partial<Task> = {}): Task {
  return createTestTask({
    id: "123e4567-e89b-42d3-a456-426614174000",
    identifier: "PAP-1",
    title: "Fast link target",
    request: "Open the linked task detail.",
    createdAt: new Date("2026-04-11T00:00:00.000Z"),
    updatedAt: new Date("2026-04-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  });
}

describe("taskDetailCache", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it("stores detail under the task UUID only", () => {
    const task = createTask();

    seedTaskDetailCache(queryClient, task);

    expect(getCachedTaskDetail(queryClient, task.id)).toEqual(task);
    expect(getCachedTaskDetail(queryClient, task.identifier)).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.id))).toEqual(task);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.identifier!))).toBeUndefined();
  });

  it("prefetches a complete snapshot without forcing a fresh fetch", async () => {
    const task = createTask();

    await prefetchTaskDetail(queryClient, task.id, { task });

    expect(getCachedTaskDetail(queryClient, task.id)).toEqual(task);
    expect(tasksApi.get).not.toHaveBeenCalled();
  });

  it("fetches partial snapshots by UUID and never creates an identifier alias", async () => {
    const task = createTask();
    const partialTask = {
      id: task.id,
      identifier: task.identifier,
      title: task.title,
      boardPresentationStatus: task.boardPresentationStatus,
      priority: task.priority,
    } as Task;
    vi.mocked(tasksApi.get).mockResolvedValue(task);

    await prefetchTaskDetail(queryClient, task.id, { task: partialTask });

    expect(tasksApi.get).toHaveBeenCalledWith(task.id);
    expect(getCachedTaskDetail(queryClient, task.id)).toEqual(task);
    expect(getCachedTaskDetail(queryClient, task.identifier)).toBeUndefined();
  });

  it("does not write partial task snapshots into the detail cache", () => {
    const task = createTask();
    const partialTask = {
      id: task.id,
      identifier: task.identifier,
      title: task.title,
      boardPresentationStatus: task.boardPresentationStatus,
      priority: task.priority,
    } as Task;

    seedTaskDetailCache(queryClient, partialTask);

    expect(getCachedTaskDetail(queryClient, task.id)).toBeUndefined();
  });

  it("hydrates the UUID cache from a canonical detail fetch", async () => {
    const task = createTask();
    vi.mocked(tasksApi.get).mockResolvedValue(task);

    const result = await fetchTaskDetail(queryClient, task.id);

    expect(result).toEqual(task);
    expect(tasksApi.get).toHaveBeenCalledWith(task.id);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.id))).toEqual(task);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.identifier!))).toBeUndefined();
  });

});
