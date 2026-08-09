import type { Issue } from "@paperclipai/shared";

type SubIssueDefaultSource = Pick<
  Issue,
  | "id"
  | "identifier"
  | "title"
  | "projectId"
  | "projectWorkspaceId"
  | "goalId"
  | "ownerAgentId"
>;

export function buildSubIssueDefaults(issue: SubIssueDefaultSource) {
  return buildSubIssueDefaultsForViewer(issue);
}

export function buildSubIssueDefaultsForViewer(issue: SubIssueDefaultSource) {
  return {
    parentId: issue.id,
    parentIdentifier: issue.identifier ?? undefined,
    parentTitle: issue.title ?? issue.identifier ?? undefined,
    ...(issue.projectId ? { projectId: issue.projectId } : {}),
    ...(issue.projectWorkspaceId
      ? { projectWorkspaceId: issue.projectWorkspaceId }
      : {}),
    ...(issue.goalId ? { goalId: issue.goalId } : {}),
    ...(issue.ownerAgentId ? { ownerAgentId: issue.ownerAgentId } : {}),
  };
}

export function projectWorkspaceIdAfterProjectChange(
  currentProjectId: string,
  nextProjectId: string,
  currentProjectWorkspaceId: string,
) {
  return currentProjectId === nextProjectId ? currentProjectWorkspaceId : "";
}
