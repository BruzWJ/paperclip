import type { Task, TaskBlockerAttention } from "@paperclipai/shared";

type InboxLiveDescendantTask = Pick<
  Task,
  | "boardPresentationStatus"
  | "blockerAttention"
  | "liveDescendantCount"
>;

interface InboxLiveDescendantOptions {
  isLive: boolean;
  loadedSubtreeLiveCount?: number;
}

function normalizeLiveDescendantCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function asBlockerAttention(value: unknown): TaskBlockerAttention | null {
  if (!value || typeof value !== "object") return null;
  const attention = value as Partial<TaskBlockerAttention>;
  return typeof attention.state === "string" ? attention as TaskBlockerAttention : null;
}

export function resolveTaskLiveDescendantCount(
  task: Pick<Task, "liveDescendantCount">,
  loadedSubtreeLiveCount = 0,
): number {
  return Math.max(
    normalizeLiveDescendantCount(task.liveDescendantCount),
    normalizeLiveDescendantCount(loadedSubtreeLiveCount),
  );
}

export function resolveInboxTaskBlockerAttention(
  task: InboxLiveDescendantTask,
  options: InboxLiveDescendantOptions,
): TaskBlockerAttention | null {
  const blockerAttention = asBlockerAttention(task.blockerAttention);
  if (
    task.boardPresentationStatus !== "blocked" ||
    options.isLive
  ) {
    return blockerAttention;
  }
  if (blockerAttention?.state === "needs_attention" || blockerAttention?.state === "stalled") {
    return blockerAttention;
  }
  if (blockerAttention?.state === "covered") return blockerAttention;

  const liveDescendantCount = resolveTaskLiveDescendantCount(task, options.loadedSubtreeLiveCount);
  if (liveDescendantCount <= 0) return blockerAttention;

  return {
    state: "covered",
    reason: "active_child",
    unresolvedBlockerCount: blockerAttention?.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: liveDescendantCount,
    stalledBlockerCount: blockerAttention?.stalledBlockerCount ?? 0,
    attentionBlockerCount: blockerAttention?.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: blockerAttention?.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: blockerAttention?.sampleStalledBlockerIdentifier ?? null,
  };
}
