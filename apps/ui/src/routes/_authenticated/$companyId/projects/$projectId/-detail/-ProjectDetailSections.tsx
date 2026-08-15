import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { InlineEditor } from "@/features/markdown/InlineEditor";
import { TasksList } from "@/features/tasks/list";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/kibo-ui/combobox";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
import { HexColorPicker } from "@/components/patterns/BrandColorPicker";
import { Separator } from "@/components/ui/separator";
import { useCompanyLiveTaskIds } from "@/hooks/useCompanyLiveTaskIds";
import { getProjectIcon, PROJECT_ICONS } from "@/lib/project-icons";
import { queryKeys } from "@/lib/queryKeys";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import type { ProjectScope } from "@/lib/presentation-contracts";
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
            <DomainStatus status={project.status} />
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
    const entries = PROJECT_ICON_NAMES.map((name) => [name, PROJECT_ICONS[name]] as const);
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(([name]) => name.includes(q));
  }, [search]);
  const SelectedProjectIcon = getProjectIcon(icon);

  // Keep the popover open across selections so the user can pick both an icon
  // and a color in one pass; reset the search when it closes.
  return (
    <Combobox
      data={PROJECT_ICON_NAMES.map((name) => ({ label: name, value: name }))}
      type="icon"
      value={icon ?? DEFAULT_PROJECT_ICON}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <ComboboxTrigger type="button" variant="ghost" size="icon" aria-label="Change project icon and color">
        <Avatar style={{ backgroundColor: color ?? undefined }} aria-hidden="true">
          <AvatarFallback className={color ? "bg-transparent" : undefined}>
            <SelectedProjectIcon />
          </AvatarFallback>
        </Avatar>
      </ComboboxTrigger>
      <ComboboxContent shouldFilter={false} popoverOptions={{ className: "!w-72 p-0", align: "start" }}>
        <ComboboxInput
          aria-label="Search project icons"
          placeholder="Search icons..."
          value={search}
          onValueChange={setSearch}
          autoFocus
        />
        <ComboboxList className="max-h-40">
          <ComboboxEmpty>No icons match.</ComboboxEmpty>
          <ComboboxGroup heading="Icon">
            {filteredIcons.map(([name, Icon]) => (
              <ComboboxItem key={name} value={name} onSelect={() => onSelectIcon(name)}>
                <Icon />
                <span className="flex-1 capitalize">{name}</span>
                {(icon ?? DEFAULT_PROJECT_ICON) === name ? <Check /> : null}
              </ComboboxItem>
            ))}
          </ComboboxGroup>
        </ComboboxList>
        <Separator />
        <div className="space-y-2 p-3">
          <p className="text-sm font-medium">Color</p>
          <HexColorPicker
            value={color ?? PROJECT_COLORS[0]}
            onChange={onSelectColor}
            ariaLabel="Project color"
          />
          <Button type="button" size="sm" variant="ghost" onClick={() => onSelectColor(null)}>
            Reset to neutral
          </Button>
        </div>
      </ComboboxContent>
    </Combobox>
  );
}

/* ── List (tasks) tab content ── */

export function ProjectTasksList({ projectId, companyId }: ProjectScope) {
  return <ProjectScopedTasks companyId={companyId} projectId={projectId} />;
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
  return (
    <ProjectScopedTasks
      companyId={companyId}
      projectId={projectId}
      originKind={originKind}
      viewStateKey={`paperclip:project-plugin-operations-view:${pluginKey}`}
    />
  );
}

function ProjectScopedTasks({
  companyId,
  originKind,
  projectId,
  viewStateKey = "paperclip:project-tasks-view",
}: ProjectScope & { originKind?: string; viewStateKey?: string }) {
  const { agents, projects, liveTaskIds, tasks, isLoading, error } = useProjectTaskListData({
    companyId,
    projectId,
    originKind,
  });

  return (
    <TasksList
      tasks={tasks ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveTaskIds={liveTaskIds}
      projectId={projectId}
      viewStateKey={viewStateKey}
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
  const liveTaskIds = useCompanyLiveTaskIds(companyId, Boolean(companyId));

  const {
    data: tasks,
    isLoading,
    error,
  } = useQuery({
    queryKey: originKind
      ? queryKeys.tasks.listPluginOperationsByProject(companyId, projectId, originKind)
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
