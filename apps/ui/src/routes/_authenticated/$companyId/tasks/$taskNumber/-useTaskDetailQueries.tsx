// Empty collections render dedicated UI when data.length === 0.
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { projectsApi } from "@/api/projects";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { tasksApi } from "@/api/tasks";
import { useProjectOrder } from "@/hooks/useProjectOrder";
import type { MentionOption } from "@/routes/_authenticated/$companyId/-markdown/-MarkdownEditor";
import {
  buildCompanyUserLabelMap,
  buildCompanyUserProfileMap,
  buildMarkdownMentionOptions,
} from "@/lib/company-members";
import { collectLiveTaskIds } from "@/lib/liveTaskIds";
import {
  mergeTaskComments,
  type ClientTaskComment,
  type OptimisticTaskComment,
} from "@/lib/optimistic-task-comments";
import { buildSubTaskDefaultsForViewer } from "@/lib/subTaskDefaults";
import { buildTaskSiblingNavigation } from "@/lib/task-detail-subtasks";
import { buildTaskPropertiesPanelKey } from "@/lib/task-properties-panel-key";
import { filterTaskDescendants } from "@/lib/task-tree";
import { keepPreviousDataForSameQueryTail } from "@/lib/query-placeholder-data";
import { indexEntitiesById } from "@/lib/presentation-contracts";
import { queryKeys } from "@/lib/queryKeys";
import { usePluginSlots } from "@/plugins/slots";
import type {
  Agent,
  Project,
  Task,
  TaskAttachment,
  TaskExecutionRunListPageRecord,
  TaskTreeControlMode,
  TaskWorkProduct,
} from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

interface TaskDetailQueriesOptions {
  companyId: string;
  taskId: string;
  task: Task | undefined;
  detailTab: string;
  treeControlOpen: boolean;
  treeControlMode: TaskTreeControlMode;
}

