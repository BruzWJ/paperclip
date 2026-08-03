import { describe, expect, it, vi } from "vitest";
import {
  createIssueExecutionLivePlanStore,
  type VisibleActiveIssueExecutionPrompt,
} from "./issue-execution-live-plan";

const visiblePrompt: VisibleActiveIssueExecutionPrompt = {
  companyId: "company-1",
  issueId: "issue-1",
  runId: "run-1",
  refId: "ref-1",
  runOrdinal: 1,
  segmentOrdinal: 0,
  promptActive: true,
};

function event(
  id: number,
  overrides: Partial<{
    companyId: string;
    issueId: string;
    runId: string;
    refId: string;
    runOrdinal: number;
    segmentOrdinal: number;
    replacement: unknown[];
  }> = {},
) {
  const companyId = overrides.companyId ?? visiblePrompt.companyId;
  return {
    id,
    companyId,
    type: "issue.execution.plan.live",
    createdAt: "2026-07-31T00:00:00.000Z",
    payload: {
      companyId,
      issueId: overrides.issueId ?? visiblePrompt.issueId,
      runId: overrides.runId ?? visiblePrompt.runId,
      refId: overrides.refId ?? visiblePrompt.refId,
      runOrdinal: overrides.runOrdinal ?? visiblePrompt.runOrdinal,
      segmentOrdinal:
        overrides.segmentOrdinal ?? visiblePrompt.segmentOrdinal,
      replacement: overrides.replacement ?? [
        { content: "First", priority: "high", status: "in_progress" },
      ],
    },
  };
}

describe("issue execution live plan store", () => {
  it("wholly replaces without merging, deduplicating, or normalizing", () => {
    const store = createIssueExecutionLivePlanStore();
    store.registerVisiblePrompt(visiblePrompt);
    expect(
      store.acceptEvent(
        event(10, {
          replacement: [
            { content: "Same", priority: "high", status: "completed" },
            { content: "Same", priority: "high", status: "completed" },
            { content: "Pending", priority: "low", status: "pending" },
          ],
        }),
      ),
    ).toBe(true);
    expect(store.getSnapshot()?.replacement).toEqual([
      { content: "Same", priority: "high", status: "completed" },
      { content: "Same", priority: "high", status: "completed" },
      { content: "Pending", priority: "low", status: "pending" },
    ]);

    expect(
      store.acceptEvent(
        event(11, {
          replacement: [
            { content: "Replacement", priority: "medium", status: "pending" },
          ],
        }),
      ),
    ).toBe(true);
    expect(store.getSnapshot()?.replacement).toEqual([
      { content: "Replacement", priority: "medium", status: "pending" },
    ]);
  });

  it("keeps known-empty distinct from no plan", () => {
    const store = createIssueExecutionLivePlanStore();
    store.registerVisiblePrompt(visiblePrompt);
    expect(store.getSnapshot()).toBeNull();
    expect(store.acceptEvent(event(1, { replacement: [] }))).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ replacement: [] });
  });

  it("rejects duplicate and out-of-order ids", () => {
    const store = createIssueExecutionLivePlanStore();
    store.registerVisiblePrompt(visiblePrompt);
    expect(store.acceptEvent(event(20))).toBe(true);
    expect(store.acceptEvent(event(20, { replacement: [] }))).toBe(false);
    expect(store.acceptEvent(event(19, { replacement: [] }))).toBe(false);
    expect(store.getSnapshot()?.eventId).toBe(20);
  });

  it.each([
    ["companyId", "company-2"],
    ["issueId", "issue-2"],
    ["runId", "run-2"],
    ["refId", "ref-2"],
    ["runOrdinal", 2],
    ["segmentOrdinal", 1],
  ] as const)("rejects wrong-scope %s", (field, value) => {
    const store = createIssueExecutionLivePlanStore();
    store.registerVisiblePrompt(visiblePrompt);
    expect(store.acceptEvent(event(1, { [field]: value }))).toBe(false);
    expect(store.getSnapshot()).toBeNull();
  });

  it("rejects malformed entries rather than partially accepting", () => {
    const store = createIssueExecutionLivePlanStore();
    store.registerVisiblePrompt(visiblePrompt);
    expect(
      store.acceptEvent(
        event(1, {
          replacement: [
            { content: "Good", priority: "high", status: "pending" },
            { content: "Bad", priority: "urgent", status: "pending" },
          ],
        }),
      ),
    ).toBe(false);
    expect(store.getSnapshot()).toBeNull();
  });

  it("clears on ref/segment scope change and terminal visibility loss", () => {
    const store = createIssueExecutionLivePlanStore();
    const unregister = store.registerVisiblePrompt(visiblePrompt);
    store.acceptEvent(event(1));
    store.registerVisiblePrompt({
      ...visiblePrompt,
      segmentOrdinal: 1,
    });
    expect(store.getSnapshot()).toBeNull();

    store.acceptEvent(event(2, { segmentOrdinal: 1 }));
    expect(store.getSnapshot()).not.toBeNull();
    store.clearVisibility();
    expect(store.getSnapshot()).toBeNull();

    // An obsolete cleanup cannot clear a later registration.
    store.registerVisiblePrompt(visiblePrompt);
    store.acceptEvent(event(3));
    unregister();
    expect(store.getSnapshot()).not.toBeNull();
  });

  it("clears on socket lifecycle while allowing a restarted id sequence", () => {
    const store = createIssueExecutionLivePlanStore();
    store.registerVisiblePrompt(visiblePrompt);
    store.acceptEvent(event(100));
    store.resetConnection();
    expect(store.getSnapshot()).toBeNull();
    expect(store.acceptEvent(event(1))).toBe(true);
  });

  it("clears on navigation without replay or hydration", () => {
    const store = createIssueExecutionLivePlanStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.registerVisiblePrompt(visiblePrompt);
    store.acceptEvent(event(1));
    store.clearPlan();
    expect(store.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    const reloaded = createIssueExecutionLivePlanStore();
    reloaded.registerVisiblePrompt(visiblePrompt);
    expect(reloaded.getSnapshot()).toBeNull();
  });
});
