// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTask } from "@/test-utils/task";

const useTaskDetailPageMock = vi.hoisted(() => vi.fn());

vi.mock("./-TaskDetailPageContext", () => ({
  useTaskDetailPage: useTaskDetailPageMock,
}));

vi.mock("@/routes/_authenticated/$companyId/-markdown/-InlineEditor", () => ({
  InlineEditor: ({ value }: { value: string }) => <h1>{value}</h1>,
}));

vi.mock("@/routes/_authenticated/$companyId/-markdown/-MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("./-TaskMonitorBanner", () => ({
  TaskMonitorBanner: () => null,
}));

vi.mock("./-TaskAttribution", () => ({
  TaskAttributionByline: () => null,
}));

import { TaskDetailHeader } from "./-TaskDetailHeader";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  (globalThis as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
    MouseEvent as unknown as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}

function pointerClick(element: Element) {
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  (element as HTMLElement).click();
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function buttonWithText(label: string) {
  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
}

function menuItemWithText(label: string) {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.trim() === label,
  );
}

describe("TaskDetailHeader work controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function renderHeader(humanLifecycleMode: "system" | "creator" | "withdrawal" | null) {
    const withdrawAndCancelTask = {
      isPending: false,
      mutateAsync: vi.fn(async () => undefined),
    };
    const commitHumanOwnerStatus = {
      isPending: false,
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => undefined),
    };
    useTaskDetailPageMock.mockReturnValue({
      task: createTestTask({
        title: "Review the lifecycle controls",
        request: "",
        creatorKind: "user/board",
        creatorUserId: "user-1",
        ownerAgentId: "agent-1",
      }),
      companyId: "company-1",
      agentMap: new Map(),
      userLabelMap: new Map(),
      userProfileMap: new Map(),
      archiveFromInbox: { mutate: vi.fn() },
      archivePending: false,
      canArchiveFromInbox: false,
      canPauseLeafWork: false,
      canRestoreSubtree: false,
      canResumeLeafWork: false,
      canResumeSubtree: false,
      canShowSubtreeControls: false,
      copied: false,
      commitHumanOwnerStatus,
      copyTaskToClipboard: vi.fn(),
      hasLiveRuns: false,
      humanLifecycleMode,
      isFromInbox: true,
      isMobile: true,
      panelVisible: false,
      setMobileInspectorOpen: vi.fn(),
      setPanelVisible: vi.fn(),
      setReopenDialogOpen: vi.fn(),
      setTreeControlCancelConfirmed: vi.fn(),
      setTreeControlMode: vi.fn(),
      setTreeControlOpen: vi.fn(),
      updateTaskTitle: { mutateAsync: vi.fn(async () => undefined) },
      withdrawAndCancelTask,
    });

    act(() => root.render(<TaskDetailHeader />));
    return { commitHumanOwnerStatus, withdrawAndCancelTask };
  }

  it("moves creator cancellation into Work controls behind confirmation", async () => {
    const { withdrawAndCancelTask } = renderHeader("creator");
    const trigger = container.querySelector('button[aria-label="Work controls"]');
    expect(trigger).not.toBeNull();

    act(() => pointerClick(trigger!));
    await flush();
    const cancelItem = menuItemWithText("Cancel task…");
    expect(cancelItem).toBeTruthy();
    expect(document.body.textContent).not.toContain("Withdraw and cancel");

    act(() => pointerClick(cancelItem!));
    await flush();
    expect(document.body.textContent).toContain("Cancel this task?");
    expect(withdrawAndCancelTask.mutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      buttonWithText("Cancel task")?.click();
      await Promise.resolve();
    });
    expect(withdrawAndCancelTask.mutateAsync).toHaveBeenCalledOnce();
  });

  it("uses the same concise cancellation action for an incomplete cancellation", async () => {
    renderHeader("withdrawal");
    const trigger = container.querySelector('button[aria-label="Work controls"]');

    act(() => pointerClick(trigger!));
    await flush();

    expect(menuItemWithText("Cancel task…")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Finish cancellation");
    expect(document.body.textContent).not.toContain("withdrawal");
  });

  it("keeps system-owner lifecycle actions in Work controls", async () => {
    const { commitHumanOwnerStatus } = renderHeader("system");
    const trigger = container.querySelector('button[aria-label="Work controls"]');

    act(() => pointerClick(trigger!));
    await flush();
    const blockItem = menuItemWithText("Mark as blocked");
    expect(blockItem).toBeTruthy();
    expect(menuItemWithText("Mark as resolved")).toBeTruthy();

    act(() => pointerClick(blockItem!));
    expect(commitHumanOwnerStatus.mutate).toHaveBeenCalledWith({
      status: "blocked",
      message: "Blocked by the human escalation owner.",
    });
  });

  it("does not render Work controls when no action is available", () => {
    renderHeader(null);

    expect(container.querySelector('button[aria-label="Work controls"]')).toBeNull();
  });
});
