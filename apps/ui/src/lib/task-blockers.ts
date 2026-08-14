import type { TaskBlockerAttention, TaskRelationTaskSummary } from "@paperclipai/shared";

export function taskValueLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function taskStatusAccessibleLabel(status: string, attention?: TaskBlockerAttention | null): string {
  if (status !== "blocked" || !attention || attention.state === "none") {
    return taskValueLabel(status);
  }

  const identifier = attention.sampleStalledBlockerIdentifier ?? attention.sampleBlockerIdentifier;
  if (attention.reason === "active_child") {
    return identifier
      ? `Blocked · waiting on active sub-task ${identifier}`
      : `Blocked · waiting on ${attention.coveredBlockerCount} active sub-task${attention.coveredBlockerCount === 1 ? "" : "s"}`;
  }
  if (attention.reason === "active_dependency") {
    return identifier
      ? `Blocked · covered by active dependency ${identifier}`
      : `Blocked · covered by ${attention.coveredBlockerCount} active dependenc${attention.coveredBlockerCount === 1 ? "y" : "ies"}`;
  }
  if (attention.reason === "stalled_review") {
    return identifier
      ? `Blocked · review stalled on ${identifier}`
      : "Blocked · review stalled with no clear next step";
  }
  if (attention.reason === "attention_required") {
    const count = attention.attentionBlockerCount || attention.unresolvedBlockerCount;
    return `Blocked · ${count} blocker${count === 1 ? " needs" : "s need"} attention`;
  }
  return "Blocked";
}

export function isAssignedBacklogBlocker(blocker: TaskRelationTaskSummary): boolean {
  return blocker.boardPresentationStatus === "backlog" && Boolean(blocker.ownerAgentId);
}

export function hasAssignedBacklogBlocker(blockers: TaskRelationTaskSummary[] | undefined | null): boolean {
  if (!blockers || blockers.length === 0) return false;
  return blockers.some((blocker) => {
    if (isAssignedBacklogBlocker(blocker)) return true;
    if (blocker.terminalBlockers?.some(isAssignedBacklogBlocker)) return true;
    return false;
  });
}
