import type { TaskChatComposerHandle } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-task-chat/-TaskChatShared";
import type { useBreadcrumbs } from "@/context/BreadcrumbContext";
import type { usePanel } from "@/context/PanelContext";
import {
  hasBlockingShortcutDialog,
  resolveInboxQuickArchiveKeyAction,
  resolveTaskDetailGoKeyAction,
} from "@/lib/keyboardShortcuts";
import type { NavigationAction } from "@/lib/navigation-action";
import type { TaskDetailSource } from "@/lib/taskDetailBreadcrumb";
import type { Task, TaskAttachment, TaskTreeControlMode, TaskWorkProduct } from "@paperclipai/shared";
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  resolveTaskDetailResourceReveal,
  shouldScrollTaskDetailToTopOnNavigation,
  taskDetailSourceLabel,
} from "./-task-detail-model";
import { TaskDetailSourceLink } from "./-TaskDetailChat";
import { TaskInspector, type TaskInspectorProps, type TaskInspectorTab } from "./-TaskInspector";
import type { useTaskDetailActionMutations } from "./-useTaskDetailActionMutations";
import type { useTaskDetailCoreMutations } from "./-useTaskDetailCoreMutations";

interface TaskDetailEffectsOptions {
  companyId: string;
  taskId: string;
  task: Task | undefined;
  taskDetailSource: TaskDetailSource | null;
  breadcrumbTaskIdentifier: string;
  setBreadcrumbs: ReturnType<typeof useBreadcrumbs>["setBreadcrumbs"];
  navigationType: NavigationAction;
  panelTask: Task | null;
  panelChildTasks: Task[];
  taskPanelKey: string;
  childTasksLoading: boolean;
  inspectorTab: TaskInspectorTab;
  setInspectorTab: Dispatch<SetStateAction<TaskInspectorTab>>;
  liveTaskIds: TaskInspectorProps["liveTaskIds"];
  mutedChildTaskIds: TaskInspectorProps["mutedChildTaskIds"];
  childPauseBadgeById: TaskInspectorProps["childPauseBadgeById"];
  taskLinkState: TaskInspectorProps["taskLinkState"];
  attachmentList: TaskAttachment[];
  attachmentsInitialLoading: boolean;
  attachmentError: string | null;
  attachmentUploadPending: boolean;
  handleAttachmentFiles: TaskInspectorProps["onUploadFiles"];
  deleteAttachment: ReturnType<typeof useTaskDetailActionMutations>["deleteAttachment"];
  openAttachmentInGallery: TaskInspectorProps["onPreviewAttachment"];
  openOutputInGallery: TaskInspectorProps["onPreviewOutput"];
  openDocumentsWorkspace: () => void;
  resolvedHasActiveRun: boolean;
  openNewSubTask: () => void;
  handleTaskPropertiesUpdate: (data: Record<string, unknown>) => void;
  openPanel: ReturnType<typeof usePanel>["openPanel"];
  closePanel: ReturnType<typeof usePanel>["closePanel"];
  setPanelVisible: ReturnType<typeof usePanel>["setPanelVisible"];
  markTaskRead: ReturnType<typeof useTaskDetailCoreMutations>["markTaskRead"];
  archiveFromInbox: ReturnType<typeof useTaskDetailActionMutations>["archiveFromInbox"];
  keyboardShortcutsEnabled: boolean;
  navigateToTaskSource: (replace?: boolean) => Promise<unknown> | unknown;
  setDetailTab: Dispatch<SetStateAction<string>>;
  locationHash: string;
  isMobile: boolean;
  setMobileInspectorOpen: Dispatch<SetStateAction<boolean>>;
  setDocumentsWorkspaceOpen: Dispatch<SetStateAction<boolean>>;
  workProducts?: TaskWorkProduct[];
  detailTab: string;
}

