import type { Task } from "@paperclipai/shared";

type SubTaskDefaultSource = Pick<
  Task,
  | "id"
  | "identifier"
  | "title"
  | "projectId"
  | "projectWorkspaceId"
  | "goalId"
  | "ownerAgentId"
>;

export function buildSubTaskDefaults(task: SubTaskDefaultSource) {
  return buildSubTaskDefaultsForViewer(task);
}

export function buildSubTaskDefaultsForViewer(task: SubTaskDefaultSource) {
  return {
    parentId: task.id,
    ...(task.identifier ? { parentIdentifier: task.identifier } : {}),
    ...(task.title || task.identifier
      ? { parentTitle: task.title ?? task.identifier }
      : {}),
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(task.projectWorkspaceId
      ? { projectWorkspaceId: task.projectWorkspaceId }
      : {}),
    ...(task.goalId ? { goalId: task.goalId } : {}),
    ...(task.ownerAgentId ? { ownerAgentId: task.ownerAgentId } : {}),
  };
}

export function projectWorkspaceIdAfterProjectChange(
  currentProjectId: string,
  nextProjectId: string,
  currentProjectWorkspaceId: string,
) {
  return currentProjectId === nextProjectId ? currentProjectWorkspaceId : "";
}
