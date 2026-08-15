import { Plus } from "lucide-react";

import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { Button } from "@/components/ui/button";
import { DocumentDiffModal } from "./-DocumentDiffModal";
import { NewTaskDocumentEditor } from "./-TaskDocumentBodyEditor";
import { TaskDocumentCard } from "./-TaskDocumentCard";
import type { TaskDocumentsSectionController } from "./-useTaskDocumentsController";

export function TaskDocumentsSectionView(controller: TaskDocumentsSectionController) {
  const diffDocument = controller.diffViewKey
    ? (controller.sortedDocuments.find((doc) => doc.key === controller.diffViewKey) ?? null)
    : null;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={controller.beginNewDocument}>
          <Plus data-icon="inline-start" />
          <span className="hidden sm:inline">New document</span>
          <span className="sm:hidden">New</span>
        </Button>
      </div>
      {controller.error ? <p className="text-xs text-destructive">{controller.error}</p> : null}
      <NewTaskDocumentEditor controller={controller} />
      <div className="space-y-3">
        {controller.sortedDocuments.map((doc) => (
          <TaskDocumentCard key={doc.id} controller={controller} doc={doc} />
        ))}
      </div>
      {diffDocument ? (
        <DocumentDiffModal
          documentKey={diffDocument.key}
          latestRevisionNumber={diffDocument.latestRevisionNumber}
          revisionsQueryKey={controller.documentSubject.documentRevisionsQueryKey(diffDocument.key)}
          revisionsQueryFn={() => controller.documentSubject.listDocumentRevisions(diffDocument.key)}
          open
          onOpenChange={(open) => {
            if (!open) controller.setDiffViewKey(null);
          }}
        />
      ) : null}
      <ConfirmActionDialog
        open={Boolean(controller.confirmDeleteKey)}
        onOpenChange={(open) => {
          if (!open) controller.setConfirmDeleteKey(null);
        }}
        title="Delete document?"
        description={
          controller.confirmDeleteKey
            ? `This permanently deletes the ${controller.confirmDeleteKey} document and its revision history.`
            : undefined
        }
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        variant="destructive"
        pending={controller.deleteDocument.isPending}
        onConfirm={() => {
          if (!controller.confirmDeleteKey) return;
          return controller.deleteDocument.mutateAsync(controller.confirmDeleteKey).then(() => undefined);
        }}
      />
    </div>
  );
}
