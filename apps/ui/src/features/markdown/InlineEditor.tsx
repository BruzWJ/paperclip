import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { useAutosaveIndicator } from "@/hooks/useAutosaveIndicator";
import { FoldCurtain } from "../../components/patterns/FoldCurtain";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { autoResizeTextarea } from "@/lib/textarea";

interface InlineEditorProps {
  value: string;
  onSave: (value: string) => void | Promise<unknown>;
  as?: "h1" | "h2" | "p" | "span";
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  imageUploadHandler?: (file: File) => Promise<string>;
  /** Called when a non-image file is dropped onto the editor. */
  onDropFile?: (file: File) => Promise<void>;
  mentions?: MentionOption[];
  nullable?: boolean;
  /** When true, long display-mode markdown is clipped with a fade curtain that expands on click. */
  foldable?: boolean;
}

/** Shared padding so display and edit modes occupy the exact same box. */
const pad = "px-1 -mx-1";
const markdownPad = "px-1";
const AUTOSAVE_DEBOUNCE_MS = 900;

export function queueContainedBlurCommit(container: HTMLDivElement, onCommit: () => void) {
  let frameId = requestAnimationFrame(() => {
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      const active = document.activeElement;
      if (active instanceof Node && container.contains(active)) return;
      onCommit();
    });
  });

  return () => {
    if (frameId === 0) return;
    cancelAnimationFrame(frameId);
    frameId = 0;
  };
}

