import { describe, expect, it } from "vitest";
import type { Task } from "@paperclipai/shared";
import { buildTaskTree, countDescendants, filterTaskDescendants } from "./task-tree";
import { createTestTask } from "../test-utils/task";

function makeTask(id: string, parentId: string | null = null): Task {
  return createTestTask({
    id,
    identifier: id.toUpperCase(),
    parentId,
    title: `Task ${id}`,
  });
}

describe("buildTaskTree", () => {
  it("returns all items as roots when no parent-child relationships exist", () => {
    const items = [makeTask("a"), makeTask("b"), makeTask("c")];
    const { roots, childMap } = buildTaskTree(items);
    expect(roots.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(childMap.size).toBe(0);
  });

  it("places children under their parent and excludes them from roots", () => {
    const parent = makeTask("parent");
    const child1 = makeTask("child1", "parent");
    const child2 = makeTask("child2", "parent");
    const { roots, childMap } = buildTaskTree([parent, child1, child2]);
    expect(roots.map((r) => r.id)).toEqual(["parent"]);
    expect(childMap.get("parent")?.map((c) => c.id)).toEqual(["child1", "child2"]);
  });

  it("handles multiple levels of nesting", () => {
    const grandparent = makeTask("gp");
    const parent = makeTask("p", "gp");
    const child = makeTask("c", "p");
    const { roots, childMap } = buildTaskTree([grandparent, parent, child]);
    expect(roots.map((r) => r.id)).toEqual(["gp"]);
    expect(childMap.get("gp")?.map((i) => i.id)).toEqual(["p"]);
    expect(childMap.get("p")?.map((i) => i.id)).toEqual(["c"]);
  });

  it("promotes orphaned sub-tasks (parent not in list) to root level", () => {
    // child references a parent that is not in the items array (e.g. filtered out)
    const child = makeTask("child", "missing-parent");
    const unrelated = makeTask("unrelated");
    const { roots, childMap } = buildTaskTree([child, unrelated]);
    expect(roots.map((r) => r.id)).toEqual(["child", "unrelated"]);
    expect(childMap.size).toBe(0);
  });

  it("returns empty roots and empty childMap for an empty list", () => {
    const { roots, childMap } = buildTaskTree([]);
    expect(roots).toEqual([]);
    expect(childMap.size).toBe(0);
  });

  it("preserves list order within roots and within children", () => {
    const p1 = makeTask("p1");
    const p2 = makeTask("p2");
    const c1 = makeTask("c1", "p1");
    const c2 = makeTask("c2", "p1");
    const { roots, childMap } = buildTaskTree([p1, c1, p2, c2]);
    expect(roots.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(childMap.get("p1")?.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("countDescendants", () => {
  it("returns 0 for a leaf node", () => {
    const { childMap } = buildTaskTree([makeTask("a")]);
    expect(countDescendants("a", childMap)).toBe(0);
  });

  it("returns direct child count for a single-level parent", () => {
    const { childMap } = buildTaskTree([
      makeTask("p"),
      makeTask("c1", "p"),
      makeTask("c2", "p"),
    ]);
    expect(countDescendants("p", childMap)).toBe(2);
  });

  it("counts all descendants across multiple levels", () => {
    // P → C → G1, G2  (P has 3 total descendants: C, G1, G2)
    const { childMap } = buildTaskTree([
      makeTask("p"),
      makeTask("c", "p"),
      makeTask("g1", "c"),
      makeTask("g2", "c"),
    ]);
    expect(countDescendants("p", childMap)).toBe(3);
  });

  it("returns 0 for an id not in the childMap", () => {
    const { childMap } = buildTaskTree([makeTask("a"), makeTask("b")]);
    expect(countDescendants("nonexistent", childMap)).toBe(0);
  });
});

describe("filterTaskDescendants", () => {
  it("returns only children and deeper descendants of the requested root", () => {
    const root = makeTask("root");
    const child = makeTask("child", "root");
    const grandchild = makeTask("grandchild", "child");
    const unrelatedParent = makeTask("other");
    const unrelatedChild = makeTask("other-child", "other");

    expect(filterTaskDescendants("root", [
      root,
      child,
      grandchild,
      unrelatedParent,
      unrelatedChild,
    ]).map((task) => task.id)).toEqual(["child", "grandchild"]);
  });

  it("handles stale broad task-list responses without requiring the root in the list", () => {
    const child = makeTask("child", "root");
    const grandchild = makeTask("grandchild", "child");
    const globalTask = makeTask("global");

    expect(filterTaskDescendants("root", [
      globalTask,
      child,
      grandchild,
    ]).map((task) => task.id)).toEqual(["child", "grandchild"]);
  });
});
