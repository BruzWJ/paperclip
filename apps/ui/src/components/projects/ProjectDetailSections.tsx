import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { tasksApi } from "@/api/tasks";
import { InlineEditor } from "@/components/InlineEditor";
import { TasksList } from "@/components/TasksList";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { collectLiveTaskIds } from "@/lib/liveTaskIds";
import { getProjectIcon, PROJECT_ICONS } from "@/lib/project-icons";
import { queryKeys } from "@/lib/queryKeys";
import { statusBadgeVariant } from "@/lib/status-variant";
import { PROJECT_COLORS, PROJECT_ICON_NAMES } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Check } from "lucide-react";

export function ProjectOverviewContent({
  project,
  onUpdate,
  imageUploadHandler,
}: {
  project: {
    description: string | null;
    status: string;
    targetDate: string | null;
  };
  onUpdate: (data: Record<string, unknown>) => void;
  imageUploadHandler?: (file: File) => Promise<string>;
}) {
  return (
    <div className="space-y-6">
      <InlineEditor
        value={project.description ?? ""}
        onSave={(description) => onUpdate({ description })}
        nullable
        as="p"
        className="text-sm text-muted-foreground"
        placeholder="Add a description..."
        multiline
        imageUploadHandler={imageUploadHandler}
      />

      <ItemGroup className="grid grid-cols-1 sm:grid-cols-2">
        <Item size="sm" variant="outline">
          <ItemContent>
            <ItemTitle>Status</ItemTitle>
            <Badge variant={statusBadgeVariant(project.status)}>
              {project.status.replace(/[_-]/g, " ")}
            </Badge>
          </ItemContent>
        </Item>
        {project.targetDate && (
          <Item size="sm" variant="outline">
            <ItemContent>
              <ItemTitle>Target date</ItemTitle>
              <p>{project.targetDate}</p>
            </ItemContent>
          </Item>
        )}
      </ItemGroup>
    </div>
  );
}

/* ── Combined icon + color picker popover (PAP-72 / PAP-68 part 4) ── */

const DEFAULT_PROJECT_ICON = "folder";

export function ProjectTilePicker({
  color,
  icon,
  onSelectIcon,
  onSelectColor,
}: {
  color: string | null;
  icon: string | null;
  onSelectIcon: (icon: string) => void;
  onSelectColor: (color: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filteredIcons = useMemo(() => {
    const entries = PROJECT_ICON_NAMES.map(
      (name) => [name, PROJECT_ICONS[name]] as const,
    );
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(([name]) => name.includes(q));
  }, [search]);
  const SelectedProjectIcon = getProjectIcon(icon);
  const DefaultProjectIcon = getProjectIcon(null);

  // Keep the popover open across selections so the user can pick both an icon
  // and a color in one pass; reset the search when it closes.
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Change project icon and color"
        >
          <Avatar
            style={{ backgroundColor: color ?? undefined }}
            aria-hidden="true"
          >
            <AvatarFallback className={color ? "bg-transparent" : undefined}>
              <SelectedProjectIcon />
            </AvatarFallback>
          </Avatar>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            aria-label="Search project icons"
            placeholder="Search icons..."
            value={search}
            onValueChange={setSearch}
            autoFocus
          />
          <CommandList className="max-h-40">
            <CommandEmpty>No icons match.</CommandEmpty>
            <CommandGroup heading="Icon">
              {filteredIcons.map(([name, Icon]) => (
                <CommandItem
                  key={name}
                  value={name}
                  onSelect={() => onSelectIcon(name)}
                >
                  <Icon />
                  <span className="flex-1 capitalize">{name}</span>
                  {(icon ?? DEFAULT_PROJECT_ICON) === name ? <Check /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        <Separator />
        <div className="space-y-2 p-3">
          <p className="text-sm font-medium">Color</p>
          <ToggleGroup
            type="single"
            value={color ?? "none"}
            variant="outline"
            size="sm"
            spacing={1}
            onValueChange={(value) => {
              if (value) onSelectColor(value === "none" ? null : value);
            }}
          >
            <ToggleGroupItem value="none" aria-label="Reset to neutral gray">
              <Avatar size="sm" aria-hidden="true">
                <AvatarFallback>
                  <DefaultProjectIcon />
                </AvatarFallback>
              </Avatar>
            </ToggleGroupItem>
            {PROJECT_COLORS.map((swatch) => (
              <ToggleGroupItem
                key={swatch}
                value={swatch}
                aria-label={`Select color ${swatch}`}
              >
                <span
                  className="size-4 rounded-sm"
                  style={{ backgroundColor: swatch }}
                />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ── List (tasks) tab content ── */

export function ProjectTasksList({
  projectId,
  companyId,
}: {
  projectId: string;
  companyId: string;
}) {
  const { agents, projects, liveTaskIds, tasks, isLoading, error } =
    useProjectTaskListData({ companyId, projectId });

  return (
    <TasksList
      tasks={tasks ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveTaskIds={liveTaskIds}
      projectId={projectId}
      viewStateKey="paperclip:project-tasks-view"
    />
  );
}

export function ProjectPluginOperationsList({
  projectId,
  companyId,
  pluginKey,
}: {
  projectId: string;
  companyId: string;
  pluginKey: string;
}) {
  const originKind = `plugin:${pluginKey}:operation`;
  const { agents, projects, liveTaskIds, tasks, isLoading, error } =
    useProjectTaskListData({ companyId, projectId, originKind });

  return (
    <TasksList
      tasks={tasks ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveTaskIds={liveTaskIds}
      projectId={projectId}
      viewStateKey={`paperclip:project-plugin-operations-view:${pluginKey}`}
    />
  );
}

function useProjectTaskListData({
  companyId,
  projectId,
  originKind,
}: {
  companyId: string;
  projectId: string;
  originKind?: string;
}) {
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });
  const activeRunsQueryKey = queryKeys.runs(companyId, {
    status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
  });
  const { data: activeRunPage } = useQuery({
    queryKey: activeRunsQueryKey,
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
    enabled: !!companyId,
  });
  const liveTaskIds = useMemo(
    () => collectLiveTaskIds(activeRunPage?.items),
    [activeRunPage],
  );

  const {
    data: tasks,
    isLoading,
    error,
  } = useQuery({
    queryKey: originKind
      ? queryKeys.tasks.listPluginOperationsByProject(
          companyId,
          projectId,
          originKind,
        )
      : queryKeys.tasks.listByProject(companyId, projectId),
    queryFn: () =>
      tasksApi.list(companyId, {
        projectId,
        ...(originKind ? { originKind } : {}),
      }),
    enabled: !!companyId && !!projectId,
  });

  return { agents, projects, liveTaskIds, tasks, isLoading, error };
}
