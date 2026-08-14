import { attentionApi } from "@/api/attention";
import { useNavigateCompanyBoardTarget } from "@/components/CompanyBoardLink";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DecisionQueue } from "@/components/decisions/DecisionQueue";
import { DecisionToolbar } from "@/components/decisions/DecisionToolbar";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { toast } from "sonner";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useInboxDismissals } from "@/hooks/useInboxBadge";
import {
  buildAttentionFilterOptions,
  defaultAttentionFilterState,
  filterAttentionItems,
  groupAttentionItems,
  isInlineResolvable,
  loadAttentionFilters,
  loadAttentionGroupBy,
  loadAttentionSortOrder,
  loadCollapsedAttentionGroupKeys,
  planAttentionRenderRows,
  saveAttentionFilters,
  saveAttentionGroupBy,
  saveAttentionSortOrder,
  saveCollapsedAttentionGroupKeys,
  sortAttentionItems,
  type AttentionFilterState,
  type AttentionGroupBy,
  type AttentionSortOrder,
} from "@/lib/attention";
import { hasBlockingShortcutDialog, resolveAttentionQueueKeyAction } from "@/lib/keyboardShortcuts";
import { queryKeys } from "@/lib/queryKeys";
import type { AttentionItem } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/_authenticated/$companyId/decisions/")({
  component: WhatNeedsMe,
});

// Incremental rendering (PAP-13784, same pattern as TasksList): the feed is
// uncapped, so mounting every row up front makes the page slow to paint and
// scroll. Render a bounded window and grow it as the scroll position nears the
// bottom. One budget spans the active groups and the open curtains in document
// order, so everything below the fold stays unmounted until needed.
const INITIAL_ATTENTION_ROW_RENDER_LIMIT = 50;

const ATTENTION_ROW_RENDER_BATCH_SIZE = 100;

const ATTENTION_SCROLL_LOAD_THRESHOLD_PX = 480;

