import { createFileRoute } from "@tanstack/react-router";
import { PROJECT_PLUGIN_TAB_PATTERN } from "@/lib/project-detail-tabs";
import { assertOnlySearchKeys, optionalSearchPattern } from "@/routes/-search";
import { loadCompanyProject } from "@/routes/-company-entity-loader";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PROJECT_COLORS,
  PROJECT_ICON_NAMES,
  parseMoneyAmount,
  type BudgetPolicySummary,
  type MoneyAmount,
} from "@paperclipai/shared";
import { budgetsApi } from "@/api/budgets";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { agentsApi } from "@/api/agents";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { assetsApi } from "@/api/assets";
import { usePanel } from "@/context/PanelContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  ProjectProperties,
  type ProjectConfigFieldKey,
  type ProjectFieldSaveState,
} from "@/components/ProjectProperties";
import { InlineEditor } from "@/components/InlineEditor";
import { StatusBadge } from "@/components/StatusBadge";
import { ProjectTile } from "@/components/ProjectTile";
import { BudgetPolicyCard } from "@/components/BudgetPolicyCard";
import { TasksList } from "@/components/TasksList";
import { PageSkeleton } from "@/components/PageSkeleton";
import { PageTabBar } from "@/components/PageTabBar";
import { MembershipAction } from "@/components/MembershipAction";
import { StarToggle } from "@/components/StarToggle";
import { collectLiveTaskIds } from "@/lib/liveTaskIds";
import { PROJECT_ICONS } from "@/lib/project-icons";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Tabs } from "@/components/ui/tabs";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import {
  PluginSlotMount,
  PluginSlotOutlet,
  usePluginSlots,
} from "@/plugins/slots";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "@/hooks/useResourceMemberships";
import { NotFoundPage } from "@/components/NotFoundPage";
import {
  isProjectPluginTab,
  type ProjectPluginTab,
} from "@/lib/project-detail-tabs";

export function validateProjectDetailSearch(search: Record<string, unknown>): {
  tab?: string;
} {
  assertOnlySearchKeys(search, ["tab"]);
  return {
    tab: optionalSearchPattern(
      search.tab,
      "tab",
      PROJECT_PLUGIN_TAB_PATTERN,
      "must be an exact plugin:<plugin-key>:<slot-id> token",
    ),
  };
}

export const Route = createFileRoute(
  "/_authenticated/$companyId/projects/$projectId/",
)({
  validateSearch: validateProjectDetailSearch,
  loader: ({ abortController, context, params }) =>
    loadCompanyProject({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.projectId,
      signal: abortController.signal,
    }),
  component: ProjectIndexRoute,
});

function ProjectIndexRoute() {
  const { companyId, projectId } = Route.useParams();
  const { tab } = Route.useSearch();

  return (
    <ProjectDetail
      companyId={companyId}
      projectId={projectId}
      variant="overview"
      pluginTab={tab}
    />
  );
}

const ZERO_AMOUNT = parseMoneyAmount("0");

/* ── Top-level tab types ── */

type ProjectBaseTab =
  "overview" | "list" | "plugin-operations" | "configuration" | "budget";

type ProjectTab = ProjectBaseTab | ProjectPluginTab;

type ProjectDetailVariant =
  "overview" | "tasks" | "plugin-operations" | "configuration" | "budget";

interface ProjectDetailProps {
  companyId: string;
  projectId: string;
  variant: ProjectDetailVariant;
  pluginTab?: string;
}

/* ── Overview tab content ── */

