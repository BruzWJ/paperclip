// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepPreviousDataForSameQueryTail } from "./query-placeholder-data";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function Harness({
  taskId,
  fetchTaskRuns,
}: {
  taskId: string;
  fetchTaskRuns: (taskId: string) => Promise<string[]>;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["tasks", "live-runs", taskId],
    queryFn: () => fetchTaskRuns(taskId),
    placeholderData: keepPreviousDataForSameQueryTail(taskId),
  });

  return (
    <div data-testid="query-state">
      {JSON.stringify({
        taskId,
        runs: data ?? null,
        isLoading,
      })}
    </div>
  );
}

describe("keepPreviousDataForSameQueryTail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("clears task-scoped placeholder data when the query tail changes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    const root = createRoot(container);
    const taskBRuns = createDeferred<string[]>();

    queryClient.setQueryData(["tasks", "live-runs", "task-a"], ["run-a"]);

    const fetchTaskRuns = (taskId: string) => {
      if (taskId === "task-a") return Promise.resolve(["run-a"]);
      if (taskId === "task-b") return taskBRuns.promise;
      return Promise.resolve([]);
    };

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness taskId="task-a" fetchTaskRuns={fetchTaskRuns} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toBe(JSON.stringify({
      taskId: "task-a",
      runs: ["run-a"],
      isLoading: false,
    }));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness taskId="task-b" fetchTaskRuns={fetchTaskRuns} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toBe(JSON.stringify({
      taskId: "task-b",
      runs: null,
      isLoading: true,
    }));

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
