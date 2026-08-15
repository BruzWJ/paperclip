import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveOriginatingActor, type Task, type TaskLabel } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { projectsApi } from "@/api/projects";
import { tasksApi, type CreateTaskLabelInput } from "@/api/tasks";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useProjectOrder } from "@/hooks/useProjectOrder";
import {
  buildCompanyUserInlineOptions,
  buildCompanyUserLabelMap,
  buildCompanyUserProfileMap,
  isAgentTaskTarget,
} from "@/lib/company-members";
import { invalidateInboxTaskQueries } from "@/lib/inboxArchiveCache";
import { describeOwnerChangeInterrupt } from "@/lib/owner-transition";
import { queryKeys } from "@/lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency } from "@/lib/recent-assignees";
import { getRecentProjectIds } from "@/lib/recent-projects";
import { buildExecutionPolicy, stageParticipantValues } from "@/lib/task-execution-policy";
import { formatOwnerUserLabel, formatUserLabel } from "@/lib/task-owners";
import type { OwnerChipResolvers } from "../-owner-transition/-OwnerTransitionViews";
import type { TaskPropertiesState } from "./-useTaskPropertiesState";

const TASK_BLOCKER_SEARCH_LIMIT = 50;

interface UseTaskPropertiesDataOptions {
  task: Task;
  childTasks: Task[];
  onUpdate: (data: Record<string, unknown>) => void;
  hasActiveRun: boolean;
  state: TaskPropertiesState;
}

