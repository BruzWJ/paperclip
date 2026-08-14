import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldLabel } from "@/components/ui/field";
import { type CompanySecret, type RoutineRevision } from "@paperclipai/shared";
import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { buildLineDiff, type DiffRow } from "../lib/line-diff";
import { relativeTime } from "../lib/utils";

import { computeFieldChanges } from "./RoutineRevisionDiff";
import { LineDiffTable } from "./LineDiffTable";

export { LineDiffTable as DiffTable } from "./LineDiffTable";

type AgentLookup = Map<string, { id: string; name: string }>;

type ProjectLookup = Map<string, { id: string; name: string }>;

type SecretLookup = Map<string, CompanySecret>;

export function RoutineRevisionDiffModal({
  open,
  onOpenChange,
  revisions,
  initialOldRevisionId,
  initialNewRevisionId,
  agents,
  projects,
  secrets,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revisions: RoutineRevision[];
  initialOldRevisionId: string;
  initialNewRevisionId: string;
  agents: AgentLookup;
  projects: ProjectLookup;
  secrets: SecretLookup;
  onRestore: (revision: RoutineRevision) => void;
}) {
  const [leftId, setLeftId] = useState<string>(initialOldRevisionId);
  const [rightId, setRightId] = useState<string>(initialNewRevisionId);

  useEffect(() => {
    if (open) {
      setLeftId(initialOldRevisionId);
      setRightId(initialNewRevisionId);
    }
  }, [open, initialOldRevisionId, initialNewRevisionId]);

  const left = revisions.find((r) => r.id === leftId) ?? null;
  const right = revisions.find((r) => r.id === rightId) ?? null;
  const fieldChanges = useMemo(
    () => (left && right ? computeFieldChanges(left, right, agents, projects, secrets) : []),
    [left, right, agents, projects, secrets],
  );
  const descriptionDiff = useMemo<DiffRow[]>(
    () =>
      left && right
        ? buildLineDiff(left.snapshot.routine.description ?? "", right.snapshot.routine.description ?? "")
        : [],
    [left, right],
  );
  const newest = revisions[0] ?? null;
  const leftIsHistorical = !!left && !!newest && left.id !== newest.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-(--pct-90) w-full max-h-(--sz-85vh) overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Compare routine revisions</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <RevisionPicker label="Old" value={leftId} onChange={setLeftId} revisions={revisions} tone="red" />
          <RevisionPicker
            label="New"
            value={rightId}
            onChange={setRightId}
            revisions={revisions}
            tone="green"
          />
        </div>
        <div className="overflow-auto flex-1 space-y-4">
          <section className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">
              Field changes
            </p>
            {fieldChanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">No structural field changes.</p>
            ) : (
              <Table className="border border-border text-sm">
                <TableHeader>
                  <TableRow className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                    <TableHead className="px-3 py-2 text-left">Field</TableHead>
                    <TableHead className="px-3 py-2 text-left">Old value</TableHead>
                    <TableHead className="px-3 py-2 text-left">New value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fieldChanges.map((change) => (
                    <TableRow key={change.field} className="border-t border-border/60">
                      <TableCell className="px-3 py-2 align-top text-xs font-medium">
                        {change.field}
                      </TableCell>
                      <TableCell className="px-3 py-2 align-top text-xs text-red-700 dark:text-red-300">
                        {change.oldValue ?? "—"}
                      </TableCell>
                      <TableCell className="px-3 py-2 align-top text-xs text-emerald-700 dark:text-emerald-300">
                        {change.newValue ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
          <section className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">
              Description diff
            </p>
            <LineDiffTable
              rows={descriptionDiff}
              emptyMessage="No description on either revision."
              identicalMessage="Descriptions are identical."
            />
          </section>
        </div>
        <DialogFooter className="justify-between sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {leftIsHistorical && left && (
            <Button onClick={() => onRestore(left)}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Restore rev {left.revisionNumber} as new revision
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RevisionPicker({
  label,
  value,
  onChange,
  revisions,
  tone,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  revisions: RoutineRevision[];
  tone: "red" | "green";
}) {
  const triggerId = `routine-revision-${tone}-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <Field orientation="horizontal" className="w-auto gap-2">
      <FieldLabel htmlFor={triggerId}>
        <Badge variant={tone === "red" ? "outline" : "secondary"}>{label}</Badge>
      </FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={triggerId} className="h-8 min-w-(--sz-12rem) px-2 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {revisions.map((revision) => (
            <SelectItem key={revision.id} value={revision.id}>
              rev {revision.revisionNumber} — {relativeTime(revision.createdAt)}
              {revision.changeSummary ? ` • ${revision.changeSummary}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
