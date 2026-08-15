import { AgentActionButtons } from "@/routes/_authenticated/$companyId/agents/-AgentActionButtons";
import { AgentIcon, AgentIconPicker } from "@/features/agents/AgentIconPicker";
import { AgentConfigurePage as AgentConfigurationPanel } from "@/routes/_authenticated/$companyId/agents/$agentId/-AgentConfigurationPanel";
import { AgentOverview } from "@/routes/_authenticated/$companyId/agents/$agentId/-AgentOverview";
import { AgentRunsPanel } from "@/routes/_authenticated/$companyId/agents/$agentId/-AgentRunsPanel";
import { BudgetPolicyCard } from "@/features/budgets/BudgetPolicyCard";
import { MembershipAction } from "@/features/resource-memberships/MembershipAction";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  formatOrgChainHealthPath,
  type AgentDetailController,
} from "@/routes/_authenticated/$companyId/agents/$agentId/-useAgentDetailController";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeftIcon, CheckCircle2, Star, X } from "lucide-react";

const AGENT_DETAIL_TABS = [
  { value: "dashboard", label: "Dashboard" },
  { value: "configuration", label: "Configuration" },
  { value: "runs", label: "Runs" },
  { value: "budget", label: "Budget" },
] as const;

interface AgentDetailViewProps {
  controller: AgentDetailController;
}

