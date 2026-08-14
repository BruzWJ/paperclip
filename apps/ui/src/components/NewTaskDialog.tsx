import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { type CreateTask, type TaskWorkMode } from "@paperclipai/shared";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { buildMarkdownMentionOptions, isAgentTaskOwnerTarget } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { isTaskWorkMode, nextWorkMode, workModeMetaList } from "../lib/work-mode-meta";
import type { MarkdownEditorRef, MentionOption } from "./MarkdownEditor";
import {
  DEBOUNCE_MS,
  clearDraft,
  isWorkModePeriodShortcut,
  loadDraft,
  saveDraft,
  statusOptions,
  type StagedTaskFile,
  type TaskDraft,
} from "./new-task-dialog/model";
import { useNewTaskCreation } from "./new-task-dialog/useNewTaskCreation";
import { useNewTaskDialogOptions } from "./new-task-dialog/useNewTaskDialogOptions";
import { NewTaskDialogContext } from "./new-task-dialog/context";
import { NewTaskDialogFrame } from "./new-task-dialog/NewTaskDialogFrame";
import { useStagedTaskFiles } from "./new-task-dialog/useStagedTaskFiles";

export function NewTaskDialog() {
  const { newTaskOpen, newTaskDefaults, closeNewTask } = useDialog();
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const workModeOptions = useMemo(() => workModeMetaList(), []);
  const statuses = statusOptions;
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const titleRef = useRef("");
  const requestRef = useRef("");
  const [requestHasText, setRequestHasText] = useState(false);
  const [draftHasText, setDraftHasText] = useState(false);
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [reviewerValue, setReviewerValue] = useState("");
  const [approverValue, setApproverValue] = useState("");
  const [showReviewerRow, setShowReviewerRow] = useState(false);
  const [showApproverRow, setShowApproverRow] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [projectWorkspaceId, setProjectWorkspaceId] = useState("");
  const [workMode, setWorkMode] = useState<TaskWorkMode>("standard");
  const [expanded, setExpanded] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<StagedTaskFile[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializationKeyRef = useRef<string | null>(null);
  const createIdempotencyKeyRef = useRef<string | null>(null);

  const isSubTaskMode = Boolean(newTaskDefaults.parentId);
  const parentTaskLabel =
    newTaskDefaults.parentIdentifier ??
    (newTaskDefaults.parentId ? newTaskDefaults.parentId.slice(0, 8) : "");

  const requestEditorRef = useRef<MarkdownEditorRef>(null);
  const stageFileInputRef = useRef<HTMLInputElement | null>(null);
  const ownerSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: newTaskOpen,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: newTaskOpen,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: newTaskOpen,
  });
  const currentUserId = session?.user.id ?? null;
  const activeProjects = useMemo(() => (projects ?? []).filter((p) => !p.archivedAt), [projects]);
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    companyId,
    userId: currentUserId,
  });

  const selectedOwnerAgentId = ownerAgentId || null;
  const mentionOptions = useMemo<MentionOption[]>(
    () => buildMarkdownMentionOptions({ agents, projects: orderedProjects, members: companyMembers?.users }),
    [agents, companyMembers?.users, orderedProjects],
  );

  const { createTask, uploadRequestImageHandler } = useNewTaskCreation({
    companyId,
    closeNewTask,
    reset,
    draftTimer,
  });

  // Debounced draft saving
  const scheduleSave = useCallback((draft: TaskDraft) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      if (draft.title.trim() || draft.request.trim()) saveDraft(draft);
    }, DEBOUNCE_MS);
  }, []);

  const setTaskText = useCallback((nextTitle: string, nextRequest: string) => {
    titleRef.current = nextTitle;
    requestRef.current = nextRequest;
    setTitle(nextTitle);
    setRequest(nextRequest);
    setRequestHasText(nextRequest.trim().length > 0);
    setDraftHasText(nextTitle.trim().length > 0 || nextRequest.trim().length > 0);
  }, []);

  const queueDraftSave = useCallback(
    (overrides: { title?: string; request?: string } = {}) => {
      if (!newTaskOpen) return;
      const nextTitle = overrides.title ?? titleRef.current;
      const nextRequest = overrides.request ?? requestRef.current;
      scheduleSave({
        title: nextTitle,
        request: nextRequest,
        status,
        priority,
        ownerAgentId,
        reviewerValue,
        approverValue,
        projectId,
        workMode,
      });
    },
    [
      newTaskOpen,
      scheduleSave,
      status,
      priority,
      ownerAgentId,
      reviewerValue,
      approverValue,
      projectId,
      workMode,
    ],
  );

  const handleTitleChange = useCallback(
    (nextTitle: string) => {
      titleRef.current = nextTitle;
      const nextTitleHasText = nextTitle.trim().length > 0;
      const nextDraftHasText = nextTitleHasText || requestRef.current.trim().length > 0;
      setDraftHasText((current) => (current === nextDraftHasText ? current : nextDraftHasText));
      queueDraftSave({ title: nextTitle });
    },
    [queueDraftSave],
  );

  const handleRequestChange = useCallback(
    (nextRequest: string) => {
      requestRef.current = nextRequest;
      const nextRequestHasText = nextRequest.trim().length > 0;
      const nextDraftHasText = titleRef.current.trim().length > 0 || nextRequest.trim().length > 0;
      setRequestHasText((current) => (current === nextRequestHasText ? current : nextRequestHasText));
      setDraftHasText((current) => (current === nextDraftHasText ? current : nextDraftHasText));
      queueDraftSave({ request: nextRequest });
    },
    [queueDraftSave],
  );

  // Save draft on meaningful changes
  useEffect(() => {
    if (!newTaskOpen) return;
    queueDraftSave();
  }, [
    status,
    priority,
    ownerAgentId,
    reviewerValue,
    approverValue,
    projectId,
    workMode,
    newTaskOpen,
    queueDraftSave,
  ]);

  // Restore draft or apply defaults when dialog opens
  useEffect(() => {
    if (!newTaskOpen) {
      initializationKeyRef.current = null;
      createIdempotencyKeyRef.current = null;
      return;
    }
    const initializationKey = `${companyId}:${JSON.stringify(newTaskDefaults)}`;
    if (initializationKeyRef.current === initializationKey) return;
    initializationKeyRef.current = initializationKey;

    const draft = loadDraft();
    if (newTaskDefaults.parentId) {
      const nextWorkMode = isTaskWorkMode(newTaskDefaults.workMode) ? newTaskDefaults.workMode : "standard";
      const defaultProjectId = newTaskDefaults.projectId ?? "";
      setTaskText(newTaskDefaults.title ?? "", newTaskDefaults.request ?? "");
      setStatus(newTaskDefaults.status ?? "todo");
      setPriority(newTaskDefaults.priority ?? "");
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(newTaskDefaults.projectWorkspaceId ?? "");
      setOwnerAgentId(newTaskDefaults.ownerAgentId ?? "");
      setWorkMode(nextWorkMode);
    } else if (newTaskDefaults.title || newTaskDefaults.request) {
      const nextWorkMode = isTaskWorkMode(newTaskDefaults.workMode) ? newTaskDefaults.workMode : "standard";
      setTaskText(newTaskDefaults.title ?? "", newTaskDefaults.request ?? "");
      setStatus(newTaskDefaults.status ?? "todo");
      setPriority(newTaskDefaults.priority ?? "");
      const defaultProjectId = newTaskDefaults.projectId ?? "";
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(newTaskDefaults.projectWorkspaceId ?? "");
      setOwnerAgentId(newTaskDefaults.ownerAgentId ?? "");
      setReviewerValue("");
      setApproverValue("");
      setShowReviewerRow(false);
      setShowApproverRow(false);
      setWorkMode(nextWorkMode);
    } else if (draft && (draft.title.trim() || draft.request.trim())) {
      const nextWorkMode = isTaskWorkMode(draft.workMode) ? draft.workMode : "standard";
      const restoredProjectId = newTaskDefaults.projectId ?? draft.projectId;
      setTaskText(draft.title, draft.request);
      setStatus(draft.status || "todo");
      setPriority(draft.priority);
      setOwnerAgentId(newTaskDefaults.ownerAgentId ?? draft.ownerAgentId);
      setReviewerValue(draft.reviewerValue ?? "");
      setApproverValue(draft.approverValue ?? "");
      setShowReviewerRow(!!draft.reviewerValue);
      setShowApproverRow(!!draft.approverValue);
      setProjectId(restoredProjectId);
      setProjectWorkspaceId(newTaskDefaults.projectWorkspaceId ?? "");
      setWorkMode(nextWorkMode);
    } else {
      setWorkMode("standard");
      const defaultProjectId = newTaskDefaults.projectId ?? "";
      setTaskText("", "");
      setStatus(newTaskDefaults.status ?? "todo");
      setPriority(newTaskDefaults.priority ?? "");
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(newTaskDefaults.projectWorkspaceId ?? "");
      setOwnerAgentId(newTaskDefaults.ownerAgentId ?? "");
      setReviewerValue("");
      setApproverValue("");
      setShowReviewerRow(false);
      setShowApproverRow(false);
    }
  }, [companyId, newTaskOpen, newTaskDefaults, orderedProjects, setTaskText]);

  useEffect(() => {
    if (!ownerAgentId || !agents) {
      return;
    }
    if (!(agents ?? []).some((agent) => agent.id === ownerAgentId && isAgentTaskOwnerTarget(agent))) {
      setOwnerAgentId("");
    }
  }, [agents, ownerAgentId]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  function reset() {
    setTaskText("", "");
    setStatus("todo");
    setPriority("");
    setOwnerAgentId("");
    setReviewerValue("");
    setApproverValue("");
    setShowReviewerRow(false);
    setShowApproverRow(false);
    setProjectId("");
    setProjectWorkspaceId("");
    setWorkMode("standard");
    setExpanded(false);
    setStagedFiles([]);
    setIsFileDragOver(false);
    initializationKeyRef.current = null;
    createIdempotencyKeyRef.current = null;
  }

  function discardDraft() {
    clearDraft();
    reset();
    closeNewTask();
  }

  function handleSubmit() {
    const currentTitle = titleRef.current.trim();
    const taskRequest = requestRef.current;
    if (!taskRequest.trim() || !selectedOwnerAgentId || createTask.isPending) return;
    createIdempotencyKeyRef.current ??= crypto.randomUUID();
    createTask.mutate({
      companyId,
      stagedFiles,
      request: taskRequest,
      ownerAgentId: selectedOwnerAgentId,
      idempotencyKey: createIdempotencyKeyRef.current,
      ...(currentTitle ? { title: currentTitle } : {}),
      priority: (priority || "medium") as NonNullable<CreateTask["priority"]>,
      ...(newTaskDefaults.parentId ? { parentId: newTaskDefaults.parentId } : {}),
      ...(newTaskDefaults.goalId ? { goalId: newTaskDefaults.goalId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (isWorkModePeriodShortcut(e)) {
      e.preventDefault();
      setWorkMode((current) => nextWorkMode(current));
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const {
    handleStageFilesPicked,
    handleFileDragEnter,
    handleFileDragOver,
    handleFileDragLeave,
    handleFileDrop,
    removeStagedFile,
  } = useStagedTaskFiles({
    setStagedFiles,
    setIsFileDragOver,
    stageFileInputRef,
  });

  const hasDraft = draftHasText || stagedFiles.length > 0;
  const currentStatus = statuses.find((s) => s.value === status) ?? statuses[1]!;
  const options = useNewTaskDialogOptions({
    newTaskOpen,
    status,
    priority,
    ownerAgentId,
    projectId,
    workMode,
    stagedFiles,
    agents,
    orderedProjects,
    setProjectId,
    setProjectWorkspaceId,
  });
  const {
    currentPriority,
    currentProject,
    currentOwner,
    neededUserSecretKeys,
    recentOwnerOptionIds,
    recentProjectIds,
    ownerOptions,
    participantOptions,
    projectOptions,
    hasSavedDraft,
    stagedDocuments,
    stagedAttachments,
    handleProjectChange,
    currentWorkMode,
  } = options;
  const canDiscardDraft = hasDraft || hasSavedDraft;
  const createTaskErrorMessage =
    createTask.error instanceof Error ? createTask.error.message : "Failed to create task. Try again.";
  const viewModel = {
    dialog: { newTaskOpen, isSubTaskMode, parentTaskLabel, newTaskDefaults, closeNewTask },
    company: { companyId, selectedCompany, currentUserId },
    values: {
      title,
      request,
      draftHasText,
      requestHasText,
      selectedOwnerAgentId,
      status,
      priority,
      ownerAgentId,
      reviewerValue,
      approverValue,
      showReviewerRow,
      showApproverRow,
      projectId,
      projectWorkspaceId,
      workMode,
      expanded,
      stagedFiles,
      isFileDragOver,
    },
    setters: {
      setStatus,
      setPriority,
      setOwnerAgentId,
      setReviewerValue,
      setApproverValue,
      setShowReviewerRow,
      setShowApproverRow,
      setWorkMode,
      setExpanded,
    },
    refs: { requestEditorRef, stageFileInputRef, ownerSelectorRef, projectSelectorRef },
    options: {
      statuses,
      workModeOptions,
      agents,
      orderedProjects,
      mentionOptions,
      ownerOptions,
      participantOptions,
      projectOptions,
      recentOwnerOptionIds,
      recentProjectIds,
    },
    derived: {
      currentStatus,
      currentPriority,
      currentProject,
      currentOwner,
      neededUserSecretKeys,
      currentWorkMode,
      canDiscardDraft,
      createTaskErrorMessage,
      stagedDocuments,
      stagedAttachments,
    },
    creation: { createTask, uploadRequestImageHandler },
    actions: {
      handleTitleChange,
      handleRequestChange,
      handleProjectChange,
      handleStageFilesPicked,
      handleFileDragEnter,
      handleFileDragOver,
      handleFileDragLeave,
      handleFileDrop,
      removeStagedFile,
      discardDraft,
      handleSubmit,
      handleKeyDown,
    },
  };

  return (
    <NewTaskDialogContext.Provider value={viewModel}>
      <NewTaskDialogFrame />
    </NewTaskDialogContext.Provider>
  );
}
