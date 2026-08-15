import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FieldSet } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { type CompanySecret, type Routine } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, History as HistoryIcon, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { routinesApi, type RestoreRoutineRevisionResponse } from "@/api/routines";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";

import { RevisionList } from "./-RoutineRevisionList";

import { RevisionPreview } from "./-RoutineRevisionPreview";

import { RestoreConfirmDialog } from "./-RoutineRestoreDialog";

import {
  collectWebhookTriggerDifferences,
  formatDirtyFieldList,
  summarizeEnvDiffCounts,
} from "./-RoutineRevisionDiff";

import { RoutineRevisionDiffModal } from "./-RoutineRevisionDiffModal";
import type { KeyedLabel, NamedEntityLookup, SecretLookup } from "@/lib/presentation-contracts";

export type DirtyFieldDescriptor = KeyedLabel;

type Props = {
  routine: Routine;
  isEditDirty: boolean;
  dirtyFields: DirtyFieldDescriptor[];
  onDiscardEdits: () => void;
  onSaveEdits: () => void;
  agents: NamedEntityLookup;
  projects: NamedEntityLookup;
  secrets?: CompanySecret[];
  onRestoreSecretMaterials: (response: RestoreRoutineRevisionResponse) => void;
  onRestored?: (response: RestoreRoutineRevisionResponse) => void;
};