/** Collects the task detail's independent server queries in one reusable hook. */
export function useTaskDetailQueries({
  companyId,
  taskId,
  task,
  detailTab,
  treeControlOpen,
  treeControlMode,
}: TaskDetailQueriesOptions) {
  const { data: attachments, isLoading: attachmentsLoading } = useQuery({
    queryKey: queryKeys.tasks.attachments(taskId),
    queryFn: () => tasksApi.listAttachments(taskId),
    placeholderData: keepPreviousDataForSameQueryTail<TaskAttachment[]>(taskId),
  });
  const { data: workProducts } = useQuery({
    queryKey: queryKeys.tasks.workProducts(taskId),
    queryFn: () => tasksApi.listWorkProducts(taskId),
    placeholderData: keepPreviousDataForSameQueryTail<TaskWorkProduct[]>(taskId),
  });
  const { data: activeTaskRunPage } = useQuery({
    queryKey: queryKeys.tasks.runs(taskId, ACTIVE_TASK_EXECUTION_RUN_STATUSES),
    queryFn: () =>
      runsApi.listForTask(taskId, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
    placeholderData: keepPreviousDataForSameQueryTail<TaskExecutionRunListPageRecord>(taskId),
  });
  const activeTaskRuns = activeTaskRunPage?.items ?? [];
  const resolvedHasActiveRun = task?.lifecycleStatus === "open" && activeTaskRuns.length > 0;
  const hasLiveRuns = activeTaskRuns.length > 0;

  const { data: rawChildTasks = [], isLoading: childTasksLoading } = useQuery({
    queryKey: task?.id
      ? queryKeys.tasks.listByDescendantRoot(companyId, task.id)
      : ["tasks", "parent", "pending"],
    queryFn: () =>
      tasksApi.list(companyId, {
        descendantOf: task!.id,
        includeBlockedBy: true,
      }),
    enabled: !!task?.id,
    placeholderData: keepPreviousDataForSameQueryTail<Task[]>(task?.id ?? "pending"),
  });
  const {
    data: rawSiblingTasks = [],
    isLoading: siblingTasksLoading,
    isError: siblingTasksError,
  } = useQuery({
    queryKey: task?.parentId
      ? queryKeys.tasks.listByParent(companyId, task.parentId)
      : ["tasks", "siblings", "pending"],
    queryFn: () =>
      tasksApi.list(companyId, {
        parentId: task!.parentId!,
        includeBlockedBy: true,
      }),
    enabled: !!task?.parentId,
  });
  const companyRunsQueryKey = queryKeys.runs(companyId, {
    status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
  });
  const { data: companyRunPage } = useQuery({
    queryKey: companyRunsQueryKey,
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
    placeholderData: keepPreviousDataForSameQueryTail<TaskExecutionRunListPageRecord>(companyId),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const { data: taskOwnerCatalog } = useQuery({
    queryKey: queryKeys.agents.taskOwnerCatalog(companyId),
    queryFn: () => agentsApi.listInvokableTaskOwners(companyId),
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });
  const { data: mentionTasks = [] } = useQuery({
    queryKey: queryKeys.tasks.mentionPool(companyId),
    queryFn: () =>
      tasksApi.list(companyId, {
        limit: 100,
        sortField: "updated",
        sortDir: "desc",
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousDataForSameQueryTail<Task[]>(companyId),
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const currentUserId = session?.user.id ?? null;
  const { data: boardAccess } = useQuery({
    queryKey: currentUserId
      ? queryKeys.access.currentBoardAccess(currentUserId)
      : (["access", "current-board-access", null] as const),
    queryFn: () => accessApi.getCurrentBoardAccess(currentUserId!),
    enabled: !!currentUserId,
    retry: false,
  });
  const canManageTreeControl = Boolean(boardAccess?.companyIds?.includes(companyId));
  const { data: instanceGeneralSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    retry: false,
  });
  const keyboardShortcutsEnabled = instanceGeneralSettings?.keyboardShortcuts === true;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId,
    userId: currentUserId,
  });
  const { slots: taskPluginDetailSlots } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "task",
  });
  const taskPluginTabItems = useMemo(
    () =>
      taskPluginDetailSlots.map((slot) => ({
        value: `plugin:${slot.pluginKey}:${slot.id}`,
        label: slot.displayName,
        slot,
      })),
    [taskPluginDetailSlots],
  );
  const activePluginTab = taskPluginTabItems.find((item) => item.value === detailTab) ?? null;

  const {
    data: treeControlPreview,
    isFetching: treeControlPreviewLoading,
    error: treeControlPreviewError,
    refetch: refetchTreeControlPreview,
  } = useQuery({
    queryKey: ["tasks", "tree-control-preview", taskId, treeControlMode],
    queryFn: () =>
      tasksApi.previewTreeControl(taskId, {
        mode: treeControlMode,
        releasePolicy: { strategy: "manual" },
      }),
    enabled: treeControlOpen && canManageTreeControl,
    staleTime: 0,
    retry: false,
  });
  const { data: treeControlState } = useQuery({
    queryKey: ["tasks", "tree-control-state", taskId],
    queryFn: () => tasksApi.getTreeControlState(taskId),
    enabled: canManageTreeControl,
    retry: false,
  });
  const { data: activeRootPauseHolds = [] } = useQuery({
    queryKey: ["tasks", "tree-holds", taskId, "active-pause-with-members"],
    queryFn: () =>
      tasksApi.listTreeHolds(taskId, {
        status: "active",
        mode: "pause",
        includeMembers: true,
      }),
    enabled: treeControlState?.activePauseHold?.isRoot === true,
  });
  const { data: activeCancelHolds = [] } = useQuery({
    queryKey: ["tasks", "tree-holds", taskId, "active-cancel"],
    queryFn: () =>
      tasksApi.listTreeHolds(taskId, {
        status: "active",
        mode: "cancel",
      }),
    enabled: canManageTreeControl,
  });

  return {
    attachments,
    attachmentsLoading,
    workProducts,
    activeTaskRuns,
    resolvedHasActiveRun,
    hasLiveRuns,
    rawChildTasks,
    childTasksLoading,
    rawSiblingTasks,
    siblingTasksLoading,
    siblingTasksError,
    companyRunPage,
    agents,
    taskOwnerCatalog,
    companyMembers,
    mentionTasks,
    session,
    projects,
    currentUserId,
    canManageTreeControl,
    keyboardShortcutsEnabled,
    orderedProjects,
    taskPluginTabItems,
    activePluginTab,
    treeControlPreview,
    treeControlPreviewLoading,
    treeControlPreviewError,
    refetchTreeControlPreview,
    treeControlState,
    activeRootPauseHolds,
    activeCancelHolds,
  };
}

interface TaskDetailDerivedDataOptions {
  task: Task | undefined;
  agents?: Agent[];
  companyMembers?: Awaited<ReturnType<typeof accessApi.listUserDirectory>>;
  orderedProjects: Project[];
  mentionTasks: Task[];
  rawChildTasks: Task[];
  rawSiblingTasks: Task[];
  childTasksLoading: boolean;
  siblingTasksLoading: boolean;
  siblingTasksError: boolean;
  companyRunPage?: TaskExecutionRunListPageRecord;
  comments: ClientTaskComment[];
  optimisticComments: OptimisticTaskComment[];
  openNewTask: (defaults: ReturnType<typeof buildSubTaskDefaultsForViewer>) => void;
}

/** Computes stable maps, navigation, and ownership presentation. */
export function useTaskDetailDerivedData({
  task,
  agents,
  companyMembers,
  orderedProjects,
  mentionTasks,
  rawChildTasks,
  rawSiblingTasks,
  childTasksLoading,
  siblingTasksLoading,
  siblingTasksError,
  companyRunPage,
  comments,
  optimisticComments,
  openNewTask,
}: TaskDetailDerivedDataOptions) {
  const agentMap = useMemo(() => indexEntitiesById(agents), [agents]);
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const mentionOptions = useMemo<MentionOption[]>(
    () =>
      buildMarkdownMentionOptions({
        agents,
        projects: orderedProjects,
        members: companyMembers?.users,
        tasks: mentionTasks,
      }),
    [agents, companyMembers?.users, orderedProjects, mentionTasks],
  );
  const childTasks = useMemo(() => {
    const descendants = task?.id ? filterTaskDescendants(task.id, rawChildTasks) : rawChildTasks;
    return [...descendants].sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );
  }, [task?.id, rawChildTasks]);
  const liveTaskIds = useMemo(() => collectLiveTaskIds(companyRunPage?.items), [companyRunPage?.items]);
  const taskPanelKey = useMemo(
    () => buildTaskPropertiesPanelKey(task ?? null, childTasks),
    [childTasks, task],
  );
  const panelTask = useMemo(() => task ?? null, [task?.documentSummaries, taskPanelKey]);
  const panelChildTasks = useMemo(() => childTasks, [taskPanelKey]);
  const siblingNavigation = useMemo(
    () =>
      task && !childTasksLoading && !siblingTasksLoading && !siblingTasksError
        ? buildTaskSiblingNavigation(task, rawSiblingTasks, childTasks)
        : null,
    [childTasks, childTasksLoading, task, rawSiblingTasks, siblingTasksError, siblingTasksLoading],
  );
  const openNewSubTask = useCallback(() => {
    if (!task) return;
    openNewTask(buildSubTaskDefaultsForViewer(task));
  }, [task, openNewTask]);

  const threadComments = useMemo(
    () => mergeTaskComments(comments, optimisticComments),
    [comments, optimisticComments],
  );

  return {
    agentMap,
    userProfileMap,
    userLabelMap,
    mentionOptions,
    childTasks,
    liveTaskIds,
    taskPanelKey,
    panelTask,
    panelChildTasks,
    siblingNavigation,
    openNewSubTask,
    threadComments,
  };
}
