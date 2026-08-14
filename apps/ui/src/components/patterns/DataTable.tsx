import type { ColumnDef } from "@tanstack/react-table";
import { Provider as JotaiProvider } from "jotai";

import {
  TableBody,
  TableCell,
  TableColumnHeader,
  TableHead,
  TableHeader,
  TableHeaderGroup,
  TableProvider,
  TableRow,
} from "@/components/kibo-ui/table";

export type { ColumnDef } from "@tanstack/react-table";
export { TableColumnHeader as DataTableColumnHeader };

type ClassNameResolver<TData> = string | ((row: TData) => string | undefined);

export interface DataTableProps<TData> {
  columns: ColumnDef<TData>[];
  data: TData[];
  className?: string;
  caption?: string;
  headerClassName?: string;
  bodyClassName?: string;
  showHeader?: boolean;
  rowClassName?: ClassNameResolver<TData>;
  getHeadClassName?: (columnId: string) => string | undefined;
  getCellClassName?: (row: TData, columnId: string) => string | undefined;
}

/** Paperclip's domain-neutral adapter over Kibo's sortable Table composition. */
export function DataTable<TData>({
  columns,
  data,
  className,
  caption,
  headerClassName,
  bodyClassName,
  showHeader = true,
  rowClassName,
  getHeadClassName,
  getCellClassName,
}: DataTableProps<TData>) {
  return (
    <JotaiProvider>
      <TableProvider columns={columns} data={data} className={className}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {showHeader ? (
          <TableHeader className={headerClassName}>
            {({ headerGroup }) => (
              <TableHeaderGroup headerGroup={headerGroup} key={headerGroup.id}>
                {({ header }) => (
                  <TableHead
                    header={header}
                    key={header.id}
                    className={getHeadClassName?.(header.column.id)}
                  />
                )}
              </TableHeaderGroup>
            )}
          </TableHeader>
        ) : null}
        <TableBody className={bodyClassName}>
          {({ row }) => {
            const original = row.original as TData;
            const resolvedRowClassName =
              typeof rowClassName === "function" ? rowClassName(original) : rowClassName;
            return (
              <TableRow key={row.id} row={row} className={resolvedRowClassName}>
                {({ cell }) => (
                  <TableCell
                    cell={cell}
                    key={cell.id}
                    className={getCellClassName?.(original, cell.column.id)}
                  />
                )}
              </TableRow>
            );
          }}
        </TableBody>
      </TableProvider>
    </JotaiProvider>
  );
}
