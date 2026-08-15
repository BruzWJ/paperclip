import { useCallback, useEffect, useMemo, useRef } from "react";
import { buildTaskTree } from "@/lib/task-tree";
import { getInboxKeyboardSelectionIndex } from "@/lib/inbox";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "@/lib/keyboardShortcuts";
import { withTaskDetailHeaderSeed } from "@/lib/taskDetailBreadcrumb";
import { INITIAL_TASK_ROW_RENDER_LIMIT, TASK_ROW_RENDER_BATCH_SIZE, TASK_SCROLL_LOAD_THRESHOLD_PX, escapeAttrValue, findTasksScrollContainer, tasksListNavEntryKey, type TasksListNavEntry } from "./model";
import type { Task } from "@paperclipai/shared";
import { useTasksListDerived, type TasksListDerivedInput } from "./useTasksListDerived";

export type TasksListNavigationInput = TasksListDerivedInput & ReturnType<typeof useTasksListDerived>;

export function useTasksListNavigation(m: TasksListNavigationInput) {
  const { groupedContent, viewState, taskLinkState, selectedNavKey, rootRef, keyboardShortcutsEnabled, navigate, companyId, pointerMovedSinceKeyNavRef, hoveredNavKeyRef, setSelectedNavKey, renderedTaskRowLimit, setRenderedTaskRowLimit, renderedTaskIdsRef, filtered, hasMoreTasks, isLoadingMoreTasks, onLoadMoreTasks, isLoading, initialServerFillRequestedRef, updateView } = m;
  // Flattened visible order (group headers, then tree DFS per group —
  // collapsed groups keep their header entry but skip their rows) — must
  // match render order below for keyboard traversal. `budgetOrdinal` counts
  // rows the way the progressive renderer consumes its budget (collapsed
  // groups still consume rows; collapsed parents' subtrees do not).
  const flatNavEntries = useMemo(() => {
    if (viewState.viewMode !== "list") return [] as TasksListNavEntry[];
    const out: TasksListNavEntry[] = [];
    let budgetCount = 0;
    for (const group of groupedContent) {
      const collapsed =
        Boolean(group.label) && viewState.collapsedGroups.includes(group.key);
      if (group.label) out.push({ type: "group", key: group.key, collapsed });
      const { roots, childMap } = viewState.nestingEnabled
        ? buildTaskTree(group.items)
        : { roots: group.items, childMap: new Map<string, Task[]>() };
      const walk = (task: Task) => {
        budgetCount += 1;
        const children = childMap.get(task.id) ?? [];
        const expanded = !viewState.collapsedParents.includes(task.id);
        if (!collapsed) {
          out.push({
            type: "task",
            task,
            hasChildren: children.length > 0,
            expanded,
            budgetOrdinal: budgetCount,
          });
        }
        if (expanded) for (const child of children) walk(child);
      };
      for (const root of roots) walk(root);
    }
    return out;
  }, [
    groupedContent,
    viewState.viewMode,
    viewState.collapsedGroups,
    viewState.collapsedParents,
    viewState.nestingEnabled,
  ]);

  const listNavStateRef = useRef({
    flatNavEntries,
    selectedNavKey,
    viewMode: viewState.viewMode,
    taskLinkState,
    collapsedGroups: viewState.collapsedGroups,
    collapsedParents: viewState.collapsedParents,
    updateView,
  });
  listNavStateRef.current = {
    flatNavEntries,
    selectedNavKey,
    viewMode: viewState.viewMode,
    taskLinkState,
    collapsedGroups: viewState.collapsedGroups,
    collapsedParents: viewState.collapsedParents,
    updateView,
  };

  const findSelectedNavElement = useCallback((navKey: string) => {
    if (navKey.startsWith("group:")) {
      const header = rootRef.current?.querySelector(
        `[data-tasks-group-key="${escapeAttrValue(navKey.slice("group:".length))}"]`,
      );
      return header instanceof HTMLElement ? header : null;
    }
    const row = rootRef.current?.querySelector(
      `[data-task-row-id="${escapeAttrValue(navKey.slice("task:".length))}"]`,
    );
    const link = row?.querySelector(":scope > [data-inbox-task-link]");
    return link instanceof HTMLElement ? link : null;
  }, []);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target;
      if (
        !(target instanceof HTMLElement) ||
        isKeyboardShortcutTextInputTarget(target) ||
        hasBlockingShortcutDialog(document) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      ) {
        return;
      }
      const st = listNavStateRef.current;
      if (st.viewMode !== "list" || st.flatNavEntries.length === 0) return;
      // The row a keystroke acts on: the hovered row when the mouse moved since
      // the last key nav (so "hover a row → press Arrow/Enter" acts on it),
      // otherwise the keyboard selection. Hover no longer writes selection
      // state, so this threads the pointer position into every handler.
      const indexOfKey = (key: string | null) =>
        key
          ? st.flatNavEntries.findIndex(
              (entry) => tasksListNavEntryKey(entry) === key,
            )
          : -1;
      const hoveredIndex = indexOfKey(hoveredNavKeyRef.current);
      const fromHover = pointerMovedSinceKeyNavRef.current && hoveredIndex >= 0;
      const currentIndex = fromHover
        ? hoveredIndex
        : indexOfKey(st.selectedNavKey);
      switch (e.key) {
        case "j":
        case "ArrowDown":
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          pointerMovedSinceKeyNavRef.current = false;
          const direction =
            e.key === "j" || e.key === "ArrowDown" ? "next" : "previous";
          const nextIndex = getInboxKeyboardSelectionIndex(
            currentIndex,
            st.flatNavEntries.length,
            direction,
          );
          const nextEntry = st.flatNavEntries[nextIndex];
          if (!nextEntry) break;
          setSelectedNavKey(tasksListNavEntryKey(nextEntry));
          // The list renders progressively; make sure the selected row is
          // within the render budget so the band mounts and can scroll into
          // view (the +1 keeps the next row visible as a scroll cue).
          if (nextEntry.type === "task") {
            setRenderedTaskRowLimit((current: number) =>
              Math.max(current, nextEntry.budgetOrdinal + 1),
            );
          }
          break;
        }
        case "ArrowLeft":
        case "ArrowRight": {
          // Groups and parent tasks collapse/expand with the same keys as the
          // inbox.
          const entry = st.flatNavEntries[currentIndex];
          if (!entry) return;
          const collapse = e.key === "ArrowLeft";
          if (entry.type === "group") {
            e.preventDefault();
            pointerMovedSinceKeyNavRef.current = false;
            setSelectedNavKey(tasksListNavEntryKey(entry));
            st.updateView({
              collapsedGroups: collapse
                ? st.collapsedGroups.includes(entry.key)
                  ? st.collapsedGroups
                  : [...st.collapsedGroups, entry.key]
                : st.collapsedGroups.filter((k: string) => k !== entry.key),
            });
            break;
          }
          if (!entry.hasChildren) return;
          e.preventDefault();
          pointerMovedSinceKeyNavRef.current = false;
          setSelectedNavKey(tasksListNavEntryKey(entry));
          st.updateView({
            collapsedParents: collapse
              ? st.collapsedParents.includes(entry.task.id)
                ? st.collapsedParents
                : [...st.collapsedParents, entry.task.id]
              : st.collapsedParents.filter((id: string) => id !== entry.task.id),
          });
          break;
        }
        case "Enter": {
          const entry = st.flatNavEntries[currentIndex];
          if (!entry || entry.type !== "task") return;
          // Navigate from the entry data (like the inbox) rather than the DOM
          // row — the selected row may sit past the mounted render batch.
          const task = entry.task;
          e.preventDefault();
          const detailState = withTaskDetailHeaderSeed(st.taskLinkState, task);
          void navigate({
            to: "/$companyId/tasks/$taskNumber",
            params: { companyId, taskNumber: String(task.taskNumber) },
            state: detailState,
          });
          break;
        }
        default:
          return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [companyId, keyboardShortcutsEnabled, navigate]);

  // Keep the keyboard selection visible while navigating. Depends on the
  // render budget too: a selection past the mounted batch scrolls once its
  // row mounts.
  useEffect(() => {
    if (!selectedNavKey) return;
    findSelectedNavElement(selectedNavKey)?.scrollIntoView({
      block: "nearest",
    });
  }, [findSelectedNavElement, renderedTaskRowLimit, selectedNavKey]);

  useEffect(() => {
    if (viewState.viewMode !== "list") return;
    const nextTaskIds = filtered.map((task: Task) => task.id).join("|");
    const previousTaskIds = renderedTaskIdsRef.current;
    if (nextTaskIds === previousTaskIds) return;
    renderedTaskIdsRef.current = nextTaskIds;

    setRenderedTaskRowLimit((current: number) => {
      const nextInitialLimit = Math.min(
        filtered.length,
        INITIAL_TASK_ROW_RENDER_LIMIT,
      );
      const listAppended =
        previousTaskIds.length > 0 &&
        nextTaskIds.startsWith(previousTaskIds) &&
        filtered.length >= current;
      if (listAppended)
        return Math.min(filtered.length, Math.max(current, nextInitialLimit));
      return nextInitialLimit;
    });
  }, [filtered, viewState.viewMode]);

  const hasMoreRenderedRows =
    viewState.viewMode === "list" && renderedTaskRowLimit < filtered.length;
  const remainingTaskRowCount = Math.max(
    filtered.length - renderedTaskRowLimit,
    0,
  );
  const loadMoreTaskRows = useCallback(() => {
    if (viewState.viewMode !== "list") return;
    if (hasMoreRenderedRows) {
      setRenderedTaskRowLimit((current: number) =>
        Math.min(filtered.length, current + TASK_ROW_RENDER_BATCH_SIZE),
      );
      return;
    }
    if (hasMoreTasks && !isLoadingMoreTasks) {
      onLoadMoreTasks?.();
    }
  }, [
    filtered.length,
    hasMoreTasks,
    hasMoreRenderedRows,
    isLoadingMoreTasks,
    onLoadMoreTasks,
    viewState.viewMode,
  ]);

  const canLoadMoreTasks =
    viewState.viewMode === "list" &&
    !isLoading &&
    (hasMoreRenderedRows || (hasMoreTasks && !isLoadingMoreTasks));

  useEffect(() => {
    if (!canLoadMoreTasks) return;
    let animationFrameId: number | null = null;
    const scrollContainer = findTasksScrollContainer(rootRef.current);
    const scrollTarget: Window | HTMLElement = scrollContainer ?? window;

    const checkScrollPosition = (
      trigger: "initial" | "scroll" | "resize" = "scroll",
    ) => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const scrollHeight =
          scrollContainer?.scrollHeight ??
          document.documentElement.scrollHeight;
        if (scrollHeight === 0) return;
        const viewportHeight =
          scrollContainer?.clientHeight ?? window.innerHeight;
        const scrollBottom = scrollContainer
          ? scrollContainer.scrollTop + scrollContainer.clientHeight
          : window.scrollY + window.innerHeight;
        const hasScrollableOverflow = scrollHeight > viewportHeight + 1;
        const threshold = scrollHeight - TASK_SCROLL_LOAD_THRESHOLD_PX;
        if (scrollBottom >= threshold) {
          if (
            trigger === "initial" &&
            !hasMoreRenderedRows &&
            hasMoreTasks &&
            !hasScrollableOverflow
          ) {
            if (initialServerFillRequestedRef.current) return;
            initialServerFillRequestedRef.current = true;
          }
          loadMoreTaskRows();
        }
      });
    };

    const handleScroll = () => checkScrollPosition("scroll");
    const handleResize = () => checkScrollPosition("resize");
    scrollTarget.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    checkScrollPosition("initial");

    return () => {
      scrollTarget.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
      if (animationFrameId !== null)
        window.cancelAnimationFrame(animationFrameId);
    };
  }, [canLoadMoreTasks, hasMoreTasks, hasMoreRenderedRows, loadMoreTaskRows]);

  return { flatNavEntries, findSelectedNavElement, hasMoreRenderedRows, remainingTaskRowCount, loadMoreTaskRows };
}
