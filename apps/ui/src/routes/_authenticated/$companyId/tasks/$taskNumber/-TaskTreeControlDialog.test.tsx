// @vitest-environment jsdom

import { act, type MouseEventHandler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TaskTreePreviewTask } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/TaskLinkQuicklook", () => ({
  TaskLinkQuicklook: ({
    children,
    className,
    onClick,
    taskId,
  }: {
    children?: ReactNode;
    className?: string;
    onClick?: MouseEventHandler<HTMLAnchorElement>;
    taskId: string;
  }) => (
    <a className={className} data-task-id={taskId} href={`#${taskId}`} onClick={onClick}>
      {children}
    </a>
  ),
}));

import { TaskTreeControlPreviewTree } from "./-TaskTreeControlDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function previewTask(
  id: string,
  parentId: string | null,
  depth: number,
  taskNumber: number,
): TaskTreePreviewTask {
  return {
    id,
    taskNumber,
    identifier: `PAP-${taskNumber}`,
    title: `Task ${taskNumber}`,
    boardPresentationStatus: "in_progress",
    parentId,
    depth,
    ownerAgentId: null,
    ownerUserId: null,
    activeRun: null,
    activeHoldIds: [],
    action: "pause",
    skipped: false,
    skipReason: null,
  };
}

describe("TaskTreeControlPreviewTree", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("maps parent ids to Kibo tree levels and exposes disclosure behavior", async () => {
    const rootTask = previewTask("root-task", null, 0, 1);
    const childTask = previewTask("child-task", rootTask.id, 1, 2);
    const grandchildTask = previewTask("grandchild-task", childTask.id, 2, 3);

    act(() => {
      root.render(<TaskTreeControlPreviewTree tasks={[grandchildTask, childTask, rootTask]} />);
    });

    const tree = container.querySelector('[role="tree"][aria-label="Affected tasks"]');
    const findRow = (identifier: string) =>
      Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]')).find((row) =>
        row.textContent?.includes(identifier),
      );

    expect(tree).not.toBeNull();
    expect(findRow("PAP-1")?.getAttribute("aria-level")).toBe("1");
    expect(findRow("PAP-2")?.getAttribute("aria-level")).toBe("2");
    expect(findRow("PAP-3")?.getAttribute("aria-level")).toBe("3");
    expect(findRow("PAP-1")?.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      findRow("PAP-1")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(findRow("PAP-2")).toBeUndefined());

    act(() => {
      findRow("PAP-1")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(findRow("PAP-2")?.getAttribute("aria-level")).toBe("2"));
  });
});
