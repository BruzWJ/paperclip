import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OwnerPickerProps, ProjectPickerProps } from "@paperclipai/plugin-sdk/ui";

import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { projectsApi } from "@/api/projects";
import { AgentIcon } from "@/components/AgentIconPicker";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { useProjectOrder } from "@/hooks/useProjectOrder";
import { type EntityOption } from "@/lib/entity-selector";
import { queryKeys } from "@/lib/queryKeys";
import { getRecentProjectIds, trackRecentProject } from "@/lib/recent-projects";
import { useHostContext } from "./bridge";

export function PluginSdkOwnerPicker({
  companyId,
  value,
  onChange,
  placeholder = "Owner",
  noneLabel = "Select owner",
  searchPlaceholder = "Search owners...",
  emptyMessage = "No eligible owners found.",
  includeTerminatedAgents = false,
  className,
  onConfirm,
}: OwnerPickerProps) {
  const hostContext = useHostContext();
  const resolvedCompanyId = companyId ?? hostContext.companyId ?? null;
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? "__no-company__"),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });
  const eligibleAgents = useMemo(
    () =>
      (agents ?? [])
        .filter((agent) => includeTerminatedAgents || agent.status !== "terminated")
        .sort((left, right) => left.name.localeCompare(right.name)),
    [agents, includeTerminatedAgents],
  );
  const options = useMemo<EntityOption[]>(
    () =>
      eligibleAgents.map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.title ?? ""}`,
      })),
    [eligibleAgents],
  );
  const selectedAgent = eligibleAgents.find((agent) => agent.id === value) ?? null;

  return (
    <EntityCombobox
      value={value}
      options={options}
      type="owner"
      ariaLabel={placeholder}
      placeholder={placeholder}
      noneLabel={noneLabel}
      onValueChange={(nextValue) => onChange(nextValue, { ownerAgentId: nextValue || null })}
      onConfirm={onConfirm}
      searchPlaceholder={searchPlaceholder}
      emptyMessage={emptyMessage}
      triggerClassName={className}
      contentClassName="!w-72 max-w-(--sz-calc-23)"
      renderValue={(option) => (
        <>
          {selectedAgent ? <AgentIcon icon={selectedAgent.icon} className="size-3.5 shrink-0" /> : null}
          {option?.label ?? <span className="text-muted-foreground">{placeholder}</span>}
        </>
      )}
      renderOption={(option) => {
        const agent = eligibleAgents.find((entry) => entry.id === option.id) ?? null;
        return (
          <>
            {agent ? <AgentIcon icon={agent.icon} className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{option.label}</span>
          </>
        );
      }}
    />
  );
}

export function PluginSdkProjectPicker({
  companyId,
  value,
  onChange,
  placeholder = "Project",
  noneLabel = "No project",
  searchPlaceholder = "Search projects...",
  emptyMessage = "No projects found.",
  includeArchived = false,
  className,
  onConfirm,
}: ProjectPickerProps) {
  const hostContext = useHostContext();
  const resolvedCompanyId = companyId ?? hostContext.companyId ?? null;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user.id ?? null;
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(resolvedCompanyId ?? "__no-company__"),
    queryFn: () => projectsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });
  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project) => includeArchived || !project.archivedAt),
    [includeArchived, projects],
  );
  const { orderedProjects } = useProjectOrder({
    projects: visibleProjects,
    companyId: resolvedCompanyId,
    userId: currentUserId,
  });
  const recentProjectIds = useMemo(() => getRecentProjectIds(), []);
  const options = useMemo<EntityOption[]>(
    () =>
      orderedProjects.map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [orderedProjects],
  );
  const selectedProject = orderedProjects.find((project) => project.id === value) ?? null;

  return (
    <EntityCombobox
      value={value}
      options={options}
      type="project"
      ariaLabel={placeholder}
      placeholder={placeholder}
      noneLabel={noneLabel}
      recentOptionIds={recentProjectIds}
      onValueChange={(nextProjectId) => {
        if (nextProjectId) trackRecentProject(nextProjectId);
        onChange(nextProjectId);
      }}
      onConfirm={onConfirm}
      searchPlaceholder={searchPlaceholder}
      emptyMessage={emptyMessage}
      triggerClassName={className}
      contentClassName="!w-72 max-w-(--sz-calc-23)"
      renderValue={(option) => (
        <>
          {selectedProject ? (
            <span
              className="size-3.5 shrink-0 rounded-sm"
              style={{ backgroundColor: selectedProject.color ?? "var(--project-none)" }}
            />
          ) : null}
          {option?.label ?? <span className="text-muted-foreground">{placeholder}</span>}
        </>
      )}
      renderOption={(option) => {
        const project = orderedProjects.find((entry) => entry.id === option.id);
        return (
          <>
            {option.id ? (
              <span
                className="size-3.5 shrink-0 rounded-sm"
                style={{ backgroundColor: project?.color ?? "var(--project-none)" }}
              />
            ) : null}
            <span className="truncate">{option.label}</span>
          </>
        );
      }}
    />
  );
}
