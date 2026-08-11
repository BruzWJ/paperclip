import type { TaskRelationTaskSummary } from "@paperclipai/shared";

export function isAssignedBacklogBlocker(blocker: TaskRelationTaskSummary): boolean {
  return blocker.boardPresentationStatus === "backlog" && Boolean(blocker.ownerAgentId);
}

export function hasAssignedBacklogBlocker(
  blockers: TaskRelationTaskSummary[] | undefined | null,
): boolean {
  if (!blockers || blockers.length === 0) return false;
  return blockers.some((blocker) => {
    if (isAssignedBacklogBlocker(blocker)) return true;
    if (blocker.terminalBlockers?.some(isAssignedBacklogBlocker)) return true;
    return false;
  });
}
