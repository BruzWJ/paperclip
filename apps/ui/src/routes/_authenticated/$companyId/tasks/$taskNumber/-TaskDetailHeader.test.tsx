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

vi.mock("./-TaskMonitorBanner", () => ({ TaskMonitorBanner: () => null }));
vi.mock("./-TaskAttribution", () => ({ TaskAttributionByline: () => null }));

import { TaskDetailHeader } from "./-TaskDetailHeader";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TaskDetailHeader", () => {
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

  function renderHeader(overrides: Record<string, unknown> = {}) {
    useTaskDetailPageMock.mockReturnValue({
      task: createTestTask({
        title: "Review the lifecycle controls",
        request: "",
        boardPresentationStatus: "in_progress",
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
      copyTaskToClipboard: vi.fn(),
      hasLiveRuns: false,
      isFromInbox: true,
      isMobile: true,
      panelVisible: false,
      setMobileInspectorOpen: vi.fn(),
      setPanelVisible: vi.fn(),
      setTreeControlCancelConfirmed: vi.fn(),
      setTreeControlMode: vi.fn(),
      setTreeControlOpen: vi.fn(),
      updateTaskTitle: { mutateAsync: vi.fn(async () => undefined) },
      ...overrides,
    });
    act(() => root.render(<TaskDetailHeader />));
  }

  it("renders status as information instead of an implicit mutation control", () => {
    renderHeader();

    expect(container.textContent).toContain("In Progress");
    expect(container.querySelector('[aria-label="Change task status"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Update"),
    ).toBe(false);
  });

  it("keeps execution pause controls separate from lifecycle status", () => {
    renderHeader({ canPauseLeafWork: true });

    expect(container.querySelector('button[aria-label="Work controls"]')).not.toBeNull();
  });

  it("does not render Work controls when no execution action is available", () => {
    renderHeader();

    expect(container.querySelector('button[aria-label="Work controls"]')).toBeNull();
  });
});