export function useTaskPropertiesData({
  task,
  childTasks,
  onUpdate,
  hasActiveRun,
  state,
}: UseTaskPropertiesDataOptions) {
  const companyId = useCompanyRouteId();
  const queryClient = useQueryClient();
  const normalizedBlockedBySearch = state.blockedBySearch.trim();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user.id;
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const { data: taskOwnerCatalog } = useQuery({
    queryKey: queryKeys.agents.taskOwnerCatalog(companyId!),
    queryFn: () => agentsApi.listInvokableTaskOwners(companyId!),
    enabled: !!companyId,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId!),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId!),
    queryFn: () => projectsApi.list(companyId!),
    enabled: !!companyId,
  });
  const activeProjects = useMemo(
    () => (projects ?? []).filter((project) => !project.archivedAt || project.id === task.projectId),
    [projects, task.projectId],
  );
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    companyId,
    userId: currentUserId,
  });
  const { data: labels } = useQuery({
    queryKey: queryKeys.tasks.labels(companyId!),
    queryFn: () => tasksApi.listLabels(companyId!),
    enabled: !!companyId,
  });
  const { data: allTasks, isFetching: isFetchingTaskPickerTasks } = useQuery({
    queryKey: queryKeys.tasks.list(companyId!),
    queryFn: () => tasksApi.list(companyId!),
    enabled:
      !!companyId && (state.parentOpen || (state.blockedByOpen && normalizedBlockedBySearch.length === 0)),
  });
  const { data: searchedBlockedByTasks, isFetching: isFetchingSearchedBlockedByTasks } = useQuery({
    queryKey: companyId
      ? queryKeys.tasks.search(companyId, normalizedBlockedBySearch, undefined, TASK_BLOCKER_SEARCH_LIMIT)
      : ["tasks", "blocker-search", normalizedBlockedBySearch, TASK_BLOCKER_SEARCH_LIMIT],
    queryFn: () =>
      tasksApi.list(companyId!, {
        q: normalizedBlockedBySearch,
        limit: TASK_BLOCKER_SEARCH_LIMIT,
      }),
    enabled: !!companyId && state.blockedByOpen && normalizedBlockedBySearch.length > 0,
  });
  const createLabel = useMutation({
    mutationFn: (data: CreateTaskLabelInput) => tasksApi.createLabel(companyId!, data),
    onSuccess: async (created) => {
      queryClient.setQueryData<TaskLabel[] | undefined>(queryKeys.tasks.labels(companyId!), (current) => {
        if (!current) return [created];
        if (current.some((label) => label.id === created.id)) return current;
        return [...current, created];
      });
      onUpdate({ labelIds: [...(task.labelIds ?? []), created.id] });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.labels(companyId!),
      });
      state.setNewLabelName("");
    },
  });
  const unarchiveFromInbox = useMutation({
    mutationFn: () => tasksApi.unarchiveFromInbox(task.id),
    onMutate: () => state.setUnarchiveErrorMessage(null),
    onSuccess: () => {
      state.setUnarchiveErrorMessage(null);
      queryClient.setQueryData<Task>(queryKeys.tasks.detail(task.id), (current) =>
        current
          ? {
              ...current,
              archivedAt: null,
              archivedByActorType: null,
              archivedByAgentId: null,
              archivedByRunId: null,
            }
          : current,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(task.id),
      });
      if (companyId) invalidateInboxTaskQueries(queryClient, companyId);
    },
    onError: (error) => {
      state.setUnarchiveErrorMessage(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Failed to unarchive this task. Please try again.",
      );
    },
  });
  const toggleLabel = (labelId: string) => {
    const ids = task.labelIds ?? [];
    const next = ids.includes(labelId) ? ids.filter((id) => id !== labelId) : [...ids, labelId];
    onUpdate({ labelIds: next });
  };
  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    const agent = agents.find((candidate) => candidate.id === id);
    return agent?.name ?? id.slice(0, 8);
  };
  const projectName = (id: string | null) => {
    if (!id) return id?.slice(0, 8) ?? "None";
    const project = orderedProjects.find((candidate) => candidate.id === id);
    return project?.name ?? id.slice(0, 8);
  };
  const relatedTasks = useMemo(() => {
    const excluded = new Set<string>();
    const addExcluded = (candidate: { id: string; identifier: string }) => {
      excluded.add(candidate.id);
      excluded.add(candidate.identifier);
    };
    for (const blocker of task.blockedBy ?? []) addExcluded(blocker);
    for (const blocked of task.blocks ?? []) addExcluded(blocked);
    for (const child of childTasks) addExcluded(child);
    return (task.relatedWork?.outbound.map((item) => item.task) ?? []).filter(
      (referenced) => !excluded.has(referenced.id) && !excluded.has(referenced.identifier),
    );
  }, [childTasks, task.blockedBy, task.blocks, task.relatedWork?.outbound]);
  const recentOwnerAgentIds = useMemo(() => getRecentAssigneeIds(), [state.ownerOpen]);
  const sortedAgents = useMemo(
    () => sortAgentsByRecency((agents ?? []).filter(isAgentTaskTarget), recentOwnerAgentIds),
    [agents, recentOwnerAgentIds],
  );
  const sortedTaskOwners = useMemo(
    () => sortAgentsByRecency(taskOwnerCatalog ?? [], recentOwnerAgentIds),
    [taskOwnerCatalog, recentOwnerAgentIds],
  );
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [state.projectOpen]);
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const creatorUserId = task.creatorKind === "user/board" ? task.creatorUserId : null;
  const otherUserOptions = useMemo(
    () =>
      buildCompanyUserInlineOptions(companyMembers?.users, {
        excludeUserIds: [currentUserId, creatorUserId],
      }),
    [companyMembers?.users, creatorUserId, currentUserId],
  );
  const ownerAgent = task.ownerAgentId ? agents?.find((agent) => agent.id === task.ownerAgentId) : null;
  const selectedProject = task.projectId
    ? (projects?.find((project) => project.id === task.projectId) ?? null)
    : null;
  const reviewerValues = stageParticipantValues(task.executionPolicy, "review");
  const approverValues = stageParticipantValues(task.executionPolicy, "approval");
  const userLabel = (userId: string | null | undefined) =>
    formatOwnerUserLabel(userId, currentUserId, userLabelMap);
  const actualUserLabel = (userId: string | null | undefined) => formatUserLabel(userId, userLabelMap);
  const ownerUserLabel = userLabel(task.ownerUserId);
  const creatorUserLabel = actualUserLabel(creatorUserId);
  const originatingActor = deriveOriginatingActor(task);
  const originatingAgent =
    originatingActor?.kind === "agent"
      ? (agents?.find((agent) => agent.id === originatingActor.id) ?? null)
      : null;
  const originatingUserProfile =
    originatingActor?.kind === "user" ? userProfileMap.get(originatingActor.id) : null;
  const originatingViaAgentName =
    originatingActor?.kind === "user" && originatingActor.viaAgentId
      ? (agentName(originatingActor.viaAgentId) ?? originatingActor.viaAgentId.slice(0, 8))
      : null;
  const selectedOwnerAgentId = task.ownerAgentId ?? "";
  const ownerResolvers: OwnerChipResolvers = useMemo(
    () => ({
      agentMap: new Map((agents ?? []).map((agent) => [agent.id, { name: agent.name, icon: agent.icon }])),
      resolveUserLabel: (id) => userLabel(id),
    }),
    [agents, userLabelMap, currentUserId],
  );
  const ownerChangeInterruptCopy = useMemo(
    () =>
      describeOwnerChangeInterrupt({
        runningAgentName: ownerAgent?.name ?? null,
      }),
    [ownerAgent?.name],
  );
  const closeOwnerPicker = () => {
    state.setOwnerOpen(false);
    state.setOwnerSearch("");
    state.setPendingOwner(null);
  };
  const applyOwner = (ownerAgentId: string, track?: () => void) => {
    track?.();
    onUpdate({ ownerAgentId });
    closeOwnerPicker();
  };
  const selectOwner = (ownerAgentId: string, label: string, track?: () => void) => {
    if (ownerAgentId === selectedOwnerAgentId) {
      closeOwnerPicker();
      return;
    }
    if (hasActiveRun) {
      state.setPendingOwner({ ownerAgentId, label, track });
      return;
    }
    applyOwner(ownerAgentId, track);
  };
  const updateExecutionPolicy = (nextReviewers: string[], nextApprovers: string[]) => {
    onUpdate({
      executionPolicy: buildExecutionPolicy({
        existingPolicy: task.executionPolicy ?? null,
        reviewerValues: nextReviewers,
        approverValues: nextApprovers,
      }),
    });
  };
  const toggleExecutionParticipant = (stageType: "review" | "approval", value: string) => {
    const currentValues = stageType === "review" ? reviewerValues : approverValues;
    const nextValues = currentValues.includes(value)
      ? currentValues.filter((candidate) => candidate !== value)
      : [...currentValues, value];
    updateExecutionPolicy(
      stageType === "review" ? nextValues : reviewerValues,
      stageType === "approval" ? nextValues : approverValues,
    );
  };
  const executionParticipantLabel = (value: string) => {
    if (value.startsWith("agent:")) {
      return agentName(value.slice("agent:".length)) ?? value.slice("agent:".length, "agent:".length + 8);
    }
    if (value.startsWith("user:")) {
      return userLabel(value.slice("user:".length)) ?? "User";
    }
    return value;
  };
  const reviewerLabel = reviewerValues.map((value) => executionParticipantLabel(value)).join(", ");
  const approverLabel = approverValues.map((value) => executionParticipantLabel(value)).join(", ");
  const reviewerTrigger = reviewerValues.length ? (
    <span className="text-sm truncate min-w-0" title={reviewerLabel}>
      {reviewerLabel}
    </span>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );
  const approverTrigger = approverValues.length ? (
    <span className="text-sm truncate min-w-0" title={approverLabel}>
      {approverLabel}
    </span>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );

  return {
    companyId,
    queryClient,
    normalizedBlockedBySearch,
    currentUserId,
    agents,
    projects,
    orderedProjects,
    labels,
    allTasks,
    isFetchingTaskPickerTasks,
    searchedBlockedByTasks,
    isFetchingSearchedBlockedByTasks,
    createLabel,
    unarchiveFromInbox,
    toggleLabel,
    agentName,
    projectName,
    relatedTasks,
    recentOwnerAgentIds,
    sortedAgents,
    sortedTaskOwners,
    recentProjectIds,
    creatorUserId,
    otherUserOptions,
    ownerAgent,
    selectedProject,
    reviewerValues,
    approverValues,
    userLabel,
    actualUserLabel,
    ownerUserLabel,
    creatorUserLabel,
    originatingActor,
    originatingAgent,
    originatingUserProfile,
    originatingViaAgentName,
    selectedOwnerAgentId,
    ownerResolvers,
    ownerChangeInterruptCopy,
    applyOwner,
    selectOwner,
    updateExecutionPolicy,
    toggleExecutionParticipant,
    reviewerTrigger,
    approverTrigger,
  };
}

export type TaskPropertiesData = ReturnType<typeof useTaskPropertiesData>;
