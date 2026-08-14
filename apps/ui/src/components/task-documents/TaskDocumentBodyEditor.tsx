import type { TaskDocument } from "@paperclipai/shared";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn, relativeTime } from "../../lib/utils";
import { MarkdownEditor } from "../MarkdownEditor";
import { TaskDocumentAnnotations } from "../TaskDocumentAnnotations";
import { isPlanKey, renderFoldableBody } from "../TaskDocumentUtils";

import type { TaskDocumentCardModel } from "./TaskDocumentCard";
import type { TaskDocumentsSectionController } from "./useTaskDocumentsController";

interface TaskDocumentBodyEditorProps {
  controller: TaskDocumentsSectionController;
  doc: TaskDocument;
  model: TaskDocumentCardModel;
}

export function TaskDocumentBodyEditor({ controller, doc, model }: TaskDocumentBodyEditorProps) {
  const {
    mentions,
    imageUploadHandler,
    agentMap,
    userProfileMap,
    defaultAnnotationFocusedThreadIds,
    locationHash,
    draft,
    setDraft,
    annotationPanelOpenKeys,
    autosaveDocumentKey,
    autosaveState,
    markDocumentDirty,
    commitDraft,
    setAnnotationPanelOpen,
  } = controller;
  const { activeDraft, activeConflict, annotationTarget, isHistoricalPreview, displayedBody } = model;

  let renderedDocumentBody: ReactNode;
  if (isHistoricalPreview) {
    renderedDocumentBody = renderFoldableBody(
      displayedBody,
      "paperclip-edit-in-place-content min-h-(--sz-220px) text-sm leading-7",
    );
  } else if (activeDraft) {
    renderedDocumentBody = (
      <MarkdownEditor
        value={displayedBody}
        onChange={(body) => {
          markDocumentDirty(doc.key);
          setDraft((current) =>
            current && current.key === doc.key && !current.isNew ? { ...current, body } : current,
          );
        }}
        placeholder="Markdown body"
        bordered={false}
        className="bg-transparent"
        contentClassName="paperclip-edit-in-place-content min-h-(--sz-220px) text-sm leading-7"
        mentions={mentions}
        imageUploadHandler={imageUploadHandler}
        onSubmit={() =>
          void commitDraft(activeDraft ?? draft, {
            clearAfterSave: false,
            trackAutosave: true,
          })
        }
      />
    );
  } else {
    renderedDocumentBody = renderFoldableBody(
      displayedBody,
      "paperclip-edit-in-place-content min-h-(--sz-220px) text-sm leading-7",
    );
  }

  return (
    <>
      {activeDraft && !isPlanKey(doc.key) && !isHistoricalPreview ? (
        <Input
          aria-label="Document title"
          value={activeDraft.title}
          onChange={(event) => {
            markDocumentDirty(doc.key);
            setDraft((current) => (current ? { ...current, title: event.target.value } : current));
          }}
          placeholder="Optional title"
        />
      ) : null}
      <div className={cn("mt-3", !activeDraft && !isHistoricalPreview && "rounded-md hover:bg-accent/10")}>
        {annotationTarget ? (
          <TaskDocumentAnnotations
            target={annotationTarget}
            doc={doc}
            bodyMarkdown={displayedBody}
            draftDirty={
              Boolean(activeDraft) &&
              ((activeDraft?.body ?? doc.body) !== doc.body ||
                (autosaveDocumentKey === doc.key && autosaveState === "saving"))
            }
            draftConflicted={Boolean(activeConflict)}
            historicalPreview={isHistoricalPreview}
            locationHash={locationHash}
            panelOpen={annotationPanelOpenKeys.includes(doc.key)}
            onPanelOpenChange={(next) => setAnnotationPanelOpen(doc.key, next)}
            agentMap={agentMap}
            userProfileMap={userProfileMap}
            defaultFocusedThreadId={defaultAnnotationFocusedThreadIds?.[doc.key]}
          >
            {renderedDocumentBody}
          </TaskDocumentAnnotations>
        ) : (
          renderedDocumentBody
        )}
      </div>
      <div className="flex min-h-4 items-center justify-end">
        <Badge
          variant={autosaveState === "error" ? "destructive" : "outline"}
          className={activeDraft || isHistoricalPreview ? undefined : "invisible"}
        >
          {isHistoricalPreview
            ? "Viewing historical revision"
            : activeDraft
              ? activeConflict
                ? "Out of date"
                : autosaveDocumentKey === doc.key
                  ? autosaveState === "saving"
                    ? "Autosaving..."
                    : autosaveState === "saved"
                      ? "Saved"
                      : autosaveState === "error"
                        ? "Could not save"
                        : ""
                  : ""
              : ""}
        </Badge>
      </div>
    </>
  );
}

interface NewTaskDocumentEditorProps {
  controller: TaskDocumentsSectionController;
}

