// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Task } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskLinkQuicklook } from "./TaskLinkQuicklook";
import { createTestTask } from "../test-utils/task";

const mockTasksApiGet = vi.hoisted(() => vi.fn());

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    get: mockTasksApiGet,
  },
}));

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => "11111111-1111-4111-8111-111111111111",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    hash,
    state: _state,
    ...props
  }: React.ComponentProps<"a"> & {
    to: string;
    params?: Record<string, string>;
    hash?: string;
    state?: unknown;
  }) => {
    const pathname = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    );
    return (
      <a href={`${pathname}${hash ? `#${hash}` : ""}`} {...props}>
        {children}
      </a>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createTask(overrides: Partial<Task> = {}): Task {
  return createTestTask({
    title: "Quicklook title",
    request: "Quicklook request",
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  });
}

describe("TaskLinkQuicklook", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    mockTasksApiGet.mockResolvedValue(createTask());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps portaled quicklook links mounted until after blur click handling", () => {
    const task = createTask();

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TaskLinkQuicklook taskId={task.id} taskNumber={task.taskNumber} taskPrefetch={task}>
            PAP-1
          </TaskLinkQuicklook>
        </QueryClientProvider>,
      );
    });

    const trigger = container.querySelector("a") as HTMLAnchorElement | null;
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.focus();
    });

    expect(document.body.textContent).toContain("Quicklook title");

    act(() => {
      trigger?.blur();
    });

    expect(document.body.textContent).toContain("Quicklook title");

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(document.body.textContent).not.toContain("Quicklook title");
  });
});
