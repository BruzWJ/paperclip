import type { Issue } from "@paperclipai/shared";

type IssuePropertiesPanelKeyIssue = Pick<
  Issue,
  | "id"
  | "boardPresentationStatus"
  | "priority"
  | "ownerKind"
  | "ownerAgentId"
  | "ownerUserId"
  | "ownershipEpoch"
  | "projectId"
  | "projectWorkspaceId"
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
  | "executionWorkspacePreference"
  | "executionWorkspaceSettings"
  | "currentExecutionWorkspace"
  | "blocks"
  | "blockedBy"
  | "ancestors"
  | "watchdog"
>;

type IssuePropertiesPanelKeyChild = Pick<Issue, "id" | "updatedAt" | "identifier" | "title">;

export function buildIssuePropertiesPanelKey(
  issue: IssuePropertiesPanelKeyIssue | null | undefined,
  childIssues: readonly IssuePropertiesPanelKeyChild[],
) {
  if (!issue) return "";

  return JSON.stringify({
    id: issue.id,
    boardPresentationStatus: issue.boardPresentationStatus,
    priority: issue.priority,
    ownerKind: issue.ownerKind,
    ownerAgentId: issue.ownerAgentId,
    ownerUserId: issue.ownerUserId,
    ownershipEpoch: issue.ownershipEpoch,
    projectId: issue.projectId,
    projectWorkspaceId: issue.projectWorkspaceId,
    parentId: issue.parentId,
    creatorKind: issue.creatorKind,
    creatorAuthorityId: issue.creatorAuthorityId,
    creatorUserId: issue.creatorUserId,
    creatorPluginInstallationId: issue.creatorPluginInstallationId,
    creatorRoutineId: issue.creatorRoutineId,
    creatorSystemSourceId: issue.creatorSystemSourceId,
    hiddenAt: issue.hiddenAt,
    labelIds: issue.labelIds ?? [],
    executionWorkspacePreference: issue.executionWorkspacePreference,
    executionWorkspaceSettings: issue.executionWorkspaceSettings ?? null,
    currentExecutionWorkspace: issue.currentExecutionWorkspace
      ? {
          id: issue.currentExecutionWorkspace.id,
          mode: issue.currentExecutionWorkspace.mode,
          status: issue.currentExecutionWorkspace.status,
          projectWorkspaceId: issue.currentExecutionWorkspace.projectWorkspaceId,
          branchName: issue.currentExecutionWorkspace.branchName,
          cwd: issue.currentExecutionWorkspace.cwd,
          runtimeServices: (issue.currentExecutionWorkspace.runtimeServices ?? []).map((service) => ({
            id: service.id,
            status: service.status,
            url: service.url,
          })),
        }
      : null,
    executionPolicy: issue.executionPolicy ?? null,
    executionState: issue.executionState
      ? {
          status: issue.executionState.status,
          currentStageType: issue.executionState.currentStageType,
          currentParticipant: issue.executionState.currentParticipant,
          returnOwner: issue.executionState.returnOwner,
        }
      : null,
    blocks: (issue.blocks ?? []).map((relation) => ({
      id: relation.id,
      identifier: relation.identifier ?? null,
      title: relation.title,
      boardPresentationStatus: relation.boardPresentationStatus,
    })),
    blockedBy: (issue.blockedBy ?? []).map((relation) => ({
      id: relation.id,
      identifier: relation.identifier ?? null,
      title: relation.title,
      boardPresentationStatus: relation.boardPresentationStatus,
    })),
    watchdog: issue.watchdog
      ? {
          id: issue.watchdog.id,
          status: issue.watchdog.status,
          lastObservedFingerprint: issue.watchdog.lastObservedFingerprint,
          lastTriggeredAt: issue.watchdog.lastTriggeredAt,
          triggerCount: issue.watchdog.triggerCount,
        }
      : null,
    parentSummary: issue.ancestors?.[0]
      ? {
          id: issue.ancestors[0].id,
          identifier: issue.ancestors[0].identifier ?? null,
          title: issue.ancestors[0].title,
        }
      : null,
    childIssues: childIssues.map((child) => ({
      id: child.id,
      updatedAt: String(child.updatedAt),
      identifier: child.identifier ?? null,
      title: child.title,
    })),
  });
}
