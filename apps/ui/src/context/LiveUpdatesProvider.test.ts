// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES } from "../api/runs";
import { queryKeys } from "../lib/queryKeys";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";

describe("LiveUpdatesProvider canonical run invalidation", () => {
  it("invalidates canonical company and task run projections for task activity", () => {
    const invalidateQueries = vi.fn();
    const queryClient = {
      invalidateQueries,
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "task",
        entityId: "task-1",
        action: "task.updated",
        details: null,
      },
      { userId: null, agentId: null },
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["runs", "company-1"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "runs", "task-1"],
    });
  });

  it("invalidates the visible task when a canonical run id matches", () => {
    const invalidateQueries = vi.fn();
    const task = {
      id: "task-1",
      identifier: "PAP-1",
      ownerAgentId: "agent-1",
    };
    const runPage = {
      items: [{ id: "run-1" }],
      nextCursor: null,
    };
    const queryClient = {
      invalidateQueries,
      getQueryData: (key: readonly unknown[]) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.detail("PAP-1"))) {
          return task;
        }
        if (
          JSON.stringify(key) ===
          JSON.stringify(
            queryKeys.tasks.runs(
              "PAP-1",
              ACTIVE_TASK_EXECUTION_RUN_STATUSES,
            ),
          )
        ) {
          return runPage;
        }
        return undefined;
      },
    };

    const matched = __liveUpdatesTestUtils.invalidateVisibleTaskRunQueries(
      queryClient as never,
      "/DEMO/tasks/PAP-1",
      { runId: "run-1" },
      { isForegrounded: true },
    );

    expect(matched).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "runs", "PAP-1"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "runs", "task-1"],
    });
  });

  it("rejects live events when the selected live company is stale", () => {
    expect(
      __liveUpdatesTestUtils.resolveLiveCompanyId("company-1", "company-2"),
    ).toBeNull();
    expect(
      __liveUpdatesTestUtils.resolveLiveCompanyId("company-1", "company-1"),
    ).toBe("company-1");
  });
});
