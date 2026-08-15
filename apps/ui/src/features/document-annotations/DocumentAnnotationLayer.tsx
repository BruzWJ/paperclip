import {
  initializeSelectionDebug,
  isSelectionDebugEnabled,
  recordAnnotationCommit,
  recordCaptureSelection,
  recordMarkdownMutations,
  recordSelectionChange,
} from "@/lib/document-annotation-debug";
import {
  buildAnchorFromContainerSelection,
  getContainerTextOffset,
  rangesForNormalizedSpan,
} from "@/lib/document-annotation-selection";
import type {
  DocumentAnnotationAnchorSelector,
  DocumentAnnotationAnchorState,
  DocumentAnnotationThreadStatus,
} from "@paperclipai/shared";
import { Profiler, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  NativeHighlightKind,
  PENDING_HIGHLIGHT_THREAD_ID,
  clearNativeHighlightRanges,
  elementFromNode,
  emptyNativeHighlightRanges,
  getNativeHighlightApi,
  intersectRects,
  nativeHighlightKind,
  selectionTouchesEditableElement,
  setNativeHighlightRanges,
  visibleClipRectForRange,
} from "./document-annotation-layer-utils";
import {
  DocumentAnnotationHighlights,
  type DocumentAnnotationHighlightRect,
  type DocumentAnnotationToolbarPosition,
} from "./DocumentAnnotationHighlights";

export interface AnnotationOverlayThread {
  id: string;
  selectedText: string;
  status: DocumentAnnotationThreadStatus;
  anchorState: DocumentAnnotationAnchorState;
  unreadCount?: number;
}

export interface PendingAnchor {
  selector: DocumentAnnotationAnchorSelector;
  selectedText: string;
}

export interface AnnotationLayerProps {
  containerRef: React.RefObject<HTMLElement | null>;
  markdown: string;
  threads: AnnotationOverlayThread[];
  focusedThreadId: string | null;
  onThreadFocus: (threadId: string) => void;
  /** Tracks the most recently captured pending selection. */
  pendingAnchor: PendingAnchor | null;
  onPendingAnchorChange: (anchor: PendingAnchor | null) => void;
  onRequestComment: (anchor: PendingAnchor) => void;
  /** Disables the "add comment" affordance when set. */
  newCommentDisabled?: boolean;
  newCommentDisabledReason?: string | null;
  /** Hide resolved highlights even when included in the threads list. */
  hideResolved?: boolean;
  /** Test-only: override window object for layout calculations. */
  testWindow?: { innerWidth: number; innerHeight: number };
  /**
   * When this number changes, re-read the current document selection and emit a
   * pending anchor for the keyboard shortcut path.
   */
  captureSelectionRequestId?: number;
  /**
   * Text of a comment currently being composed. We keep this segment brightly
   * highlighted in the document even after the native browser selection is lost
   * (e.g. once focus moves into the composer textarea).
   */
  pendingHighlightText?: string | null;
}

