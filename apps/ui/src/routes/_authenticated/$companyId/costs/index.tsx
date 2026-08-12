import { createFileRoute } from "@tanstack/react-router";
import { useEffect, type ComponentType } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BudgetPolicySummary,
  CostByAgent,
  CostByProject,
  FinanceSummaryRow,
  MoneyAmount,
} from "@paperclipai/shared";
import {
  Bot,
  CalendarRange,
  CircleDollarSign,
  Coins,
  FolderKanban,
  ReceiptText,
  TriangleAlert,
} from "lucide-react";
import { budgetsApi } from "@/api/budgets";
import { costsApi } from "@/api/costs";
import { BudgetIncidentCard } from "@/components/BudgetIncidentCard";
import { BudgetPolicyCard } from "@/components/BudgetPolicyCard";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { PRESET_KEYS, PRESET_LABELS, useDateRange } from "@/hooks/useDateRange";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime, formatMoneyAmount, formatNumber } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/$companyId/costs/")({
  component: Costs,
});

function MetricTile({
  label,
  value,
  subtitle,
  icon: Icon,
}: {
  label: string;
  value: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="block p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
            {label}
          </div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">
            {value}
          </div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {subtitle}
          </div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </Card>
  );
}

function CostRows({
  title,
  description,
  rows,
  icon: Icon,
}: {
  title: string;
  description: string;
  rows: Array<{
    id: string;
    name: string;
    amount: MoneyAmount;
    currency: string;
    pricedPromptCount: number;
    unpricedPromptCount: number;
  }>;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No settled prompts in this range.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((row) => (
              <div
                key={row.id}
                className="grid gap-2 py-3 sm:grid-cols-(--gtc-17) sm:items-center"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{row.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatNumber(row.pricedPromptCount)} priced ·{" "}
                    {formatNumber(row.unpricedPromptCount)} unpriced
                  </div>
                </div>
                <div className="font-mono text-sm tabular-nums sm:text-right">
                  {formatMoneyAmount(row.amount, row.currency)}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FinanceCurrencyCard({ row }: { row: FinanceSummaryRow }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{row.currency}</CardTitle>
        <CardDescription>
          {formatNumber(row.eventCount)} finance event
          {row.eventCount === 1 ? "" : "s"}; currencies are never mixed.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="text-xs text-muted-foreground">Debits</div>
          <div className="mt-1 font-mono text-sm">
            {formatMoneyAmount(row.debitAmount, row.currency)}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Credits</div>
          <div className="mt-1 font-mono text-sm">
            {formatMoneyAmount(row.creditAmount, row.currency)}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">
            Net {row.netDirection}
          </div>
          <div className="mt-1 font-mono text-sm">
            {formatMoneyAmount(row.netAmount, row.currency)}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Estimated debits</div>
          <div className="mt-1 font-mono text-sm">
            {formatMoneyAmount(row.estimatedDebitAmount, row.currency)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function Costs() {
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    from,
    to,
    customReady,
  } = useDateRange();

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
    queryKey: queryKeys.financeSummary(
      companyId,
      from || undefined,
      to || undefined,
    ),
    queryFn: async () => {
      const [summary, byBiller, byKind, events] = await Promise.all([
        costsApi.financeSummary(companyId, from || undefined, to || undefined),
        costsApi.financeByBiller(companyId, from || undefined, to || undefined),
        costsApi.financeByKind(companyId, from || undefined, to || undefined),
        costsApi.financeEvents(
          companyId,
          from || undefined,
          to || undefined,
          50,
        ),
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
        queryKey: queryKeys.costs(
          companyId,
          from || undefined,
          to || undefined,
        ),
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
    mutationFn: (input: {
      policy: BudgetPolicySummary;
      limitAmount: MoneyAmount;
    }) =>
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
    return <PageSkeleton variant="dashboard" />;
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
      <EmptyState
        icon={TriangleAlert}
        message="Cost and budget data could not be loaded."
      />
    );
  }

  const { summary, byAgent, byProject, events } = costQuery.data;
  const budgetData = budgetQuery.data;
  const financeData = financeQuery.data;
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
          <div className="ml-auto flex items-center gap-2">
            <Label className="sr-only" htmlFor="costs-custom-from">
              Start date
            </Label>
            <Input
              id="costs-custom-from"
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
            />
            <Label className="sr-only" htmlFor="costs-custom-to">
              End date
            </Label>
            <Input
              id="costs-custom-to"
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Known AI cost"
          value={formatMoneyAmount(
            summary.knownSpendAmount,
            summary.budgetCurrency,
          )}
          subtitle={`${formatNumber(summary.pricedPromptCount)} priced prompts`}
          icon={CircleDollarSign}
        />
        <MetricTile
          label="Unpriced prompts"
          value={formatNumber(summary.unpricedPromptCount)}
          subtitle="Settled prompts with unavailable cost"
          icon={TriangleAlert}
        />
        <MetricTile
          label="Monthly limit"
          value={formatMoneyAmount(
            summary.budgetMonthlyAmount,
            summary.budgetCurrency,
          )}
          subtitle={`${summary.utilizationPercent}% utilized`}
          icon={Coins}
        />
        <MetricTile
          label="Remaining"
          value={formatMoneyAmount(
            summary.remainingAmount,
            summary.budgetCurrency,
          )}
          subtitle="Known-cost budget remainder"
          icon={ReceiptText}
        />
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="budgets">Budgets</TabsTrigger>
          <TabsTrigger value="events">Prompt facts</TabsTrigger>
          <TabsTrigger value="finance">Finance</TabsTrigger>
        </TabsList>

        <TabsContent
          value="overview"
          className="mt-5 grid gap-5 xl:grid-cols-2"
        >
          <CostRows
            title="By agent"
            description="Known prompt-cost deltas attributed to each agent."
            rows={agentRows}
            icon={Bot}
          />
          <CostRows
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
                    : (limitAmount) =>
                        policyMutation.mutate({ policy, limitAmount })
                }
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="events" className="mt-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Settled prompt cost facts
              </CardTitle>
              <CardDescription>
                One immutable known or unavailable fact for each
                protocol-settled prompt.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No settled prompt facts in this range.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {events.map((event) => (
                    <div
                      key={event.id}
                      className="grid gap-2 py-3 sm:grid-cols-(--gtc-17) sm:items-center"
                    >
                      <div>
                        <div className="text-sm font-medium">
                          {event.kind === "known"
                            ? "Known cost"
                            : "Cost unavailable"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatDateTime(event.occurredAt)} ·{" "}
                          {event.promptKind}
                        </div>
                      </div>
                      <div className="font-mono text-sm sm:text-right">
                        {event.kind === "known" && event.knownDeltaAmount
                          ? formatMoneyAmount(
                              event.knownDeltaAmount,
                              event.budgetCurrency,
                            )
                          : (event.unavailableReason?.replaceAll("_", " ") ??
                            "unavailable")}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="finance" className="mt-5 space-y-5">
          {financeData.summary.currencies.length === 0 ? (
            <Card className="p-5 text-sm text-muted-foreground">
              No finance events in this range.
            </Card>
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
                <CardTitle className="text-base">
                  By biller and currency
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {financeData.byBiller.map((row) => (
                  <div
                    key={`${row.biller}:${row.currency}`}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span>
                      {row.biller} · {row.currency}
                    </span>
                    <span className="font-mono">
                      {formatMoneyAmount(row.netAmount, row.currency)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  By kind and currency
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {financeData.byKind.map((row) => (
                  <div
                    key={`${row.eventKind}:${row.currency}`}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span>
                      {row.eventKind.replaceAll("_", " ")} · {row.currency}
                    </span>
                    <span className="font-mono">
                      {formatMoneyAmount(row.netAmount, row.currency)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent finance events</CardTitle>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              {financeData.events.map((event) => (
                <div
                  key={event.id}
                  className="flex items-center justify-between gap-4 py-3 text-sm"
                >
                  <div>
                    <div className="font-medium">
                      {event.description ??
                        event.eventKind.replaceAll("_", " ")}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {event.biller} · {formatDateTime(event.occurredAt)}
                    </div>
                  </div>
                  <div className="font-mono">
                    {formatMoneyAmount(event.amount, event.currency)}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