export function InlineEditor({
  value,
  onSave,
  as: Tag = "span",
  className,
  placeholder = "Click to edit...",
  multiline = false,
  nullable = false,
  imageUploadHandler,
  onDropFile,
  mentions,
  foldable = false,
}: InlineEditorProps) {
  const [editing, setEditing] = useState(false);
  const [multilineEditing, setMultilineEditing] = useState(false);
  const [multilineFocused, setMultilineFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const lastPropValueRef = useRef(value);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const markdownRef = useRef<MarkdownEditorRef>(null);
  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurCommitFrameRef = useRef<(() => void) | null>(null);
  const pendingFocusFrameRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const justEnteredEditRef = useRef(false);
  const hasBeenFocusedRef = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const { state: autosaveState, markDirty, reset, runSave } = useAutosaveIndicator();

  useEffect(() => {
    const previousValue = lastPropValueRef.current;
    lastPropValueRef.current = value;
    setDraft((currentDraft) => {
      if (multiline && multilineFocused && currentDraft !== previousValue) {
        return currentDraft;
      }
      return value;
    });
  }, [value, multiline, multilineFocused]);

  useEffect(() => {
    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      if (blurCommitFrameRef.current !== null) {
        blurCommitFrameRef.current();
        blurCommitFrameRef.current = null;
      }
      if (pendingFocusFrameRef.current !== null) {
        cancelAnimationFrame(pendingFocusFrameRef.current);
        pendingFocusFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      if (inputRef.current instanceof HTMLTextAreaElement) {
        autoResizeTextarea(inputRef.current);
      }
    }
  }, [editing]);

  useEffect(() => {
    if (!multilineEditing || !multiline) return;
    if (!justEnteredEditRef.current) return;
    justEnteredEditRef.current = false;
    if (pendingFocusFrameRef.current !== null) {
      cancelAnimationFrame(pendingFocusFrameRef.current);
    }
    pendingFocusFrameRef.current = requestAnimationFrame(() => {
      pendingFocusFrameRef.current = null;
      markdownRef.current?.focus();
    });
    return () => {
      if (pendingFocusFrameRef.current !== null) {
        cancelAnimationFrame(pendingFocusFrameRef.current);
        pendingFocusFrameRef.current = null;
      }
    };
  }, [multilineEditing, multiline]);

  // Once the editor has been focused at least once, it's blurred, and any
  // autosave has settled, swap back to the MarkdownBody preview so inline
  // task refs render with status + quicklook.
  useEffect(() => {
    if (multilineFocused) {
      hasBeenFocusedRef.current = true;
      return;
    }
    if (!multiline || !multilineEditing) return;
    if (!hasBeenFocusedRef.current) return;
    if (autosaveState !== "idle") return;
    hasBeenFocusedRef.current = false;
    setMultilineEditing(false);
  }, [multiline, multilineEditing, multilineFocused, autosaveState]);

  const commit = useCallback(
    async (nextValue = draft) => {
      const valueToSave = nextValue.trim();
      const valueChanged = valueToSave !== value;
      const shouldSave = nullable ? valueChanged : Boolean(valueToSave && valueChanged);
      if (shouldSave) {
        await Promise.resolve(onSave(valueToSave));
      } else {
        setDraft(value);
      }
      if (!multiline) {
        setEditing(false);
      }
    },
    [draft, multiline, nullable, onSave, value],
  );

  const savePendingWork = useCallback(
    async (save: () => Promise<void>) => {
      if (saveInFlightRef.current) return;
      saveInFlightRef.current = true;
      setIsPending(true);
      try {
        await runSave(save);
      } finally {
        saveInFlightRef.current = false;
        setIsPending(false);
      }
    },
    [runSave],
  );

  /** Multiline blur/submit: show autosave indicator when persisting */
  const finalizeMultilineBlurOrSubmit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed === value) {
      reset();
      void commit();
      return;
    }
    if (!trimmed && !nullable) {
      reset();
      void commit();
      return;
    }
    void savePendingWork(() => commit());
  }, [commit, draft, nullable, reset, savePendingWork, value]);

  const cancelPendingBlurCommit = useCallback(() => {
    if (blurCommitFrameRef.current === null) return;
    blurCommitFrameRef.current();
    blurCommitFrameRef.current = null;
  }, []);

  const scheduleBlurCommit = useCallback(
    (container: HTMLDivElement) => {
      cancelPendingBlurCommit();
      blurCommitFrameRef.current = queueContainedBlurCommit(container, () => {
        blurCommitFrameRef.current = null;
        if (autosaveDebounceRef.current) {
          clearTimeout(autosaveDebounceRef.current);
        }
        setMultilineFocused(false);
        finalizeMultilineBlurOrSubmit();
      });
    },
    [cancelPendingBlurCommit, finalizeMultilineBlurOrSubmit],
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      void commit();
    }
    if (e.key === "Escape") {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      reset();
      setDraft(value);
      if (multiline) {
        setMultilineFocused(false);
        setMultilineEditing(false);
        hasBeenFocusedRef.current = false;
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      } else {
        setEditing(false);
      }
    }
  }

  useEffect(() => {
    if (!multiline) return;
    if (!multilineFocused) return;
    const trimmed = draft.trim();
    // Nullable: empty draft can still be a real edit (clearing); only skip debounce when unchanged or empty is invalid.
    if (trimmed === value || (!trimmed && !nullable)) {
      if (autosaveState !== "saved") {
        reset();
      }
      return;
    }
    markDirty();
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    autosaveDebounceRef.current = setTimeout(() => {
      void savePendingWork(() => commit(trimmed));
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
    };
  }, [
    autosaveState,
    commit,
    draft,
    markDirty,
    multiline,
    multilineFocused,
    nullable,
    reset,
    savePendingWork,
    value,
  ]);

  if (multiline) {
    const previewValue = autosaveState === "saved" || autosaveState === "idle" ? draft : value;
    const hasValue = Boolean(previewValue.trim());
    const showEditor = multilineEditing || multilineFocused || !hasValue;

    if (!showEditor) {
      const enterEditMode = () => {
        if (multilineEditing) return;
        justEnteredEditRef.current = true;
        setMultilineEditing(true);
      };
      return (
        <div
          className={cn(markdownPad, "relative rounded transition-colors hover:bg-accent/20")}
          onDragEnter={() => enterEditMode()}
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="absolute right-1 top-1 z-10 text-xs text-muted-foreground"
            onClick={enterEditMode}
          >
            Edit
          </Button>
          <div className="pr-12">
            {foldable ? (
              <FoldCurtain>
                <MarkdownBody className={cn("paperclip-edit-in-place-content", className)}>
                  {previewValue}
                </MarkdownBody>
              </FoldCurtain>
            ) : (
              <MarkdownBody className={cn("paperclip-edit-in-place-content", className)}>
                {previewValue}
              </MarkdownBody>
            )}
          </div>
        </div>
      );
    }

    return (
      <div
        className={cn(
          markdownPad,
          "rounded transition-colors",
          multilineFocused ? "bg-transparent" : "hover:bg-accent/20",
        )}
        onFocusCapture={(event) => {
          // Ignore focus events where the active element isn't actually inside
          // the wrapper (React 19 can emit a synthetic focus after a blur).
          const active = document.activeElement;
          if (!(active instanceof Node) || !event.currentTarget.contains(active)) return;
          cancelPendingBlurCommit();
          setMultilineFocused(true);
        }}
        onBlurCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          if (pendingFocusFrameRef.current !== null) {
            cancelAnimationFrame(pendingFocusFrameRef.current);
            pendingFocusFrameRef.current = null;
          }
          scheduleBlurCommit(event.currentTarget);
        }}
        onKeyDown={handleKeyDown}
      >
        <FieldSet aria-busy={isPending} className="contents" disabled={isPending}>
          <FieldLegend className="sr-only">Inline markdown editor</FieldLegend>
          <MarkdownEditor
            ref={markdownRef}
            value={draft}
            onChange={setDraft}
            placeholder={placeholder}
            bordered={false}
            className="bg-transparent"
            contentClassName={cn("paperclip-edit-in-place-content", className)}
            imageUploadHandler={imageUploadHandler}
            onDropFile={onDropFile}
            mentions={mentions}
            readOnly={isPending}
            onSubmit={() => {
              finalizeMultilineBlurOrSubmit();
            }}
          />
          <div className="flex min-h-4 items-center justify-end pr-1">
            <span
              aria-atomic="true"
              aria-live="polite"
              className={cn(
                "text-(length:--text-micro) transition-opacity duration-150",
                autosaveState === "error" ? "text-destructive" : "text-muted-foreground",
                autosaveState === "idle" ? "opacity-0" : "opacity-100",
              )}
            >
              {autosaveState === "saving"
                ? "Autosaving..."
                : autosaveState === "saved"
                  ? "Saved"
                  : autosaveState === "error"
                    ? "Could not save"
                    : "Idle"}
            </span>
          </div>
        </FieldSet>
      </div>
    );
  }

  if (editing) {
    return (
      <Textarea
        ref={inputRef}
        aria-label={placeholder}
        value={draft}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value);
          autoResizeTextarea(e.target);
        }}
        onBlur={() => {
          void commit();
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full rounded bg-transparent outline-none resize-none overflow-hidden focus-visible:ring-2 focus-visible:ring-ring",
          pad,
          className,
        )}
      />
    );
  }

  const DisplayTag = Tag;

  return (
    <DisplayTag className={cn("overflow-hidden", !value && "text-muted-foreground italic", className)}>
      <Button
        type="button"
        variant="ghost"
        className={cn("h-auto whitespace-normal py-0 text-left font-inherit text-inherit", pad)}
        onClick={() => setEditing(true)}
      >
        {value || placeholder}
      </Button>
    </DisplayTag>
  );
}
