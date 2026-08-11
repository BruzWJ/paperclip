/**
 * Plugin bridge initialization.
 *
 * Registers the host's React instances and bridge hook implementations
 * on a global object so that the plugin module loader can inject them
 * into plugin UI bundles at load time.
 *
 * Call `initPluginBridge()` once during app startup (in `main.tsx`), before
 * any plugin UI modules are loaded.
 *
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §19.0.2 — Bundle Isolation
 */

import {
  usePluginData,
  usePluginAction,
  useHostContext,
  useHostLocation,
  useHostNavigation,
  usePluginToast,
} from "./bridge.js";
import { Component, createElement, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FileTree,
} from "@/components/FileTree";
import { AgentIcon } from "@/components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "@/components/InlineEntitySelector";
import { TasksList as HostTasksList } from "@/components/TasksList";
import { ManagedRoutinesList as HostManagedRoutinesList } from "@/components/ManagedRoutinesList";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { tasksApi } from "@/api/tasks";
import { projectsApi } from "@/api/projects";
import { collectLiveTaskIds } from "@/lib/liveTaskIds";
import { useProjectOrder } from "@/hooks/useProjectOrder";
import { usePublishSharedQueryData, useSharedPollingQuery } from "@/hooks/useSharedPolling";
import { queryKeys } from "@/lib/queryKeys";
import { getRecentProjectIds, trackRecentProject } from "@/lib/recent-projects";
import type {
  DataTableProps,
  FileTreePathCollection,
  FileTreeProps,
  TasksListFilters,
  TasksListProps,
  JsonTreeProps,
  KeyValueListProps,
  MarkdownBlockProps,
  MarkdownEditorProps,
  MetricCardProps,
  OwnerPickerProps,
  ProjectPickerProps,
  SpinnerProps,
  StatusBadgeProps,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Global bridge registry
// ---------------------------------------------------------------------------

/**
 * The global bridge registry shape.
 *
 * This is placed on `globalThis.__paperclipPluginBridge__` and consumed by
 * the plugin module loader to provide implementations for external imports.
 */
type PluginSdkUiRuntime = typeof import("@paperclipai/plugin-sdk/ui");

export interface PluginBridgeRegistry {
  react: unknown;
  reactDom: unknown;
  reactDomClient: unknown;
  sdkUi: PluginSdkUiRuntime;
}

declare global {
  // eslint-disable-next-line no-var
  var __paperclipPluginBridge__: PluginBridgeRegistry | undefined;
}

function toPathSet(paths?: FileTreePathCollection | null): Set<string> {
  return new Set(paths ?? []);
}

function PluginSdkFileTree({
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

function PluginSdkMarkdownEditor(props: MarkdownEditorProps) {
  return createElement(MarkdownEditor, props);
}

function compactTaskFilters(filters: TasksListFilters): TasksListFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) =>
      value !== undefined && value !== null && value !== "" && value !== false,
    ),
  ) as TasksListFilters;
}

