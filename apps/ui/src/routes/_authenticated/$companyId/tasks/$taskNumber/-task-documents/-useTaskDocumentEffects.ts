import type { TaskDocument } from "@paperclipai/shared";
import { useEffect, useId, useRef, useState } from "react";
import { useAutosaveIndicator } from "@/hooks/useAutosaveIndicator";
import { parseDocumentAnnotationHash } from "@/lib/document-annotation-hash";
import {
  DOCUMENT_AUTOSAVE_DEBOUNCE_MS,
  loadFoldedDocumentKeys,
  saveFoldedDocumentKeys,
  type DocumentConflictState,
  type DocumentSubjectConfig,
  type DraftState,
} from "./-TaskDocumentUtils";
import type { useTaskDocumentDraftActions } from "./-useTaskDocumentDraftActions";

export type TaskDocumentEditorState = ReturnType<typeof useTaskDocumentEditorState>;
type DraftActions = ReturnType<typeof useTaskDocumentDraftActions>;

interface UseTaskDocumentEffectsOptions {
  documentSubject: DocumentSubjectConfig;
  sortedDocuments: TaskDocument[];
  locationHash: string;
  presentationActive: boolean;
  editorState: TaskDocumentEditorState;
  draftActions: DraftActions;
}

/** Coordinates persistence, deep-link highlighting, and autosave side effects. */
export function useTaskDocumentEffects({
  documentSubject,
  sortedDocuments,
  locationHash,
  presentationActive,
  editorState,
  draftActions,
}: UseTaskDocumentEffectsOptions) {
  const {
    draft,
    documentConflict,
    foldedDocumentKeys,
    autosaveState,
    autosaveDebounceRef,
    copiedDocumentTimerRef,
    hasScrolledToHashRef,
    setDocumentConflict,
    setFoldedDocumentKeys,
    setHighlightDocumentKey,
  } = editorState;
  const { resetAutosaveState, markDocumentDirty, commitDraft } = draftActions;

  useEffect(() => {
    setFoldedDocumentKeys(loadFoldedDocumentKeys(documentSubject.id));
  }, [documentSubject.id, setFoldedDocumentKeys]);

  useEffect(() => {
    hasScrolledToHashRef.current = false;
  }, [documentSubject.id, hasScrolledToHashRef, locationHash]);

  useEffect(() => {
    const validKeys = new Set(sortedDocuments.map((doc) => doc.key));
    setFoldedDocumentKeys((current) => current.filter((key) => validKeys.has(key)));
  }, [documentSubject.id, setFoldedDocumentKeys, sortedDocuments]);

  useEffect(() => {
    saveFoldedDocumentKeys(documentSubject.id, foldedDocumentKeys);
  }, [documentSubject.id, foldedDocumentKeys]);

  useEffect(() => {
    if (!documentConflict) return;
    const latest = sortedDocuments.find((doc) => doc.key === documentConflict.key);
    if (!latest || latest.latestRevisionId === documentConflict.serverDocument.latestRevisionId) return;
    setDocumentConflict((current) =>
      current?.key === latest.key ? { ...current, serverDocument: latest } : current,
    );
  }, [documentConflict, setDocumentConflict, sortedDocuments]);

  useEffect(() => {
    if (!presentationActive) return;
    const target = parseDocumentAnnotationHash(locationHash);
    if (!target) return;
    const documentKey = target.documentKey;
    const targetExists = sortedDocuments.some((doc) => doc.key === documentKey);
    if (!targetExists || hasScrolledToHashRef.current) return;
    setFoldedDocumentKeys((current) => current.filter((key) => key !== documentKey));
    const element = document.getElementById(`document-${documentKey}`);
    if (!element) return;
    hasScrolledToHashRef.current = true;
    setHighlightDocumentKey(documentKey);
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(
      () => setHighlightDocumentKey((current) => (current === documentKey ? null : current)),
      3000,
    );
    return () => clearTimeout(timer);
  }, [
    hasScrolledToHashRef,
    locationHash,
    presentationActive,
    setFoldedDocumentKeys,
    setHighlightDocumentKey,
    sortedDocuments,
  ]);

  useEffect(
    () => () => {
      if (autosaveDebounceRef.current) clearTimeout(autosaveDebounceRef.current);
      if (copiedDocumentTimerRef.current) clearTimeout(copiedDocumentTimerRef.current);
    },
    [autosaveDebounceRef, copiedDocumentTimerRef],
  );

  useEffect(() => {
    if (!draft || draft.isNew || documentConflict?.key === draft.key) return;
    const existing = sortedDocuments.find((doc) => doc.key === draft.key);
    if (!existing) return;
    const hasChanges = existing.body !== draft.body || (existing.title ?? "") !== draft.title;
    if (!hasChanges) {
      if (autosaveState !== "saved") resetAutosaveState();
      return;
    }
    markDocumentDirty(draft.key);
    if (autosaveDebounceRef.current) clearTimeout(autosaveDebounceRef.current);
    autosaveDebounceRef.current = setTimeout(() => {
      void commitDraft(draft, { clearAfterSave: false, trackAutosave: true });
    }, DOCUMENT_AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveDebounceRef.current) clearTimeout(autosaveDebounceRef.current);
    };
  }, [
    autosaveDebounceRef,
    autosaveState,
    commitDraft,
    documentConflict,
    draft,
    markDocumentDirty,
    resetAutosaveState,
    sortedDocuments,
  ]);
}

