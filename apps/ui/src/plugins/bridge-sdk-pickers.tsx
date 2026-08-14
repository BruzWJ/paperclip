import { useMemo } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { OwnerPickerProps, ProjectPickerProps } from "@paperclipai/plugin-sdk/ui";

import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { projectsApi } from "@/api/projects";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useProjectOrder } from "@/hooks/useProjectOrder";
import {
  ENTITY_NONE_VALUE,
  entityOptionMatchesSearch,
  type EntityOption,
  useEntitySelectorState,
} from "@/lib/entity-selector";
import { queryKeys } from "@/lib/queryKeys";
import { getRecentProjectIds, trackRecentProject } from "@/lib/recent-projects";
import { cn } from "@/lib/utils";
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
  const selector = useEntitySelectorState({
    value,
    options,
    noneLabel,
    onChange: (nextValue) => onChange(nextValue, { ownerAgentId: nextValue || null }),
    onConfirm,
  });

  return (
    <Popover open={selector.open} onOpenChange={selector.setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={selector.open}
          aria-label={placeholder}
          className={cn("w-full justify-between overflow-hidden", className)}
          onPointerDown={() => {
            selector.pointerFocusRef.current = true;
          }}
          onFocus={() => {
            if (selector.pointerFocusRef.current) selector.pointerFocusRef.current = false;
            else selector.setOpen(true);
          }}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-left">
            {selectedAgent ? <AgentIcon icon={selectedAgent.icon} className="size-3.5 shrink-0" /> : null}
            {selector.currentOption?.label ?? <span className="text-muted-foreground">{placeholder}</span>}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={16} className="w-72 max-w-(--sz-calc-23) p-0">
        <Command
          filter={(optionValue, search) =>
            entityOptionMatchesSearch(
              selector.orderedOptions.find((option) => (option.id || ENTITY_NONE_VALUE) === optionValue),
              search,
            )
          }
        >
          <CommandInput autoFocus placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {selector.orderedOptions.map((option) => {
              const agent = eligibleAgents.find((entry) => entry.id === option.id) ?? null;
              return (
                <CommandItem
                  key={option.id || ENTITY_NONE_VALUE}
                  value={option.id || ENTITY_NONE_VALUE}
                  keywords={[option.label, option.searchText ?? ""]}
                  onSelect={() => selector.select(option)}
                >
                  {agent ? <AgentIcon icon={agent.icon} className="size-3.5 shrink-0" /> : null}
                  <span className="truncate">{option.label}</span>
                  <Check
                    className={cn("ml-auto size-4", option.id === value ? "opacity-100" : "opacity-0")}
                  />
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
  const selector = useEntitySelectorState({
    value,
    options,
    noneLabel,
    recentOptionIds: recentProjectIds,
    onChange: (nextProjectId) => {
      if (nextProjectId) trackRecentProject(nextProjectId);
      onChange(nextProjectId);
    },
    onConfirm,
  });

  return (
    <Popover open={selector.open} onOpenChange={selector.setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={selector.open}
          aria-label={placeholder}
          className={cn("w-full justify-between overflow-hidden", className)}
          onPointerDown={() => {
            selector.pointerFocusRef.current = true;
          }}
          onFocus={() => {
            if (selector.pointerFocusRef.current) selector.pointerFocusRef.current = false;
            else selector.setOpen(true);
          }}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-left">
            {selectedProject ? (
              <span
                className="size-3.5 shrink-0 rounded-sm"
                style={{ backgroundColor: selectedProject.color ?? "var(--project-none)" }}
              />
            ) : null}
            {selector.currentOption?.label ?? <span className="text-muted-foreground">{placeholder}</span>}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={16} className="w-72 max-w-(--sz-calc-23) p-0">
        <Command
          filter={(optionValue, search) =>
            entityOptionMatchesSearch(
              selector.orderedOptions.find((option) => (option.id || ENTITY_NONE_VALUE) === optionValue),
              search,
            )
          }
        >
          <CommandInput autoFocus placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {selector.orderedOptions.map((option) => {
              const project = orderedProjects.find((entry) => entry.id === option.id);
              return (
                <CommandItem
                  key={option.id || ENTITY_NONE_VALUE}
                  value={option.id || ENTITY_NONE_VALUE}
                  keywords={[option.label, option.searchText ?? ""]}
                  onSelect={() => selector.select(option)}
                >
                  {option.id ? (
                    <span
                      className="size-3.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: project?.color ?? "var(--project-none)" }}
                    />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                  <Check
                    className={cn("ml-auto size-4", option.id === value ? "opacity-100" : "opacity-0")}
                  />
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
