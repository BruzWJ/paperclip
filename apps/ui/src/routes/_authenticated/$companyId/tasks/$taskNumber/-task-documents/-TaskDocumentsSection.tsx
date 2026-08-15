import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DocumentDiffModal } from "./-DocumentDiffModal";
import { NewTaskDocumentEditor } from "./-TaskDocumentBodyEditor";
import { TaskDocumentCard } from "./-TaskDocumentCard";
import type { TaskDocumentsSectionController } from "./-useTaskDocumentsController";

export function TaskDocumentsSectionView(controller: TaskDocumentsSectionController) {
  return (
    <div className="space-y-3">
      <TaskDocumentsSectionHeader
        empty={controller.isEmpty}
        creatingDocument={Boolean(controller.draft?.isNew)}
        onCreateDocument={controller.beginNewDocument}
      />
      {controller.error ? <p className="text-xs text-destructive">{controller.error}</p> : null}
      <NewTaskDocumentEditor controller={controller} />
      <TaskDocumentList controller={controller} />
      <TaskDocumentDiffView controller={controller} />
    </div>
  );
}

interface TaskDocumentListProps {
  controller: TaskDocumentsSectionController;
}

function TaskDocumentList({ controller }: TaskDocumentListProps) {
  return (
    <div className="space-y-3">
      {controller.sortedDocuments.map((doc) => (
        <TaskDocumentCard key={doc.id} controller={controller} doc={doc} />
      ))}
    </div>
  );
}

interface TaskDocumentDiffViewProps {
  controller: TaskDocumentsSectionController;
}

function TaskDocumentDiffView({ controller }: TaskDocumentDiffViewProps) {
  const { diffViewKey, setDiffViewKey, sortedDocuments, documentSubject } = controller;
  if (!diffViewKey) return null;

  const diffDoc = sortedDocuments.find((doc) => doc.key === diffViewKey);
  if (!diffDoc) return null;

  return (
    <DocumentDiffModal
      documentKey={diffDoc.key}
      latestRevisionNumber={diffDoc.latestRevisionNumber}
      revisionsQueryKey={documentSubject.documentRevisionsQueryKey(diffDoc.key)}
      revisionsQueryFn={() => documentSubject.listDocumentRevisions(diffDoc.key)}
      open
      onOpenChange={(open) => {
        if (!open) setDiffViewKey(null);
      }}
    />
  );
}

interface TaskDocumentsSectionHeaderProps {
  empty: boolean;
  creatingDocument: boolean;
  onCreateDocument: () => void;
}

function TaskDocumentsSectionHeader({
  empty,
  creatingDocument,
  onCreateDocument,
}: TaskDocumentsSectionHeaderProps) {
  const createButton = (
    <Button variant="outline" size="sm" onClick={onCreateDocument} className="shrink-0">
      <Plus data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
      <span className="hidden sm:inline">New document</span>
      <span className="sm:hidden">New</span>
    </Button>
  );

  if (empty && !creatingDocument) {
    return <div className="flex min-w-0 justify-end">{createButton}</div>;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <h3 className="w-full shrink-0 text-sm font-medium text-muted-foreground sm:w-auto">Documents</h3>
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto">{createButton}</div>
    </div>
  );
}
