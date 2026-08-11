import type { Task } from "@paperclipai/shared";

export interface TaskTree {
  roots: Task[];
  childMap: Map<string, Task[]>;
}

/**
 * Builds a parent→children tree from a flat list of tasks.
 *
 * - `roots` contains tasks whose parent is absent from the list (or have no
 *   parent at all), so orphaned sub-tasks are always visible at root level.
 * - `childMap` maps each parent id to its direct children in list order.
 */
export function buildTaskTree(items: Task[]): TaskTree {
  const itemIds = new Set(items.map((i) => i.id));
  const roots = items.filter((i) => !i.parentId || !itemIds.has(i.parentId));
  const childMap = new Map<string, Task[]>();
  for (const item of items) {
    if (item.parentId && itemIds.has(item.parentId)) {
      const arr = childMap.get(item.parentId) ?? [];
      arr.push(item);
      childMap.set(item.parentId, arr);
    }
  }
  return { roots, childMap };
}

/**
 * Returns the total number of descendants (all depths) of `id` in `childMap`.
 * Used to accurately label collapsed parent badges like "(3 sub-tasks)".
 */
export function countDescendants(id: string, childMap: Map<string, Task[]>): number {
  const children = childMap.get(id) ?? [];
  return children.reduce((sum, c) => sum + 1 + countDescendants(c.id, childMap), 0);
}

/**
 * Filters a flat task list to only descendants of `rootId`.
 *
 * This is intentionally useful even when the list contains unrelated tasks:
 * stale servers may ignore newer descendant-scoped query params, and the UI
 * must still avoid rendering global task data in a sub-task panel.
 */
export function filterTaskDescendants(rootId: string, items: Task[]): Task[] {
  const childrenByParentId = new Map<string, Task[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    const siblings = childrenByParentId.get(item.parentId) ?? [];
    siblings.push(item);
    childrenByParentId.set(item.parentId, siblings);
  }

  const descendants: Task[] = [];
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];

  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const parentId of frontier) {
      for (const child of childrenByParentId.get(parentId) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        descendants.push(child);
        nextFrontier.push(child.id);
      }
    }
    frontier = nextFrontier;
  }

  return descendants;
}
