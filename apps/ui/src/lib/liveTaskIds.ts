import type { TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";

function isLiveRunStatus(status: string): boolean {
  return status === "queued" || status === "scheduled_retry" || status === "running";
}

export function collectLiveTaskIds(
  runs: readonly TaskExecutionRunEnvelopeRecord[] | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const run of runs ?? []) {
    if (isLiveRunStatus(run.status)) ids.add(run.taskId);
  }
  return ids;
}

/**
 * Minimal tree node shape needed to roll live descendants up to their ancestors.
 * Both list and inbox task objects satisfy this.
 */
export interface SubtreeLiveNode {
  id: string;
  parentId: string | null;
}

/**
 * Derive, for every task in the already-loaded tree, how many of its
 * descendants currently have their own active run.
 *
 * The count is strictly over descendants — a task's own live run never
 * contributes to its own entry. Ancestors are walked through the loaded set
 * via `parentId`, so descendants that are not loaded are simply not counted.
 *
 * Pair with {@link collectLiveTaskIds}: keep `Live` for `liveTaskIds.has(id)`
 * (own run) and render the distinct "n live below" treatment only when an
 * task is not itself live but has a positive subtree-live count.
 */
export function collectSubtreeLiveCounts(
  tasks: readonly SubtreeLiveNode[] | null | undefined,
  liveTaskIds: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!tasks || tasks.length === 0 || liveTaskIds.size === 0) return counts;

  const parentById = new Map<string, string | null>();
  for (const task of tasks) parentById.set(task.id, task.parentId);

  for (const liveId of liveTaskIds) {
    // Only roll up live tasks that belong to the loaded tree.
    if (!parentById.has(liveId)) continue;
    const seen = new Set<string>([liveId]);
    let parentId = parentById.get(liveId) ?? null;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
      parentId = parentById.get(parentId) ?? null;
    }
  }
  return counts;
}
