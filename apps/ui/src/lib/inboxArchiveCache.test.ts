import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginLocalInboxArchive,
  boundLocalInboxArchive,
  clearLocalInboxArchive,
  confirmLocalInboxArchive,
  filterLocalInboxArchivedTasks,
  getTaskPresenceInActiveInboxCaches,
  getLocalInboxArchiveTaskIds,
  removeTaskFromInboxCaches,
  restoreTaskToInboxCaches,
  snapshotInboxTaskCaches,
} from "./inboxArchiveCache";
import { queryKeys } from "./queryKeys";

function task(id: string): Task {
  return { id } as Task;
}

describe("inboxArchiveCache", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const taskId of getLocalInboxArchiveTaskIds("company-1")) {
      clearLocalInboxArchive("company-1", taskId);
    }
  });

  it("restores only the failed archive during overlapping optimistic removals", () => {
    const companyId = "company-1";
    const queryClient = new QueryClient();
    const queryKey = [...queryKeys.tasks.listMineByMe(companyId), "with-routine-executions"] as const;

    queryClient.setQueryData<Task[]>(queryKey, [
      task("task-a"),
      task("task-b"),
      task("task-c"),
    ]);

    const archiveASnapshot = snapshotInboxTaskCaches(queryClient, companyId);
    removeTaskFromInboxCaches(queryClient, companyId, "task-a");

    const archiveBSnapshot = snapshotInboxTaskCaches(queryClient, companyId);
    removeTaskFromInboxCaches(queryClient, companyId, "task-b");

    restoreTaskToInboxCaches(queryClient, archiveASnapshot, "task-a");

    expect(queryClient.getQueryData<Task[]>(queryKey)?.map((cachedTask) => cachedTask.id)).toEqual([
      "task-a",
      "task-c",
    ]);

    restoreTaskToInboxCaches(queryClient, archiveBSnapshot, "task-b");

    expect(queryClient.getQueryData<Task[]>(queryKey)?.map((cachedTask) => cachedTask.id)).toEqual([
      "task-a",
      "task-b",
      "task-c",
    ]);
  });

  it("filters locally archived tasks until confirmed grace expires", () => {
    vi.useFakeTimers();
    const tasks = [task("task-a"), task("task-b")];

    beginLocalInboxArchive("company-1", "task-a");
    expect(filterLocalInboxArchivedTasks("company-1", tasks)).toEqual([task("task-b")]);

    confirmLocalInboxArchive("company-1", "task-a");
    vi.advanceTimersByTime(4_999);
    expect(filterLocalInboxArchivedTasks("company-1", tasks)).toEqual([task("task-b")]);

    vi.advanceTimersByTime(1);
    expect(filterLocalInboxArchivedTasks("company-1", tasks)).toEqual(tasks);
  });

  it("does not expire an in-flight archive before post-settle bounding starts", () => {
    vi.useFakeTimers();
    beginLocalInboxArchive("company-1", "task-a");

    vi.advanceTimersByTime(30_000);
    expect(getLocalInboxArchiveTaskIds("company-1").has("task-a")).toBe(true);

    boundLocalInboxArchive("company-1", "task-a");
    vi.advanceTimersByTime(29_999);
    expect(getLocalInboxArchiveTaskIds("company-1").has("task-a")).toBe(true);

    vi.advanceTimersByTime(1);
    expect(getLocalInboxArchiveTaskIds("company-1").has("task-a")).toBe(false);
  });

  it("distinguishes present, absent, and unavailable active inbox data", () => {
    const companyId = "company-1";
    const queryClient = new QueryClient();
    const queryKey = [...queryKeys.tasks.listMineByMe(companyId), "with-routine-executions"] as const;

    expect(getTaskPresenceInActiveInboxCaches(queryClient, companyId, "task-a")).toBe("unknown");

    queryClient.setQueryData<Task[]>(queryKey, [task("task-a")]);
    const observer = new QueryObserver<Task[]>(queryClient, {
      queryKey,
      queryFn: async () => [],
    });
    const unsubscribe = observer.subscribe(() => undefined);

    expect(getTaskPresenceInActiveInboxCaches(queryClient, companyId, "task-a")).toBe("present");
    queryClient.setQueryData<Task[]>(queryKey, [task("task-b")]);
    expect(getTaskPresenceInActiveInboxCaches(queryClient, companyId, "task-a")).toBe("absent");

    unsubscribe();
  });
});
