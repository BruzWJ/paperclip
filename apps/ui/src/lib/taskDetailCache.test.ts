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
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    vi.clearAllMocks();
  });

  it("seeds and resolves task detail by both identifier and id", () => {
    const task = createTask();

    seedTaskDetailCache(queryClient, task, { taskRef: task.identifier });

    expect(getCachedTaskDetail(queryClient, task.identifier)).toEqual(task);
    expect(getCachedTaskDetail(queryClient, task.id)).toEqual(task);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.identifier!))).toEqual(task);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.id))).toEqual(task);
  });

  it("prefetches with the provided task snapshot without forcing a fresh fetch", async () => {
    const task = createTask();

    await prefetchTaskDetail(queryClient, task.identifier!, { task });

    expect(getCachedTaskDetail(queryClient, task.identifier)).toEqual(task);
    expect(getCachedTaskDetail(queryClient, task.id)).toEqual(task);
    expect(tasksApi.get).not.toHaveBeenCalled();
  });

  it("does not seed partial task snapshots during prefetch", async () => {
    const task = createTask();
    const partialTask = {
      id: task.id,
      identifier: task.identifier,
      title: task.title,
      boardPresentationStatus: task.boardPresentationStatus,
      priority: task.priority,
    } as Task;
    vi.mocked(tasksApi.get).mockResolvedValue(task);

    await prefetchTaskDetail(queryClient, task.identifier!, { task: partialTask });

    expect(tasksApi.get).toHaveBeenCalledWith(task.identifier);
    expect(getCachedTaskDetail(queryClient, task.identifier)).toEqual(task);
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

    seedTaskDetailCache(queryClient, partialTask, { taskRef: task.identifier });

    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.identifier!))).toBeUndefined();
    expect(getCachedTaskDetail(queryClient, task.identifier)).toBeUndefined();
  });

  it("hydrates both cache aliases from a fetched task detail response", async () => {
    const task = createTask();
    vi.mocked(tasksApi.get).mockResolvedValue(task);

    const result = await fetchTaskDetail(queryClient, task.identifier!);

    expect(result).toEqual(task);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.identifier!))).toEqual(task);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.id))).toEqual(task);
  });
});
