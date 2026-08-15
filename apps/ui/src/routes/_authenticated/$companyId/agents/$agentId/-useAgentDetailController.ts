import { agentsApi } from "@/api/agents";
import { budgetsApi } from "@/api/budgets";
import { isTaskExecutionRunActive, runsApi } from "@/api/runs";
import { tasksApi } from "@/api/tasks";
import { useCompany } from "@/context/CompanyContext";
import { usePanel } from "@/context/PanelContext";
import { useSidebar } from "@/context/SidebarContext";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "@/hooks/useResourceMemberships";
import type { AgentDetailView } from "@/lib/agent-detail-tabs";
import { queryKeys } from "@/lib/queryKeys";
import {
  compareMoneyAmounts,
  moneyAmountUtilizationPercent,
  parseMoneyAmount,
  subtractMoneyAmounts,
  type AgentDetail as AgentDetailRecord,
  type BudgetPolicySummary,
  type MoneyAmount,
  type TaskExecutionRunListPageRecord,
} from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const ZERO_AMOUNT = parseMoneyAmount("0");

export function formatOrgChainHealthPath(agent: AgentDetailRecord) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  return (
    agent.orgChainHealth?.fullChain
      .map((entry) => `${entry.name}${entry.status !== "idle" ? ` (${entry.status})` : ""}`)
      .join(" -> ") ?? agent.name
  );
}

