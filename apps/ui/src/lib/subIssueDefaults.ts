import type { Issue } from "@paperclipai/shared";

type SubIssueDefaultSource = Pick<
  Issue,
  | "id"
  | "identifier"
  | "title"
  | "projectId"
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
    ...(issue.goalId ? { goalId: issue.goalId } : {}),
    ...(issue.ownerAgentId ? { ownerAgentId: issue.ownerAgentId } : {}),
  };
}
