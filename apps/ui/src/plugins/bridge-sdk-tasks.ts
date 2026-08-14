import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { tasksApi } from "@/api/tasks";
import { FileTree } from "@/components/FileTree";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { TasksList as HostTasksList } from "@/components/TasksList";
import { collectLiveTaskIds } from "@/lib/liveTaskIds";
import { queryKeys } from "@/lib/queryKeys";
import type {
  FileTreePathCollection,
  FileTreeProps,
  MarkdownEditorProps,
  TasksListFilters,
  TasksListProps,
} from "@paperclipai/plugin-sdk/ui";
import { useQuery } from "@tanstack/react-query";
import { createElement, useMemo } from "react";

function toPathSet(paths?: FileTreePathCollection | null): Set<string> {
  return new Set(paths ?? []);
}

export function PluginSdkFileTree({
  expandedPaths,
  checkedPaths,
  selectedFile = null,
  showCheckboxes = false,
  onToggleDir,
  onSelectFile,
  ...props
}: FileTreeProps) {
  return createElement(FileTree, {
    ...props,
    selectedFile,
    expandedDirs: toPathSet(expandedPaths),
    checkedFiles: checkedPaths ? toPathSet(checkedPaths) : undefined,
    showCheckboxes,
    onToggleDir: onToggleDir ?? (() => undefined),
    onSelectFile: onSelectFile ?? (() => undefined),
  });
}

export function PluginSdkMarkdownEditor(props: MarkdownEditorProps) {
  return createElement(MarkdownEditor, props);
}

function compactTaskFilters(filters: TasksListFilters): TasksListFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        value !== "" &&
        value !== false &&
        (!Array.isArray(value) || value.length > 0),
    ),
  ) as TasksListFilters;
}

export function PluginSdkTasksList({
  companyId,
  projectId = null,
  filters,
  viewStateKey = "paperclip:plugin-tasks-view",
  initialSearch,
  createTaskLabel,
  searchWithinLoadedTasks = true,
}: TasksListProps) {
  const taskFilters = useMemo(
    () =>
      compactTaskFilters({
        ...(filters ?? {}),
        projectId: filters?.projectId ?? projectId ?? undefined,
      }),
    [filters, projectId],
  );
  const resolvedProjectId = taskFilters.projectId ?? projectId ?? null;
  const tasksQueryKey = useMemo(
    () => ["plugins", "sdk-ui", "tasks-list", companyId ?? "__no-company__", taskFilters] as const,
    [companyId, taskFilters],
  );

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? "__no-company__"),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId ?? "__no-company__"),
    queryFn: () => projectsApi.list(companyId!),
    enabled: !!companyId,
  });
  const activeRunsQueryKey = queryKeys.runs(companyId ?? "__no-company__", {
    status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
  });
  const { data: activeRunPage } = useQuery({
    queryKey: activeRunsQueryKey,
    queryFn: () =>
      runsApi.listForCompany(companyId!, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
    enabled: !!companyId,
  });
  const liveTaskIds = useMemo(() => collectLiveTaskIds(activeRunPage?.items), [activeRunPage]);

  const {
    data: tasks,
    isLoading,
    error,
  } = useQuery({
    queryKey: tasksQueryKey,
    queryFn: () => tasksApi.list(companyId!, taskFilters),
    enabled: !!companyId,
  });

  if (!companyId) {
    return createElement(
      "div",
      { className: "text-sm text-muted-foreground" },
      "Select a company to view tasks.",
    );
  }

  return createElement(HostTasksList, {
    tasks: tasks ?? [],
    isLoading,
    error: error as Error | null,
    agents,
    projects,
    liveTaskIds,
    projectId: resolvedProjectId ?? undefined,
    viewStateKey,
    initialSearch,
    createTaskLabel,
    searchWithinLoadedTasks,
  });
}