export function AgentDetailView({ controller }: AgentDetailViewProps) {
  if (controller.status === "loading") {
    return <Skeleton className="h-32 w-full" />;
  }
  if (controller.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Could not load agent</AlertTitle>
        <AlertDescription>{controller.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (controller.status === "missing") return null;

  const {
    actionError,
    activeView,
    adoptPluginManagement,
    agent,
    agentBudgetSummary,
    agentId,
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
  } = controller;
  const handleAgentTabChange = (value: string) => {
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
  };
  const configActionButtons = (
    <>
      <Button
        variant={isMobile ? "ghost" : "outline"}
        size="sm"
        onClick={() => cancelConfigActionRef.current?.()}
        disabled={configSaving}
      >
        Cancel
      </Button>
      <Button size="sm" onClick={() => saveConfigActionRef.current?.()} disabled={configSaving}>
        {configSaving ? "Saving…" : "Save"}
      </Button>
    </>
  );

  return (
    <div className={cn("space-y-6", isMobile && showConfigActionBar && "pb-24")}>
      {pendingAgentStatus ? (
        <p className="sr-only" role="status">
          {pendingAgentStatus}
        </p>
      ) : null}
      {showLeftAgentNotice ? (
        <Alert>
          <AlertDescription className="flex items-center">
            <span className="min-w-0 flex-1">You left this agent. It no longer appears in your sidebar.</span>
            <MembershipAction
              compact
              state="left"
              mutation={membershipMutation}
              resourceId={agent.id}
              resourceName={agent.name}
              resourceType="agent"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss agent membership notice"
              onClick={() => setDismissedLeftAgentIds((current) => new Set(current).add(agent.id))}
            >
              <X />
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {hasInvalidOrgChain ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Invalid reporting chain</AlertTitle>
          <AlertDescription>
            <p>{agent.name} cannot accept tasks or start runs until its reporting chain is repaired.</p>
            <p className="break-words font-mono text-xs">{formatOrgChainHealthPath(agent)}</p>
            {agent.orgChainHealth?.repairGuidance ? (
              <p>{agent.orgChainHealth.repairGuidance}</p>
            ) : (
              <p>
                Assign this agent to an eligible manager/root, or explicitly pause or terminate the affected
                agent/subtree.
              </p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {urlRunId ? (
        <div className="border-b pb-3">
          <Button asChild variant="ghost" size="sm" className="max-w-full">
            <Link to="/$companyId/agents/$agentId/$tab" params={{ companyId, agentId, tab: "runs" }}>
              <ArrowLeftIcon />
              <AgentIcon icon={agent.icon} className="size-4" />
              <span className="truncate">{agent.name} runs</span>
            </Link>
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <AgentIconPicker value={agent.icon} onChange={(icon) => updateIcon.mutate(icon)} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-bold truncate">{agent.name}</h2>
              </div>
              {agent.title ? <p className="text-sm text-muted-foreground truncate">{agent.title}</p> : null}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Toggle
              size="sm"
              pressed={agentStarred}
              disabled={agentStarPending}
              aria-label={`${agentStarred ? "Unstar" : "Star"} ${agent.name}`}
              onPressedChange={(next) =>
                membershipMutation.mutate({
                  resourceType: "agent",
                  resourceId: agent.id,
                  resourceName: agent.name,
                  starred: next,
                })
              }
            >
              {agentStarPending ? <Spinner /> : <Star />}
            </Toggle>
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
                  className="sm:hidden"
                >
                  <DomainStatus status="running">Live</DomainStatus>
                </Link>
              )}
            </AgentActionButtons>
          </div>
        </div>
      )}

      {!urlRunId && !isPluginTriage && (
        <Tabs value={activeView} onValueChange={handleAgentTabChange}>
          {isMobile ? (
            <Select value={activeView} onValueChange={handleAgentTabChange}>
              <SelectTrigger className="h-9" aria-label="Page section">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_DETAIL_TABS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <TabsList variant="line">
              {AGENT_DETAIL_TABS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          )}
        </Tabs>
      )}

      {actionError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Agent action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {isPendingApproval && (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Board approval required</AlertTitle>
          <AlertDescription>
            <span>This agent is pending board approval and cannot be invoked yet.</span>
            <Button variant="outline" size="sm" asChild>
              <Link to="/$companyId/approvals" params={{ companyId }}>
                Review approval
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {isPluginTriage && agent.pluginManagement && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Plugin-managed agent awaiting board triage</AlertTitle>
          <AlertDescription>
            <p>
              Plugin {agent.pluginManagement.pluginKey} is unavailable. Adopt this existing agent to sever
              future plugin management, or terminate it. Its current configuration and provenance remain
              unchanged.
            </p>
            {agent.pluginManagement.lifecycleReason ? (
              <p className="font-mono text-xs">{agent.pluginManagement.lifecycleReason}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => adoptPluginManagement.mutate()}
                disabled={adoptPluginManagement.isPending || terminatePluginTriage.isPending}
              >
                {adoptPluginManagement.isPending ? "Adopting…" : "Adopt agent"}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => terminatePluginTriage.mutate()}
                disabled={adoptPluginManagement.isPending || terminatePluginTriage.isPending}
              >
                {terminatePluginTriage.isPending ? "Terminating…" : "Terminate agent"}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Floating Save/Cancel (desktop) */}
      {!isPluginTriage && !isMobile && showConfigActionBar && (
        <div className="fixed bottom-6 right-6 z-30">
          <ButtonGroup>{configActionButtons}</ButtonGroup>
        </div>
      )}

      {/* Mobile bottom Save/Cancel bar */}
      {!isPluginTriage && isMobile && showConfigActionBar && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur-sm">
          <ButtonGroup
            className="ml-auto px-3 py-2"
            style={{
              paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)",
            }}
          >
            {configActionButtons}
          </ButtonGroup>
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
            companies.find((company) => company.id === companyId)?.budgetCurrency
          }
          agentId={agent.id}
          agentRouteId={agentId}
        />
      )}

      {!isPluginTriage && activeView === "configuration" && (
        <AgentConfigurationPanel
          agent={agent}
          onDirtyChange={setConfigDirty}
          onSaveActionChange={setSaveConfigAction}
          onCancelActionChange={setCancelConfigAction}
          onSavingChange={setConfigSaving}
        />
      )}

      {!isPluginTriage && activeView === "runs" && (
        <AgentRunsPanel runs={runs} agentRouteId={agentId} selectedRunId={urlRunId ?? null} agent={agent} />
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
            <p className="text-sm text-muted-foreground">Budget data is unavailable.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
