import { UserPlus, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  parseBudgetCurrency,
  parseMoneyAmount,
  type BudgetCurrency,
  type MoneyAmount,
} from "@paperclipai/shared";
import { formatMoneyAmount } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Kbd } from "@/components/ui/kbd";
import { CodeBlockPanel } from "@/components/patterns/CodeBlockPanel";
import { JsonCodeBlock } from "@/components/patterns/JsonCodeBlock";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  budget_override_required: "Budget Override",
  request_board_approval: "Board Approval",
};

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function approvalSubject(payload?: Record<string, unknown> | null): string | null {
  return firstNonEmptyString(payload?.title, payload?.name, payload?.summary, payload?.recommendedAction);
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload);
  if (subject) {
    return `${base}: ${subject}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  budget_override_required: ShieldAlert,
  request_board_approval: ShieldCheck,
};

function ApprovalDetailItems({ details }: { details: unknown[][] }) {
  return details.map(([label, value]) =>
    value ? (
      <Item key={String(label)} size="sm">
        <ItemContent>
          <ItemDescription>{String(label)}</ItemDescription>
          <ItemTitle>{String(value)}</ItemTitle>
        </ItemContent>
      </Item>
    ) : null,
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  const details = [
    ["Name", payload.name ?? "—"],
    ["Title", payload.title],
    ["Icon", payload.icon],
    ["Capabilities", payload.capabilities],
  ];
  return (
    <ItemGroup className="mt-3">
      <ApprovalDetailItems details={details} />
      {!!payload.adapterType && (
        <Item size="sm">
          <ItemContent>
            <ItemDescription>Adapter</ItemDescription>
            <ItemTitle>
              <Kbd>{String(payload.adapterType)}</Kbd>
            </ItemTitle>
          </ItemContent>
        </Item>
      )}
    </ItemGroup>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      {payload.title ? (
        <Item size="sm">
          <ItemContent>
            <ItemDescription>Title</ItemDescription>
            <ItemTitle>{String(payload.title)}</ItemTitle>
          </ItemContent>
        </Item>
      ) : null}
      {!!plan && (
        <CodeBlockPanel
          bodyClassName="max-h-48"
          className="mt-2"
          code={String(plan)}
          filename="strategy.txt"
          syntaxHighlighting={false}
        />
      )}
      {!plan && (
        <JsonCodeBlock bodyClassName="max-h-48" className="mt-2" filename="approval.json" value={payload} />
      )}
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  let budgetCurrency: BudgetCurrency | null = null;
  let limitAmount: MoneyAmount | null = null;
  let observedAmount: MoneyAmount | null = null;
  try {
    budgetCurrency = parseBudgetCurrency(payload.budgetCurrency);
    limitAmount = parseMoneyAmount(payload.limitAmount);
    observedAmount = parseMoneyAmount(payload.observedAmount);
  } catch {
    // Approval payloads are immutable audit data. Invalid canonical money is
    // shown as unavailable rather than coerced through a compatibility shape.
  }
  const details = [
    ["Scope", payload.scopeName ?? payload.scopeType],
    ["Window", payload.windowKind],
  ];
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <ApprovalDetailItems details={details} />
      {budgetCurrency && limitAmount && observedAmount ? (
        <Alert>
          <AlertDescription>
            Limit {formatMoneyAmount(limitAmount, budgetCurrency)} · Observed{" "}
            {formatMoneyAmount(observedAmount, budgetCurrency)}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertDescription>Budget amounts unavailable</AlertDescription>
        </Alert>
      )}
      {!!payload.guidance && <p className="text-muted-foreground">{String(payload.guidance)}</p>}
    </div>
  );
}

export function BoardApprovalPayload({
  payload,
  hideTitle = false,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
}) {
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return <BoardApprovalPayloadContent payload={nextPayload} />;
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const recommendedAction = firstNonEmptyString(payload.recommendedAction);
  const nextActionOnApproval = firstNonEmptyString(payload.nextActionOnApproval);
  const proposedComment = firstNonEmptyString(payload.proposedComment);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Title
          </p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Summary
          </p>
          <p className="leading-6 text-foreground/90">{summary}</p>
        </div>
      )}
      {recommendedAction && (
        <Alert>
          <AlertTitle>Recommended action</AlertTitle>
          <AlertDescription>{recommendedAction}</AlertDescription>
        </Alert>
      )}
      {nextActionOnApproval && (
        <Alert>
          <AlertTitle>On approval</AlertTitle>
          <AlertDescription>{nextActionOnApproval}</AlertDescription>
        </Alert>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Risks
          </p>
          <ItemGroup>
            {risks.map((risk) => (
              <Item key={risk} size="sm" variant="outline">
                <ItemContent>
                  <ItemDescription>{risk}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Proposed comment
          </p>
          <CodeBlockPanel
            bodyClassName="max-h-48"
            code={proposedComment}
            filename="proposed-comment.txt"
            syntaxHighlighting={false}
          />
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  hidePrimaryTitle = false,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_board_approval") {
    return <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} />;
  }
  return <CeoStrategyPayload payload={payload} />;
}