export function useAgentDetailController({
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  companyId,
  agentId,
  urlTab,
  urlRunId,
}: {
  companyId: string;
  agentId: string;
  urlTab?: Exclude<AgentDetailView, "dashboard">;
  urlRunId?: string;
}) {
  const { companies } = useCompany();
  const { closePanel } = usePanel();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedLeftAgentIds, setDismissedLeftAgentIds] = useState<Set<string>>(() => new Set());
  const activeView: AgentDetailView = urlRunId ? "runs" : (urlTab ?? "dashboard");
  const needsDashboardData = activeView === "dashboard";
  const needsRunData = activeView === "runs" || Boolean(urlRunId);
  const shouldLoadRuns = needsDashboardData || needsRunData;
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const saveConfigActionRef = useRef<(() => void) | null>(null);
  const cancelConfigActionRef = useRef<(() => void) | null>(null);
  const { isMobile } = useSidebar();
  const setSaveConfigAction = useCallback((fn: (() => void) | null) => {
    saveConfigActionRef.current = fn;
  }, []);
  const setCancelConfigAction = useCallback((fn: (() => void) | null) => {
    cancelConfigActionRef.current = fn;
  }, []);

  const agentQuery = useQuery<AgentDetailRecord>({
    queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => agentsApi.get(agentId),
  });
  const agent = agentQuery.data;
  const isLoading = agentQuery.isLoading;
  const error = agentQuery.error;
  const membershipsQuery = useResourceMemberships(companyId);
  const membershipMutation = useResourceMembershipMutation(companyId);
  const agentMembershipState = resourceMembershipState(membershipsQuery.data, "agent", agentId);

  const { data: runtimeState } = useQuery({
    queryKey: queryKeys.agents.runtimeState(agentId),
    queryFn: () => agentsApi.runtimeState(agentId),
    enabled: needsDashboardData,
  });

  const { data: runPage } = useQuery<TaskExecutionRunListPageRecord>({
    queryKey: queryKeys.runs(companyId, { agentId: agent?.id }),
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        agentId: agent!.id,
        limit: 200,
      }),
    enabled: Boolean(agent?.id && shouldLoadRuns),
  });
  const runs = runPage?.items ?? [];

  const { data: allTasks } = useQuery({
    queryKey: [...queryKeys.tasks.list(companyId), "participant-agent", agentId],
    queryFn: () =>
      tasksApi.list(companyId, {
        participantAgentId: agentId,
      }),
    enabled: needsDashboardData,
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
    staleTime: 5_000,
  });

  const assignedTasks = (allTasks ?? []).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const agentBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "agent" && policy.scopeId === agent?.id,
    );
    if (matched) return matched;
    if (!agent) return null;
    const budgetCurrency =
      budgetOverview?.budgetCurrency ?? companies.find((company) => company.id === companyId)?.budgetCurrency;
    if (!budgetCurrency) return null;
    const limitAmount = agent.budgetMonthlyAmount;
    const observedAmount = agent.knownSpendAmount;
    const hasLimit = compareMoneyAmounts(limitAmount, ZERO_AMOUNT) > 0;
    const utilizationPercent = moneyAmountUtilizationPercent(observedAmount, limitAmount);
    const windowStart = new Date();
    windowStart.setUTCDate(1);
    windowStart.setUTCHours(0, 0, 0, 0);
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCMonth(windowEnd.getUTCMonth() + 1);
    return {
      policyId: "",
      companyId,
      budgetCurrency,
      scopeType: "agent",
      scopeId: agent.id,
      scopeName: agent.name,
      windowKind: "calendar_month_utc",
      limitAmount,
      observedAmount,
      remainingAmount:
        hasLimit && compareMoneyAmounts(observedAmount, limitAmount) < 0
          ? subtractMoneyAmounts(limitAmount, observedAmount)
          : ZERO_AMOUNT,
      utilizationPercent,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: hasLimit,
      status:
        hasLimit && compareMoneyAmounts(observedAmount, limitAmount) >= 0
          ? "hard_stop"
          : hasLimit && utilizationPercent >= 80
            ? "warning"
            : "ok",
      paused: agent?.status === "paused",
      pauseReason: agent?.pauseReason ?? null,
      windowStart,
      windowEnd,
    } satisfies BudgetPolicySummary;
  }, [agent, budgetOverview, companies, companyId]);
  const mobileLiveRun = useMemo(() => runs.find(isTaskExecutionRunActive) ?? null, [runs]);

  const budgetMutation = useMutation({
    mutationFn: (amount: MoneyAmount) =>
      agentsApi.updateOperationalConfiguration(agent!.id, {
        budgetMonthlyAmount: amount,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.budgets.overview(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent!.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard(companyId),
      });
    },
  });

  const updateIcon = useMutation({
    mutationFn: (icon: string) => agentsApi.updateOperationalConfiguration(agent!.id, { icon }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent!.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
    },
  });

  const adoptPluginManagement = useMutation({
    mutationFn: () => agentsApi.adoptPluginManagement(agent!.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent!.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Agent adoption failed"),
  });

  const terminatePluginTriage = useMutation({
    mutationFn: () => agentsApi.terminate(agent!.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent!.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Agent termination failed"),
  });

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useEffect(() => {
    if (agentMembershipState !== "joined") return;
    setDismissedLeftAgentIds((current) => {
      if (!current.has(agentId)) return current;
      const next = new Set(current);
      next.delete(agentId);
      return next;
    });
  }, [agentId, agentMembershipState]);

  useEffect(() => {
    if (!configDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!configDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [configDirty]);

  if (isLoading)
    return {
      status: "loading" as const,
      companyId,
      agentId,
      activeView,
      urlRunId,
      agentName: agentId,
    };
  if (error)
    return {
      status: "error" as const,
      companyId,
      agentId,
      activeView,
      urlRunId,
      agentName: agentId,
      error,
    };
  if (!agent)
    return {
      status: "missing" as const,
      companyId,
      agentId,
      activeView,
      urlRunId,
      agentName: agentId,
    };
  const isPendingApproval = agent.status === "pending_approval";
  const isPluginTriage = agent.pluginManagement?.lifecycleState === "triage_paused";
  const hasInvalidOrgChain = agent.orgChainHealth?.status === "invalid_org_chain";
  const showConfigActionBar = activeView === "configuration" && (configDirty || configSaving);
  const showLeftAgentNotice = agentMembershipState === "left" && !dismissedLeftAgentIds.has(agent.id);
  const agentMembershipPending =
    membershipMutation.isPending &&
    membershipMutation.variables?.resourceType === "agent" &&
    membershipMutation.variables.resourceId === agent.id;
  const agentStarred = isStarred(membershipsQuery.data, "agent", agent.id);
  const agentStarPending = agentMembershipPending && membershipMutation.variables?.starred !== undefined;
  const agentJoinLeavePending = agentMembershipPending && membershipMutation.variables?.starred === undefined;
  const pendingAgentStatus = configSaving
    ? "Saving agent configuration…"
    : adoptPluginManagement.isPending
      ? "Adopting plugin-managed agent…"
      : terminatePluginTriage.isPending
        ? "Terminating plugin-managed agent…"
        : null;

  return {
    status: "ready" as const,
    actionError,
    activeView,
    adoptPluginManagement,
    agent,
    agentBudgetSummary,
    agentId,
    agentJoinLeavePending,
    agentStarPending,
    agentStarred,
    assignedTasks,
    budgetMutation,
    budgetOverview,
    cancelConfigActionRef,
    companies,
    companyId,
    configSaving,
    hasInvalidOrgChain,
    isMobile,
    isPendingApproval,
    isPluginTriage,
    membershipMutation,
    mobileLiveRun,
    navigate,
    pendingAgentStatus,
    runs,
    runtimeState,
    saveConfigActionRef,
    setActionError,
    setCancelConfigAction,
    setConfigDirty,
    setConfigSaving,
    setDismissedLeftAgentIds,
    setSaveConfigAction,
    showConfigActionBar,
    showLeftAgentNotice,
    terminatePluginTriage,
    updateIcon,
    urlRunId,
    agentName: agent.name,
  };
}

export type AgentDetailController = ReturnType<typeof useAgentDetailController>;
