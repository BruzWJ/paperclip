// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";
import { getTaskDetailQueryOptions } from "./taskDetailCache";
import { createTestTask } from "../test-utils/task";

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    get: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date("2026-04-13T20:00:00.000Z");
  return createTestTask({
    title: "Task title",
    taskNumber: 1442,
    identifier: "PAP-1442",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function TaskDetailQueryHarness({
  taskId,
}: {
  taskId: string;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...getTaskDetailQueryOptions(queryClient, taskId),
  });

  return <div>{query.data?.request ?? "EMPTY"}</div>;
}

async function flush() {
  // Multiple act cycles to allow React Query to process the async queryFn
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("getTaskDetailQueryOptions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("treats cached task data as placeholder and still fetches full detail", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const partialTask = makeTask({ request: "" });
    const fullTask = makeTask({ request: "GitHub Security Advisory body" });

    queryClient.setQueryData(queryKeys.tasks.detail(partialTask.id), partialTask);
    vi.mocked(tasksApi.get).mockResolvedValue(fullTask);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TaskDetailQueryHarness
            taskId={partialTask.id}
          />
        </QueryClientProvider>,
      );
    });

    await flush();

    expect(tasksApi.get).toHaveBeenCalledWith(partialTask.id, {
      signal: expect.any(AbortSignal),
    });
    expect(container.textContent).toContain("GitHub Security Advisory body");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });
});
