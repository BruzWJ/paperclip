// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Task } from "@paperclipai/shared";
import {
  buildTaskSiblingNavigation,
  buildSubTaskProgressSummary,
  shouldRenderRichSubTasksSection,
  shouldRenderSubTaskProgressSummary,
} from "./task-detail-subtasks";

function task(
  id: string,
  boardPresentationStatus: Task["boardPresentationStatus"],
  createdAt: string,
  blockedByIds: string[] = [],
): Task {
  return {
    id,
    identifier: `PAP-${id}`,
    title: `Task ${id}`,
    boardPresentationStatus,
    createdAt: new Date(createdAt),
    blockedBy: blockedByIds.map((blockerId) => ({ id: blockerId })),
  } as Task;
}

function siblingTask(
  id: string,
  createdAt: string,
  blockedByIds: string[] = [],
  overrides: Partial<Task> = {},
): Task {
  return {
    ...task(id, "todo", createdAt, blockedByIds),
    parentId: "parent-1",
    title: `Sibling ${id}`,
    hiddenAt: null,
    ...overrides,
  } as Task;
}

describe("shouldRenderRichSubTasksSection", () => {
  it("shows the rich sub-tasks section while child tasks are loading", () => {
    expect(shouldRenderRichSubTasksSection(true, 0)).toBe(true);
  });

  it("shows the rich sub-tasks section when at least one child task exists", () => {
    expect(shouldRenderRichSubTasksSection(false, 1)).toBe(true);
  });

  it("hides the rich sub-tasks section when there are no child tasks", () => {
    expect(shouldRenderRichSubTasksSection(false, 0)).toBe(false);
  });
});

describe("shouldRenderSubTaskProgressSummary", () => {
  it("requires both the opt-in flag and multiple child tasks", () => {
    expect(shouldRenderSubTaskProgressSummary(true, 2)).toBe(true);
    expect(shouldRenderSubTaskProgressSummary(true, 1)).toBe(false);
    expect(shouldRenderSubTaskProgressSummary(false, 1)).toBe(false);
    expect(shouldRenderSubTaskProgressSummary(true, 0)).toBe(false);
  });
});

describe("buildSubTaskProgressSummary", () => {
  it("counts statuses and picks the first actionable task in workflow order", () => {
    const summary = buildSubTaskProgressSummary([
      task("3", "todo", "2026-04-03T00:00:00.000Z", ["2"]),
      task("1", "done", "2026-04-01T00:00:00.000Z"),
      task("2", "in_progress", "2026-04-02T00:00:00.000Z", ["1"]),
      task("4", "blocked", "2026-04-04T00:00:00.000Z"),
      task("5", "cancelled", "2026-04-05T00:00:00.000Z"),
    ]);

    expect(summary.totalCount).toBe(4);
    expect(summary.doneCount).toBe(1);
    expect(summary.inProgressCount).toBe(1);
    expect(summary.blockedCount).toBe(1);
    expect(summary.countsByStatus.todo).toBe(1);
    expect(summary.countsByStatus.cancelled).toBeUndefined();
    expect(summary.target?.kind).toBe("next");
    expect(summary.target?.task.id).toBe("2");
  });

  it("waits on the first blocked task when no remaining work is actionable", () => {
    const summary = buildSubTaskProgressSummary([
      task("1", "done", "2026-04-01T00:00:00.000Z"),
      task("2", "blocked", "2026-04-02T00:00:00.000Z"),
      task("3", "cancelled", "2026-04-03T00:00:00.000Z"),
    ]);

    expect(summary.target?.kind).toBe("blocked");
    expect(summary.target?.task.id).toBe("2");
  });
});

