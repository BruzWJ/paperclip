// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useTaskDetailPageMock = vi.hoisted(() => vi.fn());

vi.mock("./-TaskDetailPageContext", () => ({
  useTaskDetailPage: useTaskDetailPageMock,
}));

vi.mock("./-TaskDetailChat", () => ({
  TaskDetailChat: () => <div data-testid="task-detail-chat">Canonical task chat</div>,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => <div data-testid="task-plugin-tab">Plugin content</div>,
}));

import { TaskDetailContent } from "./-TaskDetailContent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const task = {
  id: "task-1",
  companyId: "company-1",
  projectId: null,
};

describe("TaskDetailContent", () => {
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

  it("renders chat directly without tab chrome when no plugin contributes a tab", () => {
    useTaskDetailPageMock.mockReturnValue({
      activePluginTab: null,
      detailTab: "chat",
      setDetailTab: vi.fn(),
      task,
      taskPluginTabItems: [],
    });

    act(() => root.render(<TaskDetailContent />));

    expect(container.querySelector('[data-testid="task-detail-chat"]')).not.toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.textContent).not.toContain("Activity");
    expect(container.textContent).not.toContain("Related work");
  });

  it("resets a stale selection from a removed built-in tab back to chat", () => {
    const setDetailTab = vi.fn();
    useTaskDetailPageMock.mockReturnValue({
      activePluginTab: null,
      detailTab: "activity",
      setDetailTab,
      task,
      taskPluginTabItems: [],
    });

    act(() => root.render(<TaskDetailContent />));

    expect(container.querySelector('[data-testid="task-detail-chat"]')).not.toBeNull();
    expect(setDetailTab).toHaveBeenCalledWith("chat");
  });

  it("preserves contributed plugin tabs without restoring Activity or Related work", () => {
    const pluginTab = {
      value: "plugin:example:insights",
      label: "Insights",
      slot: { id: "insights" },
    };
    useTaskDetailPageMock.mockReturnValue({
      activePluginTab: pluginTab,
      detailTab: pluginTab.value,
      setDetailTab: vi.fn(),
      task,
      taskPluginTabItems: [pluginTab],
    });

    act(() => root.render(<TaskDetailContent />));

    expect(container.querySelector('[role="tablist"]')?.textContent).toContain("Chat");
    expect(container.querySelector('[role="tablist"]')?.textContent).toContain("Insights");
    expect(container.querySelector('[data-testid="task-plugin-tab"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Activity");
    expect(container.textContent).not.toContain("Related work");
  });
});
