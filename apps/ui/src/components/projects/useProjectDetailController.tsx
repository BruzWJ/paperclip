import { assetsApi } from "@/api/assets";
import { budgetsApi } from "@/api/budgets";
import { projectsApi } from "@/api/projects";
import {
  type ProjectConfigFieldKey,
  type ProjectFieldSaveState,
} from "@/components/ProjectProperties";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { usePanel } from "@/context/PanelContext";
import { toast } from "sonner";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "@/hooks/useResourceMemberships";
import {
  isProjectPluginTab,
  type ProjectPluginTab,
} from "@/lib/project-detail-tabs";
import { queryKeys } from "@/lib/queryKeys";
import { usePluginSlots } from "@/plugins/slots";
import {
  parseMoneyAmount,
  type BudgetPolicySummary,
  type MoneyAmount,
} from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const ZERO_AMOUNT = parseMoneyAmount("0");
type ProjectBaseTab =
  "overview" | "list" | "plugin-operations" | "configuration" | "budget";
export type ProjectTab = ProjectBaseTab | ProjectPluginTab;
export type ProjectDetailVariant =
  "overview" | "tasks" | "plugin-operations" | "configuration" | "budget";
export interface ProjectDetailProps {
  companyId: string;
  projectId: string;
  variant: ProjectDetailVariant;
  pluginTab?: string;
}

export function useProjectDetailController({
  companyId,
  projectId,
  variant,
  pluginTab,
}: ProjectDetailProps) {
  const { companies } = useCompany();
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
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
        toast.success(`"${name}" has been archived`);
        void navigate({
          to: "/$companyId/dashboard",
          params: { companyId },
        });
      } else {
        toast.success(`"${name}" has been unarchived`);
      }
    },
    onError: (_, archived) => {
      toast.error(
        archived ? "Failed to archive project" : "Failed to unarchive project",
      );
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
    return { state: "not-found" as const };
  }

  if (isLoading) return { state: "loading" as const };
  if (error) return { state: "error" as const, message: error.message };
  if (!project) return { state: "empty" as const };
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

  return {
    state: "ready" as const,
    companyId,
    project,
    showLeftProjectNotice,
    projectJoinLeavePending,
    membershipMutation,
    setDismissedLeftProjectIds,
    updateProject,
    projectStarred,
    projectStarPending,
    pluginTabItems,
    activeTab,
    handleTabChange,
    uploadImage,
    fieldSaveStates,
    updateProjectField,
    archiveProject,
    projectBudgetSummary,
    budgetMutation,
    activePluginTab,
  };
}
