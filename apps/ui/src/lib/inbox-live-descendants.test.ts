import { describe, expect, it } from "vitest";
import type { Task, TaskBlockerAttention } from "@paperclipai/shared";
import {
  resolveInboxTaskBlockerAttention,
  resolveTaskLiveDescendantCount,
} from "./inbox-live-descendants";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    boardPresentationStatus: "blocked",
    blockerAttention: null,
    liveDescendantCount: 0,
    ...overrides,
  } as unknown as Task;
}

function makeBlockerAttention(
  overrides: Partial<TaskBlockerAttention> = {},
): TaskBlockerAttention {
  return {
    state: "none",
    reason: null,
    unresolvedBlockerCount: 0,
    coveredBlockerCount: 0,
    stalledBlockerCount: 0,
    attentionBlockerCount: 0,
    sampleBlockerIdentifier: null,
    sampleStalledBlockerIdentifier: null,
    ...overrides,
  };
}

describe("inbox live descendant status helpers", () => {
  it("combines server and loaded live descendant counts without double-counting", () => {
    expect(resolveTaskLiveDescendantCount(makeTask({ liveDescendantCount: 3 }), 1)).toBe(3);
    expect(resolveTaskLiveDescendantCount(makeTask({ liveDescendantCount: 0 }), 2)).toBe(2);
    expect(resolveTaskLiveDescendantCount(makeTask({ liveDescendantCount: -1 }), 2.7)).toBe(2);
  });

  it("synthesizes covered blocker attention for a blocked row with live descendants", () => {
    const attention = resolveInboxTaskBlockerAttention(
      makeTask({ liveDescendantCount: 2 }),
      { isLive: false },
    );

    expect(attention).toMatchObject({
      state: "covered",
      reason: "active_child",
      coveredBlockerCount: 2,
    });
  });

  it("uses loaded live descendants when the server count is absent", () => {
    const attention = resolveInboxTaskBlockerAttention(
      makeTask({ liveDescendantCount: undefined }),
      { isLive: false, loadedSubtreeLiveCount: 1 },
    );

    expect(attention?.state).toBe("covered");
    expect(attention?.coveredBlockerCount).toBe(1);
  });

  it("keeps urgent blocked attention red even when descendants are live", () => {
    for (const state of ["needs_attention", "stalled"] as const) {
      const original = makeBlockerAttention({ state, reason: "attention_required" });
      const attention = resolveInboxTaskBlockerAttention(
        makeTask({ blockerAttention: original, liveDescendantCount: 4 }),
        { isLive: false },
      );

      expect(attention).toBe(original);
    }
  });

  it("does not synthesize covered attention for the live row itself or non-blocked parents", () => {
    expect(
      resolveInboxTaskBlockerAttention(
        makeTask({ boardPresentationStatus: "blocked", liveDescendantCount: 2 }),
        { isLive: true },
      ),
    ).toBeNull();
    expect(
      resolveInboxTaskBlockerAttention(
        makeTask({ boardPresentationStatus: "done", liveDescendantCount: 2 }),
        { isLive: false },
      ),
    ).toBeNull();
  });
});
