import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate, Link, Navigate, useBeforeUnload, type NavigateFunction } from "@/lib/router";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { budgetsApi } from "../api/budgets";
import { isIssueExecutionRunActive, runsApi, type IssueExecutionRunJoinedDetail } from "../api/runs";
import { ApiError } from "../api/client";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { issuesApi } from "../api/issues";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { AgentSkillsTab } from "./agent-skills/AgentSkillsTab";
import { AgentConfigForm } from "../components/AgentConfigForm";
import { PageTabBar } from "../components/PageTabBar";
import { adapterLabels, help } from "../components/agent-config-primitives";
import { StatusBadge } from "../components/StatusBadge";
import { EntityRow } from "../components/EntityRow";
import { MembershipAction } from "../components/MembershipAction";
import { StarToggle } from "../components/StarToggle";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentActionButtons } from "../components/AgentActionButtons";
import { InlineBanner } from "../components/InlineBanner";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { AgentRuntimeGrantsSection } from "../components/AgentRuntimeGrantsSection";
import { issueDisplayTitle } from "../lib/issue-display";
import { cn, formatDate, formatMoneyAmount, formatTokens, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import {
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  AlertTriangle,
} from "lucide-react";
import { AgentIcon, AgentIconPicker } from "../components/AgentIconPicker";
import { AgentToolsTab } from "./AgentToolsTab";
import {
  isUuidLike,
  compareMoneyAmounts,
  moneyAmountUtilizationPercent,
  parseMoneyAmount,
  subtractMoneyAmounts,
  type Agent,
  type AgentAdapterConfigRevision,
  type AgentDetail as AgentDetailRecord,
  type BudgetCurrency,
  type BudgetPolicySummary,
  type AgentRuntimeState,
  type IssueExecutionRunEnvelopeRecord,
  type IssueExecutionRunListPageRecord,
  type MoneyAmount,
} from "@paperclipai/shared";
import { agentRouteRef } from "../lib/utils";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { Badge } from "@/components/ui/badge";
import {
  buildAdapterRevisionConfiguration,
  partitionAgentConfigurationPatch,
} from "../lib/agent-configuration-control-plane";

const ZERO_AMOUNT = parseMoneyAmount("0");

function formatOrgChainHealthPath(agent: AgentDetailRecord) {
  return agent.orgChainHealth?.fullChain
    .map((entry) => `${entry.name}${entry.status !== "active" && entry.status !== "idle" ? ` (${entry.status})` : ""}`)
    .join(" -> ") ?? agent.name;
}

type AgentDetailView = "dashboard" | "configuration" | "skills" | "tools" | "runs" | "budget";

function parseAgentDetailView(value: string | null): AgentDetailView {
  if (value === "configure" || value === "configuration") return "configuration";
  if (value === "skills") return "skills";
  if (value === "tools") return "tools";
  if (value === "budget") return "budget";
  if (value === "runs") return value;
  return "dashboard";
}

export function AgentDetail() {
  const { companyPrefix, agentId, tab: urlTab, runId: urlRunId } = useParams<{
    companyPrefix?: string;
    agentId: string;
    tab?: string;
    runId?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedLeftAgentIds, setDismissedLeftAgentIds] = useState<Set<string>>(() => new Set());
  const activeView = urlRunId ? "runs" as AgentDetailView : parseAgentDetailView(urlTab ?? null);
  const needsDashboardData = activeView === "dashboard";
  const needsRunData = activeView === "runs" || Boolean(urlRunId);
  const shouldLoadRuns = needsDashboardData || needsRunData;
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const saveConfigActionRef = useRef<(() => void) | null>(null);
  const cancelConfigActionRef = useRef<(() => void) | null>(null);
  const { isMobile } = useSidebar();
  const routeAgentRef = agentId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchAgent = routeAgentRef.length > 0 && (isUuidLike(routeAgentRef) || Boolean(lookupCompanyId));
  const setSaveConfigAction = useCallback((fn: (() => void) | null) => { saveConfigActionRef.current = fn; }, []);
  const setCancelConfigAction = useCallback((fn: (() => void) | null) => { cancelConfigActionRef.current = fn; }, []);

  const { data: agent, isLoading, error } = useQuery<AgentDetailRecord>({
    queryKey: [...queryKeys.agents.detail(routeAgentRef), lookupCompanyId ?? null],
    queryFn: () => agentsApi.get(routeAgentRef, lookupCompanyId),
    enabled: canFetchAgent,
  });
  const resolvedCompanyId = agent?.companyId ?? selectedCompanyId;
  const canonicalAgentRef = agent ? agentRouteRef(agent) : routeAgentRef;
  const agentLookupRef = agent?.id ?? routeAgentRef;
  const resolvedAgentId = agent?.id ?? null;
  const membershipsQuery = useResourceMemberships(resolvedCompanyId);
  const membershipMutation = useResourceMembershipMutation(resolvedCompanyId);
  const agentMembershipState = resolvedAgentId
    ? resourceMembershipState(membershipsQuery.data, "agent", resolvedAgentId)
    : "joined";

  const { data: runtimeState } = useQuery({
    queryKey: queryKeys.agents.runtimeState(resolvedAgentId ?? routeAgentRef),
    queryFn: () => agentsApi.runtimeState(resolvedAgentId!, resolvedCompanyId ?? undefined),
    enabled: Boolean(resolvedAgentId) && needsDashboardData,
  });

  const { data: runPage } = useQuery<IssueExecutionRunListPageRecord>({
    queryKey: queryKeys.runs(resolvedCompanyId!, { agentId: agent?.id }),
    queryFn: () => runsApi.listForCompany(resolvedCompanyId!, {
      agentId: agent!.id,
      limit: 200,
    }),
    enabled: Boolean(resolvedCompanyId && agent?.id && shouldLoadRuns),
    refetchInterval: needsRunData ? 3_000 : false,
  });
  const runs = runPage?.items ?? [];

  const { data: allIssues } = useQuery({
    queryKey: [...queryKeys.issues.list(resolvedCompanyId!), "participant-agent", resolvedAgentId ?? "__none__"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { participantAgentId: resolvedAgentId! }),
    enabled: !!resolvedCompanyId && !!resolvedAgentId && needsDashboardData,
  });

  const { data: allAgents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId && needsDashboardData,
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const assignedIssues = (allIssues ?? [])
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const reportsToAgent = (allAgents ?? []).find((a) => a.id === agent?.reportsTo);
  const directReports = (allAgents ?? []).filter((a) => a.reportsTo === agent?.id && a.status !== "terminated");
  const agentBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "agent" && policy.scopeId === (agent?.id ?? routeAgentRef),
    );
    if (matched) return matched;
    if (!agent) return null;
    const budgetCurrency = budgetOverview?.budgetCurrency
      ?? companies.find((company) => company.id === resolvedCompanyId)?.budgetCurrency;
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
      companyId: resolvedCompanyId ?? "",
      budgetCurrency,
      scopeType: "agent",
      scopeId: agent?.id ?? routeAgentRef,
      scopeName: agent?.name ?? "Agent",
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
  }, [agent, budgetOverview, companies, resolvedCompanyId, routeAgentRef]);
  const mobileLiveRun = useMemo(
    () => runs.find(isIssueExecutionRunActive) ?? null,
    [runs],
  );

  useEffect(() => {
    if (!agent) return;
    if (urlRunId) {
      if (routeAgentRef !== canonicalAgentRef) {
        navigate(`/agents/${canonicalAgentRef}/runs/${urlRunId}`, { replace: true });
      }
      return;
    }
    const canonicalTab =
      activeView === "configuration"
          ? "configuration"
          : activeView === "skills"
            ? "skills"
            : activeView === "tools"
              ? "tools"
              : activeView === "runs"
                ? "runs"
                : activeView === "budget"
                  ? "budget"
              : "dashboard";
    if (routeAgentRef !== canonicalAgentRef || urlTab !== canonicalTab) {
      navigate(`/agents/${canonicalAgentRef}/${canonicalTab}`, { replace: true });
      return;
    }
  }, [agent, routeAgentRef, canonicalAgentRef, urlRunId, urlTab, activeView, navigate]);

  useEffect(() => {
    if (!agent?.companyId || agent.companyId === selectedCompanyId) return;
    setSelectedCompanyId(agent.companyId, { source: "route_sync" });
  }, [agent?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const budgetMutation = useMutation({
    mutationFn: (amount: MoneyAmount) =>
      agentsApi.updateOperationalConfiguration(
        agent?.id ?? routeAgentRef,
        { budgetMonthlyAmount: amount },
        resolvedCompanyId!,
      ),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  const updateIcon = useMutation({
    mutationFn: (icon: string) =>
      agentsApi.updateOperationalConfiguration(
        agentLookupRef,
        { icon },
        resolvedCompanyId ?? undefined,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
  });

  const adoptPluginManagement = useMutation({
    mutationFn: () =>
      agentsApi.adoptPluginManagement(
        agentLookupRef,
        resolvedCompanyId ?? undefined,
      ),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(routeAgentRef),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agentLookupRef),
      });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(resolvedCompanyId),
        });
      }
    },
    onError: (err) =>
      setActionError(
        err instanceof Error ? err.message : "Agent adoption failed",
      ),
  });

  const terminatePluginTriage = useMutation({
    mutationFn: () =>
      agentsApi.terminate(agentLookupRef, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(routeAgentRef),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agentLookupRef),
      });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(resolvedCompanyId),
        });
      }
    },
    onError: (err) =>
      setActionError(
        err instanceof Error ? err.message : "Agent termination failed",
      ),
  });

  useEffect(() => {
    const crumbs: { label: string; href?: string }[] = [
      { label: "Agents", href: "/agents" },
    ];
    const agentName = agent?.name ?? routeAgentRef ?? "Agent";
    if (activeView === "dashboard" && !urlRunId) {
      crumbs.push({ label: agentName });
    } else {
      crumbs.push({ label: agentName, href: `/agents/${canonicalAgentRef}/dashboard` });
      if (urlRunId) {
        crumbs.push({ label: "Runs", href: `/agents/${canonicalAgentRef}/runs` });
        crumbs.push({ label: `Run ${urlRunId.slice(0, 8)}` });
      } else if (activeView === "configuration") {
        crumbs.push({ label: "Configuration" });
      // } else if (activeView === "skills") { // TODO: bring back later
      //   crumbs.push({ label: "Skills" });
      } else if (activeView === "tools") {
        crumbs.push({ label: "Tools" });
      } else if (activeView === "runs") {
        crumbs.push({ label: "Runs" });
      } else if (activeView === "budget") {
        crumbs.push({ label: "Budget" });
      } else {
        crumbs.push({ label: "Dashboard" });
      }
    }
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, agent, routeAgentRef, canonicalAgentRef, activeView, urlRunId]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useEffect(() => {
    if (!resolvedAgentId || agentMembershipState !== "joined") return;
    setDismissedLeftAgentIds((current) => {
      if (!current.has(resolvedAgentId)) return current;
      const next = new Set(current);
      next.delete(resolvedAgentId);
      return next;
    });
  }, [resolvedAgentId, agentMembershipState]);

  useBeforeUnload(
    useCallback((event) => {
      if (!configDirty) return;
      event.preventDefault();
      event.returnValue = "";
    }, [configDirty]),
  );

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!agent) return null;
  if (!urlRunId && !urlTab) {
    return <Navigate to={`/agents/${canonicalAgentRef}/dashboard`} replace />;
  }
  const isPendingApproval = agent.status === "pending_approval";
  const isPluginTriage =
    agent.pluginManagement?.lifecycleState === "triage_paused";
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

  return (
    <div className={cn("space-y-6", isMobile && showConfigActionBar && "pb-24")}>
      {showLeftAgentNotice ? (
        <div className="flex items-center gap-3 border border-yellow-300/35 bg-yellow-300/10 px-3 py-2 text-sm text-yellow-900 dark:text-yellow-100">
          <p className="min-w-0 flex-1">
            You left this agent. It no longer appears in your sidebar.
          </p>
          <MembershipAction
            compact
            state="left"
            pending={agentJoinLeavePending}
            pendingState={agentJoinLeavePending ? membershipMutation.variables?.state : null}
            resourceName={agent.name}
            onJoin={() => membershipMutation.mutate({
              resourceType: "agent",
              resourceId: agent.id,
              resourceName: agent.name,
              state: "joined",
            })}
            onLeave={() => membershipMutation.mutate({
              resourceType: "agent",
              resourceId: agent.id,
              resourceName: agent.name,
              state: "left",
            })}
          />
          <button
            type="button"
            className="h-6 w-6 shrink-0 text-yellow-900/70 hover:text-yellow-900 dark:text-yellow-100/70 dark:hover:text-yellow-100"
            aria-label="Dismiss agent membership notice"
            onClick={() => setDismissedLeftAgentIds((current) => new Set(current).add(agent.id))}
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
              {agent.name} cannot accept tasks or start runs until its reporting chain is repaired.
            </p>
            <p className="break-words font-mono text-xs text-amber-900/80 dark:text-amber-100/80">
              {formatOrgChainHealthPath(agent)}
            </p>
            {agent.orgChainHealth?.repairGuidance ? (
              <p className="text-amber-900/85 dark:text-amber-100/85">{agent.orgChainHealth.repairGuidance}</p>
            ) : (
              <p className="text-amber-900/85 dark:text-amber-100/85">
                Assign this agent to an active manager/root, or explicitly pause or terminate the affected agent/subtree.
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
            <button className="shrink-0 flex items-center justify-center h-12 w-12 rounded-lg bg-accent hover:bg-accent/80 transition-colors">
              <AgentIcon icon={agent.icon} className="h-6 w-6" />
            </button>
          </AgentIconPicker>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold truncate">{agent.name}</h2>
            </div>
            {agent.title ? (
              <p className="text-sm text-muted-foreground truncate">{agent.title}</p>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StarToggle
            size="button"
            starred={agentStarred}
            pending={agentStarPending}
            resourceName={agent.name}
            onToggle={(next) => membershipMutation.mutate({
              resourceType: "agent",
              resourceId: agent.id,
              resourceName: agent.name,
              starred: next,
            })}
          />
          <AgentActionButtons
            agent={agent}
            companyId={resolvedCompanyId}
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
                to={`/agents/${canonicalAgentRef}/runs/${mobileLiveRun.id}`}
                className="sm:hidden flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                </span>
                <span className="text-(length:--text-micro) font-medium text-blue-600 dark:text-blue-400">Live</span>
              </Link>
            )}
          </AgentActionButtons>
        </div>
      </div>

      {!urlRunId && !isPluginTriage && (
        <Tabs
          value={activeView}
          onValueChange={(value) => navigate(`/agents/${canonicalAgentRef}/${value}`)}
        >
          <PageTabBar
            items={[
              { value: "dashboard", label: "Dashboard" },
              { value: "skills", label: "Skills" },
              { value: "configuration", label: "Configuration" },
              { value: "tools", label: "Tools" },
              { value: "runs", label: "Runs" },
              { value: "budget", label: "Budget" },
            ]}
            value={activeView}
            onValueChange={(value) => navigate(`/agents/${canonicalAgentRef}/${value}`)}
          />
        </Tabs>
      )}

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {isPendingApproval && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-200">
          <span>This agent is pending board approval and cannot be invoked yet.</span>
          <Button variant="outline" size="sm" asChild>
            <Link to="/approvals">
              <CheckCircle2 className="h-3.5 w-3.5 sm:mr-1" />
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
              <p className="font-medium">Plugin-managed agent awaiting board triage</p>
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
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
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
          agent={agent}
          runs={runs}
          assignedIssues={assignedIssues}
          runtimeState={runtimeState}
          budgetCurrency={
            budgetOverview?.budgetCurrency
              ?? companies.find((company) => company.id === resolvedCompanyId)?.budgetCurrency
          }
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
        />
      )}

      {!isPluginTriage && activeView === "configuration" && (
        <AgentConfigurePage
          agent={agent}
          companyId={resolvedCompanyId ?? undefined}
          onDirtyChange={setConfigDirty}
          onSaveActionChange={setSaveConfigAction}
          onCancelActionChange={setCancelConfigAction}
          onSavingChange={setConfigSaving}
        />
      )}

      {!isPluginTriage && activeView === "skills" && (
        <AgentSkillsTab
          agent={agent}
          companyId={resolvedCompanyId ?? undefined}
        />
      )}

      {!isPluginTriage && activeView === "tools" && resolvedCompanyId && (
        <AgentToolsTab agent={agent} companyId={resolvedCompanyId} />
      )}

      {!isPluginTriage && activeView === "runs" && (
        <RunsTab
          runs={runs}
          agentRouteId={canonicalAgentRef}
          selectedRunId={urlRunId ?? null}
        />
      )}

      {!isPluginTriage && activeView === "budget" && resolvedCompanyId ? (
        <div className="max-w-3xl">
          {agentBudgetSummary ? (
            <BudgetPolicyCard
              summary={agentBudgetSummary}
              isSaving={budgetMutation.isPending}
              onSave={(amount) => budgetMutation.mutate(amount)}
              variant="plain"
            />
          ) : (
            <p className="text-sm text-muted-foreground">Budget data is unavailable.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---- Helper components ---- */

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
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
  runs: IssueExecutionRunEnvelopeRecord[];
  agentId: string;
}) {
  if (runs.length === 0) return null;

  const sorted = [...runs].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const run = sorted.find(isIssueExecutionRunActive) ?? sorted[0]!;
  const isLive = isIssueExecutionRunActive(run);
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
          to={"/agents/" + agentId + "/runs/" + run.id}
          className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground no-underline"
        >
          View details &rarr;
        </Link>
      </div>
      <Link
        to={"/agents/" + agentId + "/runs/" + run.id}
        className={cn(
          "block w-full space-y-2 rounded-lg border p-4 no-underline transition-colors hover:bg-muted/50",
          isLive ? "border-blue-500/30 shadow-(--shadow-extract-14)" : "border-border",
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
  agent,
  runs,
  assignedIssues,
  runtimeState,
  budgetCurrency,
  agentId,
  agentRouteId,
}: {
  agent: AgentDetailRecord;
  runs: IssueExecutionRunEnvelopeRecord[];
  assignedIssues: { id: string; title: string | null; boardPresentationStatus: string; priority: string; identifier?: string | null; request?: string | null; createdAt: Date }[];
  runtimeState?: AgentRuntimeState | null;
  budgetCurrency?: BudgetCurrency;
  agentId: string;
  agentRouteId: string;
}) {
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
          <PriorityChart issues={assignedIssues} />
        </ChartCard>
        <ChartCard title="Tasks by Status" subtitle="Last 14 days">
          <IssueStatusChart issues={assignedIssues} />
        </ChartCard>
        <ChartCard title="Success Rate" subtitle="Last 14 days">
          <SuccessRateChart runs={runs} />
        </ChartCard>
      </div>

      {/* Recent Issues */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent Tasks</h3>
          <Link
            to={`/issues?participantAgentId=${agentId}`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            See All &rarr;
          </Link>
        </div>
        {assignedIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent tasks.</p>
        ) : (
          <div className="border border-border rounded-lg">
            {assignedIssues.slice(0, 10).map((issue) => (
              <EntityRow
                key={issue.id}
                identifier={issue.identifier ?? issue.id.slice(0, 8)}
                title={issueDisplayTitle(issue)}
                to={`/issues/${issue.identifier ?? issue.id}`}
                trailing={<StatusBadge status={issue.boardPresentationStatus} />}
              />
            ))}
            {assignedIssues.length > 10 && (
              <div className="px-3 py-2 text-xs text-muted-foreground text-center border-t border-border">
                +{assignedIssues.length - 10} more tasks
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
    return <p className="text-sm text-muted-foreground">No settled prompt accounting yet.</p>;
  }
  return (
    <div className="border border-border rounded-lg p-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 tabular-nums">
        <div>
          <span className="text-xs text-muted-foreground block">Latest context</span>
          <span className="text-lg font-semibold">
            {runtimeState.lastContextUsedTokens !== null
              && runtimeState.lastContextWindowTokens !== null
              ? `${formatTokens(runtimeState.lastContextUsedTokens)} / ${formatTokens(runtimeState.lastContextWindowTokens)}`
              : "Unavailable"}
          </span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">Peak context used</span>
          <span className="text-lg font-semibold">{formatTokens(runtimeState.peakContextUsedTokens)}</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">Known cost</span>
          <span className="text-lg font-semibold">
            {budgetCurrency
              ? formatMoneyAmount(runtimeState.aggregateKnownCostAmount, budgetCurrency)
              : "Currency unavailable"}
          </span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">Unpriced prompts</span>
          <span className="text-lg font-semibold">{runtimeState.unpricedPromptCount}</span>
        </div>
      </div>
    </div>
  );
}

/* ---- Agent Configure Page ---- */

/**
 * Agent detail URLs use a name-derived key, so updates that change the agent's
 * name (a rename or a config-revision rollback) can invalidate the reference
 * currently in the URL. When that happens, refetching the old reference would
 * 404 with "Agent not found". Instead, drop the stale cached queries and
 * replace the URL with the new canonical reference. Returns true when a
 * redirect happened.
 */
export function syncAgentRouteAfterRename(
  queryClient: QueryClient,
  navigate: NavigateFunction,
  previous: { id: string; urlKey?: string | null; name?: string | null },
  updated: { id: string; urlKey?: string | null; name?: string | null },
  tab: string,
): boolean {
  const previousRef = agentRouteRef(previous);
  const nextRef = agentRouteRef(updated);
  if (nextRef === previousRef) return false;
  queryClient.removeQueries({ queryKey: queryKeys.agents.detail(previousRef) });
  navigate(`/agents/${nextRef}/${tab}`, { replace: true });
  return true;
}

function AgentConfigurePage({
  agent,
  companyId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
}: {
  agent: AgentDetailRecord;
  companyId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [revisionsOpen, setRevisionsOpen] = useState(false);

  const { data: adapterRevisions } = useQuery({
    queryKey: queryKeys.agents.adapterConfigRevisions(agent.id),
    queryFn: () => agentsApi.listAdapterConfigRevisions(agent.id, companyId),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <ConfigurationTab
        agent={agent}
        currentAdapterRevision={(adapterRevisions ?? []).find(
          (revision) => revision.id === agent.currentAdapterConfigRevisionId,
        )}
        onDirtyChange={onDirtyChange}
        onSaveActionChange={onSaveActionChange}
        onCancelActionChange={onCancelActionChange}
        onSavingChange={onSavingChange}
        companyId={companyId}
      />
      <div>
        <button
          className="flex items-center gap-2 text-sm font-medium hover:text-foreground transition-colors"
          onClick={() => setRevisionsOpen((v) => !v)}
        >
          {revisionsOpen
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          }
          Immutable adapter revisions
          <span className="text-xs font-normal text-muted-foreground">{adapterRevisions?.length ?? 0}</span>
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
                  <div key={revision.id} className="border border-border/70 rounded-md p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        Revision {revision.revisionNumber}
                      </span>
                      {revision.id === agent.currentAdapterConfigRevisionId ? (
                        <Badge variant="outline">Current</Badge>
                      ) : null}
                      <span className="mx-1">·</span>
                      <span>{adapterLabels[revision.adapterType] ?? revision.adapterType}</span>
                      <span className="mx-1">·</span>
                      <span>{formatDate(revision.createdAt)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Immutable id <span className="font-mono">{revision.id}</span>
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
  currentAdapterRevision,
  companyId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
}: {
  agent: AgentDetailRecord;
  currentAdapterRevision?: AgentAdapterConfigRevision;
  companyId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { tab: urlTab } = useParams<{ tab?: string }>();
  const { pushToast } = useToastActions();
  const [formDirty, setFormDirty] = useState(false);
  const [formSaveAction, setFormSaveAction] = useState<(() => void) | null>(null);
  const [formCancelAction, setFormCancelAction] = useState<(() => void) | null>(null);
  const [awaitingRefreshAfterSave, setAwaitingRefreshAfterSave] = useState(false);
  const lastAgentRef = useRef(agent);
  const { data: adapterModels } = useQuery({
    queryKey: ["agents", agent.id, "adapter-models", agent.adapterType],
    queryFn: () => {
      if (!companyId || !agent.adapterType || !agent.adapterConfig) {
        throw new Error("Agent adapter configuration is absent.");
      }
      return agentsApi.adapterModels(companyId, agent.adapterType);
    },
    enabled: Boolean(companyId && agent.adapterType && agent.adapterConfig),
  });

  const updateConfiguration = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const partitioned = partitionAgentConfigurationPatch(data);
      const runtimeAgentPatch = partitioned.runtimeAgent;
      const operationalPatch = partitioned.operational;
      const hasAdapterRevisionChange =
        partitioned.hasAdapterRevisionChange;

      if (Object.keys(runtimeAgentPatch).length > 0) {
        await agentsApi.updateRuntimeConfiguration(
          agent.id,
          runtimeAgentPatch,
          companyId,
        );
      }

      if (Object.keys(operationalPatch).length > 0) {
        await agentsApi.updateOperationalConfiguration(
          agent.id,
          operationalPatch,
          companyId,
        );
      }

      if (hasAdapterRevisionChange) {
        if (!currentAdapterRevision) {
          throw new Error(
            "Load the agent's exact current adapter revision before saving.",
          );
        }
        await agentsApi.createAdapterConfigRevision(
          agent.id,
          buildAdapterRevisionConfiguration({
            agent,
            currentRevision: currentAdapterRevision,
            patch: data,
          }),
          companyId,
        );
      }

      const updated = await agentsApi.get(agent.id, companyId);
      return updated;
    },
    onMutate: () => {
      setAwaitingRefreshAfterSave(true);
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.adapterConfigRevisions(agent.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.currentAdapterConfigRevisionRoot(agent.id),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) });
      if (!syncAgentRouteAfterRename(queryClient, navigate, agent, updated, urlTab ?? "configuration")) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      }
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
  }, [
    formDirty,
    formSaveAction,
    onSaveActionChange,
  ]);

  useEffect(() => {
    if (!formDirty) {
      onCancelActionChange(null);
      return;
    }
    onCancelActionChange(() => {
      formCancelAction?.();
    });
  }, [
    formCancelAction,
    formDirty,
    onCancelActionChange,
  ]);

  useEffect(() => {
    onSavingChange(isConfigSaving);
  }, [onSavingChange, isConfigSaving]);

  return (
    <div className="space-y-6">
      <AgentConfigForm
        mode="edit"
        agent={agent}
        onSave={(patch) => updateConfiguration.mutateAsync(patch)}
        isSaving={isConfigSaving}
        adapterModels={adapterModels}
        onDirtyChange={setFormDirty}
        onSaveActionChange={(action) =>
          setFormSaveAction(() => action)
        }
        onCancelActionChange={(action) =>
          setFormCancelAction(() => action)
        }
        hideInlineSave
        sectionLayout="cards"
      />
      <p className="text-xs text-muted-foreground">
        Saved adapter config affects the next run. Active runs keep the config they started with, and config changes may start a fresh adapter session.
      </p>

      <AgentRuntimeGrantsSection agentId={agent.id} companyId={companyId} />
    </div>
  );
}

/* ---- Runs Tab ---- */

function runDuration(run: IssueExecutionRunEnvelopeRecord) {
  if (!run.startedAt) return null;
  const startedAt = new Date(run.startedAt).getTime();
  const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
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
  run: IssueExecutionRunEnvelopeRecord;
  isSelected: boolean;
  agentId: string;
}) {
  return (
    <Link
      to={isSelected ? "/agents/" + agentId + "/runs" : "/agents/" + agentId + "/runs/" + run.id}
      className={cn(
        "flex w-full flex-col gap-1 border-b border-border px-3 py-2.5 text-left text-inherit no-underline transition-colors last:border-b-0",
        isSelected ? "bg-accent/40" : "hover:bg-accent/20",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusBadge status={run.status} />
        <Badge variant="outline" className="px-1.5 text-(length:--text-nano) capitalize">
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
    </Link>
  );
}

function RunsTab({
  runs,
  agentRouteId,
  selectedRunId,
}: {
  runs: IssueExecutionRunEnvelopeRecord[];
  agentRouteId: string;
  selectedRunId: string | null;
}) {
  const { isMobile } = useSidebar();

  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  const sorted = [...runs].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const effectiveRunId = isMobile
    ? selectedRunId
    : selectedRunId ?? sorted[0]?.id ?? null;
  const selectedRun = sorted.find((run) => run.id === effectiveRunId) ?? null;

  if (isMobile) {
    if (selectedRun) {
      return (
        <div className="min-w-0 space-y-3 overflow-x-hidden">
          <Link
            to={"/agents/" + agentRouteId + "/runs"}
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
        <div className="sticky top-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 2rem)" }}>
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

function RunDetail({ run: initialRun }: { run: IssueExecutionRunEnvelopeRecord }) {
  const { data: detail, isLoading, error } = useQuery<IssueExecutionRunJoinedDetail>({
    queryKey: queryKeys.runDetail(initialRun.id),
    queryFn: () => runsApi.get(initialRun.id),
    refetchInterval: isIssueExecutionRunActive(initialRun) ? 3_000 : false,
  });
  const run = detail?.run ?? initialRun;
  const duration = runDuration(run);

  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={run.status} />
          <Badge variant="outline" className="capitalize">{run.kind}</Badge>
          <span className="font-mono text-xs text-muted-foreground">{run.id}</span>
        </div>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <SummaryRow label="Issue">
            <Link to={"/issues/" + run.issueId} className="font-mono hover:underline">
              {run.issueId.slice(0, 8)}
            </Link>
          </SummaryRow>
          <SummaryRow label="Session">
            <span className="font-mono">{run.sessionId.slice(0, 8)}</span>
          </SummaryRow>
          <SummaryRow label="Execution scope">
            <span className="font-mono">{run.executionScopeId.slice(0, 8)}</span>
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
        {run.processExitCode !== null || run.processSignal !== null ? (
          <p className="text-xs text-muted-foreground">
            Process settled by {run.processSignal ?? "exit " + String(run.processExitCode)}
          </p>
        ) : null}
      </div>

      {isLoading && !detail ? (
        <p className="text-sm text-muted-foreground">Loading joined run detail…</p>
      ) : null}
      {error ? (
        <InlineBanner tone="danger">
          {error instanceof Error ? error.message : "Could not load the run detail."}
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
              <Badge variant="outline" className="capitalize">{attempt.state}</Badge>
              <span className="capitalize">{attempt.promptKind} · {attempt.sessionOperation.replace(/_/g, " ")}</span>
              <span className="ml-auto font-mono text-muted-foreground">generation {attempt.attemptGeneration}</span>
            </div>
            <span className="font-mono text-muted-foreground">{attempt.id}</span>
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
              <Badge variant="outline" className="capitalize">{retry.state}</Badge>
              <span className="capitalize">{retry.reasonCode.replace(/_/g, " ")}</span>
              <span className="ml-auto">{relativeTime(retry.retryAt)}</span>
            </div>
            <span className="font-mono text-muted-foreground">{retry.predecessorAttemptId}</span>
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
              <Badge variant="outline" className="capitalize">{message.type.replace(/-/g, " ")}</Badge>
              <span className="font-mono text-muted-foreground">seq {message.seq}</span>
              <span className="ml-auto">{relativeTime(message.timeCreated)}</span>
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
              <span className="font-mono text-muted-foreground">seq {event.seq}</span>
              <span className="ml-auto">{relativeTime(event.createdAt)}</span>
            </div>
            <JsonData value={event.data} />
          </div>
        )}
      />

      <BoundedRecordSection
        title="Tool invocations"
        items={detail?.toolInvocations.items ?? []}
        truncated={detail?.toolInvocations.truncated ?? false}
        render={(invocation) => (
          <div key={invocation.id} className="space-y-2 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{invocation.toolName}</span>
              <Badge variant="outline" className="capitalize">{invocation.status}</Badge>
              <Badge variant="outline" className="capitalize">{invocation.approvalState.replace(/_/g, " ")}</Badge>
              <span className="ml-auto">{relativeTime(invocation.createdAt)}</span>
            </div>
            {invocation.argumentsSummary !== null ? <JsonData value={invocation.argumentsSummary} /> : null}
            {invocation.resultSummary !== null ? <JsonData value={invocation.resultSummary} /> : null}
            {invocation.errorCode ? <p className="text-destructive">{invocation.errorCode}</p> : null}
          </div>
        )}
      />

      <BoundedRecordSection
        title="Workspace operations"
        items={detail?.workspaceOperations.items ?? []}
        truncated={detail?.workspaceOperations.truncated ?? false}
        render={(operation) => (
          <div key={operation.id} className="space-y-1 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium capitalize">{operation.phase.replace(/_/g, " ")}</span>
              <Badge variant="outline" className="capitalize">{operation.status}</Badge>
              <span className="ml-auto">{relativeTime(operation.startedAt)}</span>
            </div>
            <span className="font-mono text-muted-foreground">{operation.id}</span>
          </div>
        )}
      />

      <BoundedRecordSection
        title="Watchdog decisions"
        items={detail?.watchdogDecisions.items ?? []}
        truncated={detail?.watchdogDecisions.truncated ?? false}
        render={(decision) => (
          <div key={decision.id} className="space-y-1 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="capitalize">{decision.decision.replace(/_/g, " ")}</Badge>
              <span className="ml-auto">{relativeTime(decision.createdAt)}</span>
            </div>
            {decision.reason ? <p className="text-muted-foreground">{decision.reason}</p> : null}
          </div>
        )}
      />
    </div>
  );
}
