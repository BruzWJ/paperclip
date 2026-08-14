import { useEffect, useId, useState } from "react";
import {
  compareMoneyAmounts,
  parseMoneyAmount,
  type BudgetPolicySummary,
  type MoneyAmount,
} from "@paperclipai/shared";
import { PauseCircle } from "lucide-react";
import { cn, formatMoneyAmount } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";

const ZERO_AMOUNT = parseMoneyAmount("0");

function parseBudgetInput(value: string): MoneyAmount | null {
  try {
    return parseMoneyAmount(value);
  } catch {
    return null;
  }
}

function windowLabel(windowKind: BudgetPolicySummary["windowKind"]) {
  return windowKind === "lifetime" ? "Lifetime budget" : "Monthly UTC budget";
}

function budgetStatusLabel(summary: BudgetPolicySummary) {
  if (summary.paused) return "Paused";
  if (summary.status === "warning") return "Warning";
  if (summary.status === "hard_stop") return "Hard stop";
  return "Healthy";
}

export function BudgetPolicyCard({
  summary,
  onSave,
  isSaving,
  compact = false,
  variant = "card",
}: {
  summary: BudgetPolicySummary;
  onSave?: (amount: MoneyAmount) => void;
  isSaving?: boolean;
  compact?: boolean;
  variant?: "card" | "plain";
}) {
  const [draftBudget, setDraftBudget] = useState<string>(summary.limitAmount);

  useEffect(() => {
    setDraftBudget(summary.limitAmount);
  }, [summary.limitAmount]);

  const parsedDraft = parseBudgetInput(draftBudget);
  const hasLimit = compareMoneyAmounts(summary.limitAmount, ZERO_AMOUNT) > 0;
  const canSave =
    parsedDraft !== null && compareMoneyAmounts(parsedDraft, summary.limitAmount) !== 0 && Boolean(onSave);
  const progress = hasLimit ? Math.min(100, summary.utilizationPercent) : 0;
  const isPlain = variant === "plain";
  const budgetInputId = useId();

  const observedBudgetGrid = (
    <ItemGroup className="grid gap-3 sm:grid-cols-2">
      <Item variant="outline">
        <ItemContent>
          <ItemDescription>Observed</ItemDescription>
          <ItemTitle className="text-xl tabular-nums">
            {formatMoneyAmount(summary.observedAmount, summary.budgetCurrency)}
          </ItemTitle>
          <ItemDescription>
            {hasLimit ? `${summary.utilizationPercent}% of limit` : "No cap configured"}
          </ItemDescription>
        </ItemContent>
      </Item>
      <Item variant="outline">
        <ItemContent>
          <ItemDescription>Budget</ItemDescription>
          <ItemTitle className="text-xl tabular-nums">
            {hasLimit ? formatMoneyAmount(summary.limitAmount, summary.budgetCurrency) : "Disabled"}
          </ItemTitle>
          <ItemDescription>
            Soft alert at {summary.warnPercent}%
            {summary.paused && summary.pauseReason ? ` · ${summary.pauseReason} pause` : ""}
          </ItemDescription>
        </ItemContent>
      </Item>
    </ItemGroup>
  );

  const progressSection = (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Remaining</span>
        <span>
          {hasLimit ? formatMoneyAmount(summary.remainingAmount, summary.budgetCurrency) : "Unlimited"}
        </span>
      </div>
      <Progress value={progress} />
    </div>
  );

  const pausedPane = summary.paused ? (
    <Alert variant="destructive">
      <PauseCircle />
      <AlertDescription>
        {summary.scopeType === "project"
          ? "Execution is paused for this project until the budget is raised or the incident is dismissed."
          : "Execution is paused for this scope until the budget is raised or the incident is dismissed."}
      </AlertDescription>
    </Alert>
  ) : null;

  const saveSection = onSave ? (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <LabeledFormField
        className="min-w-0 flex-1"
        label={`Budget (${summary.budgetCurrency})`}
        labelFor={budgetInputId}
      >
        <Input
          id={budgetInputId}
          value={draftBudget}
          onChange={(event) => setDraftBudget(event.target.value)}
          inputMode="decimal"
          placeholder="0.00"
        />
      </LabeledFormField>
      <Button
        onClick={() => {
          if (parsedDraft && onSave) onSave(parsedDraft);
        }}
        disabled={!canSave || isSaving || parsedDraft === null}
      >
        {isSaving ? "Saving..." : hasLimit ? "Update budget" : "Set budget"}
      </Button>
    </div>
  ) : null;

  if (isPlain) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {summary.scopeType}
            </div>
            <div className="mt-2 text-xl font-semibold">{summary.scopeName}</div>
            <div className="mt-2 text-sm text-muted-foreground">{windowLabel(summary.windowKind)}</div>
          </div>
          <DomainStatus status={summary.paused ? "paused" : summary.status}>
            {budgetStatusLabel(summary)}
          </DomainStatus>
        </div>

        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {parsedDraft === null ? (
          <FieldError>Enter a canonical non-negative decimal amount.</FieldError>
        ) : null}
      </div>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className={cn("gap-3", compact ? "px-4 pt-4 pb-2" : "px-5 pt-5 pb-3")}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {summary.scopeType}
            </div>
            <CardTitle className="mt-1 text-base">{summary.scopeName}</CardTitle>
            <CardDescription className="mt-1">{windowLabel(summary.windowKind)}</CardDescription>
          </div>
          <DomainStatus status={summary.paused ? "paused" : summary.status}>
            {budgetStatusLabel(summary)}
          </DomainStatus>
        </div>
      </CardHeader>
      <CardContent className={cn("space-y-4", compact ? "px-4 pb-4 pt-0" : "px-5 pb-5 pt-0")}>
        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {parsedDraft === null ? (
          <FieldError>Enter a canonical non-negative decimal amount.</FieldError>
        ) : null}
      </CardContent>
    </Card>
  );
}
