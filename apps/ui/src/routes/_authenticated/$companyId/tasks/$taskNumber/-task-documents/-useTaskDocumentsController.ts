import type { DocumentRevision, TaskDocument } from "@paperclipai/shared";
import { isSystemTaskDocumentKey, taskDocumentKeySchema } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { deriveDocumentRevisionState } from "@/lib/document-revisions";

import {
  documentHasUnsavedChanges,
  isPlanKey,
  makeTaskDocumentSubject,
  type DraftState,
  type TaskDocumentsSectionProps,
} from "./-TaskDocumentUtils";
import { useTaskDocumentDraftActions } from "./-useTaskDocumentDraftActions";
import { useTaskDocumentEditorState, useTaskDocumentEffects } from "./-useTaskDocumentEffects";

export function useTaskDocumentsSectionController({
  task,
  subject,
  canDeleteDocuments,
  canManageDocumentLocks = false,
  mentions,
  imageUploadHandler,
  extraActions,
  agentMap,
  userProfileMap,
  defaultAnnotationPanelOpenKeys,
  defaultAnnotationFocusedThreadIds,
  forceEditDocumentKey,
}: TaskDocumentsSectionProps) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const queryClient = useQueryClient();

  const location = useLocation();

  const locationHash = location.hash ? `#${location.hash}` : "";

  const documentSubject = useMemo(() => {
    if (subject) return subject;
    if (!task) throw new Error("TaskDocumentsSection requires either task or subject");
    return makeTaskDocumentSubject(task);
  }, [task, subject]);

  const editorState = useTaskDocumentEditorState({
    documentSubject,
    defaultAnnotationPanelOpenKeys,
  });
  const {
    setConfirmDeleteKey,
    setError,
    draft,
    setDraft,
    documentConflict,
    setDocumentConflict,
    setFoldedDocumentKeys,
    setAnnotationPanelOpenKeys,
    revisionMenuOpenKey,
    setSelectedRevisionIds,
  } = editorState;

  const { data: documents } = useQuery({
    queryKey: documentSubject.documentsQueryKey,
    queryFn: documentSubject.listDocuments,
  });

  const { data: activeDocumentRevisions, isFetching: isFetchingDocumentRevisions } = useQuery({
    queryKey: revisionMenuOpenKey
      ? documentSubject.documentRevisionsQueryKey(revisionMenuOpenKey)
      : documentSubject.idleDocumentRevisionsQueryKey,
    queryFn: async () => {
      if (!revisionMenuOpenKey) return [];
      return documentSubject.listDocumentRevisions(revisionMenuOpenKey);
    },
    enabled: Boolean(revisionMenuOpenKey),
  });

  const invalidateTaskDocuments = useCallback(() => {
    if (documentSubject.detailQueryKey) {
      queryClient.invalidateQueries({
        queryKey: documentSubject.detailQueryKey,
      });
    }
    queryClient.invalidateQueries({
      queryKey: documentSubject.documentsQueryKey,
    });
    queryClient.invalidateQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey.includes(documentSubject.id) &&
        (query.queryKey.includes("document-revisions") ||
          query.queryKey.includes("document-annotations") ||
          query.queryKey.includes("revisions")),
    });
  }, [documentSubject, queryClient]);

  const syncDocumentCaches = useCallback(
    (document: TaskDocument) => {
      if (documentSubject.hideSystemDocuments && isSystemTaskDocumentKey(document.key)) return;
      queryClient.setQueryData<TaskDocument[] | undefined>(documentSubject.documentsQueryKey, (current) => {
        if (!current) return [document];
        const existingIndex = current.findIndex((entry) => entry.key === document.key);
        if (existingIndex === -1) return [...current, document];
        return current.map((entry, index) => (index === existingIndex ? document : entry));
      });
      documentSubject.syncDetailCache?.(queryClient, document);
    },
    [documentSubject, queryClient],
  );

  const upsertDocument = useMutation({
    mutationFn: async (nextDraft: DraftState) =>
      documentSubject.upsertDocument(nextDraft.key, {
        title: isPlanKey(nextDraft.key) ? null : nextDraft.title.trim() || null,
        format: "markdown",
        body: nextDraft.body,
        baseRevisionId: nextDraft.baseRevisionId,
      }),
  });

  const deleteDocument = useMutation({
    mutationFn: (key: string) =>
      documentSubject.deleteDocument
        ? documentSubject.deleteDocument(key)
        : Promise.reject(new Error("Document deletion is not available")),
    onSuccess: () => {
      setError(null);
      setConfirmDeleteKey(null);
      invalidateTaskDocuments();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to delete document");
    },
  });

  const restoreDocumentRevision = useMutation({
    mutationFn: ({ key, revisionId }: { key: string; revisionId: string }) =>
      documentSubject.restoreDocumentRevision
        ? documentSubject.restoreDocumentRevision(key, revisionId)
        : Promise.reject(new Error("Document revision restore is not available")),
    onSuccess: (document, variables) => {
      syncDocumentCaches(document);
      setSelectedRevisionIds((current) => ({
        ...current,
        [variables.key]: null,
      }));
      setDraft((current) => (current?.key === variables.key ? null : current));
      setDocumentConflict((current) => (current?.key === variables.key ? null : current));
      resetAutosaveState();
      setError(null);
      invalidateTaskDocuments();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to restore document revision");
    },
  });

  const setDocumentLock = useMutation({
    mutationFn: ({ key, locked }: { key: string; locked: boolean }) =>
      documentSubject.setDocumentLock
        ? documentSubject.setDocumentLock(key, locked)
        : Promise.reject(new Error("Document locking is not available")),
    onSuccess: (document) => {
      syncDocumentCaches(document);
      setDraft((current) => (current?.key === document.key ? null : current));
      setDocumentConflict((current) => (current?.key === document.key ? null : current));
      resetAutosaveState();
      setError(null);
      invalidateTaskDocuments();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to update document lock");
    },
  });

  const sortedDocuments = useMemo(() => {
    return (documents ?? [])
      .filter((doc) => !documentSubject.hideSystemDocuments || !isSystemTaskDocumentKey(doc.key))
      .sort((a, b) => {
        if (a.key === "plan" && b.key !== "plan") return -1;
        if (a.key !== "plan" && b.key === "plan") return 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [documentSubject.hideSystemDocuments, documents]);

  const isEmpty = sortedDocuments.length === 0;

  const newDocumentKeyError =
    draft?.isNew && draft.key.length > 0 && !taskDocumentKeySchema.safeParse(draft.key).success
      ? "Use lowercase letters, numbers, -, or _, and start with a letter or number."
      : null;

  const draftActions = useTaskDocumentDraftActions({
    documentSubject,
    sortedDocuments,
    upsertDocument,
    editorState,
    syncDocumentCaches,
    invalidateTaskDocuments,
  });
  const { resetAutosaveState } = draftActions;

  const getDocumentRevisions = useCallback(
    (key: string) => {
      const cached = queryClient.getQueryData<DocumentRevision[]>(
        documentSubject.documentRevisionsQueryKey(key),
      );
      if (cached) return cached;
      if (revisionMenuOpenKey === key) return activeDocumentRevisions ?? [];
      return [];
    },
    [activeDocumentRevisions, documentSubject, queryClient, revisionMenuOpenKey],
  );

  const returnToLatestRevision = useCallback((key: string) => {
    setSelectedRevisionIds((current) => ({ ...current, [key]: null }));
    setError(null);
  }, []);

  const previewRevision = useCallback(
    (doc: TaskDocument, revisionId: string) => {
      const revisionState = deriveDocumentRevisionState(doc, getDocumentRevisions(doc.key));
      const selectedRevision = revisionState.revisions.find((revision) => revision.id === revisionId);
      if (!selectedRevision) return;
      if (selectedRevision.id === revisionState.currentRevision.id) {
        returnToLatestRevision(doc.key);
        return;
      }
      if (documentConflict?.key === doc.key || documentHasUnsavedChanges(doc, draft)) {
        setError("Save or cancel your local changes before viewing an older revision.");
        return;
      }
      resetAutosaveState();
      setDraft((current) => (current?.key === doc.key ? null : current));
      setDocumentConflict((current) => (current?.key === doc.key ? null : current));
      setFoldedDocumentKeys((current) => current.filter((entry) => entry !== doc.key));
      setSelectedRevisionIds((current) => ({
        ...current,
        [doc.key]: selectedRevision.id,
      }));
      setError(null);
    },
    [documentConflict, draft, getDocumentRevisions, resetAutosaveState, returnToLatestRevision],
  );

  const toggleDocumentLock = useCallback(
    (doc: TaskDocument, locked: boolean) => {
      if (!canManageDocumentLocks || setDocumentLock.isPending) return;
      if (locked && (documentConflict?.key === doc.key || documentHasUnsavedChanges(doc, draft))) {
        setError("Save or cancel local changes before changing the document lock.");
        return;
      }
      setDocumentLock.mutate({ key: doc.key, locked });
    },
    [canManageDocumentLocks, documentConflict, draft, setDocumentLock],
  );

  useTaskDocumentEffects({
    documentSubject,
    documents,
    sortedDocuments,
    locationHash,
    forceEditDocumentKey: forceEditDocumentKey ?? undefined,
    editorState,
    draftActions,
  });

  const toggleFoldedDocument = (key: string) => {
    setFoldedDocumentKeys((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  };

  const setAnnotationPanelOpen = useCallback((key: string, nextOpen: boolean) => {
    setAnnotationPanelOpenKeys((current) => {
      const isOpen = current.includes(key);
      if (nextOpen && !isOpen) return [...current, key];
      if (!nextOpen && isOpen) return current.filter((entry) => entry !== key);
      return current;
    });
    if (nextOpen) {
      setFoldedDocumentKeys((current) => current.filter((entry) => entry !== key));
    }
  }, []);

  const toggleAnnotationPanel = useCallback((key: string) => {
    setAnnotationPanelOpenKeys((current) => {
      if (current.includes(key)) return current.filter((entry) => entry !== key);
      setFoldedDocumentKeys((folded) => folded.filter((entry) => entry !== key));
      return [...current, key];
    });
  }, []);

  return {
    canDeleteDocuments,
    canManageDocumentLocks,
    mentions,
    imageUploadHandler,
    extraActions,
    agentMap,
    userProfileMap,
    defaultAnnotationFocusedThreadIds,
    locationHash,
    documentSubject,
    ...editorState,
    isFetchingDocumentRevisions,
    upsertDocument,
    deleteDocument,
    restoreDocumentRevision,
    setDocumentLock,
    sortedDocuments,
    isEmpty,
    newDocumentKeyError,
    ...draftActions,
    getDocumentRevisions,
    returnToLatestRevision,
    previewRevision,
    toggleDocumentLock,
    toggleFoldedDocument,
    setAnnotationPanelOpen,
    toggleAnnotationPanel,
  };
}

export type TaskDocumentsSectionController = ReturnType<typeof useTaskDocumentsSectionController>;