export function RoutineHistoryTab({
  routine,
  isEditDirty,
  dirtyFields,
  onDiscardEdits,
  onSaveEdits,
  agents,
  projects,
  secrets,
  onRestoreSecretMaterials,
  onRestored,
}: Props) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const secretLookup = useMemo<SecretLookup>(
    () => new Map((secrets ?? []).map((secret) => [secret.id, secret])),
    [secrets],
  );
  const queryClient = useQueryClient();
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [highlightedRevisionId, setHighlightedRevisionId] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [restoreSummary, setRestoreSummary] = useState("");

  const revisionsQuery = useQuery({
    queryKey: queryKeys.routines.revisions(routine.id),
    queryFn: () => routinesApi.listRevisions(routine.id),
  });

  const revisions = useMemo(() => revisionsQuery.data ?? [], [revisionsQuery.data]);
  const sortedRevisions = useMemo(
    () => [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber),
    [revisions],
  );
  const currentRevision = useMemo(
    () => sortedRevisions.find((r) => r.id === routine.latestRevisionId) ?? sortedRevisions[0] ?? null,
    [sortedRevisions, routine.latestRevisionId],
  );

  useEffect(() => {
    if (selectedRevisionId === null && currentRevision) {
      setSelectedRevisionId(currentRevision.id);
    }
  }, [currentRevision, selectedRevisionId]);

  const selectedRevision = useMemo(
    () => sortedRevisions.find((r) => r.id === selectedRevisionId) ?? null,
    [sortedRevisions, selectedRevisionId],
  );
  const isHistoricalSelected = !!selectedRevision && selectedRevision.id !== routine.latestRevisionId;
  const visibleRevisions = useMemo(() => {
    if (showOlder || sortedRevisions.length <= 8) return sortedRevisions;
    return sortedRevisions.slice(0, 8);
  }, [sortedRevisions, showOlder]);

  const restoreMutation = useMutation({
    mutationFn: (input: { revisionId: string; changeSummary: string }) =>
      routinesApi.restoreRevision(routine.id, input.revisionId, {
        changeSummary: input.changeSummary.trim() || null,
      }),
    onSuccess: async (data) => {
      const restoredFromNumber = data.restoredFromRevisionNumber;
      const newNumber = data.revision.revisionNumber;
      toast.success(`Restored revision ${restoredFromNumber} as revision ${newNumber}`, {
        description:
          data.secretMaterials.length > 0
            ? "Trigger enabled state was restored from the snapshot. New webhook secrets are available in the banner above."
            : "Trigger enabled state was restored from the snapshot.",
      });
      onRestoreSecretMaterials(data);
      onRestored?.(data);
      setConfirmOpen(false);
      setRestoreSummary("");
      setSelectedRevisionId(data.revision.id);
      setHighlightedRevisionId(data.revision.id);
      window.setTimeout(() => {
        setHighlightedRevisionId((current) => (current === data.revision.id ? null : current));
      }, 3000);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.detail(routine.id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.runs(routine.id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.activity(routine.companyId, routine.id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.list(routine.companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.revisions(routine.id),
        }),
      ]);
    },
    onError: (error) => {
      toast.error("Failed to restore revision", {
        description: error instanceof Error ? error.message : "Paperclip could not restore the revision.",
      });
    },
  });

  const handleSelectRevision = (revisionId: string) => {
    if (isEditDirty) return;
    setSelectedRevisionId(revisionId);
  };

  const handleReturnToCurrent = () => {
    if (currentRevision) setSelectedRevisionId(currentRevision.id);
  };

  const openRestoreConfirm = () => {
    if (!selectedRevision || !isHistoricalSelected) return;
    setRestoreSummary("");
    setConfirmOpen(true);
  };

  const confirmRestore = async () => {
    if (!selectedRevision) return;
    await restoreMutation.mutateAsync({
      revisionId: selectedRevision.id,
      changeSummary: restoreSummary,
    });
  };

  if (revisionsQuery.isLoading) {
    return (
      <div className="grid gap-5 md:grid-cols-(--gtc-9)">
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, idx) => (
            <Skeleton key={idx} className="h-10 w-full" />
          ))}
        </div>
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (revisionsQuery.error) {
    return (
      <Alert variant="destructive">
        <AlertCircle  data-icon="inline-start"/>
        <AlertTitle>Could not load revisions</AlertTitle>
        <AlertDescription>
          <p>
            {revisionsQuery.error instanceof Error
              ? revisionsQuery.error.message
              : "Unknown error loading revisions."}
          </p>
          <Button size="sm" variant="outline" onClick={() => revisionsQuery.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const onlyBootstrapRevision = revisions.length <= 1;

  return (
    <>
      <FieldSet
        aria-busy={restoreMutation.isPending}
        aria-label="Routine revision history controls"
        className="gap-0"
        disabled={restoreMutation.isPending}
      >
        <div className="grid gap-5 md:grid-cols-(--gtc-9)">
          <RevisionList
            revisions={visibleRevisions}
            latestRevisionId={routine.latestRevisionId}
            selectedRevisionId={selectedRevisionId}
            highlightedRevisionId={highlightedRevisionId}
            isEditDirty={isEditDirty}
            totalRevisions={sortedRevisions.length}
            onSelect={handleSelectRevision}
            onShowOlder={() => setShowOlder(true)}
            showOlder={showOlder}
          />
          <div className="space-y-4 min-w-0">
            {isEditDirty ? (
              <Alert>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <AlertTitle>Unsaved routine edits</AlertTitle>
                    <AlertDescription>
                      You changed{" "}
                      {formatDirtyFieldList(
                        dirtyFields.length > 0 ? dirtyFields.map((field) => field.label) : ["the routine"],
                      )}{" "}
                      but haven&apos;t saved yet. Save or discard before previewing or restoring an older
                      revision.
                    </AlertDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={onDiscardEdits}>
                      Discard changes
                    </Button>
                    <Button size="sm" onClick={onSaveEdits}>
                      Save and continue
                    </Button>
                  </div>
                </div>
                {dirtyFields.length > 0 ? (
                  <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                    {dirtyFields.map((field) => (
                      <li key={field.key} className="flex items-center gap-2">
                        <span aria-hidden>•</span>
                        {field.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Alert>
            ) : null}
            {!isEditDirty && onlyBootstrapRevision ? (
              <div className="space-y-2">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <HistoryIcon  data-icon="inline-start"/>
                    </EmptyMedia>
                    <EmptyTitle>No edits yet</EmptyTitle>
                  </EmptyHeader>
                </Empty>
                <p className="text-center text-xs text-muted-foreground">
                  Revision 1 is the only history this routine has. Saving an edit creates the first additional
                  revision.
                </p>
              </div>
            ) : (
              selectedRevision && (
                <>
                  {isHistoricalSelected && currentRevision ? (
                    <Alert>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <AlertTitle>
                            Viewing revision {selectedRevision.revisionNumber} (read-only)
                          </AlertTitle>
                          <AlertDescription>
                            Restoring this revision creates a new revision{" "}
                            {currentRevision.revisionNumber + 1} with the same content. History stays
                            append-only.
                          </AlertDescription>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleReturnToCurrent}
                            disabled={restoreMutation.isPending}
                          >
                            Return to current
                          </Button>
                          <Button size="sm" onClick={openRestoreConfirm} disabled={restoreMutation.isPending}>
                            <RotateCcw data-icon="inline-start" />
                            Restore as new revision
                          </Button>
                        </div>
                      </div>
                    </Alert>
                  ) : null}
                  <RevisionPreview
                    revision={selectedRevision}
                    currentRevision={currentRevision}
                    isHistorical={isHistoricalSelected}
                    agents={agents}
                    projects={projects}
                    onCompare={() => setDiffOpen(true)}
                    onRestore={openRestoreConfirm}
                    restorePending={restoreMutation.isPending}
                    highlighted={highlightedRevisionId === selectedRevision.id}
                  />
                </>
              )
            )}
          </div>

          {selectedRevision && currentRevision && (
            <RestoreConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              target={selectedRevision}
              currentRevisionNumber={currentRevision.revisionNumber}
              changeSummary={restoreSummary}
              onChangeSummaryChange={setRestoreSummary}
              onConfirm={confirmRestore}
              pending={restoreMutation.isPending}
              recreatedWebhookLabels={collectWebhookTriggerDifferences(selectedRevision, currentRevision)}
              envDiffCounts={summarizeEnvDiffCounts(
                currentRevision.snapshot.routine.env ?? null,
                selectedRevision.snapshot.routine.env ?? null,
              )}
            />
          )}

          {currentRevision && selectedRevision && (
            <RoutineRevisionDiffModal
              open={diffOpen}
              onOpenChange={setDiffOpen}
              revisions={sortedRevisions}
              initialOldRevisionId={selectedRevision.id}
              initialNewRevisionId={currentRevision.id}
              agents={agents}
              projects={projects}
              secrets={secretLookup}
              onRestore={(rev) => {
                setSelectedRevisionId(rev.id);
                setDiffOpen(false);
                setRestoreSummary("");
                setConfirmOpen(true);
              }}
            />
          )}
        </div>
      </FieldSet>
      {restoreMutation.isPending ? (
        <p aria-live="polite" className="flex items-center gap-2 text-sm">
          <Spinner /> Restoring routine revision…
        </p>
      ) : null}
    </>
  );
}

export * from "./-RoutineRestoreDialog";
export * from "./-RoutineRevisionDiff";
export * from "./-RoutineRevisionDiffModal";
export * from "./-RoutineRevisionList";
export * from "./-RoutineRevisionPreview";
