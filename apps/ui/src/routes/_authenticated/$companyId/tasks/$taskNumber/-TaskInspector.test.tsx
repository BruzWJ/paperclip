// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Task } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useTaskDetailPageMock = vi.hoisted(() => vi.fn());

vi.mock("./-TaskDetailPageContext", () => ({
  useTaskDetailPage: useTaskDetailPageMock,
}));

vi.mock("./-task-properties/-TaskProperties", () => ({
  TaskProperties: () => <div data-testid="task-properties">Properties body</div>,
}));

vi.mock("./-TaskResources", () => ({
  TaskResources: () => <div data-testid="task-resources">Resources body</div>,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div data-testid="task-sheet">{children}</div> : null,
  SheetContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <h2 className={className}>{children}</h2>
  ),
}));

import { TaskDetailInspectorSheet, TaskInspector, type TaskInspectorProps } from "./-TaskInspector";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const task = {
  id: "task-1",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "Task",
} as Task;

function inspectorProps(overrides: Partial<TaskInspectorProps> = {}): TaskInspectorProps {
  return {
    activeTab: "details",
    onTabChange: vi.fn(),
    onUpdateTask: vi.fn(),
    hasActiveRun: false,
    task,
    childTasks: [],
    childTasksLoading: false,
    liveTaskIds: new Set(),
    mutedChildTaskIds: new Set(),
    childPauseBadgeById: new Map(),
    onAddSubTask: vi.fn(),
    attachments: [],
    attachmentsLoading: false,
    attachmentError: null,
    attachmentUploadPending: false,
    onUploadFiles: vi.fn(),
    attachmentDeletePending: false,
    onDeleteAttachment: vi.fn(),
    onPreviewAttachment: vi.fn(),
    workProducts: [],
    onPreviewOutput: vi.fn(),
    onOpenDocuments: vi.fn(),
    ...overrides,
  };
}

describe("TaskInspector", () => {
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
    vi.clearAllMocks();
  });

  it("defaults to Details and switches to the compact Resources surface", () => {
    act(() => root.render(<TaskInspector {...inspectorProps()} />));

    const tabList = container.querySelector('[role="tablist"]');
    expect(tabList?.parentElement?.classList.contains("sticky")).toBe(true);
    expect(tabList?.parentElement?.classList.contains("top-0")).toBe(true);
    expect(
      container
        .querySelector('[data-testid="task-properties"]')
        ?.closest('[role="tabpanel"]')
        ?.getAttribute("data-state"),
    ).toBe("active");
    expect(
      container
        .querySelector('[data-testid="task-properties"]')
        ?.closest('[role="tabpanel"]')
        ?.classList.contains("p-4"),
    ).toBe(true);

    act(() => root.render(<TaskInspector {...inspectorProps({ activeTab: "resources" })} />));

    expect(container.querySelector('[data-testid="task-properties"]')).toBeNull();
    expect(
      container
        .querySelector('[data-testid="task-resources"]')
        ?.closest('[role="tabpanel"]')
        ?.getAttribute("data-state"),
    ).toBe("active");
  });

  it("uses the same Task details inspector in the mobile sheet", () => {
    useTaskDetailPageMock.mockReturnValue({
      attachmentError: null,
      attachmentList: [],
      attachmentUploadPending: false,
      attachmentsInitialLoading: false,
      childPauseBadgeById: new Map(),
      childTasks: [],
      childTasksLoading: false,
      deleteAttachment: { isPending: false, mutate: vi.fn() },
      handleAttachmentFiles: vi.fn(),
      handleTaskPropertiesUpdate: vi.fn(),
      inspectorTab: "details",
      liveTaskIds: new Set(),
      location: { state: undefined },
      mobileInspectorOpen: true,
      mutedChildTaskIds: new Set(),
      openAttachmentInGallery: vi.fn(),
      openDocumentsWorkspace: vi.fn(),
      openNewSubTask: vi.fn(),
      openOutputInGallery: vi.fn(),
      resolvedHasActiveRun: false,
      resolvedTaskDetailState: null,
      setInspectorTab: vi.fn(),
      setMobileInspectorOpen: vi.fn(),
      task,
      workProducts: [],
    });

    act(() => root.render(<TaskDetailInspectorSheet />));

    expect(container.querySelector('[data-testid="task-sheet"]')).not.toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("Task details");
    expect(container.querySelector("h2")?.classList.contains("sr-only")).toBe(true);
    expect(container.querySelector('[data-testid="task-properties"]')).not.toBeNull();
  });
});
