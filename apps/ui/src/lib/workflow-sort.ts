export type WorkflowSortBlocker = { id: string };

export type WorkflowSortTask = {
  id: string;
  createdAt: Date | string;
  blockedBy?: WorkflowSortBlocker[] | null;
};

// Orders siblings so that blocker chains stay contiguous (predecessor emitted
// immediately before its successor) when the graph is linear enough to allow
// it. Branches, merges, and cross-parent blockers stop the chain walk and send
// control back to the ready queue, where creation order (then id) breaks ties.
//
// Blockers whose id is absent from the input are treated as absent for
// ordering — the row chip can still surface them visually later.
//
// If the input contains a cycle (API rejects this, so it shouldn't happen in
// practice), the util degrades to a pure tie-break sort instead of hanging.
export function workflowSort<T extends WorkflowSortTask>(tasks: T[]): T[] {
  if (tasks.length <= 1) return [...tasks];

  const tieBreakAsc = (a: T, b: T): number => {
    const ta = toTimestamp(a.createdAt);
    const tb = toTimestamp(b.createdAt);
    if (ta !== tb) return ta - tb;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  };

  const byId = new Map<string, T>();
  for (const task of tasks) byId.set(task.id, task);

  const successors = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const task of tasks) {
    successors.set(task.id, []);
    inDegree.set(task.id, 0);
  }
  for (const task of tasks) {
    const seenBlockers = new Set<string>();
    for (const blocker of task.blockedBy ?? []) {
      if (!blocker || !byId.has(blocker.id)) continue;
      if (blocker.id === task.id) continue;
      if (seenBlockers.has(blocker.id)) continue;
      seenBlockers.add(blocker.id);
      successors.get(blocker.id)!.push(task.id);
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  for (const ids of successors.values()) {
    ids.sort((a, b) => tieBreakAsc(byId.get(a)!, byId.get(b)!));
  }

  const ready: T[] = [];
  for (const task of tasks) {
    if (inDegree.get(task.id) === 0) ready.push(task);
  }
  ready.sort(tieBreakAsc);

  const emitted = new Set<string>();
  const output: T[] = [];

  const insertReady = (task: T): void => {
    let lo = 0;
    let hi = ready.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tieBreakAsc(ready[mid], task) <= 0) lo = mid + 1;
      else hi = mid;
    }
    ready.splice(lo, 0, task);
  };

  const releaseSuccessors = (id: string): void => {
    for (const succId of successors.get(id) ?? []) {
      if (emitted.has(succId)) continue;
      const remaining = (inDegree.get(succId) ?? 0) - 1;
      inDegree.set(succId, remaining);
      if (remaining === 0) {
        const succ = byId.get(succId);
        if (succ) insertReady(succ);
      }
    }
  };

  while (ready.length > 0) {
    let current = ready.shift()!;
    while (current && !emitted.has(current.id)) {
      output.push(current);
      emitted.add(current.id);
      releaseSuccessors(current.id);

      const succIds = successors.get(current.id) ?? [];
      if (succIds.length !== 1) break;
      const nextId = succIds[0];
      if (emitted.has(nextId)) break;
      if ((inDegree.get(nextId) ?? 0) !== 0) break;
      const nextIndex = ready.findIndex((task) => task.id === nextId);
      if (nextIndex < 0) break;
      [current] = ready.splice(nextIndex, 1);
    }
  }

  if (emitted.size < tasks.length) {
    return [...tasks].sort(tieBreakAsc);
  }

  return output;
}

function toTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}
