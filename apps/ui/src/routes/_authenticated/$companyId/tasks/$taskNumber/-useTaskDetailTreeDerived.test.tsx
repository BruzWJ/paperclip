// @vitest-environment jsdom

import type { Task } from "@paperclipai/shared";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PanelProvider, usePanel } from "@/context/PanelContext";
import { useTaskDetailTreeDerived } from "./-useTaskDetailTreeDerived";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type TreeDerivedOptions = Parameters<typeof useTaskDetailTreeDerived>[0];

const task = {
  id: "task-1",
  lifecycleStatus: "open",
  ownerAgentId: null,
} as Task;

const baseOptions: Omit<TreeDerivedOptions, "activeRootPauseHolds" | "activeCancelHolds"> = {
  task,
  childTasks: [],
  agentMap: new Map(),
  canManageTreeControl: false,
  treeControlMode: "pause",
  treeControlPreview: undefined,
  treeControlPreviewLoading: false,
  treeControlState: undefined,
  treeControlCancelConfirmed: false,
  uploadAttachment: { mutateAsync: vi.fn() } as unknown as TreeDerivedOptions["uploadAttachment"],
  importMarkdownDocument: { mutateAsync: vi.fn() } as unknown as TreeDerivedOptions["importMarkdownDocument"],
  isNamedUserCreator: false,
  isSystemEscalationHumanOwner: false,
  isUserCreatorWithdrawalOwner: false,
};

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

describe("useTaskDetailTreeDerived", () => {
  it("does not reopen the task panel when an unrelated interaction rerenders the page", () => {
    let panelRegistrations = 0;

    function Harness({ revision }: { revision: number }) {
      const result = useTaskDetailTreeDerived({
        ...baseOptions,
        activeRootPauseHolds: [],
        activeCancelHolds: [],
      });
      const { openPanel } = usePanel();
      useEffect(() => {
        panelRegistrations += 1;
        openPanel(<span>Task details</span>);
      }, [openPanel, result.childPauseBadgeById, result.mutedChildTaskIds]);
      return <span>{revision}</span>;
    }

    act(() =>
      root.render(
        <PanelProvider>
          <Harness revision={0} />
        </PanelProvider>,
      ),
    );

    act(() =>
      root.render(
        <PanelProvider>
          <Harness revision={1} />
        </PanelProvider>,
      ),
    );

    expect(panelRegistrations).toBe(1);
  });
});
