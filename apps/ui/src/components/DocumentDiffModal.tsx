import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { DocumentRevision } from "@paperclipai/shared";
import { tasksApi } from "../api/tasks";
import { queryKeys } from "../lib/queryKeys";
import { buildLineDiff } from "../lib/line-diff";
import { relativeTime } from "../lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { LineDiffTable } from "./LineDiffTable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function getRevisionLabel(revision: DocumentRevision) {
  const actor = revision.createdByUserId ? "board" : revision.createdByAgentId ? "agent" : "system";
  return `rev ${revision.revisionNumber} — ${relativeTime(revision.createdAt)} • ${actor}`;
}

export function DocumentDiffModal({
  taskId,
  documentKey,
  latestRevisionNumber,
  open,
  onOpenChange,
  revisionsQueryKey,
  revisionsQueryFn,
}: {
  taskId?: string;
  documentKey: string;
  latestRevisionNumber: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revisionsQueryKey?: QueryKey;
  revisionsQueryFn?: () => Promise<DocumentRevision[]>;
}) {
  const { data: revisions } = useQuery({
    queryKey: revisionsQueryKey ?? queryKeys.tasks.documentRevisions(taskId ?? "", documentKey),
    queryFn: () =>
      revisionsQueryFn ? revisionsQueryFn() : tasksApi.listDocumentRevisions(taskId ?? "", documentKey),
    enabled: open,
  });

  const sortedRevisions = useMemo(() => {
    if (!revisions) return [];
    return [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  }, [revisions]);

  // Default: compare previous (latestRevisionNumber - 1) with current (latestRevisionNumber)
  const [leftRevisionId, setLeftRevisionId] = useState<string | null>(null);
  const [rightRevisionId, setRightRevisionId] = useState<string | null>(null);

  const effectiveLeftId =
    leftRevisionId ?? sortedRevisions.find((r) => r.revisionNumber === latestRevisionNumber - 1)?.id ?? null;

  const effectiveRightId =
    rightRevisionId ?? sortedRevisions.find((r) => r.revisionNumber === latestRevisionNumber)?.id ?? null;

  const leftRevision = sortedRevisions.find((r) => r.id === effectiveLeftId) ?? null;
  const rightRevision = sortedRevisions.find((r) => r.id === effectiveRightId) ?? null;

  const leftBody = leftRevision?.body ?? "";
  const rightBody = rightRevision?.body ?? "";
  const diffRows = useMemo(() => buildLineDiff(leftBody, rightBody), [leftBody, rightBody]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-(--pct-90) w-full max-h-(--sz-85vh) overflow-hidden flex flex-col">
        <div className="flex items-center justify-between gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              Diff — <span className="font-mono text-sm">{documentKey}</span>
            </DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-4 shrink-0">
            <div className="flex items-center gap-2">
              <Badge variant="outline">Old</Badge>
              <Select value={effectiveLeftId ?? ""} onValueChange={(value) => setLeftRevisionId(value)}>
                <SelectTrigger aria-label="Select old revision" className="h-7 w-60 text-xs border-border/60">
                  <SelectValue placeholder="Select revision" />
                </SelectTrigger>
                <SelectContent>
                  {sortedRevisions.map((revision) => (
                    <SelectItem key={revision.id} value={revision.id} className="text-xs">
                      {getRevisionLabel(revision)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">New</Badge>
              <Select value={effectiveRightId ?? ""} onValueChange={(value) => setRightRevisionId(value)}>
                <SelectTrigger aria-label="Select new revision" className="h-7 w-60 text-xs border-border/60">
                  <SelectValue placeholder="Select revision" />
                </SelectTrigger>
                <SelectContent>
                  {sortedRevisions.map((revision) => (
                    <SelectItem key={revision.id} value={revision.id} className="text-xs">
                      {getRevisionLabel(revision)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="overflow-auto flex-1 rounded-md border border-border text-xs">
          {!revisions ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Spinner /> Loading revisions...
            </div>
          ) : sortedRevisions.length < 2 ? (
            <Empty data-testid="document-diff-empty">
              <EmptyHeader>
                <EmptyTitle>
                  {sortedRevisions.length === 0
                    ? "No revisions are available for this document."
                    : "A second revision is needed to compare changes."}
                </EmptyTitle>
                <EmptyDescription>
                  {sortedRevisions.length === 0
                    ? "Save changes to create the first revision, then open the diff again."
                    : "Save another revision, then return here to compare changes."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : !leftRevision || !rightRevision ? (
            <Empty>
              <EmptyDescription>Select two revisions to compare.</EmptyDescription>
            </Empty>
          ) : leftRevision.id === rightRevision.id ? (
            <Empty>
              <EmptyDescription>Both sides are the same revision.</EmptyDescription>
            </Empty>
          ) : (
            <LineDiffTable rows={diffRows} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
