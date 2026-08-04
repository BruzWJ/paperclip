import { useId, useState } from "react";
import {
  addMoneyAmounts,
  compareMoneyAmounts,
  parseMoneyAmount,
  type BudgetIncident,
  type MoneyAmount,
} from "@paperclipai/shared";
import { AlertOctagon, ArrowUpRight, PauseCircle } from "lucide-react";
import { formatMoneyAmount } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const ONE_AMOUNT = parseMoneyAmount("1");

function parseBudgetInput(value: string): MoneyAmount | null {
  try {
    return parseMoneyAmount(value);
  } catch {
    return null;
  }
}

function incidentStateLabel(incident: BudgetIncident) {
  if (incident.status === "resolved") return "Resolved";
  if (incident.status === "dismissed") return "Dismissed";
  if (incident.approvalStatus === "revision_requested") return "Escalated";
  if (incident.approvalStatus === "pending") return "Pending approval";
  return "Open";
}

export function BudgetIncidentCard({
  incident,
  onRaiseAndResume,
  onKeepPaused,
  isMutating,
}: {
  incident: BudgetIncident;
  onRaiseAndResume: (amount: MoneyAmount) => void;
  onKeepPaused: () => void;
  isMutating?: boolean;
}) {
  const greaterCurrentAmount = compareMoneyAmounts(
    incident.observedAmount,
    incident.limitAmount,
  ) >= 0
    ? incident.observedAmount
    : incident.limitAmount;
  const [draftAmount, setDraftAmount] = useState<string>(
    addMoneyAmounts(greaterCurrentAmount, ONE_AMOUNT),
  );
  const parsed = parseBudgetInput(draftAmount);
  const exceedsObserved = parsed !== null
    && compareMoneyAmounts(parsed, incident.observedAmount) > 0;
  const stateLabel = incidentStateLabel(incident);
  const budgetInputId = useId();

  return (
    <Card className="overflow-hidden border-red-500/20 bg-(image:--gradient-extract-4)">
      <CardHeader className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-red-700/90 dark:text-red-200/80">
                {incident.scopeType} hard stop
              </div>
              <Badge variant={incident.status === "resolved" ? "outline" : "secondary"}>
                {stateLabel}
              </Badge>
            </div>
            <CardTitle className="mt-1 text-base text-red-950 dark:text-red-50">{incident.scopeName}</CardTitle>
            <CardDescription className="mt-1 text-red-900/75 dark:text-red-100/70">
              Spending reached {formatMoneyAmount(incident.observedAmount, incident.budgetCurrency)} against a limit of {formatMoneyAmount(incident.limitAmount, incident.budgetCurrency)}.
            </CardDescription>
          </div>
          <div className="rounded-full border border-red-400/30 bg-red-500/10 p-2 text-red-600 dark:text-red-200">
            <AlertOctagon className="h-4 w-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <div className="flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-950/90 dark:text-red-50/90">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {incident.scopeType === "project"
              ? "Project execution is paused. New work in this project will not start until you resolve the budget incident."
              : "This scope is paused. New execution will not start until you resolve the budget incident."}
          </div>
        </div>

        <div className="rounded-xl border border-border/60 bg-background/60 p-3">
          <label
            htmlFor={budgetInputId}
            className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground"
          >
            New budget ({incident.budgetCurrency})
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Input
              id={budgetInputId}
              value={draftAmount}
              onChange={(event) => setDraftAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
            <Button
              className="gap-2"
              disabled={isMutating || !exceedsObserved}
              onClick={() => {
                if (parsed) onRaiseAndResume(parsed);
              }}
            >
              <ArrowUpRight className="h-4 w-4" />
              {isMutating ? "Applying..." : "Raise budget & resume"}
            </Button>
          </div>
          {parsed !== null && !exceedsObserved ? (
            <p className="mt-2 text-xs text-red-700 dark:text-red-200/80">
              The new budget must exceed current observed spend.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" className="text-muted-foreground" disabled={isMutating} onClick={onKeepPaused}>
            Keep paused
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
