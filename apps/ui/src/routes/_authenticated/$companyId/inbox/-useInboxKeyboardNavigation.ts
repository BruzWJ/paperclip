import {
  getInboxKeyboardSelectionIndex,
  getInboxWorkItemKey,
  resolveInboxSelectionIndex,
  type InboxWorkItem,
} from "@/lib/inbox";
import {
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
  resolveInboxUndoArchiveKeyAction,
} from "@/lib/keyboardShortcuts";
import {
  armTaskDetailInboxQuickArchive,
  withTaskDetailHeaderSeed,
  type TaskDetailLocationState,
} from "@/lib/taskDetailBreadcrumb";
import { prefetchTaskDetail } from "@/lib/taskDetailCache";
import type { Task } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { navEntryKey } from "./-inbox-controller-model";
import type { useInboxMutations } from "./-useInboxMutations";
import type { InboxState } from "./-useInboxState";
import type { useInboxWorkItems } from "./-useInboxWorkItems";

type InboxMutations = ReturnType<typeof useInboxMutations>;
type InboxWorkItems = ReturnType<typeof useInboxWorkItems>;

export interface UseInboxKeyboardNavigationOptions {
  companyId: string;
  keyboardShortcutsEnabled: boolean;
  taskLinkState: TaskDetailLocationState;
  state: InboxState;
  workItems: InboxWorkItems;
  mutations: InboxMutations;
}

