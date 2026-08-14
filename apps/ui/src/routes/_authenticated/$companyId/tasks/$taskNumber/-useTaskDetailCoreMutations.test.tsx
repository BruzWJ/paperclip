// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PanelProvider, usePanel } from "@/context/PanelContext";

import { useTaskDetailCoreMutations } from "./-useTaskDetailCoreMutations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("useTaskDetailCoreMutations", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not republish panel content after the panel context rerenders", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const cacheActions = {
      invalidateTaskDetail: vi.fn(),
      invalidateTaskThreadLazily: vi.fn(),
      invalidateTaskRunState: vi.fn(),
      upsertCommentInCache: vi.fn(),
      invalidateTaskCollections: vi.fn(),
      applyOptimisticTaskCacheUpdate: vi.fn(),
      mergeTaskResponseIntoCaches: vi.fn(),
    };
    let panelEffectRuns = 0;

    function Harness() {
      const { openPanel } = usePanel();
      const { handleTaskPropertiesUpdate } = useTaskDetailCoreMutations({
        companyId: "company-1",
        taskId: "task-1",
        task: undefined,
        currentUserId: null,
        cacheActions,
      });

      useEffect(() => {
        panelEffectRuns += 1;
        // Reproduce the route's first panel publication, but stop after the
        // provider feeds that state update back into this consumer.
        if (panelEffectRuns === 1) {
          openPanel(<aside>Task properties</aside>);
        }
      }, [handleTaskPropertiesUpdate, openPanel]);

      return null;
    }

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PanelProvider>
            <Harness />
          </PanelProvider>
        </QueryClientProvider>,
      );
    });

    expect(panelEffectRuns).toBe(1);

    act(() => root.unmount());
    queryClient.clear();
  });
});
