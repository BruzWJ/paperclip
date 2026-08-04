import type { Issue, Project } from "@paperclipai/shared";

export function defaultProjectWorkspaceIdForProject(project: {
  workspaces?: Array<{ id: string; isPrimary: boolean }>;
  executionWorkspacePolicy?: { defaultProjectWorkspaceId?: string | null } | null;
} | null | undefined) {
  if (!project) return null;
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? null;
}

export function defaultExecutionWorkspaceModeForProject(project: { executionWorkspacePolicy?: { enabled?: boolean; defaultMode?: string | null } | null } | null | undefined) {
  const defaultMode = project?.executionWorkspacePolicy?.enabled ? project.executionWorkspacePolicy.defaultMode : null;
  if (defaultMode === "isolated_workspace" || defaultMode === "operator_branch") return defaultMode;
  if (defaultMode === "adapter_default") return "agent_default";
  return "shared_workspace";
}

function primaryWorkspaceIdForProject(project: Pick<Project, "primaryWorkspace" | "workspaces"> | null | undefined) {
  return project?.primaryWorkspace?.id
    ?? project?.workspaces.find((workspace) => workspace.isPrimary)?.id
    ?? project?.workspaces[0]?.id
    ?? null;
}

export function isMainIssueWorkspace(input: {
  issue: Pick<Issue, "projectWorkspaceId" | "currentExecutionWorkspace">;
  project: Pick<Project, "primaryWorkspace" | "workspaces"> | null | undefined;
}) {
  const workspace = input.issue.currentExecutionWorkspace ?? null;
  const primaryWorkspaceId = primaryWorkspaceIdForProject(input.project);
  const linkedProjectWorkspaceId = workspace?.projectWorkspaceId ?? input.issue.projectWorkspaceId ?? null;
  if (workspace) {
    if (workspace.mode !== "shared_workspace") return false;
    if (!linkedProjectWorkspaceId || !primaryWorkspaceId) return true;
    return workspace.mode === "shared_workspace" && linkedProjectWorkspaceId === primaryWorkspaceId;
  }
  if (!linkedProjectWorkspaceId || !primaryWorkspaceId) return true;
  return linkedProjectWorkspaceId === primaryWorkspaceId;
}

export function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