function PluginSdkTasksList({
  companyId,
  projectId = null,
  filters,
  viewStateKey = "paperclip:plugin-tasks-view",
  initialSearch,
  createTaskLabel,
  searchWithinLoadedTasks = true,
}: TasksListProps) {
  const taskFilters = useMemo(
    () => compactTaskFilters({
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
  const activeRunsQueryKey = queryKeys.runs(companyId ?? "__no-company__", { status: ACTIVE_TASK_EXECUTION_RUN_STATUSES });
  const sharedActiveRuns = useSharedPollingQuery({
    companyId,
    resourceKey: "active-runs",
    queryKey: activeRunsQueryKey,
    enabled: !!companyId,
    // Event-sourced via LiveUpdatesProvider (#9627); no interval poll needed.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: activeRunPage, dataUpdatedAt: activeRunsUpdatedAt } = useQuery({
    queryKey: activeRunsQueryKey,
    queryFn: () => runsApi.listForCompany(companyId!, { status: ACTIVE_TASK_EXECUTION_RUN_STATUSES, limit: 200 }),
    enabled: sharedActiveRuns.enabled,
    refetchInterval: sharedActiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedActiveRuns, activeRunPage, activeRunsUpdatedAt);
  const liveTaskIds = useMemo(() => collectLiveTaskIds(activeRunPage?.items), [activeRunPage]);

  const { data: tasks, isLoading, error } = useQuery({
    queryKey: tasksQueryKey,
    queryFn: () => tasksApi.list(companyId!, taskFilters),
    enabled: !!companyId,
  });

  if (!companyId) {
    return createElement("div", { className: "text-sm text-muted-foreground" }, "Select a company to view tasks.");
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

function PluginSdkOwnerPicker({
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
    () => (agents ?? [])
      .filter((agent) => includeTerminatedAgents || agent.status !== "terminated")
      .sort((left, right) => left.name.localeCompare(right.name)),
    [agents, includeTerminatedAgents],
  );
  const options = useMemo<InlineEntityOption[]>(
    () => eligibleAgents.map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.title ?? ""}`,
      })),
    [eligibleAgents],
  );
  const selectedAgent = eligibleAgents.find((agent) => agent.id === value) ?? null;

  return createElement(InlineEntitySelector, {
    value,
    options,
    placeholder,
    noneLabel,
    searchPlaceholder,
    emptyMessage,
    className,
    onConfirm,
    onChange: (nextValue: string) => {
      onChange(nextValue, { ownerAgentId: nextValue || null });
    },
    renderTriggerValue: (option: InlineEntityOption | null) => {
      if (!option) return createElement("span", { className: "text-muted-foreground" }, placeholder);
      if (selectedAgent) {
        return createElement(
          FragmentSafe,
          null,
          createElement(AgentIcon, { icon: selectedAgent.icon, className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }),
          createElement("span", { className: "truncate" }, option.label),
        );
      }
      return createElement("span", { className: "truncate" }, option.label);
    },
    renderOption: (option: InlineEntityOption) => {
      if (!option.id) return createElement("span", { className: "truncate" }, option.label);
      const agent = eligibleAgents.find((entry) => entry.id === option.id) ?? null;
      return createElement(
        FragmentSafe,
        null,
        createElement(AgentIcon, { icon: agent?.icon, className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }),
        createElement("span", { className: "truncate" }, option.label),
      );
    },
  });
}

function PluginSdkProjectPicker({
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
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
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
  const options = useMemo<InlineEntityOption[]>(
    () => orderedProjects.map((project) => ({
      id: project.id,
      label: project.name,
      searchText: project.description ?? "",
    })),
    [orderedProjects],
  );
  const selectedProject = orderedProjects.find((project) => project.id === value) ?? null;

  return createElement(InlineEntitySelector, {
    value,
    options,
    recentOptionIds: recentProjectIds,
    placeholder,
    noneLabel,
    searchPlaceholder,
    emptyMessage,
    className,
    onConfirm,
    onChange: (nextProjectId: string) => {
      if (nextProjectId) trackRecentProject(nextProjectId);
      onChange(nextProjectId);
    },
    renderTriggerValue: (option: InlineEntityOption | null) => {
      if (!option || !selectedProject) {
        return createElement("span", { className: "text-muted-foreground" }, placeholder);
      }
      return createElement(
        FragmentSafe,
        null,
        createElement("span", {
          className: "h-3.5 w-3.5 shrink-0 rounded-sm",
          style: { backgroundColor: selectedProject.color ?? "#6366f1" },
        }),
        createElement("span", { className: "truncate" }, option.label),
      );
    },
    renderOption: (option: InlineEntityOption) => {
      if (!option.id) return createElement("span", { className: "truncate" }, option.label);
      const project = orderedProjects.find((entry) => entry.id === option.id);
      return createElement(
        FragmentSafe,
        null,
        createElement("span", {
          className: "h-3.5 w-3.5 shrink-0 rounded-sm",
          style: { backgroundColor: project?.color ?? "#6366f1" },
        }),
        createElement("span", { className: "truncate" }, option.label),
      );
    },
  });
}

function FragmentSafe({ children }: { children?: ReactNode }) {
  return createElement("span", { className: "contents" }, children);
}

function PluginSdkStatusBadge({ label, status }: StatusBadgeProps) {
  const className = {
    ok: "border-emerald-300 bg-emerald-50 text-emerald-700",
    warning: "border-amber-300 bg-amber-50 text-amber-800",
    error: "border-red-300 bg-red-50 text-red-700",
    info: "border-slate-300 bg-slate-50 text-slate-700",
    pending: "border-slate-300 bg-slate-50 text-slate-600",
  }[status];
  return createElement(
    "span",
    { className: `inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}` },
    label,
  );
}

function PluginSdkDataTable({ columns, rows, loading, emptyMessage = "No rows." }: DataTableProps) {
  if (loading) return createElement("div", { className: "text-sm text-muted-foreground" }, "Loading...");
  if (!rows.length) return createElement("div", { className: "text-sm text-muted-foreground" }, emptyMessage);
  const gridColumns = columns.map((column) => column.width ?? "minmax(0, 1fr)").join(" ");
  return createElement(
    "div",
    { className: "overflow-hidden rounded-md border" },
    createElement(
      "div",
      {
        className: "hidden border-b bg-muted/35 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid md:[grid-template-columns:var(--plugin-grid-cols)]",
        style: { "--plugin-grid-cols": gridColumns },
      },
      columns.map((column) => createElement("div", { key: column.key }, column.header)),
    ),
    createElement(
      "div",
      { className: "divide-y" },
      rows.map((row, index) => createElement(
        "div",
        {
          key: String(row.id ?? index),
          className: "grid gap-2 px-3 py-3 md:items-center md:[grid-template-columns:var(--plugin-grid-cols)]",
          style: { "--plugin-grid-cols": gridColumns },
        },
        columns.map((column) => createElement(
          "div",
          { key: column.key, className: "min-w-0 text-sm" },
          createElement("div", { className: "mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:hidden" }, column.header),
          column.render ? column.render(row[column.key], row) : String(row[column.key] ?? ""),
        )),
      )),
    ),
  );
}

function PluginSdkKeyValueList({ pairs }: KeyValueListProps) {
  return createElement(
    "dl",
    { className: "grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]" },
    pairs.flatMap((pair) => [
      createElement("dt", { key: `${pair.label}:label`, className: "text-muted-foreground" }, pair.label),
      createElement("dd", { key: `${pair.label}:value`, className: "min-w-0" }, pair.value),
    ]),
  );
}

function PluginSdkMetricCard({ label, value, unit }: MetricCardProps) {
  return createElement(
    "div",
    { className: "rounded-md border bg-card p-3" },
    createElement("div", { className: "text-xs font-medium uppercase tracking-wide text-muted-foreground" }, label),
    createElement("div", { className: "mt-1 text-lg font-semibold" }, `${value}${unit ?? ""}`),
  );
}

function PluginSdkJsonTree({ data }: JsonTreeProps) {
  return createElement("pre", { className: "max-h-80 overflow-auto rounded-md border bg-muted/30 p-2 text-xs" }, JSON.stringify(data, null, 2));
}

function PluginSdkSpinner({ label = "Loading" }: SpinnerProps) {
  return createElement("span", {
    className: "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground align-middle",
    role: "status",
    "aria-label": label,
  });
}

class PluginSdkErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { hasError: boolean }> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback ?? createElement("div", { className: "rounded-md border border-destructive/30 p-3 text-sm text-destructive" }, "Plugin UI failed to render.");
    }
    return this.props.children;
  }
}

/**
 * Initialize the plugin bridge global registry.
 *
 * Registers the host's React, ReactDOM, ReactDOM client, and SDK UI bridge implementations
 * on `globalThis.__paperclipPluginBridge__` so the plugin module loader
 * can provide them to plugin bundles.
 *
 * @param react - The host's React module
 * @param reactDom - The host's ReactDOM module
 * @param reactDomClient - The host's ReactDOM client module
 */
export function initPluginBridge(
  react: typeof import("react"),
  reactDom: typeof import("react-dom"),
  reactDomClient: typeof import("react-dom/client"),
): void {
  globalThis.__paperclipPluginBridge__ = {
    react,
    reactDom,
    reactDomClient,
    sdkUi: {
      usePluginData,
      usePluginAction,
      useHostContext,
      useHostLocation,
      useHostNavigation,
      usePluginToast,
      MarkdownBlock: ({
        content,
        className,
        enableWikiLinks,
        wikiLinkRoot,
        resolveWikiLinkHref,
      }: MarkdownBlockProps) =>
        createElement(MarkdownBody, {
          className,
          softBreaks: false,
          enableWikiLinks,
          wikiLinkRoot,
          resolveWikiLinkHref,
          children: content,
        }),
      MetricCard: PluginSdkMetricCard,
      StatusBadge: PluginSdkStatusBadge,
      DataTable: PluginSdkDataTable,
      KeyValueList: PluginSdkKeyValueList,
      JsonTree: PluginSdkJsonTree,
      Spinner: PluginSdkSpinner,
      ErrorBoundary: PluginSdkErrorBoundary,
      MarkdownEditor: PluginSdkMarkdownEditor,
      FileTree: PluginSdkFileTree,
      TasksList: PluginSdkTasksList,
      OwnerPicker: PluginSdkOwnerPicker,
      ProjectPicker: PluginSdkProjectPicker,
      ManagedRoutinesList: HostManagedRoutinesList,
    },
  };
}
