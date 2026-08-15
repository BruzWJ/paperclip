// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Task } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRow } from "./TaskRow";
import { createTestTask } from "@/test-utils/task";

vi.mock("../shared/TaskLinkQuicklook", () => ({
  TaskLinkQuicklook: ({
    children,
    className,
    disableTaskQuicklook: _disableTaskQuicklook,
    taskPrefetch,
    taskId: _taskId,
    taskNumber,
    ...props
  }: React.ComponentProps<"a"> & {
    disableTaskQuicklook?: boolean;
    taskPrefetch?: Task | null;
    taskId: string;
    taskNumber: number | null;
  }) => (
    <a
      href={`/11111111-1111-4111-8111-111111111111/tasks/${taskNumber}`}
      className={className}
      data-disable-task-quicklook={_disableTaskQuicklook ? "true" : undefined}
      data-task-prefetch-id={taskPrefetch?.id}
      {...props}
    >
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  if (typeof reactAct === "function") {
    reactAct(callback);
    return;
  }

  flushSync(callback);
}

function createTask(overrides: Partial<Task> = {}): Task {
  return createTestTask({
    title: "Inbox item",
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  });
}

describe("TaskRow", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders task status through the shared Kibo Status pattern", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TaskRow task={createTask({ boardPresentationStatus: "in_progress" })} />);
    });

    const badges = container.querySelectorAll('[data-slot="badge"]');
    expect(badges.length).toBeGreaterThan(0);
    badges.forEach((badge) => {
      expect(badge.textContent).toBe("In Progress");
      expect(badge.classList.contains("online")).toBe(true);
      expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull();
    });

    act(() => {
      root.unmount();
    });
  });

  it("suppresses accent hover styling when the row is selected", () => {
    const root = createRoot(container);
    const task = createTask();

    act(() => {
      root.render(<TaskRow task={task} selected />);
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    const row = link?.parentElement;
    expect(link).not.toBeNull();
    expect(row?.className).toContain("hover:bg-transparent");

    act(() => {
      root.unmount();
    });
  });

  it("neutralizes the selected unread dot accent", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TaskRow task={createTask()} selected unreadState="visible" />);
    });

    const markReadButton = container.querySelector('button[aria-label="Mark as read"]');
    const unreadDot = markReadButton?.querySelector("span");
    const statusBadge = container.querySelector('[data-slot="badge"]');

    expect(markReadButton).not.toBeNull();
    expect(markReadButton?.className).toContain("hover:bg-muted/80");
    expect(markReadButton?.className).not.toContain("hover:bg-primary/10");
    expect(unreadDot).not.toBeNull();
    expect(unreadDot?.className).toContain("bg-muted-foreground/70");
    expect(unreadDot?.className).not.toContain("bg-primary");
    expect(statusBadge?.textContent).toBe("Todo");

    act(() => {
      root.unmount();
    });
  });

  it("reserves the leading dot slot on read rows so unread rows never indent past them", () => {
    const root = createRoot(container);
    act(() => {
      // A read inbox row still supplies `unreadState` (as "hidden").
      root.render(<TaskRow task={createTask()} unreadState="hidden" />);
    });

    // The desktop dot slot is reserved even when read (empty), so unread rows
    // add no column and line up with read rows.
    const slot = container.querySelector('[data-testid="task-row-unread-slot"]');
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain("w-4");
    expect(slot?.className).toContain("sm:inline-flex");
    // In flow, not an absolute overlay.
    expect(slot?.className).not.toContain("absolute");
    // Read rows carry no dot button in the slot.
    expect(slot?.querySelector('button[aria-label="Mark as read"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("puts the unread dot in the reserved far-left slot on desktop and in flow on mobile", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<TaskRow task={createTask()} unreadState="visible" />);
    });

    // Desktop: the dot lives in the reserved leading slot (far left, ahead of
    // any leading control such as a parent's collapse caret).
    const slot = container.querySelector('[data-testid="task-row-unread-slot"]');
    expect(slot).not.toBeNull();
    expect(slot?.querySelector('button[aria-label="Mark as read"]')).not.toBeNull();

    // Mobile: a separate in-flow, order-first dot (mobile has no reserved slot).
    const mobileDot = container
      .querySelector(
        'button[aria-label="Mark as read"].sm\\:hidden, span.sm\\:hidden button[aria-label="Mark as read"]',
      )
      ?.closest("span.sm\\:hidden");
    expect(mobileDot).not.toBeNull();
    expect(mobileDot?.className).toContain("order-first");

    act(() => {
      root.unmount();
    });
  });

  it("preserves the typed task detail source in the link target", () => {
    const root = createRoot(container);
    const task = createTask();
    const state = {
      taskDetailSource: "inbox",
    };

    act(() => {
      root.render(<TaskRow task={task} taskLinkState={state} />);
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("to") ?? link?.getAttribute("href")).toBe(
      "/11111111-1111-4111-8111-111111111111/tasks/1",
    );

    act(() => {
      root.unmount();
    });
  });

  it("opts task quicklook out for dense inbox rows", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TaskRow task={createTask()} />);
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("data-disable-task-quicklook")).toBe("true");

    act(() => {
      root.unmount();
    });
  });

  it("passes the visible row task into the navigation prefetch path", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TaskRow task={createTask()} />);
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    expect(link?.getAttribute("data-task-prefetch-id")).toBe("task-1");

    act(() => {
      root.unmount();
    });
  });

  it("renders titleSuffix inline after the task title", () => {
    const root = createRoot(container);
    const task = createTask({ title: "Parent task" });

    act(() => {
      root.render(<TaskRow task={task} titleSuffix={<span data-testid="suffix">(3 sub-tasks)</span>} />);
    });

    const titleEl = container.querySelector(".line-clamp-2, .truncate");
    expect(titleEl?.textContent).toContain("Parent task");
    expect(titleEl?.textContent).toContain("(3 sub-tasks)");
    expect(container.querySelector('[data-testid="suffix"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders checklist step numbers beside the task identifier", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <TaskRow
          task={createTask({ identifier: "PAP-42" })}
          checklistStepNumber="2.1"
          mobileMeta="updated now"
        />,
      );
    });

    const metaRow = Array.from(container.querySelectorAll("span.flex.items-center.gap-2")).find((element) =>
      element.textContent?.includes("PAP-42"),
    );

    expect(metaRow).not.toBeUndefined();
    expect(metaRow?.textContent?.replace(/\s+/g, "")).toContain("2.1.PAP-42");

    act(() => {
      root.unmount();
    });
  });

  it("marks the current checklist step without adding a left border", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <TaskRow
          task={createTask({ identifier: "PAP-42" })}
          checklistStepNumber="2.1"
          checklistCurrentStep
        />,
      );
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    const row = link?.parentElement;

    expect(link).not.toBeNull();
    expect(link?.getAttribute("aria-current")).toBe("step");
    expect(row?.className).toContain("bg-primary/5");
    expect(row?.className).not.toContain("border-l-");

    act(() => {
      root.unmount();
    });
  });

  it("does not render a planning mode marker for planning work mode tasks", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TaskRow task={createTask({ workMode: "planning" })} />);
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).not.toContain("Planning");

    act(() => {
      root.unmount();
    });
  });

  it("renders without error when titleSuffix is omitted", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TaskRow task={createTask()} />);
    });

    const titleEl = container.querySelector(".line-clamp-2, .truncate");
    expect(titleEl?.textContent).toContain("Inbox item");

    act(() => {
      root.unmount();
    });
  });

  it("flags rows blocked by an assigned-backlog leaf with a parked-work badge", () => {
    const root = createRoot(container);
    const task = createTask({
      blockedBy: [
        {
          id: "blocker-1",
          taskNumber: 2,
          identifier: "PAP-2",
          title: "Parked child",
          boardPresentationStatus: "backlog",
          priority: "high",
          ownerAgentId: "agent-99",
          ownerUserId: null,
        },
      ],
    });

    act(() => {
      root.render(<TaskRow task={task} />);
    });

    const badges = container.querySelectorAll('[data-testid="task-row-parked-blocker"]');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]?.textContent).toContain("Blocked by parked work");

    act(() => {
      root.unmount();
    });
  });

  it("does not show the parked-work badge when assigned blocker is not in backlog", () => {
    const root = createRoot(container);
    const task = createTask({
      blockedBy: [
        {
          id: "blocker-1",
          taskNumber: 2,
          identifier: "PAP-2",
          title: "Active child",
          boardPresentationStatus: "in_progress",
          priority: "high",
          ownerAgentId: "agent-99",
          ownerUserId: null,
        },
      ],
    });

    act(() => {
      root.render(<TaskRow task={task} />);
    });

    expect(container.querySelector('[data-testid="task-row-parked-blocker"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("keeps row controls outside the task navigation link", () => {
    const root = createRoot(container);
    const onArchive = vi.fn();

    act(() => {
      root.render(
        <TaskRow
          task={createTask()}
          unreadState="visible"
          onArchive={onArchive}
          mobileLeading={<button type="button">Collapse</button>}
          checklistDependencyChips={<button type="button">View blocker</button>}
        />,
      );
    });

    const link = container.querySelector("[data-inbox-task-link]");
    expect(link).not.toBeNull();
    expect(link?.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);

    const archiveButton = container.querySelector<HTMLButtonElement>('button[aria-label="Archive"]');
    expect(archiveButton).not.toBeNull();
    act(() => archiveButton?.click());
    expect(onArchive).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });
});
