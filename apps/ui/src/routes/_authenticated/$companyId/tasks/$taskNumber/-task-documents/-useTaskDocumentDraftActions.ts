import type { TaskDocument } from "@paperclipai/shared";
import { taskDocumentKeySchema } from "@paperclipai/shared";
import { useCallback, type FocusEvent, type KeyboardEvent } from "react";
import {
  isDocumentConflictError,
  isLockedDocumentError,
  isPlanKey,
  type DocumentSubjectConfig,
  type DraftState,
} from "./-TaskDocumentUtils";
import type { TaskDocumentEditorState } from "./-useTaskDocumentEffects";

export interface UseTaskDocumentDraftActionsOptions {
  documentSubject: DocumentSubjectConfig;
  sortedDocuments: TaskDocument[];
  upsertDocument: {
    isPending: boolean;
    mutateAsync: (draft: DraftState) => Promise<TaskDocument>;
  };
  editorState: TaskDocumentEditorState;
  syncDocumentCaches: (document: TaskDocument) => void;
  invalidateTaskDocuments: () => void;
}

/** Provides the create/edit/autosave/conflict actions for task documents. */
export function useTaskDocumentDraftActions({
  documentSubject,
  sortedDocuments,
  upsertDocument,
  editorState,
  syncDocumentCaches,
  invalidateTaskDocuments,
}: UseTaskDocumentDraftActionsOptions) {
  const {
    draft,
    setDraft,
    documentConflict,
    setDocumentConflict,
    setFoldedDocumentKeys,
    setAutosaveDocumentKey,
    setCopiedDocumentKey,
    setError,
    autosaveDebounceRef,
    copiedDocumentTimerRef,
    markDirty,
    reset,
    runSave,
  } = editorState;
  const resetAutosaveState = useCallback(() => {
    setAutosaveDocumentKey(null);
    reset();
  }, [reset, setAutosaveDocumentKey]);

  const markDocumentDirty = useCallback(
    (key: string) => {
      setAutosaveDocumentKey(key);
      markDirty();
    },
    [markDirty, setAutosaveDocumentKey],
  );

  const beginNewDocument = useCallback(() => {
    resetAutosaveState();
    setDocumentConflict(null);
    setDraft({
      key: "",
      title: "",
      body: "",
      baseRevisionId: null,
      isNew: true,
    });
    setError(null);
  }, [resetAutosaveState, setDocumentConflict, setDraft, setError]);

  const beginEdit = useCallback(
    (key: string) => {
      const doc = sortedDocuments.find((entry) => entry.key === key);
      if (!doc) return;
      const conflictedDraft = documentConflict?.key === key ? documentConflict.localDraft : null;
      setFoldedDocumentKeys((current) => current.filter((entry) => entry !== key));
      resetAutosaveState();
      setDocumentConflict((current) => (current?.key === key ? current : null));
      setDraft({
        key: conflictedDraft?.key ?? doc.key,
        title: conflictedDraft?.title ?? doc.title ?? "",
        body: conflictedDraft?.body ?? doc.body,
        baseRevisionId: conflictedDraft?.baseRevisionId ?? doc.latestRevisionId,
        isNew: false,
      });
      setError(null);
    },
    [
      documentConflict,
      resetAutosaveState,
      setDocumentConflict,
      setDraft,
      setError,
      setFoldedDocumentKeys,
      sortedDocuments,
    ],
  );

  const cancelDraft = useCallback(() => {
    if (autosaveDebounceRef.current) clearTimeout(autosaveDebounceRef.current);
    resetAutosaveState();
    setDocumentConflict(null);
    setDraft(null);
    setError(null);
  }, [autosaveDebounceRef, resetAutosaveState, setDocumentConflict, setDraft, setError]);

  const commitDraft = useCallback(
    async (
      currentDraft: DraftState | null,
      options?: {
        clearAfterSave?: boolean;
        trackAutosave?: boolean;
        overrideConflict?: boolean;
      },
    ) => {
      if (!currentDraft || upsertDocument.isPending) return false;
      const key = currentDraft.key;
      const normalizedBody = currentDraft.body.trim();
      const normalizedTitle = currentDraft.title.trim();
      const activeConflict = documentConflict?.key === key ? documentConflict : null;

      if (activeConflict && !options?.overrideConflict) {
        if (options?.trackAutosave) resetAutosaveState();
        return false;
      }
      if (!key || !normalizedBody) {
        if (currentDraft.isNew) setError("Document key and body are required");
        else if (!normalizedBody) setError("Document body cannot be empty");
        if (options?.trackAutosave) resetAutosaveState();
        return false;
      }
      if (!taskDocumentKeySchema.safeParse(key).success) {
        setError(
          "Document key must start with a letter or number and use only lowercase letters, numbers, -, or _.",
        );
        if (options?.trackAutosave) resetAutosaveState();
        return false;
      }

      const existing = sortedDocuments.find((doc) => doc.key === key);
      if (
        !currentDraft.isNew &&
        existing &&
        existing.body === currentDraft.body &&
        (existing.title ?? "") === currentDraft.title
      ) {
        if (options?.clearAfterSave) setDraft((value) => (value?.key === key ? null : value));
        if (options?.trackAutosave) resetAutosaveState();
        return true;
      }

      const save = async () => {
        const saved = await upsertDocument.mutateAsync({
          ...currentDraft,
          key,
          title: isPlanKey(key) ? "" : normalizedTitle,
          body: currentDraft.body,
          baseRevisionId: options?.overrideConflict
            ? (activeConflict?.serverDocument.latestRevisionId ?? currentDraft.baseRevisionId)
            : currentDraft.baseRevisionId,
        });
        setError(null);
        setDocumentConflict((current) => (current?.key === key ? null : current));
        setDraft((value) => {
          if (!value || value.key !== key) return value;
          if (options?.clearAfterSave) return null;
          return {
            key: saved.key,
            title: saved.title ?? "",
            body: saved.body,
            baseRevisionId: saved.latestRevisionId,
            isNew: false,
          };
        });
        syncDocumentCaches(saved);
        invalidateTaskDocuments();
      };

      try {
        if (options?.trackAutosave) {
          setAutosaveDocumentKey(key);
          await runSave(save);
        } else {
          await save();
        }
        return true;
      } catch (error) {
        if (isLockedDocumentError(error)) {
          setError("Document is locked. Unlock it before editing.");
          resetAutosaveState();
          invalidateTaskDocuments();
          return false;
        }
        if (isDocumentConflictError(error)) {
          try {
            const latestDocument = await documentSubject.getDocument(key);
            setDocumentConflict({
              key,
              serverDocument: latestDocument,
              localDraft: {
                key,
                title: isPlanKey(key) ? "" : normalizedTitle,
                body: currentDraft.body,
                baseRevisionId: currentDraft.baseRevisionId,
                isNew: false,
              },
              showRemote: true,
            });
            setFoldedDocumentKeys((current) => current.filter((entry) => entry !== key));
            setError(null);
            resetAutosaveState();
            return false;
          } catch {
            setError("Document changed remotely and the latest version could not be loaded");
            return false;
          }
        }
        setError(error instanceof Error ? error.message : "Failed to save document");
        return false;
      }
    },
    [
      documentConflict,
      documentSubject,
      invalidateTaskDocuments,
      resetAutosaveState,
      runSave,
      setAutosaveDocumentKey,
      setDocumentConflict,
      setDraft,
      setError,
      setFoldedDocumentKeys,
      sortedDocuments,
      syncDocumentCaches,
      upsertDocument,
    ],
  );

  const reloadDocumentFromServer = useCallback(
    (key: string) => {
      if (documentConflict?.key !== key) return;
      const serverDocument = documentConflict.serverDocument;
      setDraft({
        key: serverDocument.key,
        title: serverDocument.title ?? "",
        body: serverDocument.body,
        baseRevisionId: serverDocument.latestRevisionId,
        isNew: false,
      });
      setDocumentConflict(null);
      resetAutosaveState();
      setError(null);
    },
    [documentConflict, resetAutosaveState, setDocumentConflict, setDraft, setError],
  );

  const overwriteDocumentFromDraft = useCallback(
    async (key: string) => {
      if (documentConflict?.key !== key) return;
      const sourceDraft = draft && draft.key === key && !draft.isNew ? draft : documentConflict.localDraft;
      await commitDraft(
        {
          ...sourceDraft,
          baseRevisionId: documentConflict.serverDocument.latestRevisionId,
        },
        {
          clearAfterSave: false,
          trackAutosave: true,
          overrideConflict: true,
        },
      );
    },
    [commitDraft, documentConflict, draft],
  );

  const keepConflictedDraft = useCallback(
    (key: string) => {
      if (documentConflict?.key !== key) return;
      setDraft(documentConflict.localDraft);
      setDocumentConflict((current) => (current?.key === key ? { ...current, showRemote: false } : current));
      setError(null);
    },
    [documentConflict, setDocumentConflict, setDraft, setError],
  );

  const copyDocumentBody = useCallback(
    async (key: string, body: string) => {
      try {
        await navigator.clipboard.writeText(body);
        setCopiedDocumentKey(key);
        if (copiedDocumentTimerRef.current) clearTimeout(copiedDocumentTimerRef.current);
        copiedDocumentTimerRef.current = setTimeout(() => {
          setCopiedDocumentKey((current) => (current === key ? null : current));
        }, 1400);
      } catch {
        setError("Could not copy document");
      }
    },
    [copiedDocumentTimerRef, setCopiedDocumentKey, setError],
  );

  const handleDraftBlur = async (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (autosaveDebounceRef.current) clearTimeout(autosaveDebounceRef.current);
    await commitDraft(draft, { clearAfterSave: true, trackAutosave: true });
  };

  const handleDraftKeyDown = async (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDraft();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (autosaveDebounceRef.current) clearTimeout(autosaveDebounceRef.current);
      await commitDraft(draft, {
        clearAfterSave: false,
        trackAutosave: true,
      });
    }
  };

  return {
    resetAutosaveState,
    markDocumentDirty,
    beginNewDocument,
    beginEdit,
    cancelDraft,
    commitDraft,
    reloadDocumentFromServer,
    overwriteDocumentFromDraft,
    keepConflictedDraft,
    copyDocumentBody,
    handleDraftBlur,
    handleDraftKeyDown,
  };
}
