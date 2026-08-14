import type {
  DataTableProps,
  JsonTreeProps,
  KeyValueListProps,
  MetricCardProps,
  SpinnerProps,
  StatusBadgeProps,
} from "@paperclipai/plugin-sdk/ui";
import { Component, createElement as h, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import * as CardUI from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import * as TableUI from "@/components/ui/table";

const STATUS_BADGE_VARIANT = {
  ok: "default",
  warning: "secondary",
  error: "destructive",
  info: "outline",
  pending: "secondary",
} as const;

export function PluginSdkStatusBadge({ label, status }: StatusBadgeProps) {
  return h(Badge, { variant: STATUS_BADGE_VARIANT[status] }, label);
}

function tableState(message: string, loading = false) {
  return h(
    Empty,
    { className: "border py-6 md:p-6" },
    h(
      EmptyDescription,
      { className: loading ? "inline-flex items-center gap-2" : undefined },
      loading ? h(Spinner, { "aria-label": message }) : null,
      message,
    ),
  );
}

function renderTableColumn(column: DataTableProps["columns"][number], row?: Record<string, unknown>) {
  const header = row === undefined;
  return h(
    header ? TableUI.TableHead : TableUI.TableCell,
    {
      key: column.key,
      className: header ? "whitespace-normal" : "min-w-0 whitespace-normal",
      scope: header ? "col" : undefined,
      style: column.width ? { width: column.width } : undefined,
    },
    header
      ? column.header
      : column.render
        ? column.render(row[column.key], row)
        : String(row[column.key] ?? ""),
  );
}

export function PluginSdkDataTable({ columns, rows, loading, emptyMessage = "No rows." }: DataTableProps) {
  if (loading) return tableState("Loading...", true);
  if (!rows.length) return tableState(emptyMessage);
  return h(
    CardUI.Card,
    { className: "gap-0 overflow-hidden py-0" },
    h(
      TableUI.Table,
      { className: "table-fixed" },
      h(
        TableUI.TableHeader,
        null,
        h(
          TableUI.TableRow,
          null,
          columns.map((column) => renderTableColumn(column)),
        ),
      ),
      h(
        TableUI.TableBody,
        null,
        rows.map((row, index) =>
          h(
            TableUI.TableRow,
            { key: String(row.id ?? index) },
            columns.map((column) => renderTableColumn(column, row)),
          ),
        ),
      ),
    ),
  );
}

export function PluginSdkKeyValueList({ pairs }: KeyValueListProps) {
  return h(
    "dl",
    {
      className: "grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]",
    },
    pairs.flatMap((pair) => [
      h("dt", { key: `${pair.label}:label`, className: "text-muted-foreground" }, pair.label),
      h("dd", { key: `${pair.label}:value`, className: "min-w-0" }, pair.value),
    ]),
  );
}

export function PluginSdkMetricCard({ label, value, unit }: MetricCardProps) {
  return h(
    CardUI.Card,
    { className: "gap-2 py-4" },
    h(
      CardUI.CardHeader,
      { className: "gap-1 px-4" },
      h(CardUI.CardDescription, { className: "text-xs font-medium uppercase tracking-wide" }, label),
      h(CardUI.CardTitle, { className: "text-lg" }, `${value}${unit ?? ""}`),
    ),
  );
}

export function PluginSdkJsonTree({ data }: JsonTreeProps) {
  return h(
    CardUI.Card,
    { className: "max-h-80 gap-0 overflow-hidden py-0" },
    h(
      ScrollArea,
      { className: "max-h-80" },
      h("pre", { className: "p-3 text-xs" }, JSON.stringify(data, null, 2)),
    ),
  );
}

export function PluginSdkSpinner({ label = "Loading", size }: SpinnerProps) {
  const className = size === "sm" ? "size-3" : size === "lg" ? "size-5" : "size-4";
  return h(Spinner, { className, "aria-label": label });
}

export class PluginSdkErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ??
        h(Alert, { variant: "destructive" }, h(AlertDescription, null, "Plugin UI failed to render."))
      );
    }
    return this.props.children;
  }
}