interface UseTaskDocumentEditorStateOptions {
  documentSubject: DocumentSubjectConfig;
}

/** Centralizes the local editor, revision, and annotation UI state. */
export function useTaskDocumentEditorState({ documentSubject }: UseTaskDocumentEditorStateOptions) {
  const newDocumentKeyInputId = useId();
  const newDocumentKeyErrorId = useId();
  const newDocumentTitleInputId = useId();
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [documentConflict, setDocumentConflict] = useState<DocumentConflictState | null>(null);
  const [foldedDocumentKeys, setFoldedDocumentKeys] = useState<string[]>(() =>
    loadFoldedDocumentKeys(documentSubject.id),
  );
  const [annotationPanelOpenKeys, setAnnotationPanelOpenKeys] = useState<string[]>([]);
  const [autosaveDocumentKey, setAutosaveDocumentKey] = useState<string | null>(null);
  const [copiedDocumentKey, setCopiedDocumentKey] = useState<string | null>(null);
  const [highlightDocumentKey, setHighlightDocumentKey] = useState<string | null>(null);
  const [revisionMenuOpenKey, setRevisionMenuOpenKey] = useState<string | null>(null);
  const [selectedRevisionIds, setSelectedRevisionIds] = useState<Record<string, string | null>>({});
  const [diffViewKey, setDiffViewKey] = useState<string | null>(null);
  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedDocumentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasScrolledToHashRef = useRef(false);
  const autosave = useAutosaveIndicator();

  return {
    newDocumentKeyInputId,
    newDocumentKeyErrorId,
    newDocumentTitleInputId,
    confirmDeleteKey,
    setConfirmDeleteKey,
    error,
    setError,
    draft,
    setDraft,
    documentConflict,
    setDocumentConflict,
    foldedDocumentKeys,
    setFoldedDocumentKeys,
    annotationPanelOpenKeys,
    setAnnotationPanelOpenKeys,
    autosaveDocumentKey,
    setAutosaveDocumentKey,
    copiedDocumentKey,
    setCopiedDocumentKey,
    highlightDocumentKey,
    setHighlightDocumentKey,
    revisionMenuOpenKey,
    setRevisionMenuOpenKey,
    selectedRevisionIds,
    setSelectedRevisionIds,
    diffViewKey,
    setDiffViewKey,
    autosaveDebounceRef,
    copiedDocumentTimerRef,
    hasScrolledToHashRef,
    autosaveState: autosave.state,
    markDirty: autosave.markDirty,
    reset: autosave.reset,
    runSave: autosave.runSave,
  };
}
