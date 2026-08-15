import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { cn } from "@/lib/utils";
import type { DocumentAnnotationAnchorState, DocumentAnnotationThreadStatus } from "@paperclipai/shared";
import { AlertTriangle, MessageSquarePlus } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { PENDING_HIGHLIGHT_THREAD_ID } from "./document-annotation-layer-utils";

export interface DocumentAnnotationHighlightRect {
  threadId: string;
  status: DocumentAnnotationThreadStatus;
  anchorState: DocumentAnnotationAnchorState;
  top: number;
  left: number;
  width: number;
  height: number;
  isTail: boolean;
  focused: boolean;
}

export interface DocumentAnnotationToolbarPosition {
  top: number;
  left: number;
}

interface DocumentAnnotationHighlightsProps {
  nativeHighlightsSupported: boolean;
  rects: DocumentAnnotationHighlightRect[];
  hoveredThreadId: string | null;
  setHoveredThreadId: Dispatch<SetStateAction<string | null>>;
  overlayRef: RefObject<HTMLDivElement | null>;
  hasPendingAnchor: boolean;
  toolbarPosition: DocumentAnnotationToolbarPosition | null;
  onThreadFocus: (threadId: string) => void;
  onAddComment: () => void;
  newCommentDisabled: boolean;
  newCommentDisabledReason: string | null;
}

export function DocumentAnnotationHighlights({
  nativeHighlightsSupported,
  rects,
  hoveredThreadId,
  setHoveredThreadId,
  overlayRef,
  hasPendingAnchor,
  toolbarPosition,
  onThreadFocus,
  onAddComment,
  newCommentDisabled,
  newCommentDisabledReason,
}: DocumentAnnotationHighlightsProps) {
  return (
    <>
      {!nativeHighlightsSupported ? (
        <div
          className="paperclip-doc-annotation-visual-layer pointer-events-none absolute inset-0 z-0"
          aria-hidden="true"
        >
          <div className="relative h-full w-full">
            {rects.map((rect, index) => {
              const isFocused = rect.focused;
              const isStale = rect.anchorState === "stale";
              const isResolved = rect.status === "resolved";
              return (
                <span
                  key={`visual-${rect.threadId}-${index}`}
                  data-thread-id={rect.threadId}
                  data-anchor-state={rect.anchorState}
                  data-status={rect.status}
                  data-focused={isFocused || undefined}
                  className={cn(
                    "paperclip-doc-annotation-highlight absolute rounded-none transition-colors",
                    isResolved
                      ? "bg-yellow-100 outline outline-1 outline-dashed outline-offset-0 outline-yellow-700/45 dark:bg-yellow-700 dark:outline-yellow-200/45"
                      : isStale
                        ? "bg-yellow-200 outline outline-2 outline-dashed outline-offset-0 outline-yellow-700/65 dark:bg-yellow-600 dark:outline-yellow-200/70"
                        : isFocused
                          ? "bg-yellow-300 outline outline-2 outline-offset-0 outline-yellow-700/85 shadow-(--shadow-extract-6) dark:bg-yellow-500 dark:outline-yellow-200/85"
                          : "bg-yellow-200 dark:bg-yellow-600",
                  )}
                  style={{
                    top: rect.top,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height,
                  }}
                />
              );
            })}
          </div>
        </div>
      ) : null}
      <div
        className="paperclip-doc-annotation-layer pointer-events-none absolute inset-0 z-(--z-2)"
        aria-hidden="true"
      >
        <div ref={overlayRef} className="relative h-full w-full">
          {rects.map((rect, index) => {
            if (rect.threadId === PENDING_HIGHLIGHT_THREAD_ID) return null;
            const isFocused = rect.focused;
            const isHovered = rect.threadId === hoveredThreadId;
            return (
              <Button
                key={`${rect.threadId}-${index}`}
                type="button"
                variant="ghost"
                data-thread-id={rect.threadId}
                data-anchor-state={rect.anchorState}
                data-status={rect.status}
                data-focused={isFocused || undefined}
                data-hovered={isHovered || undefined}
                aria-label="Open annotation thread"
                className={cn(
                  "paperclip-doc-annotation-hit-target pointer-events-auto absolute h-auto w-auto rounded-none p-0",
                  isHovered && "bg-amber-400/40 dark:bg-amber-300/30",
                  isFocused && "ring-1 ring-transparent",
                )}
                style={{
                  top: rect.top,
                  left: rect.left,
                  width: rect.width,
                  height: rect.height,
                }}
                onMouseEnter={() => setHoveredThreadId(rect.threadId)}
                onMouseLeave={() =>
                  setHoveredThreadId((current) => (current === rect.threadId ? null : current))
                }
                onMouseDown={(event) => {
                  event.preventDefault();
                  onThreadFocus(rect.threadId);
                }}
              />
            );
          })}
          {rects.map((rect, index) =>
            rect.isTail && rect.anchorState === "stale" ? (
              <span
                key={`tail-${rect.threadId}-${index}`}
                aria-hidden="true"
                data-thread-id={rect.threadId}
                className="paperclip-doc-annotation-tail pointer-events-none absolute inline-flex items-center justify-center rounded-sm bg-amber-500/95 text-amber-50 shadow-sm dark:bg-amber-500/90 dark:text-amber-50"
                style={{
                  top: rect.top + Math.max(0, rect.height / 2 - 8),
                  left: rect.left + rect.width + 2,
                  width: 16,
                  height: 16,
                }}
                title="Anchor moved — needs review"
              >
                <AlertTriangle className="h-3 w-3" />
              </span>
            ) : null,
          )}
          {hasPendingAnchor && toolbarPosition ? (
            <ButtonGroup
              data-testid="document-annotation-selection-toolbar"
              aria-label="Selection actions"
              className="paperclip-doc-annotation-selection-toolbar pointer-events-auto absolute z-10 bg-popover shadow-md"
              style={{ top: toolbarPosition.top, left: toolbarPosition.left }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs"
                onClick={onAddComment}
                disabled={newCommentDisabled}
                title={
                  newCommentDisabled
                    ? (newCommentDisabledReason ?? undefined)
                    : "Add comment on selection (⌘⇧M)"
                }
              >
                <MessageSquarePlus data-icon="inline-start" className="h-3.5 w-3.5" aria-hidden="true" />
                Comment
              </Button>
            </ButtonGroup>
          ) : null}
        </div>
      </div>
    </>
  );
}