function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element || typeof window === "undefined") return null;
  let current = element.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function WhatNeedsMe() {
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedAttentionId, setSelectedAttentionId] = useState<string | null>(null);
  const [autoExpandDone, setAutoExpandDone] = useState(false);

  // Toolbar preferences (persisted to localStorage, Inbox pattern).
  const [groupBy, setGroupBy] = useState<AttentionGroupBy>(() => loadAttentionGroupBy());
  const [sortOrder, setSortOrder] = useState<AttentionSortOrder>(() => loadAttentionSortOrder());
  const [filters, setFilters] = useState<AttentionFilterState>(() => defaultAttentionFilterState);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set());
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [dismissedOpen, setDismissedOpen] = useState(false);

  // Optimistic hide/restore. Reset whenever a fresh feed lands (server truth).
  const [pendingHide, setPendingHide] = useState<Set<string>>(() => new Set());
  const [pendingRestore, setPendingRestore] = useState<Set<string>>(() => new Set());

  const { dismiss, snooze, restore } = useInboxDismissals(companyId);
  const navigateBoardTarget = useNavigateCompanyBoardTarget();

  useEffect(() => {
    setBreadcrumbs([{ label: "Decisions" }]);
  }, [setBreadcrumbs]);

  // Re-hydrate per-company preferences when the company changes.
  useEffect(() => {
    setFilters(loadAttentionFilters(companyId));
    setCollapsedGroupKeys(loadCollapsedAttentionGroupKeys(companyId));
  }, [companyId]);

  const {
    data: feed,
    isLoading,
    error,
  } = useQuery({
    // Distinct from the sidebar badge's `queryKeys.attention` so dismissed rows
    // (needed for the curtains) never inflate the badge count. Invalidating the
    // `["attention", companyId]` prefix still cascades to this query.
    queryKey: [...queryKeys.attention(companyId), "with-dismissed"],
    queryFn: () => attentionApi.list(companyId, { includeDismissed: true }),
  });

  // Reset optimistic state once the server sends a fresh snapshot.
  useEffect(() => {
    setPendingHide(new Set());
    setPendingRestore(new Set());
  }, [feed?.generatedAt]);

  const allItems = useMemo(() => feed?.items ?? [], [feed]);

  const isServerHidden = (item: AttentionItem) => item.dismissal != null && item.dismissal.isActive;

  const activeItems = useMemo(
    () =>
      allItems.filter(
        (item) => (!isServerHidden(item) || pendingRestore.has(item.id)) && !pendingHide.has(item.id),
      ),
    [allItems, pendingHide, pendingRestore],
  );
  const snoozedItems = useMemo(
    () =>
      allItems.filter(
        (item) =>
          item.dismissal?.kind === "snooze" && item.dismissal.isActive && !pendingRestore.has(item.id),
      ),
    [allItems, pendingRestore],
  );
  const dismissedItems = useMemo(
    () =>
      allItems.filter(
        (item) =>
          item.dismissal?.kind === "dismiss" && item.dismissal.isActive && !pendingRestore.has(item.id),
      ),
    [allItems, pendingRestore],
  );

  const filterOptions = useMemo(() => buildAttentionFilterOptions(activeItems), [activeItems]);

  // Filter → sort → group, all client-side so switching re-buckets without a refetch.
  const groups = useMemo(() => {
    const filtered = filterAttentionItems(activeItems, filters);
    const sorted = sortAttentionItems(filtered, sortOrder);
    return groupAttentionItems(sorted, groupBy);
  }, [activeItems, filters, sortOrder, groupBy]);

  const visibleCount = useMemo(() => groups.reduce((sum, group) => sum + group.items.length, 0), [groups]);
  const keyboardItems = useMemo(
    () =>
      groups
        .filter((group) => group.label === null || !collapsedGroupKeys.has(group.key))
        .flatMap((group) => group.items),
    [collapsedGroupKeys, groups],
  );

  // Rendered-row budget: only ratchets up (a hard reset mid-scroll would yank
  // the DOM out from under the user), and resets when the company changes.
  const [renderedRowLimit, setRenderedRowLimit] = useState(INITIAL_ATTENTION_ROW_RENDER_LIMIT);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setRenderedRowLimit(INITIAL_ATTENTION_ROW_RENDER_LIMIT);
  }, [companyId]);

  // Keyboard selection may point past the budget (e.g. wrapping to the last
  // row), so the effective limit is derived to always cover it — the selected
  // row is then guaranteed to be in the DOM in the same commit that selects it.
  const renderPlan = useMemo(() => {
    const selectedIndex = selectedAttentionId
      ? keyboardItems.findIndex((item) => item.id === selectedAttentionId)
      : -1;
    return planAttentionRenderRows({
      groups,
      collapsedGroupKeys,
      snoozedItems,
      snoozedOpen,
      dismissedItems,
      dismissedOpen,
      limit: Math.max(renderedRowLimit, selectedIndex + 1),
    });
  }, [
    collapsedGroupKeys,
    dismissedItems,
    dismissedOpen,
    groups,
    keyboardItems,
    renderedRowLimit,
    selectedAttentionId,
    snoozedItems,
    snoozedOpen,
  ]);

  const loadMoreRows = useCallback(() => {
    setRenderedRowLimit((current) => current + ATTENTION_ROW_RENDER_BATCH_SIZE);
  }, []);

  useEffect(() => {
    if (!renderPlan.hasMoreRows) return;
    let animationFrameId: number | null = null;
    const scrollContainer = findScrollContainer(rootRef.current);
    const scrollTarget: Window | HTMLElement = scrollContainer ?? window;

    const checkScrollPosition = () => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const scrollHeight = scrollContainer?.scrollHeight ?? document.documentElement.scrollHeight;
        if (scrollHeight === 0) return;
        const scrollBottom = scrollContainer
          ? scrollContainer.scrollTop + scrollContainer.clientHeight
          : window.scrollY + window.innerHeight;
        if (scrollBottom >= scrollHeight - ATTENTION_SCROLL_LOAD_THRESHOLD_PX) {
          loadMoreRows();
        }
      });
    };

    scrollTarget.addEventListener("scroll", checkScrollPosition, {
      passive: true,
    });
    window.addEventListener("resize", checkScrollPosition);
    // Initial check: a tall viewport (or an opened curtain) may need more rows
    // than the current budget before any scrolling happens.
    checkScrollPosition();

    return () => {
      scrollTarget.removeEventListener("scroll", checkScrollPosition);
      window.removeEventListener("resize", checkScrollPosition);
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    };
  }, [loadMoreRows, renderPlan.hasMoreRows, renderedRowLimit]);

  useEffect(() => {
    if (selectedAttentionId && !keyboardItems.some((item) => item.id === selectedAttentionId)) {
      setSelectedAttentionId(null);
    }
  }, [keyboardItems, selectedAttentionId]);

  useEffect(() => {
    if (!selectedAttentionId) return;
    document.getElementById(`attention-row-${selectedAttentionId}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedAttentionId]);

  // Auto-expand the topmost inline-capable decision, once.
  useEffect(() => {
    if (autoExpandDone || activeItems.length === 0) return;
    const sorted = sortAttentionItems(activeItems, sortOrder);
    const topInline = sorted.find((item) => isInlineResolvable(item));
    if (topInline) setExpandedId(topInline.id);
    setAutoExpandDone(true);
  }, [activeItems, autoExpandDone, sortOrder]);

  const updateGroupBy = (next: AttentionGroupBy) => {
    setGroupBy(next);
    saveAttentionGroupBy(next);
  };
  const updateSortOrder = (next: AttentionSortOrder) => {
    setSortOrder(next);
    saveAttentionSortOrder(next);
  };
  const updateFilters = (next: AttentionFilterState) => {
    setFilters(next);
    saveAttentionFilters(companyId, next);
  };
  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedAttentionGroupKeys(companyId, next);
      return next;
    });
  };

  // All row callbacks are stable (deps are setState functions, stable hook
  // callbacks) so the memoized rows only re-render
  // when their own item/expanded/selected props change (PAP-13784).
  const handleUndoDismiss = useCallback(
    (item: AttentionItem) => {
      setPendingHide((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      restore(item.dismissalKey);
    },
    [restore],
  );
  const handleDismiss = useCallback(
    (item: AttentionItem) => {
      setPendingHide((prev) => new Set(prev).add(item.id));
      dismiss(item.dismissalKey);
      setExpandedId((previous) => (previous === item.id ? null : previous));
      // ~8s undo window; restores the row in place via T1's DELETE endpoint.
      toast.info("Dismissed", {
        description: item.subject.title ?? undefined,
        duration: 8000,
        id: `attention-dismiss-${item.id}`,
        action: { label: "Undo", onClick: () => handleUndoDismiss(item) },
      });
    },
    [dismiss, handleUndoDismiss],
  );
  const handleSnooze = useCallback(
    (item: AttentionItem, snoozedUntil: string) => {
      setPendingHide((prev) => new Set(prev).add(item.id));
      snooze(item.dismissalKey, snoozedUntil);
      setExpandedId((previous) => (previous === item.id ? null : previous));
    },
    [snooze],
  );
  const handleRestore = useCallback(
    (item: AttentionItem) => {
      setPendingRestore((prev) => new Set(prev).add(item.id));
      restore(item.dismissalKey);
    },
    [restore],
  );
  const handleToggleExpand = useCallback((item: AttentionItem) => {
    setSelectedAttentionId(item.id);
    setExpandedId((prev) => (prev === item.id ? null : item.id));
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveAttentionQueueKeyAction({
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
        hasSelection: selectedAttentionId !== null,
      });
      if (action === "ignore" || keyboardItems.length === 0) return;

      if (action === "next" || action === "previous") {
        event.preventDefault();
        const currentIndex = selectedAttentionId
          ? keyboardItems.findIndex((item) => item.id === selectedAttentionId)
          : -1;
        const offset = action === "next" ? 1 : -1;
        const nextIndex =
          currentIndex < 0
            ? action === "next"
              ? 0
              : keyboardItems.length - 1
            : (currentIndex + offset + keyboardItems.length) % keyboardItems.length;
        setSelectedAttentionId(keyboardItems[nextIndex]?.id ?? null);
        return;
      }

      const selectedItem = keyboardItems.find((item) => item.id === selectedAttentionId);
      if (!selectedItem) return;
      event.preventDefault();

      if (action === "dismiss") {
        handleDismiss(selectedItem);
      } else if (isInlineResolvable(selectedItem)) {
        setExpandedId((previous) => (previous === selectedItem.id ? null : selectedItem.id));
      } else if (selectedItem.subject.routeTarget) {
        navigateBoardTarget(selectedItem.subject.routeTarget);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleDismiss, keyboardItems, navigateBoardTarget, selectedAttentionId]);

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  const hasAnything = activeItems.length > 0 || snoozedItems.length > 0 || dismissedItems.length > 0;

  return (
    <div ref={rootRef} className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Decisions</h1>
        <DecisionToolbar
          visibleCount={visibleCount}
          options={filterOptions}
          filters={filters}
          groupBy={groupBy}
          sortOrder={sortOrder}
          onFiltersChange={updateFilters}
          onGroupByChange={updateGroupBy}
          onSortOrderChange={updateSortOrder}
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      <DecisionQueue
        companyId={companyId}
        hasAnything={hasAnything}
        activeItemCount={activeItems.length}
        visibleCount={visibleCount}
        groups={groups}
        collapsedGroupKeys={collapsedGroupKeys}
        renderPlan={renderPlan}
        expandedId={expandedId}
        selectedAttentionId={selectedAttentionId}
        snoozedItems={snoozedItems}
        snoozedOpen={snoozedOpen}
        dismissedItems={dismissedItems}
        dismissedOpen={dismissedOpen}
        onToggleGroup={toggleGroupCollapse}
        onToggleExpand={handleToggleExpand}
        onDismiss={handleDismiss}
        onSnooze={handleSnooze}
        onRestore={handleRestore}
        onToggleSnoozed={() => setSnoozedOpen((previous) => !previous)}
        onToggleDismissed={() => setDismissedOpen((previous) => !previous)}
      />
    </div>
  );
}
