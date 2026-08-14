import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { type RoutineRevision } from "@paperclipai/shared";
import { relativeTime } from "../lib/utils";

import { getActorLabel } from "./RoutineRevisionDiff";

export function RevisionList({
  revisions,
  latestRevisionId,
  selectedRevisionId,
  highlightedRevisionId,
  isEditDirty,
  totalRevisions,
  onSelect,
  onShowOlder,
  showOlder,
}: {
  revisions: RoutineRevision[];
  latestRevisionId: string | null;
  selectedRevisionId: string | null;
  highlightedRevisionId: string | null;
  isEditDirty: boolean;
  totalRevisions: number;
  onSelect: (revisionId: string) => void;
  onShowOlder: () => void;
  showOlder: boolean;
}) {
  return (
    <aside className="space-y-1">
      <header className="flex items-center justify-between pb-2">
        <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">
          Revisions
        </p>
        <span className="text-(length:--text-micro) text-muted-foreground">{totalRevisions} total</span>
      </header>
      <ToggleGroup
        type="single"
        value={selectedRevisionId ?? ""}
        onValueChange={(revisionId) => revisionId && onSelect(revisionId)}
        variant="outline"
        spacing={1}
        orientation="vertical"
        aria-label="Routine revisions"
        className="w-full flex-col items-stretch"
      >
        {revisions.map((revision) => {
          const isCurrent = revision.id === latestRevisionId;
          const isHistorical = !isCurrent;
          const isHighlighted = revision.id === highlightedRevisionId;
          const blockedByEdits = isEditDirty && isHistorical;
          return (
            <ToggleGroupItem
              key={revision.id}
              value={revision.id}
              disabled={blockedByEdits}
              className={cn(
                "h-auto w-full flex-col items-stretch gap-0 whitespace-normal px-3 py-2 text-left font-normal",
                isHighlighted && "ring-2 ring-ring",
              )}
              data-testid={`revision-row-${revision.revisionNumber}`}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <span>rev {revision.revisionNumber}</span>
                {isCurrent && <Badge variant="outline">Current</Badge>}
                {revision.restoredFromRevisionId && <Badge variant="secondary">Restored</Badge>}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {relativeTime(revision.createdAt)} • {getActorLabel(revision)}
                {revision.changeSummary ? ` • ${revision.changeSummary}` : ""}
              </div>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      {totalRevisions > revisions.length && !showOlder && (
        <Button variant="ghost" size="sm" className="w-full" onClick={onShowOlder}>
          Show {totalRevisions - revisions.length} older…
        </Button>
      )}
    </aside>
  );
}
