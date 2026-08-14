import type { TaskDocument } from "@paperclipai/shared";
import { isSystemTaskDocumentKey } from "@paperclipai/shared";
import { Check, Copy, Diff, Download, FilePenLine, Lock, MoreHorizontal, Trash2, Unlock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "../../lib/utils";
import { deriveDocumentRevisionState } from "../../lib/document-revisions";
import { DocumentFrameHeader } from "../DocumentFrameHeader";
import { DocumentAnnotationsCountChip } from "../TaskDocumentAnnotations";
import { downloadDocumentFile, getRevisionActor, isPlanKey, titlesMatchKey } from "../TaskDocumentUtils";

import { TaskDocumentBodyEditor, TaskDocumentRevisionNotices } from "./TaskDocumentBodyEditor";
import type { TaskDocumentsSectionController } from "./useTaskDocumentsController";

function createTaskDocumentCardModel(doc: TaskDocument, controller: TaskDocumentsSectionController) {
  const isLocked = Boolean(doc.lockedAt);
  const activeDraft =
    !isLocked && controller.draft?.key === doc.key && !controller.draft.isNew ? controller.draft : null;
  const activeConflict =
    !isLocked && controller.documentConflict?.key === doc.key ? controller.documentConflict : null;
  const isFolded = controller.foldedDocumentKeys.includes(doc.key);
  const revisionState = deriveDocumentRevisionState(doc, controller.getDocumentRevisions(doc.key));
  const revisionHistory = revisionState.revisions;
  const currentRevision = revisionState.currentRevision;
  const selectedRevisionId = controller.selectedRevisionIds[doc.key] ?? null;
  const selectedHistoricalRevision = selectedRevisionId
    ? (revisionHistory.find((revision) => revision.id === selectedRevisionId) ?? null)
    : null;
  const displayedTitle = selectedHistoricalRevision
    ? (selectedHistoricalRevision.title ?? "")
    : (activeDraft?.title ?? currentRevision.title ?? "");

  return {
    isLocked,
    activeDraft,
    activeConflict,
    isFolded,
    revisionHistory,
    currentRevision,
    selectedRevisionId,
    selectedHistoricalRevision,
    isHistoricalPreview: Boolean(selectedHistoricalRevision),
    displayedTitle,
    displayedBody: selectedHistoricalRevision?.body ?? activeDraft?.body ?? currentRevision.body,
    displayedRevisionNumber: selectedHistoricalRevision?.revisionNumber ?? currentRevision.revisionNumber,
    displayedUpdatedAt: selectedHistoricalRevision?.createdAt ?? currentRevision.createdAt,
    showTitle: !isPlanKey(doc.key) && !!displayedTitle.trim() && !titlesMatchKey(displayedTitle, doc.key),
    lockActionPending:
      controller.setDocumentLock.isPending && controller.setDocumentLock.variables?.key === doc.key,
    annotationTarget: controller.documentSubject.annotations?.target(doc.key) ?? null,
  };
}

export type TaskDocumentCardModel = ReturnType<typeof createTaskDocumentCardModel>;

interface TaskDocumentCardProps {
  controller: TaskDocumentsSectionController;
  doc: TaskDocument;
}

export interface TaskDocumentPresentationProps extends TaskDocumentCardProps {
  model: TaskDocumentCardModel;
}

export function TaskDocumentCard({ controller, doc }: TaskDocumentCardProps) {
  const model = createTaskDocumentCardModel(doc, controller);

  return (
    <Collapsible
      asChild
      id={`document-${doc.key}`}
      open={!model.isFolded}
      onOpenChange={(open) => {
        if (open === model.isFolded) controller.toggleFoldedDocument(doc.key);
      }}
    >
      <Card
        className={cn(
          "gap-0 p-3 transition-colors duration-1000",
          controller.highlightDocumentKey === doc.key && "border-primary/50 bg-primary/5",
        )}
      >
        <TaskDocumentCardHeader controller={controller} doc={doc} model={model} />
        <TaskDocumentCardContent controller={controller} doc={doc} model={model} />
        <TaskDocumentDeleteConfirmation controller={controller} documentKey={doc.key} />
      </Card>
    </Collapsible>
  );
}

function TaskDocumentCardContent({ controller, doc, model }: TaskDocumentPresentationProps) {
  return (
    <CollapsibleContent
      className="mt-3 space-y-3"
      onBlurCapture={
        !model.isHistoricalPreview
          ? async (event) => {
              if (model.activeDraft) await controller.handleDraftBlur(event);
            }
          : undefined
      }
      onKeyDown={
        !model.isHistoricalPreview
          ? async (event) => {
              if (model.activeDraft) await controller.handleDraftKeyDown(event);
            }
          : undefined
      }
    >
      <TaskDocumentRevisionNotices controller={controller} doc={doc} model={model} />
      <TaskDocumentBodyEditor controller={controller} doc={doc} model={model} />
    </CollapsibleContent>
  );
}

function TaskDocumentCardHeader({ controller, doc, model }: TaskDocumentPresentationProps) {
  const {
    canDeleteDocuments,
    canManageDocumentLocks,
    agentMap,
    userProfileMap,
    annotationPanelOpenKeys,
    copiedDocumentKey,
    revisionMenuOpenKey,
    setRevisionMenuOpenKey,
    setConfirmDeleteKey,
    setDiffViewKey,
    isFetchingDocumentRevisions,
    beginEdit,
    copyDocumentBody,
    previewRevision,
    toggleDocumentLock,
    toggleAnnotationPanel,
  } = controller;
  const {
    isLocked,
    isFolded,
    revisionHistory,
    currentRevision,
    selectedRevisionId,
    isHistoricalPreview,
    displayedTitle,
    displayedBody,
    displayedRevisionNumber,
    displayedUpdatedAt,
    showTitle,
    lockActionPending,
    annotationTarget,
  } = model;
  const lowTrust = doc.sourceTrust?.preset === "low_trust_review";
  const promoted = doc.sourceTrust?.disposition === "promoted";
  const trustLabel = promoted ? "Promoted from low-trust" : "Low-trust source";
  const trustDescription = promoted
    ? `Promoted from low-trust${doc.sourceTrust?.promotedAt ? ` on ${new Date(doc.sourceTrust.promotedAt).toLocaleString()}` : ""}.`
    : "Authored by a low-trust review agent. Raw document is not auto-shared with higher-trust agents.";

  return (
    <DocumentFrameHeader
      documentKey={doc.key}
      folded={isFolded}
      sourceTrustSlot={
        lowTrust ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <DomainStatus status={promoted ? "promoted" : "low_trust_review"} aria-label={trustLabel}>
                {trustLabel}
              </DomainStatus>
            </TooltipTrigger>
            <TooltipContent>{trustDescription}</TooltipContent>
          </Tooltip>
        ) : null
      }
      revisionMenu={{
        open: revisionMenuOpenKey === doc.key,
        onOpenChange: (open) => setRevisionMenuOpenKey(open ? doc.key : null),
        loading: revisionMenuOpenKey === doc.key && isFetchingDocumentRevisions,
        revisions: revisionHistory.map((revision) => ({
          id: revision.id,
          revisionNumber: revision.revisionNumber,
          createdAt: revision.createdAt,
          actor: getRevisionActor(revision, { agentMap, userProfileMap }),
        })),
        selectedRevisionId,
        currentRevisionId: currentRevision.id,
        displayedRevisionNumber,
        historicalPreview: isHistoricalPreview,
        onSelectRevision: (revisionId) => previewRevision(doc, revisionId),
      }}
      updatedAt={displayedUpdatedAt}
      annotationSlot={
        annotationTarget && !isSystemTaskDocumentKey(doc.key) ? (
          <DocumentAnnotationsCountChip
            target={annotationTarget}
            panelOpen={annotationPanelOpenKeys.includes(doc.key)}
            onToggle={() => toggleAnnotationPanel(doc.key)}
          />
        ) : null
      }
      titleSlot={showTitle ? <p className="mt-2 text-sm font-medium">{displayedTitle}</p> : null}
      actionsSlot={
        <>
          {canManageDocumentLocks ? (
            <Button
              variant={isLocked ? "secondary" : "ghost"}
              size="icon-xs"
              title={isLocked ? "Unlock document" : "Lock document"}
              aria-label={isLocked ? `Unlock ${doc.key} document` : `Lock ${doc.key} document`}
              onClick={() => toggleDocumentLock(doc, !isLocked)}
              disabled={lockActionPending}
            >
              {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
            </Button>
          ) : isLocked ? (
            <Button
              variant="secondary"
              size="icon-xs"
              disabled
              title="Locked document"
              aria-label="Locked document"
            >
              <Lock className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "text-muted-foreground transition-colors",
              copiedDocumentKey === doc.key && "text-foreground",
            )}
            title={copiedDocumentKey === doc.key ? "Copied" : "Copy document"}
            onClick={() => void copyDocumentBody(doc.key, displayedBody)}
          >
            {copiedDocumentKey === doc.key ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                title="Document actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!isHistoricalPreview && !isLocked ? (
                <DropdownMenuItem onClick={() => beginEdit(doc.key)}>
                  <FilePenLine className="h-3.5 w-3.5" />
                  Edit document
                </DropdownMenuItem>
              ) : null}
              {!isHistoricalPreview && !isLocked ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onClick={() => downloadDocumentFile(doc.key, displayedBody)}>
                <Download className="h-3.5 w-3.5" />
                Download document
              </DropdownMenuItem>
              {doc.latestRevisionNumber > 1 ? (
                <DropdownMenuItem onClick={() => setDiffViewKey(doc.key)}>
                  <Diff className="h-3.5 w-3.5" />
                  View diff
                </DropdownMenuItem>
              ) : null}
              {canDeleteDocuments && !isLocked ? <DropdownMenuSeparator /> : null}
              {canDeleteDocuments && !isLocked ? (
                <DropdownMenuItem variant="destructive" onClick={() => setConfirmDeleteKey(doc.key)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete document
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    />
  );
}

interface TaskDocumentDeleteConfirmationProps {
  controller: TaskDocumentsSectionController;
  documentKey: string;
}

function TaskDocumentDeleteConfirmation({ controller, documentKey }: TaskDocumentDeleteConfirmationProps) {
  const { confirmDeleteKey, setConfirmDeleteKey, deleteDocument } = controller;
  if (confirmDeleteKey !== documentKey) return null;

  return (
    <ConfirmActionDialog
      open
      onOpenChange={(open) => !open && setConfirmDeleteKey(null)}
      title="Delete document?"
      description="This document and its revision history will be permanently deleted."
      confirmLabel="Delete"
      pendingLabel="Deleting…"
      variant="destructive"
      pending={deleteDocument.isPending}
      onConfirm={() => deleteDocument.mutateAsync(documentKey).then(() => undefined)}
    />
  );
}
