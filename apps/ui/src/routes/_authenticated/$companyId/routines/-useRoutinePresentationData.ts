import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import type { EntityOption } from "@/lib/entity-selector";
import { queryKeys } from "@/lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency } from "@/lib/recent-assignees";
import { getRecentProjectIds } from "@/lib/recent-projects";
import type { Agent, Project } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

export function useRoutineDirectoryData(companyId: string) {
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });

  return { agents, projects, companyMembers };
}

export function useRoutineAssignmentPresentation({
  agents,
  projects,
  recencyKey,
}: {
  agents: Agent[] | undefined;
  projects: Project[] | undefined;
  recencyKey: unknown;
}) {
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [recencyKey]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [recencyKey]);
  const assigneeOptions = useMemo<EntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<EntityOption[]>(
    () =>
      (projects ?? []).map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [projects],
  );
  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );

  return {
    agentById,
    assigneeOptions,
    projectById,
    projectOptions,
    recentAssigneeIds,
    recentProjectIds,
  };
}
