import type { Issue } from "@paperclipai/shared";

type SubIssueDefaultSource = Pick<
  Issue,
  | "id"
  | "identifier"
  | "title"
  | "projectId"
  | "projectWorkspaceId"
  | "goalId"
  | "executionWorkspacePreference"
  | "currentExecutionWorkspace"
  | "ownerAgentId"
>;

export function buildSubIssueDefaults(issue: SubIssueDefaultSource) {
  return buildSubIssueDefaultsForViewer(issue);
}

export function buildSubIssueDefaultsForViewer(issue: SubIssueDefaultSource) {
  const executionWorkspaceId = issue.currentExecutionWorkspace?.id ?? null;
  const parentExecutionWorkspaceLabel =
    issue.currentExecutionWorkspace?.name
    ?? issue.currentExecutionWorkspace?.branchName
    ?? issue.currentExecutionWorkspace?.cwd
    ?? executionWorkspaceId
    ?? null;
  return {
    parentId: issue.id,
    parentIdentifier: issue.identifier ?? undefined,
    parentTitle: issue.title ?? issue.identifier ?? undefined,
    ...(issue.projectId ? { projectId: issue.projectId } : {}),
    ...(issue.projectWorkspaceId ? { projectWorkspaceId: issue.projectWorkspaceId } : {}),
    ...(issue.goalId ? { goalId: issue.goalId } : {}),
    ...(executionWorkspaceId ? { executionWorkspaceId } : {}),
    ...(executionWorkspaceId
      ? { executionWorkspaceMode: "reuse_existing" }
      : issue.executionWorkspacePreference
        ? { executionWorkspaceMode: issue.executionWorkspacePreference }
        : {}),
    ...(parentExecutionWorkspaceLabel ? { parentExecutionWorkspaceLabel } : {}),
    ...(issue.ownerAgentId ? { ownerAgentId: issue.ownerAgentId } : {}),
  };
}