export function DocumentAnnotationLayer({
  containerRef,
  markdown,
  threads,
  focusedThreadId,
  onThreadFocus,
  pendingAnchor,
  onPendingAnchorChange,
  onRequestComment,
  newCommentDisabled = false,
  newCommentDisabledReason = null,
  hideResolved = true,
  captureSelectionRequestId,
  pendingHighlightText = null,
}: AnnotationLayerProps) {
  const [highlightRects, setHighlightRects] = useState<DocumentAnnotationHighlightRect[]>([]);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const [toolbarPosition, setToolbarPosition] = useState<DocumentAnnotationToolbarPosition | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const lastCaptureSelectionRequestIdRef = useRef<number>(0);
  const reactId = useId();
  const nativeHighlightInstanceId = useMemo(
    () => `document-annotation-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const nativeHighlightsSupported = getNativeHighlightApi() !== null;
  const selectionDebugEnabled = isSelectionDebugEnabled();
  if (selectionDebugEnabled) initializeSelectionDebug();

  const visibleThreads = useMemo(() => {
    if (!hideResolved) return threads;
    return threads.filter(
      (thread) =>
        thread.status !== "resolved" || thread.anchorState === "orphaned" || thread.id === focusedThreadId,
    );
  }, [threads, hideResolved, focusedThreadId]);

  const computeHighlightRects = useCallback(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) {
      clearNativeHighlightRanges(nativeHighlightInstanceId);
      setHighlightRects([]);
      return;
    }
    const overlayRect = overlay.getBoundingClientRect();
    const next: DocumentAnnotationHighlightRect[] = [];
    const nativeRanges = emptyNativeHighlightRanges();
    const pushRunRects = (run: {
      threadId: string;
      status: DocumentAnnotationThreadStatus;
      anchorState: DocumentAnnotationAnchorState;
      focused: boolean;
      selectedText: string;
      nativeKind: NativeHighlightKind;
    }) => {
      const ranges = rangesForNormalizedSpan({
        container,
        selectedText: run.selectedText,
      });
      const startIndex = next.length;
      for (const range of ranges) {
        const visibleClipRect = visibleClipRectForRange(range, container);
        if (!visibleClipRect) continue;
        let rangeIsVisible = false;
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width === 0 || rect.height === 0) continue;
          const visibleRect = intersectRects(rect, visibleClipRect);
          if (!visibleRect) continue;
          rangeIsVisible = true;
          next.push({
            threadId: run.threadId,
            status: run.status,
            anchorState: run.anchorState,
            focused: run.focused,
            top: visibleRect.top - overlayRect.top,
            left: visibleRect.left - overlayRect.left,
            width: visibleRect.width,
            height: visibleRect.height,
            isTail: false,
          });
        }
        if (rangeIsVisible) nativeRanges[run.nativeKind].push(range);
      }
      if (next.length > startIndex) {
        next[next.length - 1].isTail = true;
      }
    };
    for (const thread of visibleThreads) {
      if (thread.anchorState === "orphaned") continue;
      const isFocused = thread.id === focusedThreadId;
      const isStale = thread.anchorState === "stale";
      const isResolved = thread.status === "resolved";
      pushRunRects({
        threadId: thread.id,
        status: thread.status,
        anchorState: thread.anchorState,
        focused: isFocused,
        selectedText: thread.selectedText,
        nativeKind: nativeHighlightKind({
          focused: isFocused,
          stale: isStale,
          resolved: isResolved,
        }),
      });
    }
    // Keep the in-progress (pending) comment selection brightly highlighted so the
    // segment stays anchored in the document while the composer is open.
    if (pendingHighlightText && pendingHighlightText.trim().length > 0) {
      pushRunRects({
        threadId: PENDING_HIGHLIGHT_THREAD_ID,
        status: "open",
        anchorState: "active",
        focused: true,
        selectedText: pendingHighlightText,
        nativeKind: "focused",
      });
    }
    setNativeHighlightRanges(nativeHighlightInstanceId, nativeRanges);
    setHighlightRects(next);
  }, [containerRef, focusedThreadId, nativeHighlightInstanceId, pendingHighlightText, visibleThreads]);

  useLayoutEffect(() => {
    computeHighlightRects();
  }, [computeHighlightRects]);

  useEffect(() => () => clearNativeHighlightRanges(nativeHighlightInstanceId), [nativeHighlightInstanceId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const container = containerRef.current;
    const overlay = overlayRef.current;
    let cancelled = false;
    let frame: number | null = null;

    const schedule = () => {
      if (cancelled || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (!cancelled) computeHighlightRects();
      });
    };

    const handleResizeOrScroll = () => schedule();
    window.addEventListener("resize", handleResizeOrScroll);
    window.addEventListener("scroll", handleResizeOrScroll, true);

    const resizeObserver =
      typeof window.ResizeObserver === "function" ? new window.ResizeObserver(schedule) : null;
    if (resizeObserver && container) resizeObserver.observe(container);
    if (resizeObserver && overlay) resizeObserver.observe(overlay);

    const mutationObserver =
      typeof window.MutationObserver === "function" && container
        ? new window.MutationObserver((mutations) => {
            if (selectionDebugEnabled) {
              const markdownMutations = mutations.filter((mutation) =>
                Boolean(elementFromNode(mutation.target)?.closest(".paperclip-markdown")),
              );
              if (markdownMutations.length > 0) recordMarkdownMutations(markdownMutations.length);
            }
            const onlyLayerMutations = mutations.every((mutation) => {
              const target = elementFromNode(mutation.target);
              return !!target?.closest(
                ".paperclip-doc-annotation-layer, .paperclip-doc-annotation-visual-layer",
              );
            });
            if (!onlyLayerMutations) schedule();
          })
        : null;
    if (mutationObserver && container) {
      mutationObserver.observe(container, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "data-state", "open", "hidden", "aria-expanded"],
      });
    }

    schedule();

    return () => {
      cancelled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", handleResizeOrScroll);
      window.removeEventListener("scroll", handleResizeOrScroll, true);
    };
  }, [computeHighlightRects, containerRef, selectionDebugEnabled]);

  const captureSelection = useCallback((): PendingAnchor | null => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    if (selectionTouchesEditableElement(container, range)) return null;
    const containerOffset = getContainerTextOffset(container, range);
    if (!containerOffset) return null;
    const anchor = buildAnchorFromContainerSelection({
      markdown,
      containerOffset,
    });
    if (!anchor) return null;
    const overlayRect = overlay.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    const top = Math.max(0, rect.top - overlayRect.top - 36);
    const left = Math.max(0, rect.left - overlayRect.left + rect.width / 2 - 80);
    setToolbarPosition({ top, left });
    return {
      selector: anchor.selector,
      selectedText: containerOffset.selectedText,
    };
  }, [containerRef, markdown]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const selectionIsActive = Boolean(
        selection &&
        !selection.isCollapsed &&
        range &&
        containerRef.current?.contains(range.commonAncestorContainer),
      );
      if (selectionDebugEnabled) recordSelectionChange(selectionIsActive);
      const captureStartedAt = selectionDebugEnabled ? performance.now() : 0;
      const anchor = captureSelection();
      if (selectionDebugEnabled) {
        recordCaptureSelection(performance.now() - captureStartedAt, Boolean(anchor));
      }
      if (!anchor) {
        onPendingAnchorChange(null);
        setToolbarPosition(null);
        return;
      }
      onPendingAnchorChange(anchor);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [captureSelection, containerRef, onPendingAnchorChange, selectionDebugEnabled]);

  useEffect(() => {
    if (captureSelectionRequestId === undefined) return;
    if (captureSelectionRequestId === 0) return;
    if (lastCaptureSelectionRequestIdRef.current === captureSelectionRequestId) return;
    lastCaptureSelectionRequestIdRef.current = captureSelectionRequestId;
    const anchor = captureSelection();
    if (anchor) {
      onPendingAnchorChange(anchor);
      onRequestComment(anchor);
    }
  }, [captureSelectionRequestId, captureSelection, onPendingAnchorChange, onRequestComment]);

  const handleAddComment = () => {
    if (pendingAnchor) onRequestComment(pendingAnchor);
  };

  const content = (
    <DocumentAnnotationHighlights
      nativeHighlightsSupported={nativeHighlightsSupported}
      rects={highlightRects}
      hoveredThreadId={hoveredThreadId}
      setHoveredThreadId={setHoveredThreadId}
      overlayRef={overlayRef}
      hasPendingAnchor={Boolean(pendingAnchor)}
      toolbarPosition={toolbarPosition}
      onThreadFocus={onThreadFocus}
      onAddComment={handleAddComment}
      newCommentDisabled={newCommentDisabled}
      newCommentDisabledReason={newCommentDisabledReason}
    />
  );

  return selectionDebugEnabled ? (
    <Profiler id="DocumentAnnotationLayer" onRender={recordAnnotationCommit}>
      {content}
    </Profiler>
  ) : (
    content
  );
}

export * from "./document-annotation-layer-utils";
