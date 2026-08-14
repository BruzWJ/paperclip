import { Button } from "@/components/ui/button";
import { DiffCodeBlock } from "@/components/patterns/DiffCodeBlock";
import { RevisionCombobox } from "@/components/patterns/RevisionCombobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type RoutineRevision } from "@paperclipai/shared";
import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { relativeTime } from "../lib/utils";

import { formatRoutineFieldDiff } from "./RoutineRevisionDiff";
import type { NamedEntityLookup, SecretLookup } from "@/lib/presentation-contracts";

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
  agents: NamedEntityLookup;
  projects: NamedEntityLookup;
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
  const fieldDiff = useMemo(
    () =>
      left && right
        ? formatRoutineFieldDiff(left, right, agents, projects, secrets)
        : { oldText: "", newText: "" },
    [left, right, agents, projects, secrets],
  );
  const newest = revisions[0] ?? null;
  const leftIsHistorical = !!left && !!newest && left.id !== newest.id;
  const revisionOptions = useMemo(
    () =>
      revisions.map((revision) => ({
        id: revision.id,
        label: `rev ${revision.revisionNumber} — ${relativeTime(revision.createdAt)}${
          revision.changeSummary ? ` • ${revision.changeSummary}` : ""
        }`,
      })),
    [revisions],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-(--pct-90) w-full max-h-(--sz-85vh) overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Compare routine revisions</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <RevisionCombobox
            label="Old"
            side="old"
            value={leftId}
            onValueChange={setLeftId}
            options={revisionOptions}
          />
          <RevisionCombobox
            label="New"
            side="new"
            value={rightId}
            onValueChange={setRightId}
            options={revisionOptions}
          />
        </div>
        <div className="overflow-auto flex-1 space-y-4">
          <section className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">
              Field changes
            </p>
            <DiffCodeBlock
              oldText={fieldDiff.oldText}
              newText={fieldDiff.newText}
              filename="routine-fields.txt"
              emptyMessage="No structural field changes."
              identicalMessage="No structural field changes."
            />
          </section>
          <section className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">
              Description diff
            </p>
            <DiffCodeBlock
              oldText={left?.snapshot.routine.description ?? ""}
              newText={right?.snapshot.routine.description ?? ""}
              filename="description.md"
              language="markdown"
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
