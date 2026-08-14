import type { DiffRow } from "@/lib/line-diff";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const MARKER_BY_KIND: Record<DiffRow["kind"], string> = {
  context: " ",
  removed: "−",
  added: "+",
};

export function LineDiffTable({
  rows,
  emptyMessage = "No content on either revision.",
  identicalMessage = "The revisions are identical.",
}: {
  rows: DiffRow[];
  emptyMessage?: string;
  identicalMessage?: string;
}) {
  const message =
    rows.length === 0 ? emptyMessage : rows.every((row) => row.kind === "context") ? identicalMessage : null;

  if (message) {
    return (
      <Empty className="py-8">
        <EmptyDescription>{message}</EmptyDescription>
      </Empty>
    );
  }

  return (
    <Table className="font-mono text-xs">
      <TableHeader>
        <TableRow>
          <TableHead className="w-14 text-right">Old</TableHead>
          <TableHead className="w-14 text-right">New</TableHead>
          <TableHead className="w-10 text-center">
            <span className="sr-only">Change</span>
          </TableHead>
          <TableHead>Content</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow
            key={`${row.kind}-${index}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}`}
            data-diff-kind={row.kind}
          >
            <TableCell className="select-none text-right text-muted-foreground">
              {row.oldLineNumber ?? ""}
            </TableCell>
            <TableCell className="select-none text-right text-muted-foreground">
              {row.newLineNumber ?? ""}
            </TableCell>
            <TableCell className="select-none text-center text-muted-foreground">
              {MARKER_BY_KIND[row.kind]}
            </TableCell>
            <TableCell>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-inherit">
                {row.text.length > 0 ? row.text : " "}
              </pre>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
