// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pluginSlotMock = vi.hoisted(() =>
  vi.fn((_props: Record<string, unknown>) => <div data-testid="plugin-slot" />),
);
const pluginLauncherMock = vi.hoisted(() =>
  vi.fn((_props: Record<string, unknown>) => <div data-testid="plugin-launcher" />),
);

vi.mock("./-TaskDetailPageContext", () => ({
  useTaskDetailPage: () => ({
    task: {
      id: "task-1",
      companyId: "company-1",
      projectId: "project-1",
    },
  }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: pluginSlotMock,
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: pluginLauncherMock,
}));

import { TaskDetailExtensionToolbar, TaskDetailExtensionViews } from "./-TaskDetailExtensions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("task detail extensions", () => {
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

  it("preserves toolbar slots, toolbar launchers, and task detail views", () => {
    act(() =>
      root.render(
        <>
          <TaskDetailExtensionToolbar />
          <TaskDetailExtensionViews />
        </>,
      ),
    );

    expect(pluginSlotMock).toHaveBeenCalledTimes(2);
    expect(pluginSlotMock.mock.calls[0]?.[0]).toMatchObject({
      slotTypes: ["toolbarButton"],
      entityType: "task",
      context: {
        companyId: "company-1",
        projectId: "project-1",
        entityId: "task-1",
        entityType: "task",
      },
    });
    expect(pluginLauncherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placementZones: ["toolbarButton"],
        entityType: "task",
      }),
      undefined,
    );
    expect(pluginSlotMock.mock.calls[1]?.[0]).toMatchObject({ slotTypes: ["taskDetailView"] });
  });
});
