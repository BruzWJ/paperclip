import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";
import type { Agent, Project } from "@paperclipai/shared";
import type { EntityOption } from "@/lib/entity-selector";
import { isAgentTaskOwnerTarget, isAgentTaskTarget } from "@/lib/company-members";
import { getRecentAssigneeIds, sortAgentsByRecency } from "@/lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "@/lib/recent-projects";
import { projectWorkspaceIdAfterProjectChange } from "@/lib/subTaskDefaults";
import { workModeMetaFor } from "@/lib/work-mode-meta";
import {
  loadDraft,
  priorities,
  shouldWarnAboutRunUserSecrets,
  uniqueRequiredUserSecretKeys,
  type StagedTaskFile,
} from "./model";

export function useNewTaskDialogOptions({
  newTaskOpen,
  status,
  priority,
  ownerAgentId,
  projectId,
  workMode,
  stagedFiles,
  agents,
  orderedProjects,
  setProjectId,
  setProjectWorkspaceId,
}: {
  newTaskOpen: boolean;
  status: string;
  priority: string;
  ownerAgentId: string;
  projectId: string;
  workMode: "standard" | "ask" | "planning";
  stagedFiles: StagedTaskFile[];
  agents?: Agent[];
  orderedProjects: Project[];
  setProjectId: Dispatch<SetStateAction<string>>;
  setProjectWorkspaceId: Dispatch<SetStateAction<string>>;
}) {
  const currentProject = orderedProjects.find((item) => item.id === projectId);
  const recentOwnerIds = useMemo(() => getRecentAssigneeIds(), [newTaskOpen]);
  const mapAgent = (agent: Agent, participant = false) => ({
    id: participant ? `agent:${agent.id}` : agent.id,
    label: agent.name,
    searchText: `${agent.name} ${agent.title ?? ""}`,
  });
  const ownerOptions = useMemo<EntityOption[]>(
    () =>
      sortAgentsByRecency((agents ?? []).filter(isAgentTaskOwnerTarget), recentOwnerIds).map((agent) =>
        mapAgent(agent),
      ),
    [agents, recentOwnerIds],
  );
  const participantOptions = useMemo<EntityOption[]>(
    () =>
      sortAgentsByRecency((agents ?? []).filter(isAgentTaskTarget), recentOwnerIds).map((agent) =>
        mapAgent(agent, true),
      ),
    [agents, recentOwnerIds],
  );
  const handleProjectChange = useCallback(
    (nextId: string) => {
      if (nextId) trackRecentProject(nextId);
      setProjectWorkspaceId((current) => projectWorkspaceIdAfterProjectChange(projectId, nextId, current));
      setProjectId(nextId);
    },
    [projectId, setProjectId, setProjectWorkspaceId],
  );
  const savedDraft = useMemo(() => (newTaskOpen ? loadDraft() : null), [newTaskOpen]);
  return {
    currentStatus: undefined,
    currentPriority: priorities.find((item) => item.value === priority),
    currentProject,
    currentOwner: (agents ?? []).find((item) => item.id === ownerAgentId) ?? null,
    neededUserSecretKeys: shouldWarnAboutRunUserSecrets(status, ownerAgentId)
      ? uniqueRequiredUserSecretKeys([currentProject?.env ?? null])
      : [],
    recentOwnerOptionIds: recentOwnerIds,
    recentProjectIds: getRecentProjectIds(),
    ownerOptions,
    participantOptions,
    projectOptions: orderedProjects.map((project) => ({
      id: project.id,
      label: project.name,
      searchText: project.description ?? "",
    })),
    hasSavedDraft: Boolean(savedDraft?.title.trim() || savedDraft?.request.trim()),
    stagedDocuments: stagedFiles.filter((file) => file.kind === "document"),
    stagedAttachments: stagedFiles.filter((file) => file.kind === "attachment"),
    handleProjectChange,
    currentWorkMode: workModeMetaFor(workMode),
  };
}
