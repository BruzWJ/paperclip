import { TaskProperties } from "@/components/task-properties/TaskProperties";
import type { TaskChatComposerHandle } from "@/components/TaskChatThread";
import type { useBreadcrumbs } from "@/context/BreadcrumbContext";
import type { usePanel } from "@/context/PanelContext";
import {
  hasBlockingShortcutDialog,
  resolveInboxQuickArchiveKeyAction,
  resolveTaskDetailGoKeyAction,
} from "@/lib/keyboardShortcuts";
import type { NavigationAction } from "@/lib/navigation-action";
import { parseTaskArtifactFragment } from "@/lib/task-artifact-fragment";
import type { TaskDetailSource } from "@/lib/taskDetailBreadcrumb";
import type { Task, TaskAttachment, TaskTreeControlMode, TaskWorkProduct } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  applyOptimisticTaskFieldUpdate,
  applyOptimisticTaskFieldUpdateToCollection,
  matchesTaskId,
  type ClientTaskComment,
} from "@/lib/optimistic-task-comments";
import { queryKeys } from "@/lib/queryKeys";

import { shouldScrollTaskDetailToTopOnNavigation, taskDetailSourceLabel } from "./-task-detail-model";
import { TaskDetailSourceLink } from "./-TaskDetailChatTab";
import type { useTaskDetailActionMutations } from "./-useTaskDetailActionMutations";
import type { useTaskDetailCoreMutations } from "./-useTaskDetailCoreMutations";

export interface TaskDetailEffectsOptions {
  companyId: string;
  taskId: string;
  task: Task | undefined;
  taskDetailSource: TaskDetailSource | null;
  breadcrumbTitle: string;
  breadcrumbStatusLeading: ReactNode;
  breadcrumbStatusKey?: string;
  hasLiveRuns: boolean;
  setBreadcrumbs: ReturnType<typeof useBreadcrumbs>["setBreadcrumbs"];
  navigationType: NavigationAction;
  panelTask: Task | null;
  panelChildTasks: Task[];
  taskPanelKey: string;
  resolvedHasActiveRun: boolean;
  openNewSubTask: () => void;
  handleTaskPropertiesUpdate: (data: Record<string, unknown>) => void;
  openPanel: ReturnType<typeof usePanel>["openPanel"];
  closePanel: ReturnType<typeof usePanel>["closePanel"];
  markTaskRead: ReturnType<typeof useTaskDetailCoreMutations>["markTaskRead"];
  archiveFromInbox: ReturnType<typeof useTaskDetailActionMutations>["archiveFromInbox"];
  keyboardShortcutsEnabled: boolean;
  navigateToTaskSource: (replace?: boolean) => Promise<unknown> | unknown;
  setDetailTab: Dispatch<SetStateAction<string>>;
  locationHash: string;
  workProducts?: TaskWorkProduct[];
  attachments?: TaskAttachment[];
  detailTab: string;
}

