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
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
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
  const greaterCurrentAmount =
    compareMoneyAmounts(incident.observedAmount, incident.limitAmount) >= 0
      ? incident.observedAmount
      : incident.limitAmount;
  const [draftAmount, setDraftAmount] = useState<string>(addMoneyAmounts(greaterCurrentAmount, ONE_AMOUNT));
  const parsed = parseBudgetInput(draftAmount);
  const exceedsObserved = parsed !== null && compareMoneyAmounts(parsed, incident.observedAmount) > 0;
  const stateLabel = incidentStateLabel(incident);
  const budgetInputId = useId();

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <CardDescription>{incident.scopeType} hard stop</CardDescription>
              <DomainStatus status={incident.approvalStatus ?? incident.status}>{stateLabel}</DomainStatus>
            </div>
            <CardTitle className="mt-1 text-base">{incident.scopeName}</CardTitle>
            <CardDescription className="mt-1">
              Spending reached {formatMoneyAmount(incident.observedAmount, incident.budgetCurrency)} against a
              limit of {formatMoneyAmount(incident.limitAmount, incident.budgetCurrency)}.
            </CardDescription>
          </div>
          <AlertOctagon className="size-5 text-destructive" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="destructive">
          <PauseCircle />
          <AlertDescription>
            {incident.scopeType === "project"
              ? "Project execution is paused. New work in this project will not start until you resolve the budget incident."
              : "This scope is paused. New execution will not start until you resolve the budget incident."}
          </AlertDescription>
        </Alert>

        <LabeledFormField label={`New budget (${incident.budgetCurrency})`} labelFor={budgetInputId}>
          <div className="flex flex-col gap-3 sm:flex-row">
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
            <FieldError>The new budget must exceed current observed spend.</FieldError>
          ) : null}
        </LabeledFormField>

        <div className="flex justify-end">
          <Button
            variant="ghost"
            className="text-muted-foreground"
            disabled={isMutating}
            onClick={onKeepPaused}
          >
            Keep paused
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
