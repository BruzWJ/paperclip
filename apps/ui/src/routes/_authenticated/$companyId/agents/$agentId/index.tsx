import { createFileRoute } from "@tanstack/react-router";
import { loadCompanyAgent } from "@/routes/-company-entity-loader";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { budgetsApi } from "@/api/budgets";
import {
  isTaskExecutionRunActive,
  runsApi,
  type TaskExecutionRunJoinedDetail,
} from "@/api/runs";
import { ApiError } from "@/api/client";
import {
  ChartCard,
  RunActivityChart,
  PriorityChart,
  TaskStatusChart,
  SuccessRateChart,
} from "@/components/ActivityCharts";
import { tasksApi } from "@/api/tasks";
import { usePanel } from "@/context/PanelContext";
import { useSidebar } from "@/context/SidebarContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { useBreadcrumbs, type Breadcrumb } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { AgentConfigForm } from "@/components/AgentConfigForm";
import { PageTabBar } from "@/components/PageTabBar";
import { StatusBadge } from "@/components/StatusBadge";
import { EntityRow } from "@/components/EntityRow";
import { MembershipAction } from "@/components/MembershipAction";
import { StarToggle } from "@/components/StarToggle";
import { PageSkeleton } from "@/components/PageSkeleton";
import { AgentActionButtons } from "@/components/AgentActionButtons";
import { InlineBanner } from "@/components/InlineBanner";
import { BudgetPolicyCard } from "@/components/BudgetPolicyCard";
import { taskDisplayTitle } from "@/lib/task-display";
import {
  cn,
  formatDate,
  formatMoneyAmount,
  formatTokens,
  relativeTime,
} from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import {
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  AlertTriangle,
} from "lucide-react";
import { AgentIcon, AgentIconPicker } from "@/components/AgentIconPicker";
import {
  compareMoneyAmounts,
  moneyAmountUtilizationPercent,
  parseMoneyAmount,
  subtractMoneyAmounts,
  type AgentDetail as AgentDetailRecord,
  type BudgetCurrency,
  type BudgetPolicySummary,
  type AgentRuntimeState,
  type TaskExecutionRunEnvelopeRecord,
  type TaskExecutionRunListPageRecord,
  type MoneyAmount,
} from "@paperclipai/shared";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "@/hooks/useResourceMemberships";
import { Badge } from "@/components/ui/badge";
import {
  buildAdapterRevisionConfiguration,
  partitionAgentConfigurationPatch,
} from "@/lib/agent-configuration-control-plane";
import type { AgentDetailView } from "@/lib/agent-detail-tabs";

export const Route = createFileRoute(
  "/_authenticated/$companyId/agents/$agentId/",
)({
  loader: ({ abortController, context, params }) =>
    loadCompanyAgent({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.agentId,
      signal: abortController.signal,
    }),
  component: AgentDashboardRoute,
});

function AgentDashboardRoute() {
  const { companyId, agentId } = Route.useParams();
  return <AgentDetail companyId={companyId} agentId={agentId} />;
}

const ZERO_AMOUNT = parseMoneyAmount("0");

function formatOrgChainHealthPath(agent: AgentDetailRecord) {
  return (
    agent.orgChainHealth?.fullChain
      .map(
        (entry) =>
          `${entry.name}${entry.status !== "idle" ? ` (${entry.status})` : ""}`,
      )
      .join(" -> ") ?? agent.name
  );
}