/** Registers task-detail navigation, shortcut, panel, and anchor effects. */
export function useTaskDetailEffects({
  companyId,
  taskId,
  task,
  taskDetailSource,
  breadcrumbTaskIdentifier,
  setBreadcrumbs,
  navigationType,
  panelTask,
  panelChildTasks,
  taskPanelKey,
  childTasksLoading,
  inspectorTab,
  setInspectorTab,
  liveTaskIds,
  mutedChildTaskIds,
  childPauseBadgeById,
  taskLinkState,
  attachmentList,
  attachmentsInitialLoading,
  attachmentError,
  attachmentUploadPending,
  handleAttachmentFiles,
  deleteAttachment,
  openAttachmentInGallery,
  openOutputInGallery,
  openDocumentsWorkspace,
  resolvedHasActiveRun,
  openNewSubTask,
  handleTaskPropertiesUpdate,
  openPanel,
  closePanel,
  setPanelVisible,
  markTaskRead,
  archiveFromInbox,
  keyboardShortcutsEnabled,
  navigateToTaskSource,
  setDetailTab,
  locationHash,
  isMobile,
  setMobileInspectorOpen,
  setDocumentsWorkspaceOpen,
  workProducts,
  detailTab,
}: TaskDetailEffectsOptions) {
  const lastMarkedReadTaskIdRef = useRef<string | null>(null);
  const lastScrollTaskIdRef = useRef<string | undefined>(undefined);
  const commentComposerRef = useRef<TaskChatComposerHandle | null>(null);
  const [pendingCommentComposerFocusKey, setPendingCommentComposerFocusKey] = useState(0);
  const goToInboxShortcutArmedRef = useRef(false);
  const goToInboxShortcutTimeoutRef = useRef<number | null>(null);
  const resourceRevealKeyRef = useRef<string | null>(null);
  const resourceRevealTaskIdRef = useRef(taskId);
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
        label: breadcrumbTaskIdentifier,
      },
    ]);
  }, [breadcrumbTaskIdentifier, companyId, setBreadcrumbs, taskDetailSource]);

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
      createElement(TaskInspector, {
        key: panelTask.id,
        activeTab: inspectorTab,
        onTabChange: setInspectorTab,
        task: panelTask,
        childTasks: panelChildTasks,
        childTasksLoading,
        liveTaskIds,
        mutedChildTaskIds,
        childPauseBadgeById,
        taskLinkState,
        onAddSubTask: openNewSubTask,
        attachments: attachmentList,
        attachmentsLoading: attachmentsInitialLoading,
        attachmentError,
        attachmentUploadPending,
        onUploadFiles: handleAttachmentFiles,
        attachmentDeletePending: deleteAttachment.isPending,
        onDeleteAttachment: deleteAttachment.mutate,
        onPreviewAttachment: openAttachmentInGallery,
        workProducts,
        onPreviewOutput: openOutputInGallery,
        onOpenDocuments: openDocumentsWorkspace,
        onUpdateTask: handleTaskPropertiesUpdate,
        hasActiveRun: resolvedHasActiveRun,
      }),
      { title: "Task details", headerMode: "content" },
    );
  }, [
    attachmentError,
    attachmentList,
    attachmentUploadPending,
    attachmentsInitialLoading,
    childPauseBadgeById,
    childTasksLoading,
    closePanel,
    deleteAttachment.isPending,
    deleteAttachment.mutate,
    handleAttachmentFiles,
    handleTaskPropertiesUpdate,
    inspectorTab,
    liveTaskIds,
    mutedChildTaskIds,
    openAttachmentInGallery,
    openDocumentsWorkspace,
    taskPanelKey,
    openNewSubTask,
    openOutputInGallery,
    openPanel,
    panelChildTasks,
    panelTask,
    resolvedHasActiveRun,
    setInspectorTab,
    taskLinkState,
    workProducts,
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
    if (resourceRevealTaskIdRef.current === taskId) return;
    resourceRevealTaskIdRef.current = taskId;
    resourceRevealKeyRef.current = null;
    setDocumentsWorkspaceOpen(false);
    setMobileInspectorOpen(false);
  }, [setDocumentsWorkspaceOpen, setMobileInspectorOpen, taskId]);

  useEffect(() => {
    const reveal = resolveTaskDetailResourceReveal(locationHash);
    if (!reveal) return;

    const revealKey = `${taskId}:${locationHash}`;
    if (resourceRevealKeyRef.current !== revealKey) {
      resourceRevealKeyRef.current = revealKey;
      if (reveal.kind === "document") {
        setDocumentsWorkspaceOpen(true);
      } else {
        setInspectorTab("resources");
        if (isMobile) setMobileInspectorOpen(true);
        else setPanelVisible(true);
      }
    }

    if (reveal.kind !== "artifact") return;
    const targetId = `${reveal.target.kind}-${reveal.target.id}`;
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
  }, [
    attachmentList,
    isMobile,
    locationHash,
    setDocumentsWorkspaceOpen,
    setInspectorTab,
    setMobileInspectorOpen,
    setPanelVisible,
    taskId,
    workProducts,
  ]);

  useEffect(() => {
    if (pendingCommentComposerFocusKey === 0 || detailTab !== "chat") return;
    commentComposerRef.current?.focus();
  }, [detailTab, pendingCommentComposerFocusKey]);

  return { commentComposerRef };
}

/** Owns the route-local UI state shared by the task-detail feature hooks. */
export function useTaskDetailState() {
  const [copied, setCopied] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<TaskInspectorTab>("details");
  const [documentsWorkspaceOpen, setDocumentsWorkspaceOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("chat");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [treeControlOpen, setTreeControlOpen] = useState(false);
  const [treeControlMode, setTreeControlMode] = useState<TaskTreeControlMode>("pause");
  const [treeControlReason, setTreeControlReason] = useState("");
  const [treeControlCancelConfirmed, setTreeControlCancelConfirmed] = useState(false);
  const openDocumentsWorkspace = useCallback(() => setDocumentsWorkspaceOpen(true), []);

  return {
    copied,
    setCopied,
    mobileInspectorOpen,
    setMobileInspectorOpen,
    inspectorTab,
    setInspectorTab,
    documentsWorkspaceOpen,
    setDocumentsWorkspaceOpen,
    openDocumentsWorkspace,
    detailTab,
    setDetailTab,
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
  };
}

export { useTaskDetailCacheActions } from "./-useTaskDetailCacheActions";