/** Provides stable mail-client keyboard navigation for the live inbox list. */
export function useInboxKeyboardNavigation({
  companyId,
  keyboardShortcutsEnabled,
  taskLinkState,
  state,
  workItems,
  mutations,
}: UseInboxKeyboardNavigationOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { flatNavItems, flatNavItemsRef, groupedSections, nonInboxSearchTaskIds } = workItems;
  const {
    selectedIndex,
    setSelectedIndex,
    listRef,
    pointerMovedSinceKeyNavRef,
    hoveredIndexRef,
    hoveredNavKeyRef,
    archivingTaskIds,
    undoableArchiveTaskIds,
    unarchivingTaskIds,
    archivingNonTaskIds,
    fadingOutTasks,
    readItems,
    markItemUnread,
    setGroupCollapsed,
    setInboxParentCollapsed,
  } = state;
  const {
    canArchiveFromTab,
    archiveTaskMutation,
    unarchiveTaskMutation,
    markReadMutation,
    markUnreadMutation,
    handleArchiveNonTask,
    handleMarkNonTaskRead,
  } = mutations;

  useEffect(() => {
    const handlePointerMove = () => {
      pointerMovedSinceKeyNavRef.current = true;
    };
    window.addEventListener("mousemove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("mousemove", handlePointerMove);
  }, [pointerMovedSinceKeyNavRef]);

  const setSelectedIndexFromPointer = useCallback(
    (index: number) => {
      if (!pointerMovedSinceKeyNavRef.current) return;
      hoveredIndexRef.current = index;
      hoveredNavKeyRef.current = navEntryKey(flatNavItemsRef.current[index]);
      setSelectedIndex((previous) => (previous < 0 ? previous : -1));
    },
    [flatNavItemsRef, hoveredIndexRef, hoveredNavKeyRef, pointerMovedSinceKeyNavRef, setSelectedIndex],
  );

  const selectedNavKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const hoveredKey = hoveredNavKeyRef.current;
    const nextHovered =
      hoveredKey === null ? -1 : flatNavItems.findIndex((entry) => navEntryKey(entry) === hoveredKey);
    hoveredIndexRef.current = nextHovered >= 0 ? nextHovered : null;
    if (nextHovered < 0) hoveredNavKeyRef.current = null;
    setSelectedIndex((previous) => {
      if (previous < 0) return resolveInboxSelectionIndex(previous, flatNavItems.length);
      const previousKey = selectedNavKeyRef.current;
      const keyIndex =
        previousKey === null ? -1 : flatNavItems.findIndex((entry) => navEntryKey(entry) === previousKey);
      return keyIndex >= 0 ? keyIndex : resolveInboxSelectionIndex(previous, flatNavItems.length);
    });
  }, [flatNavItems, hoveredIndexRef, hoveredNavKeyRef, setSelectedIndex]);
  useEffect(() => {
    selectedNavKeyRef.current = selectedIndex >= 0 ? navEntryKey(flatNavItems[selectedIndex]) : null;
  }, [flatNavItems, selectedIndex]);

  const kbStateRef = useRef({
    workItems: groupedSections,
    flatNavItems,
    selectedIndex,
    canArchive: canArchiveFromTab,
    nonInboxSearchTaskIds,
    archivingTaskIds,
    undoableArchiveTaskIds,
    unarchivingTaskIds,
    archivingNonTaskIds,
    fadingOutTasks,
    readItems,
  });
  kbStateRef.current = {
    workItems: groupedSections,
    flatNavItems,
    selectedIndex,
    canArchive: canArchiveFromTab,
    nonInboxSearchTaskIds,
    archivingTaskIds,
    undoableArchiveTaskIds,
    unarchivingTaskIds,
    archivingNonTaskIds,
    fadingOutTasks,
    readItems,
  };
  const kbActions = {
    archiveTask: (id: string) => archiveTaskMutation.mutate(id),
    undoArchiveTask: (id: string) => unarchiveTaskMutation.mutate(id),
    archiveNonTask: handleArchiveNonTask,
    markRead: (id: string) => markReadMutation.mutate(id),
    markUnreadTask: (id: string) => markUnreadMutation.mutate(id),
    markNonTaskRead: handleMarkNonTaskRead,
    markNonTaskUnread: markItemUnread,
    setGroupCollapsed,
    setInboxParentCollapsed,
    navigateToTask: (taskNumber: number, locationState?: TaskDetailLocationState) => {
      void navigate({
        to: "/$companyId/tasks/$taskNumber",
        params: { companyId, taskNumber: String(taskNumber) },
        state: locationState as never,
      });
    },
    navigateToApproval: (approvalId: string) =>
      void navigate({
        to: "/$companyId/approvals/$approvalId",
        params: { companyId, approvalId },
      }),
    navigateToRun: (agentId: string, runId: string) =>
      void navigate({
        to: "/$companyId/agents/$agentId/runs/$runId",
        params: { companyId, agentId, runId },
      }),
  };
  const kbActionsRef = useRef(kbActions);
  kbActionsRef.current = kbActions;

  useEffect(() => {
    if (!keyboardShortcutsEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        isKeyboardShortcutTextInputTarget(target) ||
        hasBlockingShortcutDialog(document) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const current = kbStateRef.current;
      const actions = kbActionsRef.current;
      const undoAction = !current.canArchive
        ? "none"
        : resolveInboxUndoArchiveKeyAction({
            hasUndoableArchive: current.undoableArchiveTaskIds.length > 0,
            defaultPrevented: event.defaultPrevented,
            key: event.key,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            target,
            hasOpenDialog: hasBlockingShortcutDialog(document),
          });
      if (undoAction === "undo_archive") {
        const taskId = current.undoableArchiveTaskIds[current.undoableArchiveTaskIds.length - 1];
        if (!taskId || current.unarchivingTaskIds.has(taskId)) return;
        event.preventDefault();
        actions.undoArchiveTask(taskId);
        return;
      }
      const navItems = current.flatNavItems;
      const navCount = navItems.length;
      if (navCount === 0) return;
      const resolveNavEntry = (index: number): { task?: Task; item?: InboxWorkItem } => {
        const entry = navItems[index];
        if (!entry) return {};
        if (entry.type === "child") return { task: entry.task };
        if (entry.type === "top") return { item: entry.item };
        return {};
      };
      const rawHovered = hoveredIndexRef.current;
      const hoveredIndex = rawHovered != null && rawHovered >= 0 && rawHovered < navCount ? rawHovered : -1;
      const fromHover = pointerMovedSinceKeyNavRef.current && hoveredIndex >= 0;
      const effectiveIndex = fromHover ? hoveredIndex : current.selectedIndex;
      switch (event.key) {
        case "j":
        case "ArrowDown":
        case "k":
        case "ArrowUp": {
          event.preventDefault();
          pointerMovedSinceKeyNavRef.current = false;
          setSelectedIndex(
            getInboxKeyboardSelectionIndex(
              effectiveIndex,
              navCount,
              event.key === "j" || event.key === "ArrowDown" ? "next" : "previous",
            ),
          );
          break;
        }
        case "ArrowLeft":
        case "ArrowRight": {
          if (effectiveIndex < 0 || effectiveIndex >= navCount) return;
          const entry = navItems[effectiveIndex];
          if (!entry) return;
          if (entry.type === "group") {
            event.preventDefault();
            pointerMovedSinceKeyNavRef.current = false;
            setSelectedIndex(effectiveIndex);
            actions.setGroupCollapsed(entry.groupKey, event.key === "ArrowLeft");
            break;
          }
          const { task, item } = resolveNavEntry(effectiveIndex);
          const targetTask = task ?? (item?.kind === "task" ? item.task : null);
          if (!targetTask) return;
          const hasChildren = current.workItems.some(
            (group) => (group.childrenByTaskId.get(targetTask.id)?.length ?? 0) > 0,
          );
          if (!hasChildren) return;
          event.preventDefault();
          pointerMovedSinceKeyNavRef.current = false;
          setSelectedIndex(effectiveIndex);
          actions.setInboxParentCollapsed(targetTask.id, event.key === "ArrowLeft");
          break;
        }
        case "a":
        case "y": {
          if (!current.canArchive || effectiveIndex < 0 || effectiveIndex >= navCount) return;
          event.preventDefault();
          const { task, item } = resolveNavEntry(effectiveIndex);
          const targetTask = task ?? (item?.kind === "task" ? item.task : null);
          if (
            targetTask &&
            !current.nonInboxSearchTaskIds.has(targetTask.id) &&
            !current.archivingTaskIds.has(targetTask.id)
          ) {
            actions.archiveTask(targetTask.id);
          } else if (item && item.kind !== "task") {
            const key = getInboxWorkItemKey(item);
            if (!current.archivingNonTaskIds.has(key)) actions.archiveNonTask(key);
          }
          break;
        }
        case "U": {
          if (!current.canArchive || effectiveIndex < 0 || effectiveIndex >= navCount) return;
          event.preventDefault();
          const { task, item } = resolveNavEntry(effectiveIndex);
          const targetTask = task ?? (item?.kind === "task" ? item.task : null);
          if (targetTask) actions.markUnreadTask(targetTask.id);
          else if (item) actions.markNonTaskUnread(getInboxWorkItemKey(item));
          break;
        }
        case "r": {
          if (!current.canArchive || effectiveIndex < 0 || effectiveIndex >= navCount) return;
          event.preventDefault();
          const { task, item } = resolveNavEntry(effectiveIndex);
          const targetTask = task ?? (item?.kind === "task" ? item.task : null);
          if (targetTask?.isUnreadForMe && !current.fadingOutTasks.has(targetTask.id)) {
            actions.markRead(targetTask.id);
          } else if (item && item.kind !== "task") {
            const key = getInboxWorkItemKey(item);
            if (!current.readItems.has(key)) actions.markNonTaskRead(key);
          }
          break;
        }
        case "Enter": {
          if (effectiveIndex < 0 || effectiveIndex >= navCount) return;
          event.preventDefault();
          const { task, item } = resolveNavEntry(effectiveIndex);
          const targetTask = task ?? (item?.kind === "task" ? item.task : null);
          if (targetTask) {
            const detailState = armTaskDetailInboxQuickArchive(
              withTaskDetailHeaderSeed(taskLinkState, targetTask),
            );
            void prefetchTaskDetail(queryClient, targetTask.id, {
              task: targetTask,
            });
            actions.navigateToTask(targetTask.taskNumber, detailState);
          } else if (item?.kind === "approval") {
            actions.navigateToApproval(item.approval.id);
          } else if (item?.kind === "failed_run") {
            actions.navigateToRun(item.run.targetAgentId, item.run.id);
          }
          break;
        }
        default:
          return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keyboardShortcutsEnabled, taskLinkState]);

  useEffect(() => {
    if (selectedIndex < 0 || !listRef.current) return;
    const rows = listRef.current.querySelectorAll("[data-inbox-item]");
    rows[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [listRef, selectedIndex]);

  return {
    navigate,
    queryClient,
    setSelectedIndexFromPointer,
    selectedNavKeyRef,
    kbStateRef,
    kbActions,
    kbActionsRef,
  };
}