export function AgentDetail({
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
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedLeftAgentIds, setDismissedLeftAgentIds] = useState<
    Set<string>
  >(() => new Set());
  const activeView: AgentDetailView = urlRunId
    ? "runs"
    : (urlTab ?? "dashboard");
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
  const agentMembershipState = resourceMembershipState(
    membershipsQuery.data,
    "agent",
    agentId,
  );

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
    queryKey: [
      ...queryKeys.tasks.list(companyId),
      "participant-agent",
      agentId,
    ],
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
      budgetOverview?.budgetCurrency ??
      companies.find((company) => company.id === companyId)?.budgetCurrency;
    if (!budgetCurrency) return null;
    const limitAmount = agent.budgetMonthlyAmount;
    const observedAmount = agent.knownSpendAmount;
    const hasLimit = compareMoneyAmounts(limitAmount, ZERO_AMOUNT) > 0;
    const utilizationPercent = moneyAmountUtilizationPercent(
      observedAmount,
      limitAmount,
    );
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
  const mobileLiveRun = useMemo(
    () => runs.find(isTaskExecutionRunActive) ?? null,
    [runs],
  );

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
    mutationFn: (icon: string) =>
      agentsApi.updateOperationalConfiguration(agent!.id, { icon }),
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
    onError: (err) =>
      setActionError(
        err instanceof Error ? err.message : "Agent adoption failed",
      ),
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
    onError: (err) =>
      setActionError(
        err instanceof Error ? err.message : "Agent termination failed",
      ),
  });

  useEffect(() => {
    const crumbs: Breadcrumb[] = [
      {
        label: "Agents",
        renderLink: (content) => (
          <Link to="/$companyId/agents" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
    ];
    const agentName = agent?.name ?? agentId;
    if (activeView === "dashboard" && !urlRunId) {
      crumbs.push({ label: agentName });
    } else {
      crumbs.push({
        label: agentName,
        renderLink: (content) => (
          <Link
            to="/$companyId/agents/$agentId"
            params={{ companyId, agentId }}
          >
            {content}
          </Link>
        ),
      });
      if (urlRunId) {
        crumbs.push({
          label: "Runs",
          renderLink: (content) => (
            <Link
              to="/$companyId/agents/$agentId/$tab"
              params={{
                companyId,
                agentId,
                tab: "runs",
              }}
            >
              {content}
            </Link>
          ),
        });
        crumbs.push({ label: `Run ${urlRunId.slice(0, 8)}` });
      } else if (activeView === "configuration") {
        crumbs.push({ label: "Configuration" });
      } else if (activeView === "runs") {
        crumbs.push({ label: "Runs" });
      } else if (activeView === "budget") {
        crumbs.push({ label: "Budget" });
      } else {
        crumbs.push({ label: "Dashboard" });
      }
    }
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, agent, agentId, activeView, urlRunId]);

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

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!agent) return null;
  const isPendingApproval = agent.status === "pending_approval";
  const isPluginTriage =
    agent.pluginManagement?.lifecycleState === "triage_paused";
  const hasInvalidOrgChain =
    agent.orgChainHealth?.status === "invalid_org_chain";
  const showConfigActionBar =
    activeView === "configuration" && (configDirty || configSaving);
  const showLeftAgentNotice =
    agentMembershipState === "left" && !dismissedLeftAgentIds.has(agent.id);
  const agentMembershipPending =
    membershipMutation.isPending &&
    membershipMutation.variables?.resourceType === "agent" &&
    membershipMutation.variables.resourceId === agent.id;
  const agentStarred = isStarred(membershipsQuery.data, "agent", agent.id);
  const agentStarPending =
    agentMembershipPending &&
    membershipMutation.variables?.starred !== undefined;
  const agentJoinLeavePending =
    agentMembershipPending &&
    membershipMutation.variables?.starred === undefined;
  const pendingAgentStatus = configSaving
    ? "Saving agent configuration…"
    : adoptPluginManagement.isPending
      ? "Adopting plugin-managed agent…"
      : terminatePluginTriage.isPending
        ? "Terminating plugin-managed agent…"
        : null;

  return (
    <div
      className={cn("space-y-6", isMobile && showConfigActionBar && "pb-24")}
    >
      {pendingAgentStatus ? (
        <p className="sr-only" role="status">
          {pendingAgentStatus}
        </p>
      ) : null}
      {showLeftAgentNotice ? (
        <div className="flex items-center gap-3 border border-yellow-300/35 bg-yellow-300/10 px-3 py-2 text-sm text-yellow-900 dark:text-yellow-100">
          <p className="min-w-0 flex-1">
            You left this agent. It no longer appears in your sidebar.
          </p>
          <MembershipAction
            compact
            state="left"
            pending={agentJoinLeavePending}
            pendingState={
              agentJoinLeavePending ? membershipMutation.variables?.state : null
            }
            resourceName={agent.name}
            onJoin={() =>
              membershipMutation.mutate({
                resourceType: "agent",
                resourceId: agent.id,
                resourceName: agent.name,
                state: "joined",
              })
            }
            onLeave={() =>
              membershipMutation.mutate({
                resourceType: "agent",
                resourceId: agent.id,
                resourceName: agent.name,
                state: "left",
              })
            }
          />
          <button
            type="button"
            className="h-6 w-6 shrink-0 text-yellow-900/70 hover:text-yellow-900 dark:text-yellow-100/70 dark:hover:text-yellow-100"
            aria-label="Dismiss agent membership notice"
            onClick={() =>
              setDismissedLeftAgentIds((current) =>
                new Set(current).add(agent.id),
              )
            }
          >
            ×
          </button>
        </div>
      ) : null}
      {hasInvalidOrgChain ? (
        <div className="flex items-start gap-3 border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 space-y-1">
            <p className="font-medium">Invalid reporting chain</p>
            <p className="text-amber-900/90 dark:text-amber-100/90">
              {agent.name} cannot accept tasks or start runs until its reporting
              chain is repaired.
            </p>
            <p className="break-words font-mono text-xs text-amber-900/80 dark:text-amber-100/80">
              {formatOrgChainHealthPath(agent)}
            </p>
            {agent.orgChainHealth?.repairGuidance ? (
              <p className="text-amber-900/85 dark:text-amber-100/85">
                {agent.orgChainHealth.repairGuidance}
              </p>
            ) : (
              <p className="text-amber-900/85 dark:text-amber-100/85">
                Assign this agent to an eligible manager/root, or explicitly
                pause or terminate the affected agent/subtree.
              </p>
            )}
          </div>
        </div>
      ) : null}
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <AgentIconPicker
            value={agent.icon}
            onChange={(icon) => updateIcon.mutate(icon)}
          >
            <button
              type="button"
              className="shrink-0 flex items-center justify-center h-12 w-12 rounded-lg bg-accent hover:bg-accent/80 transition-colors"
              aria-label="Change agent icon"
            >
              <AgentIcon icon={agent.icon} className="h-6 w-6" />
            </button>
          </AgentIconPicker>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold truncate">{agent.name}</h2>
            </div>
            {agent.title ? (
              <p className="text-sm text-muted-foreground truncate">
                {agent.title}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StarToggle
            size="button"
            starred={agentStarred}
            pending={agentStarPending}
            resourceName={agent.name}
            onToggle={(next) =>
              membershipMutation.mutate({
                resourceType: "agent",
                resourceId: agent.id,
                resourceName: agent.name,
                starred: next,
              })
            }
          />
          <AgentActionButtons
            agent={agent}
            companyId={companyId}
            assignLabel="Assign Task"
            workActionsDisabled={hasInvalidOrgChain || isPluginTriage}
            workActionsDisabledReason={
              isPluginTriage
                ? "Adopt or terminate this agent before assigning work or resuming it"
                : "Repair this agent's reporting chain before assigning tasks or starting runs"
            }
            hideTerminate={isPluginTriage}
            onActionError={setActionError}
          >
            {mobileLiveRun && (
              <Link
                to="/$companyId/agents/$agentId/runs/$runId"
                params={{
                  companyId,
                  agentId,
                  runId: mobileLiveRun.id,
                }}
                className="sm:hidden flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                </span>
                <span className="text-(length:--text-micro) font-medium text-blue-600 dark:text-blue-400">
                  Live
                </span>
              </Link>
            )}
          </AgentActionButtons>
        </div>
      </div>

      {!urlRunId && !isPluginTriage && (
        <Tabs
          value={activeView}
          onValueChange={(value) => {
            if (value === "dashboard") {
              void navigate({
                to: "/$companyId/agents/$agentId",
                params: { companyId, agentId },
              });
              return;
            }
            void navigate({
              to: "/$companyId/agents/$agentId/$tab",
              params: { companyId, agentId, tab: value },
            });
          }}
        >
          <PageTabBar
            items={[
              { value: "dashboard", label: "Dashboard" },
              { value: "configuration", label: "Configuration" },
              { value: "runs", label: "Runs" },
              { value: "budget", label: "Budget" },
            ]}
            value={activeView}
            onValueChange={(value) => {
              if (value === "dashboard") {
                void navigate({
                  to: "/$companyId/agents/$agentId",
                  params: { companyId, agentId },
                });
                return;
              }
              void navigate({
                to: "/$companyId/agents/$agentId/$tab",
                params: {
                  companyId,
                  agentId,
                  tab: value,
                },
              });
            }}
          />
        </Tabs>
      )}

      {actionError && (
        <p className="text-sm text-destructive" role="alert">
          {actionError}
        </p>
      )}
      {isPendingApproval && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-200">
          <span>
            This agent is pending board approval and cannot be invoked yet.
          </span>
          <Button variant="outline" size="sm" asChild>
            <Link to="/$companyId/approvals" params={{ companyId }}>
              <CheckCircle2
                data-icon="inline-start"
                className="h-3.5 w-3.5 sm:mr-1"
              />
              <span>Review approval</span>
            </Link>
          </Button>
        </div>
      )}
      {isPluginTriage && agent.pluginManagement && (
        <div className="space-y-3 rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">
                Plugin-managed agent awaiting board triage
              </p>
              <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-100/80">
                Plugin {agent.pluginManagement.pluginKey} is unavailable. Adopt
                this existing agent to sever future plugin management, or
                terminate it. Its current configuration and provenance remain
                unchanged.
              </p>
              {agent.pluginManagement.lifecycleReason ? (
                <p className="mt-1 font-mono text-xs">
                  {agent.pluginManagement.lifecycleReason}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => adoptPluginManagement.mutate()}
              disabled={
                adoptPluginManagement.isPending ||
                terminatePluginTriage.isPending
              }
            >
              {adoptPluginManagement.isPending ? "Adopting…" : "Adopt agent"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => terminatePluginTriage.mutate()}
              disabled={
                adoptPluginManagement.isPending ||
                terminatePluginTriage.isPending
              }
            >
              {terminatePluginTriage.isPending
                ? "Terminating…"
                : "Terminate agent"}
            </Button>
          </div>
        </div>
      )}

      {/* Floating Save/Cancel (desktop) */}
      {!isPluginTriage && !isMobile && showConfigActionBar && (
        <div className="fixed bottom-6 right-6 z-30">
          <div className="flex items-center gap-2 bg-background/90 backdrop-blur-sm border border-border rounded-lg px-3 py-1.5 shadow-lg">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelConfigActionRef.current?.()}
              disabled={configSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => saveConfigActionRef.current?.()}
              disabled={configSaving}
            >
              {configSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* Mobile bottom Save/Cancel bar */}
      {!isPluginTriage && isMobile && showConfigActionBar && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur-sm">
          <div
            className="flex items-center justify-end gap-2 px-3 py-2"
            style={{
              paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)",
            }}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelConfigActionRef.current?.()}
              disabled={configSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => saveConfigActionRef.current?.()}
              disabled={configSaving}
            >
              {configSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* View content */}
      {!isPluginTriage && activeView === "dashboard" && (
        <AgentOverview
          runs={runs}
          assignedTasks={assignedTasks}
          runtimeState={runtimeState}
          budgetCurrency={
            budgetOverview?.budgetCurrency ??
            companies.find((company) => company.id === companyId)
              ?.budgetCurrency
          }
          agentId={agent.id}
          agentRouteId={agentId}
        />
      )}

      {!isPluginTriage && activeView === "configuration" && (
        <AgentConfigurePage
          agent={agent}
          onDirtyChange={setConfigDirty}
          onSaveActionChange={setSaveConfigAction}
          onCancelActionChange={setCancelConfigAction}
          onSavingChange={setConfigSaving}
        />
      )}

      {!isPluginTriage && activeView === "runs" && (
        <RunsTab
          runs={runs}
          agentRouteId={agentId}
          selectedRunId={urlRunId ?? null}
        />
      )}

      {!isPluginTriage && activeView === "budget" ? (
        <div className="max-w-3xl">
          {agentBudgetSummary ? (
            <BudgetPolicyCard
              summary={agentBudgetSummary}
              isSaving={budgetMutation.isPending}
              onSave={(amount) => budgetMutation.mutate(amount)}
              variant="plain"
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Budget data is unavailable.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---- Helper components ---- */

function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function LatestRunCard({
  runs,
  agentId,
}: {
  runs: TaskExecutionRunEnvelopeRecord[];
  agentId: string;
}) {
  const companyId = useCompanyRouteId();
  if (runs.length === 0) return null;

  const sorted = [...runs].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const run = sorted.find(isTaskExecutionRunActive) ?? sorted[0]!;
  const isLive = isTaskExecutionRunActive(run);
  const terminalSummary = run.terminalReasonCode
    ? run.terminalReasonCode.replace(/_/g, " ")
    : null;

  return (
    <div className="space-y-3">
      <div className="flex w-full items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {isLive ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
          ) : null}
          {isLive ? "Active run" : "Latest run"}
        </h3>
        <Link
          to="/$companyId/agents/$agentId/runs/$runId"
          params={{ companyId, agentId, runId: run.id }}
          className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground no-underline"
        >
          View details &rarr;
        </Link>
      </div>
      <Link
        to="/$companyId/agents/$agentId/runs/$runId"
        params={{ companyId, agentId, runId: run.id }}
        className={cn(
          "block w-full space-y-2 rounded-lg border p-4 no-underline transition-colors hover:bg-muted/50",
          isLive
            ? "border-blue-500/30 shadow-(--shadow-extract-14)"
            : "border-border",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={run.status} />
          <Badge variant="outline" className="capitalize">
            {run.kind}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">
            {run.id.slice(0, 8)}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {relativeTime(run.createdAt)}
          </span>
        </div>
        {terminalSummary ? (
          <p className="text-xs capitalize text-muted-foreground">
            {terminalSummary}
          </p>
        ) : null}
      </Link>
    </div>
  );
}

/* ---- Agent Overview (main single-page view) ---- */

function AgentOverview({
  runs,
  assignedTasks,
  runtimeState,
  budgetCurrency,
  agentId,
  agentRouteId,
}: {
  runs: TaskExecutionRunEnvelopeRecord[];
  assignedTasks: {
    id: string;
    taskNumber: number;
    title: string | null;
    boardPresentationStatus: string;
    priority: string;
    identifier: string;
    request?: string | null;
    createdAt: Date;
  }[];
  runtimeState?: AgentRuntimeState | null;
  budgetCurrency?: BudgetCurrency;
  agentId: string;
  agentRouteId: string;
}) {
  const companyId = useCompanyRouteId();
  return (
    <div className="space-y-8">
      {/* Latest Run */}
      <LatestRunCard runs={runs} agentId={agentRouteId} />

      {/* Charts */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <ChartCard title="Run Activity" subtitle="Last 14 days">
          <RunActivityChart runs={runs} />
        </ChartCard>
        <ChartCard title="Tasks by Priority" subtitle="Last 14 days">
          <PriorityChart tasks={assignedTasks} />
        </ChartCard>
        <ChartCard title="Tasks by Status" subtitle="Last 14 days">
          <TaskStatusChart tasks={assignedTasks} />
        </ChartCard>
        <ChartCard title="Success Rate" subtitle="Last 14 days">
          <SuccessRateChart runs={runs} />
        </ChartCard>
      </div>

      {/* Recent Tasks */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent Tasks</h3>
          <Link
            to="/$companyId/tasks"
            params={{ companyId }}
            search={{ participantAgentId: agentId }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            See All &rarr;
          </Link>
        </div>
        {assignedTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent tasks.</p>
        ) : (
          <div className="border border-border rounded-lg">
            {assignedTasks.slice(0, 10).map((task) => (
              <EntityRow
                key={task.id}
                identifier={task.identifier}
                title={taskDisplayTitle(task)}
                linkOptions={{
                  to: "/$companyId/tasks/$taskNumber",
                  params: { companyId, taskNumber: String(task.taskNumber) },
                }}
                trailing={<StatusBadge status={task.boardPresentationStatus} />}
              />
            ))}
            {assignedTasks.length > 10 && (
              <div className="px-3 py-2 text-xs text-muted-foreground text-center border-t border-border">
                +{assignedTasks.length - 10} more tasks
              </div>
            )}
          </div>
        )}
      </div>

      {/* Costs */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Costs</h3>
        <CostsSection
          runtimeState={runtimeState}
          budgetCurrency={budgetCurrency}
        />
      </div>
    </div>
  );
}

/* ---- Costs Section (inline) ---- */

function CostsSection({
  runtimeState,
  budgetCurrency,
}: {
  runtimeState?: AgentRuntimeState | null;
  budgetCurrency?: BudgetCurrency;
}) {
  if (!runtimeState) {
    return (
      <p className="text-sm text-muted-foreground">
        No settled prompt accounting yet.
      </p>
    );
  }
  return (
    <div className="border border-border rounded-lg p-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 tabular-nums">
        <div>
          <span className="text-xs text-muted-foreground block">
            Latest context
          </span>
          <span className="text-lg font-semibold">
            {runtimeState.lastContextUsedTokens !== null &&
            runtimeState.lastContextWindowTokens !== null
              ? `${formatTokens(runtimeState.lastContextUsedTokens)} / ${formatTokens(runtimeState.lastContextWindowTokens)}`
              : "Unavailable"}
          </span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">
            Peak context used
          </span>
          <span className="text-lg font-semibold">
            {formatTokens(runtimeState.peakContextUsedTokens)}
          </span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">
            Known cost
          </span>
          <span className="text-lg font-semibold">
            {budgetCurrency
              ? formatMoneyAmount(
                  runtimeState.aggregateKnownCostAmount,
                  budgetCurrency,
                )
              : "Currency unavailable"}
          </span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">
            Unpriced prompts
          </span>
          <span className="text-lg font-semibold">
            {runtimeState.unpricedPromptCount}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---- Agent Configure Page ---- */

function AgentConfigurePage({
  agent,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
}: {
  agent: AgentDetailRecord;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [revisionsOpen, setRevisionsOpen] = useState(false);

  const { data: adapterRevisions } = useQuery({
    queryKey: queryKeys.agents.adapterConfigRevisions(agent.id),
    queryFn: () => agentsApi.listAdapterConfigRevisions(agent.id),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <ConfigurationTab
        agent={agent}
        onDirtyChange={onDirtyChange}
        onSaveActionChange={onSaveActionChange}
        onCancelActionChange={onCancelActionChange}
        onSavingChange={onSavingChange}
      />
      <div>
        <button
          className="flex items-center gap-2 text-sm font-medium hover:text-foreground transition-colors"
          onClick={() => setRevisionsOpen((v) => !v)}
        >
          {revisionsOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          Immutable adapter revisions
          <span className="text-xs font-normal text-muted-foreground">
            {adapterRevisions?.length ?? 0}
          </span>
        </button>
        {revisionsOpen && (
          <div className="mt-3">
            {(adapterRevisions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This agent has no adapter configuration revision yet.
              </p>
            ) : (
              <div className="space-y-2">
                {(adapterRevisions ?? []).slice(0, 10).map((revision) => (
                  <div
                    key={revision.id}
                    className="border border-border/70 rounded-md p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        Revision {revision.revisionNumber}
                      </span>
                      {revision.id === agent.currentAdapterConfigRevisionId ? (
                        <Badge variant="outline">Current</Badge>
                      ) : null}
                      <span className="mx-1">·</span>
                      <span>
                        {revision.acpConfiguration.launchProfile.registryName}
                      </span>
                      <span className="mx-1">·</span>
                      <span>{formatDate(revision.createdAt)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Immutable id{" "}
                      <span className="font-mono">{revision.id}</span>
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Configuration Tab ---- */

function ConfigurationTab({
  agent,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
}: {
  agent: AgentDetailRecord;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const companyId = useCompanyRouteId();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [formDirty, setFormDirty] = useState(false);
  const [formSaveAction, setFormSaveAction] = useState<(() => void) | null>(
    null,
  );
  const [formCancelAction, setFormCancelAction] = useState<(() => void) | null>(
    null,
  );
  // Stable callback identities: AgentConfigForm re-registers its save/cancel
  // actions whenever these props change, and storing them in state triggers a
  // re-render — fresh inline arrows here would cause an infinite update loop.
  const handleFormSaveActionChange = useCallback(
    (action: (() => void) | null) => {
      setFormSaveAction(() => action);
    },
    [],
  );
  const handleFormCancelActionChange = useCallback(
    (action: (() => void) | null) => {
      setFormCancelAction(() => action);
    },
    [],
  );
  const [awaitingRefreshAfterSave, setAwaitingRefreshAfterSave] =
    useState(false);
  const lastAgentRef = useRef(agent);
  const updateConfiguration = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const partitioned = partitionAgentConfigurationPatch(data);
      const runtimeAgentPatch = partitioned.runtimeAgent;
      const operationalPatch = partitioned.operational;
      const hasAdapterRevisionChange = partitioned.hasAdapterRevisionChange;
      const currentAdapterRevision =
        hasAdapterRevisionChange && agent.currentAdapterConfigRevisionId
          ? await agentsApi.getCurrentAdapterConfigRevision(agent.id)
          : null;
      const adapterRevisionConfiguration = hasAdapterRevisionChange
        ? buildAdapterRevisionConfiguration({
            agent,
            currentRevision: currentAdapterRevision,
            patch: data,
          })
        : null;

      if (Object.keys(runtimeAgentPatch).length > 0) {
        const runtimeConfiguration = await agentsApi.updateRuntimeConfiguration(
          agent.id,
          runtimeAgentPatch,
        );
        queryClient.setQueryData(
          queryKeys.agents.runtimeConfiguration(agent.id, companyId),
          runtimeConfiguration,
        );
      }

      if (Object.keys(operationalPatch).length > 0) {
        await agentsApi.updateOperationalConfiguration(
          agent.id,
          operationalPatch,
        );
      }

      if (hasAdapterRevisionChange) {
        await agentsApi.createAdapterConfigRevision(
          agent.id,
          adapterRevisionConfiguration!,
        );
      }
    },
    onMutate: () => {
      setAwaitingRefreshAfterSave(true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.adapterConfigRevisions(agent.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
      pushToast({ title: "Agent saved", tone: "success" });
    },
    onError: (err) => {
      setAwaitingRefreshAfterSave(false);
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not save agent";
      pushToast({ title: "Save failed", body: message, tone: "error" });
    },
  });

  useEffect(() => {
    if (awaitingRefreshAfterSave && agent !== lastAgentRef.current) {
      setAwaitingRefreshAfterSave(false);
    }
    lastAgentRef.current = agent;
  }, [agent, awaitingRefreshAfterSave]);
  const isConfigSaving =
    updateConfiguration.isPending || awaitingRefreshAfterSave;

  useEffect(() => {
    onDirtyChange(formDirty);
  }, [formDirty, onDirtyChange]);

  useEffect(() => {
    if (formDirty) {
      onSaveActionChange(formSaveAction);
      return;
    }
    onSaveActionChange(null);
  }, [formDirty, formSaveAction, onSaveActionChange]);

  useEffect(() => {
    if (!formDirty) {
      onCancelActionChange(null);
      return;
    }
    onCancelActionChange(() => {
      formCancelAction?.();
    });
  }, [formCancelAction, formDirty, onCancelActionChange]);

  useEffect(() => {
    onSavingChange(isConfigSaving);
  }, [onSavingChange, isConfigSaving]);

  return (
    <div className="space-y-6">
      {updateConfiguration.isPending ? (
        <p
          aria-live="polite"
          role="status"
          className="text-xs text-muted-foreground"
        >
          Saving agent configuration…
        </p>
      ) : null}
      <fieldset
        aria-busy={isConfigSaving}
        aria-label="Agent configuration"
        className="m-0 min-w-0 border-0 p-0"
        disabled={updateConfiguration.isPending}
      >
        <AgentConfigForm
          mode="edit"
          agent={agent}
          onSave={(patch) => updateConfiguration.mutateAsync(patch)}
          isSaving={isConfigSaving}
          onDirtyChange={setFormDirty}
          onSaveActionChange={handleFormSaveActionChange}
          onCancelActionChange={handleFormCancelActionChange}
          hideInlineSave
          sectionLayout="cards"
        />
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Saved adapter config affects the next run. Active runs keep the config
        they started with, and config changes may start a fresh adapter session.
      </p>
    </div>
  );
}

/* ---- Runs Tab ---- */

function runDuration(run: TaskExecutionRunEnvelopeRecord) {
  if (!run.startedAt) return null;
  const startedAt = new Date(run.startedAt).getTime();
  const finishedAt = run.finishedAt
    ? new Date(run.finishedAt).getTime()
    : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return null;
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  if (seconds < 60) return String(seconds) + "s";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? String(minutes) + "m " + String(remainingSeconds) + "s"
    : String(minutes) + "m";
}

function RunListItem({
  run,
  isSelected,
  agentId,
}: {
  run: TaskExecutionRunEnvelopeRecord;
  isSelected: boolean;
  agentId: string;
}) {
  const companyId = useCompanyRouteId();
  const className = cn(
    "flex w-full flex-col gap-1 border-b border-border px-3 py-2.5 text-left text-inherit no-underline transition-colors last:border-b-0",
    isSelected ? "bg-accent/40" : "hover:bg-accent/20",
  );
  const content = (
    <>
      <div className="flex items-center gap-2">
        <StatusBadge status={run.status} />
        <Badge
          variant="outline"
          className="px-1.5 text-(length:--text-nano) capitalize"
        >
          {run.kind}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {run.id.slice(0, 8)}
        </span>
        <span className="ml-auto shrink-0 text-(length:--text-micro) text-muted-foreground">
          {relativeTime(run.createdAt)}
        </span>
      </div>
      {run.terminalReasonCode ? (
        <span className="truncate pl-1 text-xs capitalize text-muted-foreground">
          {run.terminalReasonCode.replace(/_/g, " ")}
        </span>
      ) : null}
    </>
  );
  if (isSelected) {
    return (
      <Link
        to="/$companyId/agents/$agentId/$tab"
        params={{ companyId, agentId, tab: "runs" }}
        className={className}
      >
        {content}
      </Link>
    );
  }
  return (
    <Link
      to="/$companyId/agents/$agentId/runs/$runId"
      params={{ companyId, agentId, runId: run.id }}
      className={className}
    >
      {content}
    </Link>
  );
}

function RunsTab({
  runs,
  agentRouteId,
  selectedRunId,
}: {
  runs: TaskExecutionRunEnvelopeRecord[];
  agentRouteId: string;
  selectedRunId: string | null;
}) {
  const { isMobile } = useSidebar();
  const companyId = useCompanyRouteId();

  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  const sorted = [...runs].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const effectiveRunId = isMobile
    ? selectedRunId
    : (selectedRunId ?? sorted[0]?.id ?? null);
  const selectedRun = sorted.find((run) => run.id === effectiveRunId) ?? null;

  if (isMobile) {
    if (selectedRun) {
      return (
        <div className="min-w-0 space-y-3 overflow-x-hidden">
          <Link
            to="/$companyId/agents/$agentId/$tab"
            params={{ companyId, agentId: agentRouteId, tab: "runs" }}
            className="flex items-center gap-1.5 text-sm text-muted-foreground no-underline transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to runs
          </Link>
          <RunDetail run={selectedRun} />
        </div>
      );
    }
    return (
      <div className="overflow-x-hidden rounded-lg border border-border">
        {sorted.map((run) => (
          <RunListItem
            key={run.id}
            run={run}
            isSelected={false}
            agentId={agentRouteId}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-0">
      <div
        className={cn(
          "shrink-0 rounded-lg border border-border",
          selectedRun ? "w-72" : "w-full",
        )}
      >
        <div
          className="sticky top-4 overflow-y-auto"
          style={{ maxHeight: "calc(100vh - 2rem)" }}
        >
          {sorted.map((run) => (
            <RunListItem
              key={run.id}
              run={run}
              isSelected={run.id === effectiveRunId}
              agentId={agentRouteId}
            />
          ))}
        </div>
      </div>
      {selectedRun ? (
        <div className="min-w-0 flex-1 pl-4">
          <RunDetail run={selectedRun} />
        </div>
      ) : null}
    </div>
  );
}

function BoundedRecordSection<T>({
  title,
  items,
  truncated,
  render,
}: {
  title: string;
  items: readonly T[];
  truncated: boolean;
  render: (item: T, index: number) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground">
          {title} ({items.length})
        </h3>
        {truncated ? (
          <Badge variant="outline" className="text-(length:--text-micro)">
            Bounded view
          </Badge>
        ) : null}
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {items.map(render)}
      </div>
    </section>
  );
}

function JsonData({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-(length:--text-micro)">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function RunDetail({
  run: initialRun,
}: {
  run: TaskExecutionRunEnvelopeRecord;
}) {
  const companyId = useCompanyRouteId();
  const {
    data: detail,
    isLoading,
    error,
  } = useQuery<TaskExecutionRunJoinedDetail>({
    queryKey: queryKeys.runDetail(initialRun.id),
    queryFn: () => runsApi.get(initialRun.id),
  });
  const run = detail?.run ?? initialRun;
  const duration = runDuration(run);
  const { data: task } = useQuery({
    queryKey: queryKeys.tasks.detail(run.taskId),
    queryFn: () => tasksApi.get(run.taskId),
  });

  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={run.status} />
          <Badge variant="outline" className="capitalize">
            {run.kind}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">
            {run.id}
          </span>
        </div>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <SummaryRow label="Task">
            {task ? (
              <Link
                to="/$companyId/tasks/$taskNumber"
                params={{ companyId, taskNumber: String(task.taskNumber) }}
                className="font-mono hover:underline"
              >
                {task.identifier}
              </Link>
            ) : (
              <span>Task unavailable</span>
            )}
          </SummaryRow>
          <SummaryRow label="Session">
            <span className="font-mono">{run.sessionId.slice(0, 8)}</span>
          </SummaryRow>
          <SummaryRow label="Execution scope">
            <span className="font-mono">
              {run.executionScopeId.slice(0, 8)}
            </span>
          </SummaryRow>
          <SummaryRow label="Ownership epoch">
            <span>{run.ownershipEpoch}</span>
          </SummaryRow>
          <SummaryRow label="Created">
            <span>{relativeTime(run.createdAt)}</span>
          </SummaryRow>
          <SummaryRow label="Duration">
            <span>{duration ?? "Not started"}</span>
          </SummaryRow>
        </div>
        {run.terminalReasonCode ? (
          <p className="text-xs capitalize text-muted-foreground">
            {run.terminalReasonCode.replace(/_/g, " ")}
          </p>
        ) : null}
      </div>

      {isLoading && !detail ? (
        <p className="text-sm text-muted-foreground">
          Loading joined run detail…
        </p>
      ) : null}
      {error ? (
        <InlineBanner tone="danger">
          {error instanceof Error
            ? error.message
            : "Could not load the run detail."}
        </InlineBanner>
      ) : null}

      {detail?.finalization ? (
        <section className="space-y-2 rounded-lg border border-border p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Finalization</span>
            <Badge variant="outline" className="capitalize">
              {detail.finalization.record.action.replace(/_/g, " ")}
            </Badge>
            {detail.finalization.liveness ? (
              <Badge variant="outline" className="capitalize">
                {detail.finalization.liveness.livenessState.replace(/_/g, " ")}
              </Badge>
            ) : null}
          </div>
          {detail.finalization.liveness?.livenessReason ? (
            <p className="capitalize text-muted-foreground">
              {detail.finalization.liveness.livenessReason.replace(/_/g, " ")}
            </p>
          ) : null}
        </section>
      ) : null}

      <BoundedRecordSection
        title="Attempts"
        items={detail?.attempts.items ?? []}
        truncated={detail?.attempts.truncated ?? false}
        render={(attempt) => (
          <div key={attempt.id} className="space-y-1 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="capitalize">
                {attempt.state}
              </Badge>
              <span className="capitalize">
                {attempt.promptKind} ·{" "}
                {attempt.sessionOperation.replace(/_/g, " ")}
              </span>
              <span className="ml-auto font-mono text-muted-foreground">
                generation {attempt.attemptGeneration}
              </span>
            </div>
            <span className="font-mono text-muted-foreground">
              {attempt.id}
            </span>
          </div>
        )}
      />

      <BoundedRecordSection
        title="Retry schedules"
        items={detail?.retrySchedules.items ?? []}
        truncated={detail?.retrySchedules.truncated ?? false}
        render={(retry) => (
          <div key={retry.id} className="space-y-1 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="capitalize">
                {retry.state}
              </Badge>
              <span className="capitalize">
                {retry.reasonCode.replace(/_/g, " ")}
              </span>
              <span className="ml-auto">{relativeTime(retry.retryAt)}</span>
            </div>
            <span className="font-mono text-muted-foreground">
              {retry.predecessorAttemptId}
            </span>
          </div>
        )}
      />

      <BoundedRecordSection
        title="Session messages"
        items={detail?.sessionMessages.items ?? []}
        truncated={detail?.sessionMessages.truncated ?? false}
        render={(message) => (
          <div key={message.id} className="space-y-2 p-3 text-xs">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="capitalize">
                {message.type.replace(/-/g, " ")}
              </Badge>
              <span className="font-mono text-muted-foreground">
                seq {message.seq}
              </span>
              <span className="ml-auto">
                {relativeTime(message.timeCreated)}
              </span>
            </div>
            <JsonData value={message.data} />
          </div>
        )}
      />

      <BoundedRecordSection
        title="Session events"
        items={detail?.sessionEvents.items ?? []}
        truncated={detail?.sessionEvents.truncated ?? false}
        render={(event) => (
          <div key={event.id} className="space-y-2 p-3 text-xs">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{event.type}</Badge>
              <span className="font-mono text-muted-foreground">
                seq {event.seq}
              </span>
              <span className="ml-auto">{relativeTime(event.createdAt)}</span>
            </div>
            <JsonData value={event.data} />
          </div>
        )}
      />
    </div>
  );
}
