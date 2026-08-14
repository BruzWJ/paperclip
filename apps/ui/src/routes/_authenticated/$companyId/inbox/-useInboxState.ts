import { useDismissedInboxAlerts, useInboxDismissals, useReadInboxItems } from "@/hooks/useInboxBadge";
import type { BlockedInboxGroupBy, BlockedInboxSort } from "@/lib/blockedInbox";
import {
  loadCollapsedInboxGroupKeys,
  loadInboxFilterPreferences,
  loadInboxNesting,
  loadInboxTaskColumns,
  loadInboxWorkItemGroupBy,
  saveCollapsedInboxGroupKeys,
  saveInboxNesting,
  type InboxFilterPreferences,
  type InboxTab,
  type InboxTaskColumn,
  type InboxWorkItemGroupBy,
} from "@/lib/inbox";
import { useLocalInboxArchiveTaskIds } from "@/lib/inboxArchiveCache";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Owns persisted preferences and transient interaction state for the inbox. */
export function useInboxState(companyId: string, tab: InboxTab) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedSearchQuery = searchQuery.trim();
  const [filterPreferences, setFilterPreferences] = useState<InboxFilterPreferences>(() =>
    loadInboxFilterPreferences(companyId),
  );
  const [groupBy, setGroupBy] = useState<InboxWorkItemGroupBy>(() => loadInboxWorkItemGroupBy());
  const [blockedGroupBy, setBlockedGroupBy] = useState<BlockedInboxGroupBy>("none");
  const [blockedSortBy, setBlockedSortBy] = useState<BlockedInboxSort>("most_recent");
  const [visibleTaskColumns, setVisibleTaskColumns] = useState<InboxTaskColumn[]>(loadInboxTaskColumns);
  const { dismissed: dismissedAlerts, dismiss: dismissAlert } = useDismissedInboxAlerts();
  const { dismissedAtByKey, dismiss: dismissInboxItem } = useInboxDismissals(companyId);
  const { readItems, markRead: markItemRead, markUnread: markItemUnread } = useReadInboxItems();
  const { allCategoryFilter, allApprovalFilter, taskFilters } = filterPreferences;
  const [archivingTaskIds, setArchivingTaskIds] = useState<Set<string>>(new Set());
  const [undoableArchiveTaskIds, setUndoableArchiveTaskIds] = useState<string[]>([]);
  const [unarchivingTaskIds, setUnarchivingTaskIds] = useState<Set<string>>(new Set());
  const guardedArchiveTaskIds = useLocalInboxArchiveTaskIds(companyId);
  const locallyArchivedTaskIds = useMemo(() => {
    const taskIds = new Set(guardedArchiveTaskIds);
    for (const taskId of undoableArchiveTaskIds) taskIds.add(taskId);
    for (const taskId of archivingTaskIds) taskIds.add(taskId);
    for (const taskId of unarchivingTaskIds) taskIds.delete(taskId);
    return taskIds;
  }, [archivingTaskIds, guardedArchiveTaskIds, undoableArchiveTaskIds, unarchivingTaskIds]);
  const [nestingPreferenceEnabled, setNestingPreferenceEnabled] = useState(() => loadInboxNesting());
  const toggleNesting = useCallback(() => {
    setNestingPreferenceEnabled((previous) => {
      const next = !previous;
      saveInboxNesting(next);
      return next;
    });
  }, []);
  const [collapsedInboxParents, setCollapsedInboxParents] = useState<Set<string>>(new Set());
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() =>
    loadCollapsedInboxGroupKeys(companyId),
  );
  const toggleGroupCollapse = useCallback(
    (groupKey: string) => {
      setCollapsedGroupKeys((previous) => {
        const next = new Set(previous);
        if (next.has(groupKey)) next.delete(groupKey);
        else next.add(groupKey);
        saveCollapsedInboxGroupKeys(companyId, next);
        return next;
      });
    },
    [companyId],
  );
  const setGroupCollapsed = useCallback(
    (groupKey: string, collapsed: boolean) => {
      setCollapsedGroupKeys((previous) => {
        if (collapsed ? previous.has(groupKey) : !previous.has(groupKey)) {
          return previous;
        }
        const next = new Set(previous);
        if (collapsed) next.add(groupKey);
        else next.delete(groupKey);
        saveCollapsedInboxGroupKeys(companyId, next);
        return next;
      });
    },
    [companyId],
  );
  const toggleInboxParentCollapse = useCallback((parentId: string) => {
    setCollapsedInboxParents((previous) => {
      const next = new Set(previous);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }, []);
  const setInboxParentCollapsed = useCallback((parentId: string, collapsed: boolean) => {
    setCollapsedInboxParents((previous) => {
      if (previous.has(parentId) === collapsed) return previous;
      const next = new Set(previous);
      if (collapsed) next.add(parentId);
      else next.delete(parentId);
      return next;
    });
  }, []);
  const [fadingOutTasks, setFadingOutTasks] = useState<Set<string>>(new Set());
  const [showMarkAllReadConfirm, setShowMarkAllReadConfirm] = useState(false);
  const [fadingNonTaskItems, setFadingNonTaskItems] = useState<Set<string>>(new Set());
  const [archivingNonTaskIds, setArchivingNonTaskIds] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const pointerMovedSinceKeyNavRef = useRef(true);
  const hoveredIndexRef = useRef<number | null>(null);
  const hoveredNavKeyRef = useRef<string | null>(null);
  const previousCompanyIdRef = useRef<string | null>(companyId);

  useEffect(() => {
    setSelectedIndex(-1);
    setSearchQuery("");
  }, [tab]);
  useEffect(() => {
    if (previousCompanyIdRef.current === companyId) return;
    previousCompanyIdRef.current = companyId;
    setFilterPreferences(loadInboxFilterPreferences(companyId));
    setCollapsedGroupKeys(loadCollapsedInboxGroupKeys(companyId));
  }, [companyId]);
  useEffect(() => {
    setUndoableArchiveTaskIds((previous) =>
      previous.filter((taskId) => guardedArchiveTaskIds.has(taskId) || unarchivingTaskIds.has(taskId)),
    );
  }, [guardedArchiveTaskIds, unarchivingTaskIds]);
  useEffect(() => {
    setUndoableArchiveTaskIds([]);
    setUnarchivingTaskIds(new Set());
  }, [companyId]);

  return {
    actionError,
    setActionError,
    searchQuery,
    setSearchQuery,
    normalizedSearchQuery,
    filterPreferences,
    setFilterPreferences,
    groupBy,
    setGroupBy,
    blockedGroupBy,
    setBlockedGroupBy,
    blockedSortBy,
    setBlockedSortBy,
    visibleTaskColumns,
    setVisibleTaskColumns,
    dismissedAlerts,
    dismissAlert,
    dismissedAtByKey,
    dismissInboxItem,
    readItems,
    markItemRead,
    markItemUnread,
    allCategoryFilter,
    allApprovalFilter,
    taskFilters,
    archivingTaskIds,
    setArchivingTaskIds,
    undoableArchiveTaskIds,
    setUndoableArchiveTaskIds,
    unarchivingTaskIds,
    setUnarchivingTaskIds,
    guardedArchiveTaskIds,
    locallyArchivedTaskIds,
    nestingPreferenceEnabled,
    setNestingPreferenceEnabled,
    toggleNesting,
    collapsedInboxParents,
    setCollapsedInboxParents,
    collapsedGroupKeys,
    setCollapsedGroupKeys,
    toggleGroupCollapse,
    setGroupCollapsed,
    toggleInboxParentCollapse,
    setInboxParentCollapsed,
    fadingOutTasks,
    setFadingOutTasks,
    showMarkAllReadConfirm,
    setShowMarkAllReadConfirm,
    fadingNonTaskItems,
    setFadingNonTaskItems,
    archivingNonTaskIds,
    setArchivingNonTaskIds,
    selectedIndex,
    setSelectedIndex,
    listRef,
    pointerMovedSinceKeyNavRef,
    hoveredIndexRef,
    hoveredNavKeyRef,
    previousCompanyIdRef,
  };
}

export type InboxState = ReturnType<typeof useInboxState>;