/** Registers task-detail navigation, shortcut, panel, and anchor effects. */
export function useTaskDetailEffects({
  companyId,
  taskId,
  task,
  taskDetailSource,
  breadcrumbTitle,
  breadcrumbStatusLeading,
  breadcrumbStatusKey,
  hasLiveRuns,
  setBreadcrumbs,
  navigationType,
  panelTask,
  panelChildTasks,
  taskPanelKey,
  resolvedHasActiveRun,
  openNewSubTask,
  handleTaskPropertiesUpdate,
  openPanel,
  closePanel,
  markTaskRead,
  archiveFromInbox,
  keyboardShortcutsEnabled,
  navigateToTaskSource,
  setDetailTab,
  locationHash,
  workProducts,
  attachments,
  detailTab,
}: TaskDetailEffectsOptions) {
  const lastMarkedReadTaskIdRef = useRef<string | null>(null);
  const lastScrollTaskIdRef = useRef<string | undefined>(undefined);
  const commentComposerRef = useRef<TaskChatComposerHandle | null>(null);
  const [pendingCommentComposerFocusKey, setPendingCommentComposerFocusKey] = useState(0);
  const goToInboxShortcutArmedRef = useRef(false);
  const goToInboxShortcutTimeoutRef = useRef<number | null>(null);
  const canQuickArchiveFromInbox = keyboardShortcutsEnabled && !task?.hiddenAt;

  useEffect(() => {
    setBreadcrumbs([
      {
        label: taskDetailSourceLabel(taskDetailSource),
        renderLink: (content) =>
          createElement(TaskDetailSourceLink, {
            source: taskDetailSource,
            companyId,
            children: content,
          }),
      },
      {
        label: breadcrumbTitle,
        leading: breadcrumbStatusLeading,
        leadingKey: breadcrumbStatusKey,
      },
    ]);
  }, [
    breadcrumbTitle,
    companyId,
    hasLiveRuns,
    setBreadcrumbs,
    taskDetailSource,
    breadcrumbStatusLeading,
    breadcrumbStatusKey,
  ]);

  useEffect(() => {
    const previousTaskId = lastScrollTaskIdRef.current;
    const nextTaskId = taskId ?? undefined;
    lastScrollTaskIdRef.current = nextTaskId;
    if (
      !shouldScrollTaskDetailToTopOnNavigation({
        previousTaskId,
        nextTaskId,
        navigationType,
      })
    ) {
      return;
    }
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const main = document.getElementById("main-content");
    if (main) main.scrollTop = 0;
  }, [taskId, navigationType]);

  useEffect(() => {
    if (!task?.id || lastMarkedReadTaskIdRef.current === task.id) return;
    lastMarkedReadTaskIdRef.current = task.id;
    markTaskRead.mutate(task.id);
  }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!panelTask) {
      closePanel();
      return;
    }
    openPanel(
      createElement(TaskProperties, {
        task: panelTask,
        childTasks: panelChildTasks,
        onAddSubTask: openNewSubTask,
        onUpdate: handleTaskPropertiesUpdate,
        hasActiveRun: resolvedHasActiveRun,
      }),
    );
  }, [
    closePanel,
    handleTaskPropertiesUpdate,
    taskPanelKey,
    openNewSubTask,
    openPanel,
    panelChildTasks,
    panelTask,
    resolvedHasActiveRun,
  ]);
  useEffect(() => () => closePanel(), [closePanel]);

  useEffect(() => {
    if (!task?.id || !canQuickArchiveFromInbox) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveInboxQuickArchiveKeyAction({
        armed: canQuickArchiveFromInbox,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });
      if (action !== "archive") return;
      event.preventDefault();
      if (!archiveFromInbox.isPending) archiveFromInbox.mutate(task.id);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [archiveFromInbox, canQuickArchiveFromInbox, task?.id]);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) {
      goToInboxShortcutArmedRef.current = false;
      if (goToInboxShortcutTimeoutRef.current !== null) {
        window.clearTimeout(goToInboxShortcutTimeoutRef.current);
        goToInboxShortcutTimeoutRef.current = null;
      }
      return;
    }
    const clearArmTimeout = () => {
      if (goToInboxShortcutTimeoutRef.current !== null) {
        window.clearTimeout(goToInboxShortcutTimeoutRef.current);
        goToInboxShortcutTimeoutRef.current = null;
      }
    };
    const disarm = () => {
      goToInboxShortcutArmedRef.current = false;
      clearArmTimeout();
    };
    const arm = () => {
      goToInboxShortcutArmedRef.current = true;
      clearArmTimeout();
      goToInboxShortcutTimeoutRef.current = window.setTimeout(() => {
        goToInboxShortcutArmedRef.current = false;
        goToInboxShortcutTimeoutRef.current = null;
      }, 1200);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== document.body) {
        disarm();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveTaskDetailGoKeyAction({
        armed: goToInboxShortcutArmedRef.current,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });
      if (action === "ignore") return;
      if (action === "arm") {
        arm();
        return;
      }
      disarm();
      if (action === "navigate_inbox") {
        event.preventDefault();
        event.stopPropagation();
        void navigateToTaskSource();
      } else if (action === "focus_comment") {
        event.preventDefault();
        event.stopPropagation();
        setDetailTab("chat");
        setPendingCommentComposerFocusKey((current) => current + 1);
      }
    };
    document.addEventListener("pointerdown", disarm, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      disarm();
      document.removeEventListener("pointerdown", disarm, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [keyboardShortcutsEnabled, navigateToTaskSource, setDetailTab]);

  useEffect(() => {
    const target = parseTaskArtifactFragment(locationHash);
    if (!target) return;
    const targetId = `${target.kind}-${target.id}`;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryScroll = () => {
      if (cancelled) return;
      const element = document.getElementById(targetId);
      if (!element) {
        if (attempts < 30) {
          attempts += 1;
          timer = setTimeout(tryScroll, 100);
        }
        return;
      }
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.add("ring-2", "ring-primary/50", "transition-shadow");
      timer = setTimeout(
        () => element.classList.remove("ring-2", "ring-primary/50", "transition-shadow"),
        3000,
      );
    };
    tryScroll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [locationHash, workProducts, attachments]);

  useEffect(() => {
    if (pendingCommentComposerFocusKey === 0 || detailTab !== "chat") return;
    commentComposerRef.current?.focus();
  }, [detailTab, pendingCommentComposerFocusKey]);

  return { commentComposerRef };
}

/** Owns the route-local UI state shared by the task-detail feature hooks. */
export function useTaskDetailState() {
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("chat");
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [treeControlOpen, setTreeControlOpen] = useState(false);
  const [treeControlMode, setTreeControlMode] = useState<TaskTreeControlMode>("pause");
  const [treeControlReason, setTreeControlReason] = useState("");
  const [treeControlCancelConfirmed, setTreeControlCancelConfirmed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return {
    moreOpen,
    setMoreOpen,
    copied,
    setCopied,
    mobilePropsOpen,
    setMobilePropsOpen,
    detailTab,
    setDetailTab,
    attachmentDragActive,
    setAttachmentDragActive,
    galleryOpen,
    setGalleryOpen,
    galleryIndex,
    setGalleryIndex,
    treeControlOpen,
    setTreeControlOpen,
    treeControlMode,
    setTreeControlMode,
    treeControlReason,
    setTreeControlReason,
    treeControlCancelConfirmed,
    setTreeControlCancelConfirmed,
    fileInputRef,
  };
}

/** Centralizes cache updates shared by task-detail mutations. */
export function useTaskDetailCacheActions(companyId: string, taskId: string) {
  const queryClient = useQueryClient();
  const invalidateTaskDetail = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.activity(taskId),
    });
  }, [taskId, queryClient]);
  const invalidateTaskThreadLazily = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.detail(taskId),
      refetchType: "inactive",
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.activity(taskId),
      refetchType: "inactive",
    });
  }, [taskId, queryClient]);
  const invalidateTaskRunState = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["tasks", "runs", taskId] });
  }, [taskId, queryClient]);
  const upsertCommentInCache = useCallback(
    (_comment: ClientTaskComment) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.comments(taskId),
      });
    },
    [taskId, queryClient],
  );
  const invalidateTaskCollections = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.list(companyId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.listMineByMe(companyId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.listTouchedByMe(companyId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.listUnreadTouchedByMe(companyId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.sidebarBadges(companyId),
    });
  }, [queryClient, companyId]);
  const applyOptimisticTaskCacheUpdate = useCallback(
    (canonicalTaskId: string, data: Record<string, unknown>) => {
      queryClient.setQueryData<Task>(queryKeys.tasks.detail(canonicalTaskId), (cached) =>
        cached ? applyOptimisticTaskFieldUpdate(cached, data) : cached,
      );
      queryClient.setQueryData<Task[] | undefined>(queryKeys.tasks.list(companyId), (cached) =>
        applyOptimisticTaskFieldUpdateToCollection(cached, canonicalTaskId, data),
      );
    },
    [queryClient, companyId],
  );
  const mergeTaskResponseIntoCaches = useCallback(
    (nextTask: Task) => {
      queryClient.setQueryData<Task>(queryKeys.tasks.detail(nextTask.id), (cached) =>
        cached ? { ...cached, ...nextTask } : nextTask,
      );
      queryClient.setQueryData<Task[] | undefined>(queryKeys.tasks.list(companyId), (cached) =>
        cached?.map((item) => (matchesTaskId(item, nextTask.id) ? { ...item, ...nextTask } : item)),
      );
    },
    [queryClient, companyId],
  );

  return {
    invalidateTaskDetail,
    invalidateTaskThreadLazily,
    invalidateTaskRunState,
    upsertCommentInCache,
    invalidateTaskCollections,
    applyOptimisticTaskCacheUpdate,
    mergeTaskResponseIntoCaches,
  };
}
