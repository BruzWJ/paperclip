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
import { DomainStatus } from "@/components/patterns/DomainStatus";
import * as CardUI from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { DataTable, DataTableColumnHeader, type ColumnDef } from "@/components/patterns/DataTable";

export function PluginSdkStatusBadge({ label, status }: StatusBadgeProps) {
  return h(DomainStatus, { status }, label);
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

export function PluginSdkDataTable({ columns, rows, loading, emptyMessage = "No rows." }: DataTableProps) {
  if (loading) return tableState("Loading...", true);
  if (!rows.length) return tableState(emptyMessage);
  const tableColumns: ColumnDef<Record<string, unknown>>[] = columns.map((definition) => ({
    id: definition.key,
    accessorFn: (row) => row[definition.key],
    enableSorting: definition.sortable === true,
    header: ({ column }) =>
      definition.sortable
        ? h(DataTableColumnHeader<Record<string, unknown>, unknown>, {
            column,
            title: definition.header,
          })
        : h("div", { style: definition.width ? { width: definition.width } : undefined }, definition.header),
    cell: ({ row }) =>
      h(
        "div",
        {
          className: "min-w-0 whitespace-normal",
          style: definition.width ? { width: definition.width } : undefined,
        },
        definition.render
          ? definition.render(row.original[definition.key], row.original)
          : String(row.original[definition.key] ?? ""),
      ),
  }));
  return h(
    CardUI.Card,
    { className: "gap-0 overflow-hidden py-0" },
    h(DataTable<Record<string, unknown>>, {
      caption: "Plugin data",
      className: "table-fixed",
      columns: tableColumns,
      data: rows,
      getHeadClassName: () => "whitespace-normal",
    }),
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
