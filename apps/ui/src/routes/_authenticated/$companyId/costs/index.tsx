import { budgetsApi } from "@/api/budgets";
import { costsApi } from "@/api/costs";
import { BudgetIncidentCard } from "@/components/BudgetIncidentCard";
import { BudgetPolicyCard } from "@/components/BudgetPolicyCard";
import {
  CostBreakdownRows,
  CostEventRows,
  FinanceBreakdownRows,
  FinanceCurrencyCard,
  FinanceEventRows,
} from "@/components/costs/CostSummaryCards";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { PRESET_KEYS, PRESET_LABELS, useDateRange } from "@/hooks/useDateRange";
import { queryKeys } from "@/lib/queryKeys";
import { formatMoneyAmount, formatNumber } from "@/lib/utils";
import type { BudgetPolicySummary, CostByAgent, CostByProject, MoneyAmount } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Bot,
  CalendarRange,
  CircleDollarSign,
  Coins,
  FolderKanban,
  ReceiptText,
  TriangleAlert,
} from "lucide-react";
import { useEffect } from "react";

export const Route = createFileRoute("/_authenticated/$companyId/costs/")({
  component: Costs,
});

function Costs() {
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo, from, to, customReady } =
    useDateRange();

  useEffect(() => {
    setBreadcrumbs([{ label: "Costs" }]);
  }, [setBreadcrumbs]);

  const costQuery = useQuery({
    queryKey: queryKeys.costs(companyId, from || undefined, to || undefined),
    queryFn: async () => {
      const [summary, byAgent, byProject, events] = await Promise.all([
        costsApi.summary(companyId, from || undefined, to || undefined),
        costsApi.byAgent(companyId, from || undefined, to || undefined),
        costsApi.byProject(companyId, from || undefined, to || undefined),
        costsApi.events(companyId, from || undefined, to || undefined, 100),
      ]);
      return { summary, byAgent, byProject, events };
    },
    enabled: customReady,
  });

  const budgetQuery = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
  });

  const financeQuery = useQuery({
    queryKey: queryKeys.financeSummary(companyId, from || undefined, to || undefined),
    queryFn: async () => {
      const [summary, byBiller, byKind, events] = await Promise.all([
        costsApi.financeSummary(companyId, from || undefined, to || undefined),
        costsApi.financeByBiller(companyId, from || undefined, to || undefined),
        costsApi.financeByKind(companyId, from || undefined, to || undefined),
        costsApi.financeEvents(companyId, from || undefined, to || undefined, 50),
      ]);
      return { summary, byBiller, byKind, events };
    },
    enabled: customReady,
  });

  const invalidateBudgetViews = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.budgets.overview(companyId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard(companyId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.costs(companyId, from || undefined, to || undefined),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(companyId),
      }),
    ]);
  };

  const policyMutation = useMutation({
    mutationFn: (input: { policy: BudgetPolicySummary; limitAmount: MoneyAmount }) =>
      budgetsApi.upsertPolicy(companyId, {
        scopeType: input.policy.scopeType,
        scopeId: input.policy.scopeId,
        windowKind: input.policy.windowKind,
        limitAmount: input.limitAmount,
        warnPercent: input.policy.warnPercent,
        hardStopEnabled: input.policy.hardStopEnabled,
        notifyEnabled: input.policy.notifyEnabled,
        isActive: input.policy.isActive,
      }),
    onSuccess: invalidateBudgetViews,
  });

  const incidentMutation = useMutation({
    mutationFn: (input: {
      incidentId: string;
      action: "keep_paused" | "raise_budget_and_resume";
      limitAmount?: MoneyAmount;
    }) =>
      budgetsApi.resolveIncident(companyId, input.incidentId, {
        action: input.action,
        ...(input.limitAmount ? { limitAmount: input.limitAmount } : {}),
      }),
    onSuccess: invalidateBudgetViews,
  });

  if (costQuery.isLoading || budgetQuery.isLoading || financeQuery.isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }
  if (
    costQuery.error ||
    budgetQuery.error ||
    financeQuery.error ||
    !costQuery.data ||
    !budgetQuery.data ||
    !financeQuery.data
  ) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlert />
          </EmptyMedia>
          <EmptyTitle>Cost and budget data could not be loaded.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  const { summary, byAgent, byProject, events } = costQuery.data;
  const budgetData = budgetQuery.data;
  const financeData = financeQuery.data;
  const costMetrics = [
    {
      label: "Known AI cost",
      value: formatMoneyAmount(summary.knownSpendAmount, summary.budgetCurrency),
      subtitle: `${formatNumber(summary.pricedPromptCount)} priced prompts`,
      icon: CircleDollarSign,
    },
    {
      label: "Unpriced prompts",
      value: formatNumber(summary.unpricedPromptCount),
      subtitle: "Settled prompts with unavailable cost",
      icon: TriangleAlert,
    },
    {
      label: "Monthly limit",
      value: formatMoneyAmount(summary.budgetMonthlyAmount, summary.budgetCurrency),
      subtitle: `${summary.utilizationPercent}% utilized`,
      icon: Coins,
    },
    {
      label: "Remaining",
      value: formatMoneyAmount(summary.remainingAmount, summary.budgetCurrency),
      subtitle: "Known-cost budget remainder",
      icon: ReceiptText,
    },
  ];
  const agentRows = byAgent.map((row: CostByAgent) => ({
    id: row.agentId,
    name: row.agentName ?? row.agentId,
    amount: row.knownCostAmount,
    currency: row.budgetCurrency,
    pricedPromptCount: row.pricedPromptCount,
    unpricedPromptCount: row.unpricedPromptCount,
  }));
  const projectRows = byProject.map((row: CostByProject) => ({
    id: row.projectId ?? "unassigned",
    name: row.projectName ?? "No project",
    amount: row.knownCostAmount,
    currency: row.budgetCurrency,
    pricedPromptCount: row.pricedPromptCount,
    unpricedPromptCount: row.unpricedPromptCount,
  }));

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarRange className="h-4 w-4 text-muted-foreground" />
        {PRESET_KEYS.map((key) => (
          <Button
            key={key}
            size="sm"
            variant={preset === key ? "secondary" : "ghost"}
            onClick={() => setPreset(key)}
          >
            {PRESET_LABELS[key]}
          </Button>
        ))}
        {preset === "custom" ? (
          <ButtonGroup className="ml-auto flex items-center gap-2" aria-label="Custom cost date range">
            <Input
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              aria-label="Cost range start date"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
              aria-label="Cost range end date"
            />
          </ButtonGroup>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {costMetrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <Card key={metric.label}>
              <CardHeader>
                <CardDescription>{metric.label}</CardDescription>
                <CardTitle>{metric.value}</CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-3">
                <CardDescription>{metric.subtitle}</CardDescription>
                <Icon />
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="budgets">Budgets</TabsTrigger>
          <TabsTrigger value="events">Prompt facts</TabsTrigger>
          <TabsTrigger value="finance">Finance</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-5 grid gap-5 xl:grid-cols-2">
          <CostBreakdownRows
            title="By agent"
            description="Known prompt-cost deltas attributed to each agent."
            rows={agentRows}
            icon={Bot}
          />
          <CostBreakdownRows
            title="By project"
            description="Known prompt-cost deltas attributed through task project membership."
            rows={projectRows}
            icon={FolderKanban}
          />
        </TabsContent>

        <TabsContent value="budgets" className="mt-5 space-y-5">
          {budgetData.activeIncidents.map((incident) => (
            <BudgetIncidentCard
              key={incident.id}
              incident={incident}
              isMutating={incidentMutation.isPending}
              onKeepPaused={() =>
                incidentMutation.mutate({
                  incidentId: incident.id,
                  action: "keep_paused",
                })
              }
              onRaiseAndResume={(limitAmount) =>
                incidentMutation.mutate({
                  incidentId: incident.id,
                  action: "raise_budget_and_resume",
                  limitAmount,
                })
              }
            />
          ))}
          <div className="grid gap-5 xl:grid-cols-2">
            {budgetData.policies.map((policy) => (
              <BudgetPolicyCard
                key={policy.policyId}
                summary={policy}
                isSaving={policyMutation.isPending}
                onSave={
                  policy.scopeType === "agent"
                    ? undefined
                    : (limitAmount) => policyMutation.mutate({ policy, limitAmount })
                }
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="events" className="mt-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Settled prompt cost facts</CardTitle>
              <CardDescription>
                One immutable known or unavailable fact for each protocol-settled prompt.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <CostEventRows events={events} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="finance" className="mt-5 space-y-5">
          {financeData.summary.currencies.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ReceiptText />
                </EmptyMedia>
                <EmptyTitle>No finance events in this range.</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-5 xl:grid-cols-2">
              {financeData.summary.currencies.map((row) => (
                <FinanceCurrencyCard key={row.currency} row={row} />
              ))}
            </div>
          )}
          <div className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By biller and currency</CardTitle>
              </CardHeader>
              <CardContent>
                <FinanceBreakdownRows
                  rows={financeData.byBiller.map((row) => ({
                    id: `${row.biller}:${row.currency}`,
                    label: `${row.biller} · ${row.currency}`,
                    amount: row.netAmount,
                    currency: row.currency,
                  }))}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By kind and currency</CardTitle>
              </CardHeader>
              <CardContent>
                <FinanceBreakdownRows
                  rows={financeData.byKind.map((row) => ({
                    id: `${row.eventKind}:${row.currency}`,
                    label: `${row.eventKind.replaceAll("_", " ")} · ${row.currency}`,
                    amount: row.netAmount,
                    currency: row.currency,
                  }))}
                />
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent finance events</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <FinanceEventRows events={financeData.events} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
