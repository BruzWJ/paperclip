import type { Task } from "@paperclipai/shared";

type TaskPropertiesPanelKeyTask = Pick<
  Task,
  | "id"
  | "boardPresentationStatus"
  | "priority"
  | "ownerKind"
  | "ownerAgentId"
  | "ownerUserId"
  | "ownershipEpoch"
  | "projectId"
  | "parentId"
  | "creatorKind"
  | "creatorAuthorityId"
  | "creatorUserId"
  | "creatorPluginInstallationId"
  | "creatorRoutineId"
  | "creatorSystemSourceId"
  | "hiddenAt"
  | "labelIds"
  | "executionPolicy"
  | "executionState"
  | "blocks"
  | "blockedBy"
  | "ancestors"
>;

type TaskPropertiesPanelKeyChild = Pick<Task, "id" | "updatedAt" | "identifier" | "title">;

export function buildTaskPropertiesPanelKey(
  task: TaskPropertiesPanelKeyTask | null | undefined,
  childTasks: readonly TaskPropertiesPanelKeyChild[],
) {
  if (!task) return "";

  return JSON.stringify({
    id: task.id,
    boardPresentationStatus: task.boardPresentationStatus,
    priority: task.priority,
    ownerKind: task.ownerKind,
    ownerAgentId: task.ownerAgentId,
    ownerUserId: task.ownerUserId,
    ownershipEpoch: task.ownershipEpoch,
    projectId: task.projectId,
    parentId: task.parentId,
    creatorKind: task.creatorKind,
    creatorAuthorityId: task.creatorAuthorityId,
    creatorUserId: task.creatorUserId,
    creatorPluginInstallationId: task.creatorPluginInstallationId,
    creatorRoutineId: task.creatorRoutineId,
    creatorSystemSourceId: task.creatorSystemSourceId,
    hiddenAt: task.hiddenAt,
    labelIds: task.labelIds ?? [],
    executionPolicy: task.executionPolicy ?? null,
    executionState: task.executionState
      ? {
          status: task.executionState.status,
          currentStageType: task.executionState.currentStageType,
          currentParticipant: task.executionState.currentParticipant,
          returnOwner: task.executionState.returnOwner,
        }
      : null,
    blocks: (task.blocks ?? []).map((relation) => ({
      id: relation.id,
      identifier: relation.identifier,
      title: relation.title,
      boardPresentationStatus: relation.boardPresentationStatus,
    })),
    blockedBy: (task.blockedBy ?? []).map((relation) => ({
      id: relation.id,
      identifier: relation.identifier,
      title: relation.title,
      boardPresentationStatus: relation.boardPresentationStatus,
    })),
    parentSummary: task.ancestors?.[0]
      ? {
          id: task.ancestors[0].id,
          identifier: task.ancestors[0].identifier,
          title: task.ancestors[0].title,
        }
      : null,
    childTasks: childTasks.map((child) => ({
      id: child.id,
      updatedAt: String(child.updatedAt),
      identifier: child.identifier,
      title: child.title,
    })),
  });
}