function OverviewContent({
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Status</span>
          <div className="mt-1">
            <StatusBadge status={project.status} />
          </div>
        </div>
        {project.targetDate && (
          <div>
            <span className="text-muted-foreground">Target Date</span>
            <p>{project.targetDate}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Combined icon + color picker popover (PAP-72 / PAP-68 part 4) ── */

const DEFAULT_PROJECT_ICON = "folder";

function ProjectTilePicker({
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
        <button
          type="button"
          className="shrink-0 rounded-lg cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-(--tp-box-shadow)"
          aria-label="Change project icon and color"
        >
          <ProjectTile color={color} icon={icon} size="md" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        {/* Icon search + grid */}
        <p className="text-xs font-medium text-muted-foreground mb-2">Icon</p>
        <Input
          aria-label="Search project icons"
          placeholder="Search icons..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-2 h-8 text-sm"
          autoFocus
        />
        <div className="grid grid-cols-7 gap-1 max-h-40 overflow-y-auto">
          {filteredIcons.map(([name, Icon]) => (
            <button
              key={name}
              type="button"
              onClick={() => onSelectIcon(name)}
              className={cn(
                "flex items-center justify-center h-8 w-8 rounded hover:bg-accent transition-colors",
                (icon ?? DEFAULT_PROJECT_ICON) === name &&
                  "bg-accent ring-1 ring-primary",
              )}
              title={name}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
          {filteredIcons.length === 0 && (
            <p className="col-span-7 text-xs text-muted-foreground text-center py-2">
              No icons match
            </p>
          )}
        </div>

        {/* Color swatches */}
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            Color
          </p>
          <div className="grid grid-cols-5 gap-1.5">
            {/* Neutral / reset-to-gray option */}
            <button
              type="button"
              onClick={() => onSelectColor(null)}
              className={`h-6 w-6 cursor-pointer transition-(--tp-transform-box-shadow) duration-150 hover:scale-110 ${
                color === null
                  ? "ring-2 ring-foreground ring-offset-1 ring-offset-background rounded-md"
                  : ""
              }`}
              aria-label="Reset to neutral gray"
              title="Neutral (default)"
            >
              <ProjectTile color={null} size="sm" />
            </button>
            {PROJECT_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                onClick={() => onSelectColor(swatch)}
                className={`h-6 w-6 rounded-md cursor-pointer transition-(--tp-transform-box-shadow) duration-150 hover:scale-110 ${
                  swatch === color
                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "hover:ring-2 hover:ring-foreground/30"
                }`}
                style={{ backgroundColor: swatch }}
                aria-label={`Select color ${swatch}`}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ── List (tasks) tab content ── */

function ProjectTasksList({
  projectId,
  companyId,
}: {
  projectId: string;
  companyId: string;
}) {
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
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
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
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
    queryKey: queryKeys.tasks.listByProject(companyId, projectId),
    queryFn: () => tasksApi.list(companyId, { projectId }),
    enabled: !!companyId,
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
      viewStateKey="paperclip:project-tasks-view"
    />
  );
}

function ProjectPluginOperationsList({
  projectId,
  companyId,
  pluginKey,
}: {
  projectId: string;
  companyId: string;
  pluginKey: string;
}) {
  const originKind = `plugin:${pluginKey}:operation`;

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
    queryKey: queryKeys.tasks.listPluginOperationsByProject(
      companyId,
      projectId,
      originKind,
    ),
    queryFn: () => tasksApi.list(companyId, { projectId, originKind }),
    enabled: !!companyId && !!projectId,
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
      viewStateKey={`paperclip:project-plugin-operations-view:${pluginKey}`}
    />
  );
}

/* ── Main project page ── */

export function ProjectDetail({
  companyId,
  projectId,
  variant,
  pluginTab,
}: ProjectDetailProps) {
  const { companies } = useCompany();
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [fieldSaveStates, setFieldSaveStates] = useState<
    Partial<Record<ProjectConfigFieldKey, ProjectFieldSaveState>>
  >({});
  const [dismissedLeftProjectIds, setDismissedLeftProjectIds] = useState<
    Set<string>
  >(() => new Set());
  const fieldSaveRequestIds = useRef<
    Partial<Record<ProjectConfigFieldKey, number>>
  >({});
  const fieldSaveTimers = useRef<
    Partial<Record<ProjectConfigFieldKey, ReturnType<typeof setTimeout>>>
  >({});
  const activeRouteTab: ProjectBaseTab = variant === "tasks" ? "list" : variant;
  const pluginTabFromSearch =
    variant === "overview" && isProjectPluginTab(pluginTab) ? pluginTab : null;
  const activeTab = pluginTabFromSearch ?? activeRouteTab;
  const hasInvalidPluginTab =
    variant === "overview" &&
    pluginTab !== undefined &&
    !isProjectPluginTab(pluginTab);

  const projectQuery = useQuery({
    queryKey: queryKeys.projects.detail(projectId),
    queryFn: () => projectsApi.get(projectId),
  });
  const project = projectQuery.data;
  const isLoading = projectQuery.isLoading;
  const error = projectQuery.error;
  const canonicalProjectId = projectId;
  const membershipsQuery = useResourceMemberships(companyId);
  const membershipMutation = useResourceMembershipMutation(companyId);
  const projectMembershipState = project?.id
    ? resourceMembershipState(membershipsQuery.data, "project", project.id)
    : "joined";
  const { slots: pluginDetailSlots, isLoading: pluginDetailSlotsLoading } =
    usePluginSlots({
      slotTypes: ["detailTab"],
      entityType: "project",
      enabled: true,
    });
  const pluginTabItems = useMemo(
    () =>
      pluginDetailSlots.map((slot) => ({
        value: `plugin:${slot.pluginKey}:${slot.id}` as ProjectPluginTab,
        label: slot.displayName,
        slot,
      })),
    [pluginDetailSlots],
  );
  const activePluginTab =
    pluginTabItems.find((item) => item.value === activeTab) ?? null;
  const invalidateProject = () => {
    if (project) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(project.id),
      });
    }
    queryClient.invalidateQueries({
      queryKey: queryKeys.projects.list(companyId),
    });
  };

  const updateProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.update(project!.id, data),
    onSuccess: invalidateProject,
  });

  const archiveProject = useMutation({
    mutationFn: (archived: boolean) =>
      projectsApi.update(project!.id, {
        archivedAt: archived ? new Date().toISOString() : null,
      }),
    onSuccess: (updatedProject, archived) => {
      invalidateProject();
      const name = updatedProject?.name ?? project?.name ?? "Project";
      if (archived) {
        pushToast({ title: `"${name}" has been archived`, tone: "success" });
        void navigate({
          to: "/$companyId/dashboard",
          params: { companyId },
        });
      } else {
        pushToast({ title: `"${name}" has been unarchived`, tone: "success" });
      }
    },
    onError: (_, archived) => {
      pushToast({
        title: archived
          ? "Failed to archive project"
          : "Failed to unarchive project",
        tone: "error",
      });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      return assetsApi.uploadImage(companyId, file, `projects/${project!.id}`);
    },
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
    staleTime: 5_000,
  });

  useEffect(() => {
    setBreadcrumbs([
      {
        label: "Projects",
        renderLink: (content) => (
          <Link to="/$companyId/projects" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: project?.name ?? projectId },
    ]);
  }, [setBreadcrumbs, project, projectId, companyId]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useEffect(() => {
    if (!project?.id || projectMembershipState !== "joined") return;
    setDismissedLeftProjectIds((current) => {
      if (!current.has(project.id)) return current;
      const next = new Set(current);
      next.delete(project.id);
      return next;
    });
  }, [project?.id, projectMembershipState]);

  useEffect(() => {
    return () => {
      Object.values(fieldSaveTimers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, []);

  const setFieldState = useCallback(
    (field: ProjectConfigFieldKey, state: ProjectFieldSaveState) => {
      setFieldSaveStates((current) => ({ ...current, [field]: state }));
    },
    [],
  );

  const scheduleFieldReset = useCallback(
    (field: ProjectConfigFieldKey, delayMs: number) => {
      const existing = fieldSaveTimers.current[field];
      if (existing) clearTimeout(existing);
      fieldSaveTimers.current[field] = setTimeout(() => {
        setFieldSaveStates((current) => {
          const next = { ...current };
          delete next[field];
          return next;
        });
        delete fieldSaveTimers.current[field];
      }, delayMs);
    },
    [],
  );

  const updateProjectField = useCallback(
    async (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
      const requestId = (fieldSaveRequestIds.current[field] ?? 0) + 1;
      fieldSaveRequestIds.current[field] = requestId;
      setFieldState(field, "saving");
      try {
        await projectsApi.update(project!.id, data);
        invalidateProject();
        if (fieldSaveRequestIds.current[field] !== requestId) return;
        setFieldState(field, "saved");
        scheduleFieldReset(field, 1800);
      } catch (error) {
        if (fieldSaveRequestIds.current[field] !== requestId) return;
        setFieldState(field, "error");
        scheduleFieldReset(field, 3000);
        throw error;
      }
    },
    [invalidateProject, project, companyId, scheduleFieldReset, setFieldState],
  );

  const projectBudgetSummary = useMemo(() => {
    if (!project) return null;
    const matched = budgetOverview?.policies.find(
      (policy) =>
        policy.scopeType === "project" && policy.scopeId === project.id,
    );
    if (matched) return matched;
    const budgetCurrency =
      budgetOverview?.budgetCurrency ??
      companies.find((company) => company.id === companyId)?.budgetCurrency;
    if (!budgetCurrency) return null;
    return {
      policyId: "",
      companyId,
      budgetCurrency,
      scopeType: "project",
      scopeId: project.id,
      scopeName: project.name,
      windowKind: "lifetime",
      limitAmount: ZERO_AMOUNT,
      observedAmount: ZERO_AMOUNT,
      remainingAmount: ZERO_AMOUNT,
      utilizationPercent: 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: false,
      status: "ok",
      paused: Boolean(project.pausedAt),
      pauseReason: project.pauseReason ?? null,
      windowStart: new Date(Date.UTC(1970, 0, 1)),
      windowEnd: new Date(Date.UTC(9999, 0, 1)),
    } satisfies BudgetPolicySummary;
  }, [budgetOverview, companies, project, companyId]);

  const budgetMutation = useMutation({
    mutationFn: (amount: MoneyAmount) =>
      budgetsApi.upsertPolicy(companyId, {
        scopeType: "project",
        scopeId: project!.id,
        limitAmount: amount,
        windowKind: "lifetime",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.budgets.overview(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(project!.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard(companyId),
      });
    },
  });

  if (
    hasInvalidPluginTab ||
    (pluginTabFromSearch && !pluginDetailSlotsLoading && !activePluginTab)
  ) {
    return <NotFoundPage scope="board" />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;
  const showLeftProjectNotice =
    projectMembershipState === "left" &&
    !dismissedLeftProjectIds.has(project.id);
  const projectMembershipPending =
    membershipMutation.isPending &&
    membershipMutation.variables?.resourceType === "project" &&
    membershipMutation.variables.resourceId === project.id;
  const projectStarred = isStarred(
    membershipsQuery.data,
    "project",
    project.id,
  );
  const projectStarPending =
    projectMembershipPending &&
    membershipMutation.variables?.starred !== undefined;
  const projectJoinLeavePending =
    projectMembershipPending &&
    membershipMutation.variables?.starred === undefined;

  const handleTabChange = (tab: ProjectTab) => {
    if (isProjectPluginTab(tab)) {
      void navigate({
        to: "/$companyId/projects/$projectId",
        params: { companyId, projectId: canonicalProjectId },
        search: { tab },
      });
      return;
    }
    if (tab === "overview") {
      void navigate({
        to: "/$companyId/projects/$projectId",
        params: { companyId, projectId: canonicalProjectId },
      });
    } else if (tab === "budget") {
      void navigate({
        to: "/$companyId/projects/$projectId/budget",
        params: { companyId, projectId: canonicalProjectId },
      });
    } else if (tab === "plugin-operations") {
      void navigate({
        to: "/$companyId/projects/$projectId/plugin-operations",
        params: { companyId, projectId: canonicalProjectId },
      });
    } else if (tab === "configuration") {
      void navigate({
        to: "/$companyId/projects/$projectId/configuration",
        params: { companyId, projectId: canonicalProjectId },
      });
    } else {
      void navigate({
        to: "/$companyId/projects/$projectId/tasks",
        params: { companyId, projectId: canonicalProjectId },
      });
    }
  };

  return (
    <div className="space-y-6">
      {showLeftProjectNotice ? (
        <div className="flex items-center gap-3 border border-yellow-300/35 bg-yellow-300/10 px-3 py-2 text-sm text-yellow-900 dark:text-yellow-100">
          <p className="min-w-0 flex-1">
            You left this project. It no longer appears in your sidebar.
          </p>
          <MembershipAction
            compact
            state="left"
            pending={projectJoinLeavePending}
            pendingState={
              projectJoinLeavePending
                ? membershipMutation.variables?.state
                : null
            }
            resourceName={project.name}
            onJoin={() =>
              membershipMutation.mutate({
                resourceType: "project",
                resourceId: project.id,
                resourceName: project.name,
                state: "joined",
              })
            }
            onLeave={() =>
              membershipMutation.mutate({
                resourceType: "project",
                resourceId: project.id,
                resourceName: project.name,
                state: "left",
              })
            }
          />
          <button
            type="button"
            className="h-6 w-6 shrink-0 text-yellow-900/70 hover:text-yellow-900 dark:text-yellow-100/70 dark:hover:text-yellow-100"
            aria-label="Dismiss project membership notice"
            onClick={() =>
              setDismissedLeftProjectIds((current) =>
                new Set(current).add(project.id),
              )
            }
          >
            ×
          </button>
        </div>
      ) : null}
      <div className="flex items-start gap-3">
        <div className="h-7 flex items-center">
          <ProjectTilePicker
            color={project.color ?? null}
            icon={project.icon ?? null}
            onSelectIcon={(icon) => updateProject.mutate({ icon })}
            onSelectColor={(color) => updateProject.mutate({ color })}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <InlineEditor
            value={project.name}
            onSave={(name) => updateProject.mutate({ name })}
            as="h2"
            className="text-xl font-bold"
          />
          {project.pauseReason === "budget" ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-caps) text-red-800 dark:text-red-200">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              Paused by budget hard stop
            </div>
          ) : null}
          {project.managedByPlugin ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-(length:--text-micro) font-medium text-muted-foreground">
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: project.color ?? "var(--project-seed)",
                }}
              />
              Managed by {project.managedByPlugin.pluginDisplayName}
            </div>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <StarToggle
            size="button"
            starred={projectStarred}
            pending={projectStarPending}
            resourceName={project.name}
            onToggle={(next) =>
              membershipMutation.mutate({
                resourceType: "project",
                resourceId: project.id,
                resourceName: project.name,
                starred: next,
              })
            }
          />
        </div>
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton"]}
        entityType="project"
        context={{
          companyId,
          projectId: project.id,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="project"
        context={{
          companyId,
          projectId: project.id,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <Tabs
        value={activeTab ?? "list"}
        onValueChange={(value) => handleTabChange(value as ProjectTab)}
      >
        <PageTabBar
          items={[
            { value: "list", label: "Tasks" },
            { value: "overview", label: "Overview" },
            ...(project.managedByPlugin
              ? [{ value: "plugin-operations", label: "Plugin operations" }]
              : []),
            { value: "configuration", label: "Configuration" },
            { value: "budget", label: "Budget" },
            ...pluginTabItems.map((item) => ({
              value: item.value,
              label: item.label,
            })),
          ]}
          align="start"
          value={activeTab ?? "list"}
          onValueChange={(value) => handleTabChange(value as ProjectTab)}
        />
      </Tabs>

      {activeTab === "overview" && (
        <OverviewContent
          project={project}
          onUpdate={(data) => updateProject.mutate(data)}
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      )}

      {activeTab === "list" && project?.id && (
        <ProjectTasksList projectId={project.id} companyId={companyId} />
      )}

      {activeTab === "plugin-operations" &&
        project?.id &&
        project.managedByPlugin && (
          <ProjectPluginOperationsList
            projectId={project.id}
            companyId={companyId}
            pluginKey={project.managedByPlugin.pluginKey}
          />
        )}

      {activeTab === "configuration" && (
        <div className="max-w-4xl">
          <ProjectProperties
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            onFieldUpdate={updateProjectField}
            getFieldSaveState={(field) => fieldSaveStates[field] ?? "idle"}
            onArchive={(archived) => archiveProject.mutate(archived)}
            archivePending={archiveProject.isPending}
          />
        </div>
      )}

      {activeTab === "budget" ? (
        <div className="max-w-3xl">
          {projectBudgetSummary ? (
            <BudgetPolicyCard
              summary={projectBudgetSummary}
              variant="plain"
              isSaving={budgetMutation.isPending}
              onSave={(amount) => budgetMutation.mutate(amount)}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Budget data is unavailable.
            </p>
          )}
        </div>
      ) : null}

      {activePluginTab && (
        <PluginSlotMount
          slot={activePluginTab.slot}
          context={{
            companyId,
            projectId: project.id,
            entityId: project.id,
            entityType: "project",
          }}
          missingBehavior="placeholder"
        />
      )}
    </div>
  );
}
