import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const BUILTIN_VARIABLE_DOCS = [
  {
    name: "date",
    example: "2026-04-28",
    description: "Current date in YYYY-MM-DD format (UTC) at run time.",
  },
  {
    name: "timestamp",
    example: "April 28, 2026 at 12:17 PM UTC",
    description: "Human-readable UTC date and time at run time.",
  },
];

export function RoutineVariablesHint() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>Use `{"{{variable_name}}"}` placeholders to prompt for run inputs.</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setOpen(true)}
          aria-label="Show variable help"
        >
          <HelpCircle />
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Routine variables</DialogTitle>
            <DialogDescription>
              Add placeholders to the title or instructions. Names start with a letter and may contain
              letters, numbers, and underscores. Choose a type, default, and whether each value is required.
              Variable names ending in capital Date, such as startDate, are created as date variables by
              default.
            </DialogDescription>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Built-in</TableHead>
                <TableHead>Example</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {BUILTIN_VARIABLE_DOCS.map((entry) => (
                <TableRow key={entry.name}>
                  <TableCell>
                    <Badge variant="outline">{`{{${entry.name}}}`}</Badge>
                  </TableCell>
                  <TableCell>{entry.example}</TableCell>
                  <TableCell>{entry.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </>
  );
}