describe("buildTaskSiblingNavigation", () => {
  it("orders linear blocker chains before selecting previous and next siblings", () => {
    const current = siblingTask("2", "2026-04-02T00:00:00.000Z", ["1"]);
    const navigation = buildTaskSiblingNavigation(current, [
      siblingTask("3", "2026-04-03T00:00:00.000Z", ["2"]),
      siblingTask("1", "2026-04-01T00:00:00.000Z"),
      current,
    ]);

    expect(navigation?.previous?.id).toBe("1");
    expect(navigation?.next?.id).toBe("3");
    expect(navigation?.currentIndex).toBe(1);
    expect(navigation?.totalCount).toBe(3);
  });

  it("degrades branch and merge graphs to stable workflow order", () => {
    const current = siblingTask("3", "2026-04-03T00:00:00.000Z", ["1"]);
    const navigation = buildTaskSiblingNavigation(current, [
      siblingTask("4", "2026-04-04T00:00:00.000Z", ["2", "3"]),
      siblingTask("2", "2026-04-02T00:00:00.000Z", ["1"]),
      current,
      siblingTask("1", "2026-04-01T00:00:00.000Z"),
    ]);

    expect(navigation?.previous?.id).toBe("2");
    expect(navigation?.next?.id).toBe("4");
  });

  it("falls back to created time and id when siblings have no direct blocker hints", () => {
    const current = siblingTask("2", "2026-04-01T00:00:00.000Z");
    const navigation = buildTaskSiblingNavigation(current, [
      siblingTask("3", "2026-04-02T00:00:00.000Z"),
      siblingTask("1", "2026-04-01T00:00:00.000Z"),
      current,
    ]);

    expect(navigation?.previous?.id).toBe("1");
    expect(navigation?.next?.id).toBe("3");
  });

  it("hides navigation for root tasks without children or hidden current tasks", () => {
    expect(buildTaskSiblingNavigation(siblingTask("1", "2026-04-01T00:00:00.000Z", [], { parentId: null }), []))
      .toBeNull();
    expect(buildTaskSiblingNavigation(siblingTask("1", "2026-04-01T00:00:00.000Z", [], { parentId: null }), [
      siblingTask("2", "2026-04-02T00:00:00.000Z", [], { parentId: null }),
    ])).toBeNull();
    expect(buildTaskSiblingNavigation(siblingTask("1", "2026-04-01T00:00:00.000Z", [], { hiddenAt: new Date() }), []))
      .toBeNull();
  });

  it("hides navigation when the current task is the only visible child", () => {
    const current = siblingTask("1", "2026-04-01T00:00:00.000Z");
    const navigation = buildTaskSiblingNavigation(current, [
      current,
      siblingTask("2", "2026-04-02T00:00:00.000Z", [], { hiddenAt: new Date() }),
    ]);

    expect(navigation).toBeNull();
  });

  it("returns only next for the first sibling and only previous for the last sibling", () => {
    const first = siblingTask("1", "2026-04-01T00:00:00.000Z");
    const last = siblingTask("3", "2026-04-03T00:00:00.000Z");
    const siblings = [
      siblingTask("2", "2026-04-02T00:00:00.000Z"),
      last,
      first,
    ];

    expect(buildTaskSiblingNavigation(first, siblings)).toMatchObject({
      previous: null,
      next: { id: "2" },
    });
    expect(buildTaskSiblingNavigation(last, siblings)).toMatchObject({
      previous: { id: "2" },
      next: null,
    });
  });

  it("uses the first direct child as next when a root task has no sibling next", () => {
    const current = siblingTask("1", "2026-04-01T00:00:00.000Z", [], { parentId: null });
    const navigation = buildTaskSiblingNavigation(current, [], [
      siblingTask("3", "2026-04-03T00:00:00.000Z", ["2"], { parentId: "1" }),
      siblingTask("2", "2026-04-02T00:00:00.000Z", [], { parentId: "1" }),
    ]);

    expect(navigation).toMatchObject({
      previous: null,
      next: { id: "2" },
    });
  });

  it("uses the first direct child as next when the current sibling is last", () => {
    const current = siblingTask("2", "2026-04-02T00:00:00.000Z");
    const navigation = buildTaskSiblingNavigation(current, [
      siblingTask("1", "2026-04-01T00:00:00.000Z"),
      current,
    ], [
      siblingTask("4", "2026-04-04T00:00:00.000Z", ["3"], { parentId: "2" }),
      siblingTask("3", "2026-04-03T00:00:00.000Z", [], { parentId: "2" }),
    ]);

    expect(navigation).toMatchObject({
      previous: { id: "1" },
      next: { id: "3" },
    });
  });
});