export function NewTaskDocumentEditor({ controller }: NewTaskDocumentEditorProps) {
  const {
    draft,
    setDraft,
    newDocumentKeyInputId,
    newDocumentKeyErrorId,
    newDocumentTitleInputId,
    newDocumentKeyError,
    mentions,
    imageUploadHandler,
    upsertDocument,
    cancelDraft,
    commitDraft,
    handleDraftBlur,
    handleDraftKeyDown,
  } = controller;

  if (!draft?.isNew) return null;

  const createDocument = () =>
    commitDraft(draft, {
      clearAfterSave: false,
      trackAutosave: false,
    });

  return (
    <Card
      className="space-y-3 rounded-lg border border-border bg-accent/10 p-3"
      onBlurCapture={handleDraftBlur}
      onKeyDown={handleDraftKeyDown}
    >
      <Field data-invalid={Boolean(newDocumentKeyError)}>
        <FieldLabel className="sr-only" htmlFor={newDocumentKeyInputId}>
          Document key
        </FieldLabel>
        <Input
          id={newDocumentKeyInputId}
          autoFocus
          value={draft.key}
          onChange={(event) =>
            setDraft((current) => (current ? { ...current, key: event.target.value } : current))
          }
          placeholder="Document key"
          aria-invalid={newDocumentKeyError ? true : undefined}
          aria-describedby={newDocumentKeyError ? newDocumentKeyErrorId : undefined}
        />
        {newDocumentKeyError ? (
          <FieldError id={newDocumentKeyErrorId}>{newDocumentKeyError}</FieldError>
        ) : null}
      </Field>
      {!isPlanKey(draft.key) ? (
        <Field>
          <FieldLabel className="sr-only" htmlFor={newDocumentTitleInputId}>
            Document title
          </FieldLabel>
          <Input
            id={newDocumentTitleInputId}
            value={draft.title}
            onChange={(event) =>
              setDraft((current) => (current ? { ...current, title: event.target.value } : current))
            }
            placeholder="Optional title"
          />
        </Field>
      ) : null}
      <MarkdownEditor
        value={draft.body}
        onChange={(body) => setDraft((current) => (current ? { ...current, body } : current))}
        placeholder="Markdown body"
        bordered={false}
        className="bg-transparent"
        contentClassName="min-h-(--sz-220px) text-sm leading-7"
        mentions={mentions}
        imageUploadHandler={imageUploadHandler}
        onSubmit={() => void createDocument()}
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={cancelDraft}>
          <X data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
          Cancel
        </Button>
        <Button size="sm" onClick={() => void createDocument()} disabled={upsertDocument.isPending}>
          {upsertDocument.isPending ? "Saving..." : "Create document"}
        </Button>
      </div>
    </Card>
  );
}

interface TaskDocumentRevisionNoticesProps {
  controller: TaskDocumentsSectionController;
  doc: TaskDocument;
  model: TaskDocumentCardModel;
}

export function TaskDocumentRevisionNotices({ controller, doc, model }: TaskDocumentRevisionNoticesProps) {
  const {
    setDocumentConflict,
    restoreDocumentRevision,
    upsertDocument,
    returnToLatestRevision,
    keepConflictedDraft,
    reloadDocumentFromServer,
    overwriteDocumentFromDraft,
  } = controller;
  const { isLocked, activeConflict, isHistoricalPreview, selectedHistoricalRevision } = model;

  return (
    <>
      {isHistoricalPreview && selectedHistoricalRevision ? (
        <Alert>
          <AlertTitle>Viewing revision {selectedHistoricalRevision.revisionNumber}</AlertTitle>
          <AlertDescription>
            <p>
              This is a historical preview. Restoring it creates a new latest revision and keeps history
              append-only.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => returnToLatestRevision(doc.key)}>
                Return to latest
              </Button>
              {!isLocked ? (
                <Button
                  size="sm"
                  onClick={() =>
                    restoreDocumentRevision.mutate({
                      key: doc.key,
                      revisionId: selectedHistoricalRevision.id,
                    })
                  }
                  disabled={restoreDocumentRevision.isPending}
                >
                  {restoreDocumentRevision.isPending && restoreDocumentRevision.variables?.key === doc.key
                    ? "Restoring..."
                    : "Restore this revision"}
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {activeConflict && !isHistoricalPreview ? (
        <Alert>
          <AlertTitle>Out of date</AlertTitle>
          <AlertDescription>
            <p>
              This document changed while you were editing. Your local draft is preserved and autosave is
              paused.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setDocumentConflict((current) =>
                    current?.key === doc.key ? { ...current, showRemote: !current.showRemote } : current,
                  )
                }
              >
                {activeConflict.showRemote ? "Hide remote" : "Review remote"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => keepConflictedDraft(doc.key)}>
                Keep my draft
              </Button>
              <Button variant="outline" size="sm" onClick={() => reloadDocumentFromServer(doc.key)}>
                Reload remote
              </Button>
              <Button
                size="sm"
                onClick={() => void overwriteDocumentFromDraft(doc.key)}
                disabled={upsertDocument.isPending}
              >
                {upsertDocument.isPending ? "Saving..." : "Overwrite remote"}
              </Button>
            </div>
            {activeConflict.showRemote ? (
              <Card className="mt-3 gap-2 bg-background/60 p-3">
                <div className="mb-2 flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
                  <span>Remote revision {activeConflict.serverDocument.latestRevisionNumber}</span>
                  <span>•</span>
                  <span>updated {relativeTime(activeConflict.serverDocument.updatedAt)}</span>
                </div>
                {!isPlanKey(doc.key) && activeConflict.serverDocument.title ? (
                  <p className="mb-2 text-sm font-medium">{activeConflict.serverDocument.title}</p>
                ) : null}
                {renderFoldableBody(activeConflict.serverDocument.body, "text-sm leading-7")}
              </Card>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
