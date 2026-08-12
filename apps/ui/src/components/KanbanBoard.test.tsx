// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Task, TaskStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKanbanColumnTone, KanbanBoard } from "./KanbanBoard";
import { createTestTask } from "../test-utils/task";

vi.mock("./TaskLinkQuicklook", () => ({
  TaskLinkQuicklook: ({
    children,
    taskId: _taskId,
    taskNumber,
    disableTaskQuicklook: _disableTaskQuicklook,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    taskId: string;
    taskNumber: number | null;
    disableTaskQuicklook?: boolean;
  }) => (
    <a href={`/11111111-1111-4111-8111-111111111111/tasks/${taskNumber}`} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function act(callback: () => void): void {
  flushSync(callback);
}

function createTask(index: number, status: TaskStatus): Task {
  return createTestTask({
    id: `task-${status}-${index}`,
    identifier: `PAP-${index}`,
    title: `Task ${index}`,
    boardPresentationStatus: status,
    ownerAgentId: index === 1 ? "agent-1" : null,
    taskNumber: index,
    createdAt: new Date("2026-05-05T00:00:00.000Z"),
    updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
  });
}

function createTasks(count: number, status: TaskStatus): Task[] {
  return Array.from({ length: count }, (_, index) => createTask(index + 1, status));
}

function renderBoard(
  props: Partial<React.ComponentProps<typeof KanbanBoard>> & { tasks: Task[] },
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  const render = (nextProps: Partial<React.ComponentProps<typeof KanbanBoard>> & { tasks: Task[] }) => {
    act(() => {
      root.render(
        <KanbanBoard
          agents={[{ id: "agent-1", name: "Codex" }]}
          liveTaskIds={new Set(["task-todo-1"])}
          {...nextProps}
        />,
      );
    });
  };

  render(props);

  return { container, root, render };
}

describe("KanbanBoard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop();
      if (root) {
        act(() => root.unmount());
      }
    }
    document.body.innerHTML = "";
  });

  it("limits visible cards and reveals more cards per column", () => {
    const { container } = renderBoard({
      tasks: createTasks(60, "todo"),
      compactCards: true,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    expect(container.textContent).toContain("Showing 50 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Task 50");
    expect(container.textContent).not.toContain("Task 51");

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Task 60");
    expect(container.textContent).not.toContain("Show 10 more");
  });

  it("resets visible counts when the column page size changes", () => {
    const tasks = createTasks(60, "todo");
    const { container, render } = renderBoard({
      tasks,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Task 60");

    render({
      tasks,
      initialVisibleCount: 10,
      revealIncrement: 10,
    });

    expect(container.textContent).toContain("Showing 10 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Task 10");
    expect(container.textContent).not.toContain("Task 11");
  });

  it("renders collapsed statuses as rails without cards", () => {
    const { container } = renderBoard({
      tasks: createTasks(3, "done"),
      collapsedStatuses: ["done"],
    });

    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("3");
    expect(container.textContent).not.toContain("Task 1");
  });

  it("gives every column a status-hued tone", () => {
    expect(getKanbanColumnTone("backlog").body).toContain("bg-muted/30");
    expect(getKanbanColumnTone("todo").body).toContain("amber");
    expect(getKanbanColumnTone("in_progress").body).toContain("blue");
    expect(getKanbanColumnTone("in_review").body).toContain("violet");
    expect(getKanbanColumnTone("blocked").body).toContain("red");
    expect(getKanbanColumnTone("done").body).toContain("green");
    expect(getKanbanColumnTone("cancelled").body).toContain("bg-muted/25");
    expect(getKanbanColumnTone("cancelled").card).toContain("opacity-80");
  });

  it("ghosts cancelled lane cards", () => {
    const { container } = renderBoard({
      tasks: createTasks(1, "cancelled"),
    });

    const card = container.querySelector(
      'a[href="/11111111-1111-4111-8111-111111111111/tasks/1"]',
    )?.parentElement;

    expect(card?.className).toContain("bg-muted/35");
    expect(card?.className).toContain("opacity-80");
  });

  it("keeps core task signals in compact cards", () => {
    const { container } = renderBoard({
      tasks: createTasks(1, "todo"),
      compactCards: true,
    });

    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Task 1");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Live");
  });

});
