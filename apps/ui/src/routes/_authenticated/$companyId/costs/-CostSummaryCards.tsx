import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { formatDateTime, formatMoneyAmount, formatNumber } from "@/lib/utils";
import type {
  CostEvent,
  FinanceEvent,
  FinanceSummaryRow,
  MoneyAmount,
} from "@paperclipai/shared";
import type { ComponentType } from "react";

export function CostBreakdownRows({
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
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No settled prompts</EmptyTitle>
              <EmptyDescription>
                There are no settled prompts in this range.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup>
            {rows.map((row) => (
              <Item key={row.id} size="sm">
                <ItemContent>
                  <ItemTitle>{row.name}</ItemTitle>
                  <ItemDescription>
                    {formatNumber(row.pricedPromptCount)} priced ·{" "}
                    {formatNumber(row.unpricedPromptCount)} unpriced
                  </ItemDescription>
                </ItemContent>
                <ItemTitle className="font-mono tabular-nums">
                  {formatMoneyAmount(row.amount, row.currency)}
                </ItemTitle>
              </Item>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}

export function FinanceCurrencyCard({ row }: { row: FinanceSummaryRow }) {
  const metrics = [
    { label: "Debits", value: row.debitAmount },
    { label: "Credits", value: row.creditAmount },
    { label: `Net ${row.netDirection}`, value: row.netAmount },
    { label: "Estimated debits", value: row.estimatedDebitAmount },
  ];
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
        {metrics.map((metric) => (
          <Item key={metric.label} size="sm">
            <ItemContent>
              <ItemDescription>{metric.label}</ItemDescription>
              <ItemTitle className="font-mono">
                {formatMoneyAmount(metric.value, row.currency)}
              </ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </CardContent>
    </Card>
  );
}

export function CostEventRows({ events }: { events: CostEvent[] }) {
  if (events.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No settled prompt facts</EmptyTitle>
          <EmptyDescription>
            There are no settled prompt facts in this range.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ItemGroup className="divide-y">
      {events.map((event) => (
        <Item key={event.id} size="sm" className="rounded-none border-0">
          <ItemContent>
            <ItemTitle>
              {event.kind === "known" ? "Known cost" : "Cost unavailable"}
            </ItemTitle>
            <ItemDescription>
              {formatDateTime(event.occurredAt)} · {event.promptKind}
            </ItemDescription>
          </ItemContent>
          <ItemActions className="font-mono text-sm tabular-nums">
            {event.kind === "known" && event.knownDeltaAmount
              ? formatMoneyAmount(event.knownDeltaAmount, event.budgetCurrency)
              : (event.unavailableReason?.replaceAll("_", " ") ??
                "unavailable")}
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}

export interface FinanceBreakdownRow {
  id: string;
  label: string;
  amount: MoneyAmount;
  currency: string;
}

export function FinanceBreakdownRows({
  rows,
}: {
  rows: FinanceBreakdownRow[];
}) {
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No finance breakdown</EmptyTitle>
          <EmptyDescription>
            There are no finance events in this range.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ItemGroup>
      {rows.map((row) => (
        <Item key={row.id} size="sm" className="px-0">
          <ItemContent>
            <ItemTitle>{row.label}</ItemTitle>
          </ItemContent>
          <ItemActions className="font-mono text-sm tabular-nums">
            {formatMoneyAmount(row.amount, row.currency)}
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}

export function FinanceEventRows({ events }: { events: FinanceEvent[] }) {
  if (events.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No recent finance events</EmptyTitle>
          <EmptyDescription>
            There are no finance events in this range.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ItemGroup className="divide-y">
      {events.map((event) => (
        <Item key={event.id} size="sm" className="rounded-none border-0">
          <ItemContent>
            <ItemTitle>
              {event.description ?? event.eventKind.replaceAll("_", " ")}
            </ItemTitle>
            <ItemDescription>
              {event.biller} · {formatDateTime(event.occurredAt)}
            </ItemDescription>
          </ItemContent>
          <ItemActions className="font-mono text-sm tabular-nums">
            {formatMoneyAmount(event.amount, event.currency)}
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}
