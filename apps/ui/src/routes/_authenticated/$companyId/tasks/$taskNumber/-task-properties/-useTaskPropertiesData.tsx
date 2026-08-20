import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveOriginatingActor, type Task } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { tasksApi } from "@/api/tasks";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
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
import { buildExecutionPolicy, stageParticipantValues } from "@/lib/task-execution-policy";
import { formatOwnerUserLabel, formatUserLabel } from "@/lib/task-owners";
import type { OwnerChipResolvers } from "../-owner-transition/-OwnerTransitionViews";
import type { TaskPropertiesUpdate } from "./-TaskProperties";
import type { TaskPropertiesState } from "./-useTaskPropertiesState";

interface UseTaskPropertiesDataOptions {
  task: Task;
  onUpdate: (data: TaskPropertiesUpdate) => void;
  hasActiveRun: boolean;
  state: TaskPropertiesState;
}

export function useTaskPropertiesData({ task, onUpdate, hasActiveRun, state }: UseTaskPropertiesDataOptions) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const companyId = useCompanyRouteId();
  const queryClient = useQueryClient();
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
  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    const agent = agents.find((candidate) => candidate.id === id);
    return agent?.name ?? id.slice(0, 8);
  };
  const recentOwnerAgentIds = useMemo(() => getRecentAssigneeIds(), [state.ownerOpen]);
  const sortedAgents = useMemo(
    () => sortAgentsByRecency((agents ?? []).filter(isAgentTaskTarget), recentOwnerAgentIds),
    [agents, recentOwnerAgentIds],
  );
  const sortedTaskOwners = useMemo(
    () => sortAgentsByRecency(taskOwnerCatalog ?? [], recentOwnerAgentIds),
    [taskOwnerCatalog, recentOwnerAgentIds],
  );
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
    currentUserId,
    agents,
    unarchiveFromInbox,
    agentName,
    recentOwnerAgentIds,
    sortedAgents,
    sortedTaskOwners,
    creatorUserId,
    otherUserOptions,
    ownerAgent,
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
