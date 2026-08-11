import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { taskStatusText } from "@/lib/status-colors";
import { Link } from "@/lib/router";
import { deriveOriginatingActor, type Task, type TaskLabel } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "../../api/access";
import { agentsApi } from "../../api/agents";
import { authApi } from "../../api/auth";
import { tasksApi } from "../../api/tasks";
import { projectsApi } from "../../api/projects";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import { taskDisplayTitle } from "../../lib/task-display";
import { buildCompanyUserInlineOptions, buildCompanyUserLabelMap, buildCompanyUserProfileMap, isAgentTaskTarget } from "../../lib/company-members";
import { useProjectOrder } from "../../hooks/useProjectOrder";
import {
  getRecentAssigneeIds,
  sortAgentsByRecency,
  trackRecentAssignee,
} from "../../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../../lib/recent-projects";
import { orderItemsBySelectedAndRecent } from "../../lib/recent-selections";
import { formatOwnerUserLabel, formatUserLabel } from "../../lib/task-owners";
import { buildExecutionPolicy, stageParticipantValues } from "../../lib/task-execution-policy";
import {
  formatMonitorAbsolute,
  formatMonitorAbsoluteFull,
  formatMonitorEta,
  formatMonitorEtaLabel,
  useMonitorCountdown,
} from "../../lib/task-monitor";
import { StatusIcon } from "../StatusIcon";
import { PriorityIcon } from "../PriorityIcon";
import { Identity } from "../Identity";
import { TaskReferencePill } from "../TaskReferencePill";
import { formatDate, formatDateTime, cn, projectUrl } from "../../lib/utils";
import { timeAgo } from "../../lib/timeAgo";
import { invalidateInboxTaskQueries } from "../../lib/inboxArchiveCache";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { User, ArrowUpRight, Plus, Check, ArchiveRestore, Clock } from "lucide-react";
import { AgentIcon } from "../AgentIconPicker";
import {
  OwnerRunningBanner,
  InterruptOwnerChangeConfirm,
  type OwnerChipResolvers,
} from "../owner-transition/OwnerTransitionViews";
import { describeOwnerChangeInterrupt } from "../../lib/owner-transition";
import { PropertyPicker } from "./property-picker";
import { PropertyChip, PropertyRow, PropertySection } from "./primitives";
import { ExpandRelationListButton, RemovableTaskReferencePill } from "./relation-controls";
import { Badge } from "@/components/ui/badge";

interface TaskPropertiesProps {
  task: Task;
  childTasks?: Task[];
  onAddSubTask?: () => void;
  onUpdate: (data: Record<string, unknown>) => void;
  inline?: boolean;
  /** Whether an agent run is currently in flight on this task, so the owner
   * picker can warn that reassigning will interrupt it. */
  hasActiveRun?: boolean;
}

const TASK_BLOCKER_SEARCH_LIMIT = 50;
const TASK_PROPERTY_RELATION_PREVIEW_COUNT = 5;

function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function TaskProperties({
  task,
  childTasks = [],
  onAddSubTask,
  onUpdate,
  inline,
  hasActiveRun = false,
}: TaskPropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const companyId = task.companyId ?? selectedCompanyId;
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerSearch, setOwnerSearch] = useState("");
  /** When a run is live, a selection is staged here until the operator confirms
   * the interrupt rather than applying it immediately. */
  const [pendingOwner, setPendingOwner] = useState<{
    ownerAgentId: string;
    label: string;
    track?: () => void;
  } | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [blockedByOpen, setBlockedByOpen] = useState(false);
  const [blockedBySearch, setBlockedBySearch] = useState("");
  const [blockedByExpanded, setBlockedByExpanded] = useState(false);
  const [blockingExpanded, setBlockingExpanded] = useState(false);
  const [subTasksExpanded, setSubTasksExpanded] = useState(false);
  const [relatedTasksExpanded, setRelatedTasksExpanded] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const [parentSearch, setParentSearch] = useState("");
  const [reviewersOpen, setReviewersOpen] = useState(false);
  const [reviewerSearch, setReviewerSearch] = useState("");
  const [approversOpen, setApproversOpen] = useState(false);
  const [approverSearch, setApproverSearch] = useState("");
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [monitorDetailsOpen, setMonitorDetailsOpen] = useState(false);
  const [monitorAtInput, setMonitorAtInput] = useState(() => toDateTimeLocalValue(task.executionPolicy?.monitor?.nextCheckAt));
  const [monitorNotesInput, setMonitorNotesInput] = useState(task.executionPolicy?.monitor?.notes ?? "");
  const [monitorServiceInput, setMonitorServiceInput] = useState(task.executionPolicy?.monitor?.serviceName ?? "");
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelSearch, setLabelSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  // token-extraction: allowlisted — color-picker seed state, persisted into label-create payload; a var() string would break that payload.
  const [newLabelColor, setNewLabelColor] = useState("#6366f1");
  const [unarchiveErrorMessage, setUnarchiveErrorMessage] = useState<string | null>(null);
  const normalizedBlockedBySearch = blockedBySearch.trim();

  useEffect(() => {
    setBlockedByExpanded(false);
    setBlockingExpanded(false);
    setSubTasksExpanded(false);
    setRelatedTasksExpanded(false);
  }, [task.id]);

  useEffect(() => {
    setMonitorAtInput(toDateTimeLocalValue(task.executionPolicy?.monitor?.nextCheckAt));
    setMonitorNotesInput(task.executionPolicy?.monitor?.notes ?? "");
    setMonitorServiceInput(task.executionPolicy?.monitor?.serviceName ?? "");
  }, [
    task.executionPolicy?.monitor?.nextCheckAt,
    task.executionPolicy?.monitor?.notes,
    task.executionPolicy?.monitor?.serviceName,
  ]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId;

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
    () => (projects ?? []).filter((p) => !p.archivedAt || p.id === task.projectId),
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
    enabled: !!companyId && (parentOpen || (blockedByOpen && normalizedBlockedBySearch.length === 0)),
  });

  const { data: searchedBlockedByTasks, isFetching: isFetchingSearchedBlockedByTasks } = useQuery({
    queryKey: companyId
      ? queryKeys.tasks.search(companyId, normalizedBlockedBySearch, undefined, TASK_BLOCKER_SEARCH_LIMIT)
      : ["tasks", "blocker-search", normalizedBlockedBySearch, TASK_BLOCKER_SEARCH_LIMIT],
    queryFn: () => tasksApi.list(companyId!, {
      q: normalizedBlockedBySearch,
      limit: TASK_BLOCKER_SEARCH_LIMIT,
    }),
    enabled: !!companyId && blockedByOpen && normalizedBlockedBySearch.length > 0,
  });

  const createLabel = useMutation({
    mutationFn: (data: { name: string; color: string }) => tasksApi.createLabel(companyId!, data),
    onSuccess: async (created) => {
      queryClient.setQueryData<TaskLabel[] | undefined>(
        queryKeys.tasks.labels(companyId!),
        (current) => {
          if (!current) return [created];
          if (current.some((label) => label.id === created.id)) return current;
          return [...current, created];
        },
      );
      onUpdate({ labelIds: [...(task.labelIds ?? []), created.id] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.labels(companyId!) });
      setNewLabelName("");
    },
  });

  const unarchiveFromInbox = useMutation({
    mutationFn: () => tasksApi.unarchiveFromInbox(task.id),
    onMutate: () => {
      setUnarchiveErrorMessage(null);
    },
    onSuccess: () => {
      setUnarchiveErrorMessage(null);
      queryClient.setQueryData<Task>(queryKeys.tasks.detail(task.id), (current) =>
        current ? { ...current, archivedAt: null, archivedByActorType: null, archivedByAgentId: null, archivedByRunId: null } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(task.id) });
      if (companyId) invalidateInboxTaskQueries(queryClient, companyId);
    },
    onError: (error) => {
      setUnarchiveErrorMessage(error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Failed to unarchive this task. Please try again.");
    },
  });

  const toggleLabel = (labelId: string) => {
    const ids = task.labelIds ?? [];
    const next = ids.includes(labelId)
      ? ids.filter((id) => id !== labelId)
      : [...ids, labelId];
    onUpdate({ labelIds: next });
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    const agent = agents.find((a) => a.id === id);
    return agent?.name ?? id.slice(0, 8);
  };

  const projectName = (id: string | null) => {
    if (!id) return id?.slice(0, 8) ?? "None";
    const project = orderedProjects.find((p) => p.id === id);
    return project?.name ?? id.slice(0, 8);
  };
  const referencedTaskIdentifiers = task.referencedTaskIdentifiers ?? [];
  const relatedTasks = useMemo(() => {
    const excluded = new Set<string>();
    const addExcluded = (candidate: { id: string; identifier?: string | null }) => {
      excluded.add(candidate.id);
      if (candidate.identifier) excluded.add(candidate.identifier);
    };

    for (const blocker of task.blockedBy ?? []) addExcluded(blocker);
    for (const blocked of task.blocks ?? []) addExcluded(blocked);
    for (const child of childTasks) addExcluded(child);

    const referencedTasks = task.relatedWork?.outbound.map((item) => item.task) ?? [];
    if (referencedTasks.length > 0) {
      return referencedTasks.filter((referenced) => {
        const label = referenced.identifier ?? referenced.id;
        return !excluded.has(referenced.id) && !excluded.has(label);
      });
    }

    return referencedTaskIdentifiers
      .filter((identifier) => !excluded.has(identifier))
      .map((identifier) => ({ id: identifier, identifier, title: identifier }));
  }, [childTasks, task.blockedBy, task.blocks, task.relatedWork?.outbound, referencedTaskIdentifiers]);
  const projectLink = (id: string | null) => {
    if (!id) return null;
    const project = projects?.find((p) => p.id === id) ?? null;
    return project ? projectUrl(project) : `/projects/${id}`;
  };

  const recentOwnerAgentIds = useMemo(() => getRecentAssigneeIds(), [ownerOpen]);
  const sortedAgents = useMemo(
    () => sortAgentsByRecency((agents ?? []).filter(isAgentTaskTarget), recentOwnerAgentIds),
    [agents, recentOwnerAgentIds],
  );
  const sortedTaskOwners = useMemo(
    () => sortAgentsByRecency(taskOwnerCatalog ?? [], recentOwnerAgentIds),
    [taskOwnerCatalog, recentOwnerAgentIds],
  );
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [projectOpen]);
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
    () => buildCompanyUserInlineOptions(companyMembers?.users, { excludeUserIds: [currentUserId, creatorUserId] }),
    [companyMembers?.users, creatorUserId, currentUserId],
  );

  const ownerAgent = task.ownerAgentId
    ? agents?.find((agent) => agent.id === task.ownerAgentId)
    : null;
  const reviewerValues = stageParticipantValues(task.executionPolicy, "review");
  const approverValues = stageParticipantValues(task.executionPolicy, "approval");
  const userLabel = (userId: string | null | undefined) => formatOwnerUserLabel(userId, currentUserId, userLabelMap);
  const actualUserLabel = (userId: string | null | undefined) => formatUserLabel(userId, userLabelMap);
  const ownerUserLabel = userLabel(task.ownerUserId);
  const creatorUserLabel = actualUserLabel(creatorUserId);
  const originatingActor = deriveOriginatingActor(task);
  const originatingUserProfile =
    originatingActor?.kind === "user" ? userProfileMap.get(originatingActor.id) : null;
  const originatingViaAgentName =
    originatingActor?.kind === "user" && originatingActor.viaAgentId
      ? agentName(originatingActor.viaAgentId) ?? originatingActor.viaAgentId.slice(0, 8)
      : null;
  const selectedOwnerAgentId = task.ownerAgentId ?? "";

  // --- Interrupt clarity for the owner picker ---
  const ownerResolvers: OwnerChipResolvers = useMemo(
    () => ({
      agentMap: new Map((agents ?? []).map((agent) => [agent.id, { name: agent.name, icon: agent.icon }])),
      resolveUserLabel: (id) => userLabel(id),
    }),
    // userLabel closes over userLabelMap + currentUserId, both reflected here.
    [agents, userLabelMap, currentUserId],
  );
  const ownerChangeInterruptCopy = useMemo(
    () => describeOwnerChangeInterrupt({ runningAgentName: ownerAgent?.name ?? null }),
    [ownerAgent?.name],
  );
  const closeOwnerPicker = () => {
    setOwnerOpen(false);
    setOwnerSearch("");
    setPendingOwner(null);
  };
  const applyOwner = (ownerAgentId: string, track?: () => void) => {
    track?.();
    onUpdate({ ownerAgentId });
    closeOwnerPicker();
  };
  /** Apply a selection immediately, or stage it for confirmation while a run is live. */
  const selectOwner = (
    ownerAgentId: string,
    label: string,
    track?: () => void,
  ) => {
    if (ownerAgentId === selectedOwnerAgentId) {
      closeOwnerPicker();
      return;
    }
    if (hasActiveRun) {
      setPendingOwner({ ownerAgentId, label, track });
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
  const reviewerTrigger = reviewerValues.length > 0
    ? <span className="text-sm truncate min-w-0" title={reviewerLabel}>{reviewerLabel}</span>
    : <span className="text-sm text-muted-foreground">None</span>;
  const approverTrigger = approverValues.length > 0
    ? <span className="text-sm truncate min-w-0" title={approverLabel}>{approverLabel}</span>
    : <span className="text-sm text-muted-foreground">None</span>;
  const currentExecutionLabel = (() => {
    if (!task.executionState?.currentStageType) return null;
    const stageLabel = task.executionState.currentStageType === "review" ? "Review" : "Approval";
    const participant = task.executionState.currentParticipant;
    const participantLabel = participant
      ? (participant.type === "agent"
        ? agentName(participant.agentId ?? null)
        : userLabel(participant.userId ?? null))
      : null;
    if (task.executionState.status === "changes_requested") {
      return `${stageLabel} requested changes${participantLabel ? ` by ${participantLabel}` : ""}`;
    }
    return `${stageLabel} pending${participantLabel ? ` with ${participantLabel}` : ""}`;
  })();
  const decideExecutionStage = useMutation({
    mutationFn: (input: {
      outcome: "approved" | "changes_requested";
      body: string;
    }) =>
      tasksApi.decideExecutionStage(task.id, {
        ...input,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: ({ task: updatedTask }) => {
      queryClient.setQueryData<Task>(
        queryKeys.tasks.detail(task.id),
        updatedTask,
      );
      if (task.identifier) {
        queryClient.setQueryData<Task>(
          queryKeys.tasks.detail(task.identifier),
          updatedTask,
        );
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(task.id),
      });
      if (task.identifier) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.tasks.detail(task.identifier),
        });
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.activity(task.id),
      });
      if (companyId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.tasks.list(companyId),
        });
        invalidateInboxTaskQueries(queryClient, companyId);
      }
    },
  });
  const canCurrentUserDecideExecutionStage =
    task.executionState?.status === "pending" &&
    task.executionState.currentParticipant?.type === "user" &&
    task.executionState.currentParticipant.userId === currentUserId;
  const requestExecutionStageDecision = (
    outcome: "approved" | "changes_requested",
  ) => {
    const body = window.prompt(
      outcome === "approved"
        ? "Record the approval decision"
        : "Describe the changes requested",
      outcome === "approved" ? "Approved" : "",
    )?.trim();
    if (!body) return;
    decideExecutionStage.mutate({ outcome, body });
  };
  const updateMonitor = (nextMonitor: Task["executionPolicy"] extends infer T
    ? T extends { monitor?: infer M | null } | null | undefined
      ? M | null
      : never
    : never) => {
    const basePolicy = buildExecutionPolicy({
      existingPolicy: task.executionPolicy ?? null,
      reviewerValues,
      approverValues,
    });
    if (!basePolicy && !nextMonitor) {
      onUpdate({ executionPolicy: null });
      return;
    }
    onUpdate({
      executionPolicy: {
        mode: basePolicy?.mode ?? task.executionPolicy?.mode ?? "normal",
        commentRequired: true,
        stages: basePolicy?.stages ?? [],
        ...(nextMonitor ? { monitor: nextMonitor } : {}),
      },
    });
  };
  const saveMonitor = () => {
    if (!monitorAtInput) return;
    const nextCheckAt = new Date(monitorAtInput);
    if (Number.isNaN(nextCheckAt.getTime())) return;
    const serviceName = monitorServiceInput.trim() || null;
    updateMonitor({
      nextCheckAt: nextCheckAt.toISOString(),
      notes: monitorNotesInput.trim() || null,
      scheduledBy: "board",
      kind: serviceName ? "external_service" : null,
      serviceName,
      externalRef: null,
    });
    setMonitorOpen(false);
  };
  const clearMonitor = () => {
    updateMonitor(null);
    setMonitorOpen(false);
  };
  const monitorState = task.executionState?.monitor ?? null;
  const monitorNextCheckAt = monitorState?.nextCheckAt ?? task.monitorNextCheckAt ?? task.executionPolicy?.monitor?.nextCheckAt ?? null;
  const monitorAttemptCount = task.monitorAttemptCount ?? monitorState?.attemptCount ?? 0;
  const monitorLastTriggeredAt = task.monitorLastTriggeredAt ?? monitorState?.lastTriggeredAt ?? null;
  const monitorServiceName = task.executionPolicy?.monitor?.serviceName ?? monitorState?.serviceName ?? null;
  const monitorNotes = task.executionPolicy?.monitor?.notes ?? monitorState?.notes ?? null;
  const monitorNow = useMonitorCountdown(monitorNextCheckAt);
  const monitorRelative = monitorNextCheckAt ? formatMonitorEta(monitorNextCheckAt, monitorNow) : null;
  const monitorIsDueNow = monitorRelative === "due now";
  const monitorIsOverdue = Boolean(monitorRelative?.startsWith("overdue by "));
  const monitorPrimary = monitorNextCheckAt
    ? formatMonitorEtaLabel(monitorNextCheckAt, monitorNow)
    : monitorState?.status === "cleared"
      ? "Cleared"
      : "None";
  const monitorSecondary = monitorNextCheckAt
    ? monitorIsDueNow
      ? "review reminder"
      : `${formatMonitorAbsolute(monitorNextCheckAt, {}, monitorNow)}${monitorIsOverdue ? " · reminder overdue" : monitorAttemptCount > 0 ? ` · Attempt ${monitorAttemptCount}` : ""}`
    : monitorState?.status === "cleared"
      ? [
          monitorLastTriggeredAt ? `last checked ${timeAgo(monitorLastTriggeredAt)}` : null,
          monitorAttemptCount > 0 ? `after attempt ${monitorAttemptCount}` : null,
        ].filter(Boolean).join(" · ")
      : null;
  const monitorTrigger = (
    <TooltipProvider>
      <Tooltip open={monitorDetailsOpen} onOpenChange={setMonitorDetailsOpen}>
      <TooltipTrigger asChild>
        <span
          className="inline-flex min-w-0 items-start gap-1.5 border-0 bg-transparent p-0 text-left font-inherit text-inherit"
          data-testid="monitor-row-trigger"
          onClick={() => setMonitorDetailsOpen(false)}
        >
      {monitorNextCheckAt ? (
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
          <span className="flex min-w-0 flex-col items-start">
            <span className={cn("text-sm", monitorNextCheckAt ? "font-semibold text-foreground" : "text-muted-foreground")}>{monitorPrimary}</span>
            {monitorSecondary ? (
              <span className="text-xs text-muted-foreground">{monitorSecondary}</span>
            ) : null}
          </span>
        </span>
      </TooltipTrigger>
      {monitorNextCheckAt ? (
        <TooltipContent
          side="left"
          className="w-80 border border-border bg-popover p-0 text-popover-foreground shadow-md"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold">Monitor</span>
            {monitorAttemptCount > 0 ? <span className="text-xs text-muted-foreground">Attempt {monitorAttemptCount}</span> : null}
          </div>
          <div className="space-y-3 px-4 py-3 text-left">
            <div>
              <div className="text-xs text-muted-foreground">Reminder time</div>
              <div className="text-sm">{formatMonitorAbsoluteFull(monitorNextCheckAt)}</div>
              <div className="text-xs text-muted-foreground">{monitorRelative}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Watching</div>
              <div className="text-sm">{monitorServiceName ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Notes</div>
              <div className="whitespace-normal text-sm">{monitorNotes ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Last recorded trigger</div>
              <div className="text-sm">{monitorLastTriggeredAt ? formatMonitorAbsoluteFull(monitorLastTriggeredAt) : "— not yet triggered"}</div>
            </div>
          </div>
          <div className="flex gap-2 border-t border-border px-4 py-3">
            <Button type="button" size="sm" variant="outline" onClick={() => { setMonitorDetailsOpen(false); setMonitorOpen(true); }}>Edit</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => { setMonitorDetailsOpen(false); clearMonitor(); }}>Clear</Button>
          </div>
        </TooltipContent>
      ) : null}
      </Tooltip>
    </TooltipProvider>
  );

  const monitorContent = (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-col gap-2 md:flex-row">
        <input
          aria-label="Schedule monitor reminder"
          type="datetime-local"
          className="rounded-md border border-border bg-transparent px-2 py-1 text-xs"
          value={monitorAtInput}
          onChange={(e) => setMonitorAtInput(e.target.value)}
        />
        <input
          aria-label="Monitor reminder notes"
          type="text"
          className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs"
          placeholder="What should be reviewed?"
          value={monitorNotesInput}
          onChange={(e) => setMonitorNotesInput(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2 md:flex-row">
        <input
          aria-label="External service to monitor"
          type="text"
          className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs"
          placeholder="External service"
          value={monitorServiceInput}
          onChange={(e) => setMonitorServiceInput(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
            disabled={!monitorAtInput}
            onClick={saveMonitor}
          >
            Schedule
          </button>
          {task.executionPolicy?.monitor ? (
            <button
              type="button"
              className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              onClick={clearMonitor}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );


  const selectedTaskLabels = useMemo(() => {
    const selectedIds = task.labelIds ?? [];
    if (selectedIds.length === 0) return task.labels ?? [];

    const labelById = new Map<string, TaskLabel>();
    for (const label of labels ?? []) labelById.set(label.id, label);
    for (const label of task.labels ?? []) labelById.set(label.id, label);

    return selectedIds
      .map((id) => labelById.get(id))
      .filter((label): label is TaskLabel => Boolean(label));
  }, [task.labelIds, task.labels, labels]);

  const labelsTrigger = selectedTaskLabels.length > 0 ? (
    <div className="flex items-center gap-1 flex-wrap">
      {selectedTaskLabels.slice(0, 3).map((label) => (
        <PropertyChip
          key={label.id}
          style={{
            borderColor: label.color,
            backgroundColor: `${label.color}22`,
            color: pickTextColorForPillBg(label.color, 0.13),
          }}
        >
          {label.name}
        </PropertyChip>
      ))}
      {selectedTaskLabels.length > 3 && (
        <Badge variant="outline" className="border-border text-muted-foreground">
          +{selectedTaskLabels.length - 3} more
        </Badge>
      )}
    </div>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );
  const labelsExtra = (task.labelIds ?? []).length > 0 ? (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      onClick={() => setLabelsOpen(true)}
      aria-label="Add label"
      title="Add label"
    >
      <Plus className="h-3 w-3" />
      Add label
    </button>
  ) : undefined;

  const labelsContent = (
    <>
      <input
        aria-label="Search labels"
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Search labels..."
        value={labelSearch}
        onChange={(e) => setLabelSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-44 overflow-y-auto overscroll-contain space-y-0.5">
        {(labels ?? [])
          .filter((label) => {
            if (!labelSearch.trim()) return true;
            return label.name.toLowerCase().includes(labelSearch.toLowerCase());
          })
          .map((label) => {
            const selected = (task.labelIds ?? []).includes(label.id);
            return (
              <button
                key={label.id}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                  selected && "bg-accent"
                )}
                onClick={() => toggleLabel(label.id)}
              >
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
                <span className="truncate flex-1">{label.name}</span>
                {selected && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />}
              </button>
            );
          })}
      </div>
      <div className="mt-2 border-t border-border pt-2 space-y-1">
        <div className="flex items-center gap-1">
          <input
            aria-label="New label color"
            className="h-7 w-7 p-0 rounded bg-transparent"
            type="color"
            value={newLabelColor}
            onChange={(e) => setNewLabelColor(e.target.value)}
          />
          <input
            aria-label="New label name"
            className="flex-1 px-2 py-1.5 text-xs bg-transparent outline-none rounded placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="New label"
            value={newLabelName}
            onChange={(e) => setNewLabelName(e.target.value)}
          />
        </div>
        <button
          className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 text-xs rounded border border-border hover:bg-accent/50 disabled:opacity-50"
          disabled={!newLabelName.trim() || createLabel.isPending}
          onClick={() =>
            createLabel.mutate({
              name: newLabelName.trim(),
              color: newLabelColor,
            })
          }
        >
          <Plus className="h-3 w-3" />
          {createLabel.isPending ? "Creating…" : "Create label"}
        </button>
      </div>
    </>
  );

  const ownerTrigger = ownerAgent ? (
    <Identity name={ownerAgent.name} size="sm" />
  ) : ownerUserLabel ? (
    <>
      <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-sm" title={ownerUserLabel}>{ownerUserLabel}</span>
    </>
  ) : (
    <span className="text-sm text-muted-foreground">Board escalation</span>
  );

  const agentOwnerOptions = sortedTaskOwners.map((agent) => ({
    value: agent.id,
    agent,
    label: agent.name,
    searchText: `${agent.name} ${agent.title ?? ""}`,
  }));

  const matchesOwnerSearch = (label: string, searchText: string) => {
    if (!ownerSearch.trim()) return true;
    return `${label} ${searchText}`.toLowerCase().includes(ownerSearch.toLowerCase());
  };

  const renderOwnerOption = (option: (typeof agentOwnerOptions)[number]) => (
    <button
      key={option.value}
      className={cn(
        "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
        option.value === selectedOwnerAgentId && "bg-accent",
      )}
      onClick={() =>
        selectOwner(option.agent.id, option.label, () => trackRecentAssignee(option.agent.id))
      }
    >
      <AgentIcon icon={option.agent.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.value === selectedOwnerAgentId ? (
        <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />
      ) : null}
    </button>
  );

  const visibleOwnerOptions = agentOwnerOptions.filter((option) =>
    matchesOwnerSearch(option.label, option.searchText),
  );

  const ownerContent = pendingOwner ? (
    <div className="space-y-2 p-1">
      <InterruptOwnerChangeConfirm
        copy={ownerChangeInterruptCopy}
        to={{ ownerKind: "agent", ownerAgentId: pendingOwner.ownerAgentId, ownerUserId: null }}
        resolvers={ownerResolvers}
        onConfirm={() =>
          applyOwner(pendingOwner.ownerAgentId, pendingOwner.track)
        }
        onCancel={() => setPendingOwner(null)}
      />
    </div>
  ) : (
    <>
      {hasActiveRun ? (
        <div className="px-1 pt-1">
          <OwnerRunningBanner copy={ownerChangeInterruptCopy} />
        </div>
      ) : null}
      <input
        aria-label="Search owners"
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Search owners..."
        value={ownerSearch}
        onChange={(event) => setOwnerSearch(event.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-56 overflow-y-auto overscroll-contain">
        {visibleOwnerOptions.map((option) => renderOwnerOption(option))}
        {visibleOwnerOptions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No invokable agent matches.</div>
        ) : null}
      </div>
    </>
  );

  const executionParticipantsContent = (
    stageType: "review" | "approval",
    values: string[],
    search: string,
    setSearch: (value: string) => void,
    onClear: () => void,
  ) => (
    <>
      <input
        aria-label="Search reviewers or approvers"
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
        placeholder={`Search ${stageType === "review" ? "reviewers" : "approvers"}...`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            values.length === 0 && "bg-accent",
          )}
          onClick={onClear}
        >
          No {stageType === "review" ? "reviewers" : "approvers"}
        </button>
        {currentUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              values.includes(`user:${currentUserId}`) && "bg-accent",
            )}
            onClick={() => toggleExecutionParticipant(stageType, `user:${currentUserId}`)}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            Assign to me
          </button>
        )}
        {creatorUserId && creatorUserId !== currentUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              values.includes(`user:${creatorUserId}`) && "bg-accent",
            )}
            onClick={() => toggleExecutionParticipant(stageType, `user:${creatorUserId}`)}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            {creatorUserLabel ? creatorUserLabel : "Requester"}
          </button>
        )}
        {otherUserOptions
          .filter((option) => {
            if (!search.trim()) return true;
            return `${option.label} ${option.searchText ?? ""}`.toLowerCase().includes(search.toLowerCase());
          })
          .map((option) => (
            <button
              key={`${stageType}:${option.id}`}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                values.includes(option.id) && "bg-accent",
              )}
              onClick={() => toggleExecutionParticipant(stageType, option.id)}
            >
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              {option.label}
            </button>
          ))}
        {sortedAgents
          .filter((agent) => {
            if (!search.trim()) return true;
            return agent.name.toLowerCase().includes(search.toLowerCase());
          })
          .map((agent) => {
            const encoded = `agent:${agent.id}`;
            return (
              <button
                key={`${stageType}:${agent.id}`}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                  values.includes(encoded) && "bg-accent",
                )}
                onClick={() => toggleExecutionParticipant(stageType, encoded)}
              >
                <AgentIcon icon={agent.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
                {agent.name}
              </button>
            );
          })}
      </div>
    </>
  );

  const projectTrigger = task.projectId ? (
    <>
      <span
        className="shrink-0 h-3 w-3 rounded-sm"
        style={{ backgroundColor: orderedProjects.find((p) => p.id === task.projectId)?.color ?? "var(--project-seed)" }}
      />
      <span className="text-sm truncate min-w-0" title={projectName(task.projectId)}>{projectName(task.projectId)}</span>
    </>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );
  const projectPickerOptions = orderItemsBySelectedAndRecent(
    [
      { id: "", kind: "none" as const, name: "No project", color: null as string | null },
      ...orderedProjects.map((project) => ({
        id: project.id,
        kind: "project" as const,
        project,
        name: project.name,
        color: project.color ?? null,
      })),
    ],
    task.projectId ?? "",
    recentProjectIds,
  );

  const projectContent = (
    <>
      <input
        aria-label="Search projects"
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Search projects..."
        value={projectSearch}
        onChange={(e) => setProjectSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        {projectPickerOptions
          .filter((option) => {
            if (!projectSearch.trim()) return true;
            const q = projectSearch.toLowerCase();
            return option.name.toLowerCase().includes(q);
          })
          .map((option) => (
            <button
              key={option.id || "__none__"}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 whitespace-nowrap",
                option.id === (task.projectId ?? "") && "bg-accent",
              )}
              onClick={() => {
                if (option.kind === "project") {
                  trackRecentProject(option.project.id);
                  onUpdate({ projectId: option.project.id });
                } else {
                  onUpdate({ projectId: null });
                }
                setProjectOpen(false);
              }}
            >
              {option.kind === "project" ? (
                <span
                  className="shrink-0 h-3 w-3 rounded-sm"
                  style={{ backgroundColor: option.color ?? "var(--project-seed)" }}
                />
              ) : null}
              {option.name}
            </button>
          ))}
      </div>
    </>
  );

  const blockedByIds = task.blockedBy?.map((relation) => relation.id) ?? [];
  const blockedByRelations = task.blockedBy ?? [];
  const visibleBlockedByRelations = blockedByExpanded
    ? blockedByRelations
    : blockedByRelations.slice(0, TASK_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenBlockedByCount = blockedByRelations.length - visibleBlockedByRelations.length;
  const visibleChildTasks = subTasksExpanded
    ? childTasks
    : childTasks.slice(0, TASK_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenChildTaskCount = childTasks.length - visibleChildTasks.length;
  const blockingTasks = task.blocks ?? [];
  const visibleBlockingTasks = blockingExpanded
    ? blockingTasks
    : blockingTasks.slice(0, TASK_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenBlockingTaskCount = blockingTasks.length - visibleBlockingTasks.length;
  const visibleRelatedTasks = relatedTasksExpanded
    ? relatedTasks
    : relatedTasks.slice(0, TASK_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenRelatedTaskCount = relatedTasks.length - visibleRelatedTasks.length;
  const descendantTaskIds = useMemo(() => {
    if (!allTasks?.length) return new Set<string>();
    const childrenByParentId = new Map<string, string[]>();
    for (const candidate of allTasks) {
      if (!candidate.parentId) continue;
      const children = childrenByParentId.get(candidate.parentId) ?? [];
      children.push(candidate.id);
      childrenByParentId.set(candidate.parentId, children);
    }

    const descendants = new Set<string>();
    const stack = [...(childrenByParentId.get(task.id) ?? [])];
    while (stack.length > 0) {
      const candidateId = stack.pop();
      if (!candidateId || descendants.has(candidateId)) continue;
      descendants.add(candidateId);
      stack.push(...(childrenByParentId.get(candidateId) ?? []));
    }
    return descendants;
  }, [allTasks, task.id]);
  const currentParentTask = useMemo(() => {
    if (!task.parentId) return null;
    return allTasks?.find((candidate) => candidate.id === task.parentId) ?? null;
  }, [allTasks, task.parentId]);
  const parentIdentifier = task.ancestors?.[0]?.identifier ?? currentParentTask?.identifier;
  const parentTitle = task.ancestors?.[0]
    ? taskDisplayTitle(task.ancestors[0])
    : currentParentTask
      ? taskDisplayTitle(currentParentTask)
      : task.parentId?.slice(0, 8);
  const parentTrigger = task.parentId ? (
    <span
      className="text-sm truncate min-w-0"
      title={`${parentIdentifier ? `${parentIdentifier} ` : ""}${parentTitle ?? ""}`.trim()}
    >
      {parentIdentifier ? `${parentIdentifier} ` : ""}
      {parentTitle}
    </span>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );
  const parentLink = task.parentId ? (
    <Link
      to={`/tasks/${parentIdentifier ?? task.parentId}`}
      className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
      onClick={(e) => e.stopPropagation()}
      aria-label="Open parent task"
    >
      <ArrowUpRight className="h-3 w-3" />
    </Link>
  ) : undefined;
  const parentOptions = (allTasks ?? [])
    .filter((candidate) => candidate.id !== task.id)
    .filter((candidate) => !descendantTaskIds.has(candidate.id))
    .filter((candidate) => {
      if (!parentSearch.trim()) return true;
      const query = parentSearch.toLowerCase();
      return (
        (candidate.identifier ?? "").toLowerCase().includes(query) ||
        candidate.title?.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      return taskDisplayTitle(a).localeCompare(taskDisplayTitle(b));
    });
  const parentContent = (
    <>
      <input
        aria-label="Search parent tasks"
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Search tasks..."
        value={parentSearch}
        onChange={(e) => setParentSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            !task.parentId && "bg-accent",
          )}
          onClick={() => {
            onUpdate({ parentId: null });
            setParentOpen(false);
          }}
        >
          No parent
        </button>
        {parentOptions.map((candidate) => (
          <button
            key={candidate.id}
            className={cn(
              "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
              candidate.id === task.parentId && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ parentId: candidate.id });
              setParentOpen(false);
            }}
          >
            <StatusIcon status={candidate.boardPresentationStatus} className="h-3 w-3" />
            <span className="truncate">
              {candidate.identifier ? `${candidate.identifier} ` : ""}
              {candidate.title}
            </span>
          </button>
        ))}
      </div>
    </>
  );
  const blockerSearchActive = normalizedBlockedBySearch.length > 0;
  const blockerSourceTasks = blockerSearchActive ? searchedBlockedByTasks : allTasks;
  const blockerOptions = (blockerSourceTasks ?? [])
    .filter((candidate) => candidate.id !== task.id);
  if (!blockerSearchActive) {
    blockerOptions.sort((a, b) => {
      return taskDisplayTitle(a).localeCompare(taskDisplayTitle(b));
    });
  }
  const blockerOptionsLoading = blockedByOpen && (
    blockerSearchActive ? isFetchingSearchedBlockedByTasks : isFetchingTaskPickerTasks
  );

  const toggleBlockedBy = (blockedByTaskId: string) => {
    const nextBlockedByIds = blockedByIds.includes(blockedByTaskId)
      ? blockedByIds.filter((candidate) => candidate !== blockedByTaskId)
      : [...blockedByIds, blockedByTaskId];
    onUpdate({ blockedByTaskIds: nextBlockedByIds });
    setBlockedByOpen(false);
    setBlockedBySearch("");
  };
  const removeBlockedBy = (blockedByTaskId: string) => {
    onUpdate({ blockedByTaskIds: blockedByIds.filter((candidate) => candidate !== blockedByTaskId) });
  };

  const blockedByContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Search tasks..."
        value={blockedBySearch}
        onChange={(e) => setBlockedBySearch(e.target.value)}
        autoFocus={!inline}
        aria-label="Search tasks to add as blockers"
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            blockedByIds.length === 0 && "bg-accent",
          )}
          onClick={() => {
            onUpdate({ blockedByTaskIds: [] });
            setBlockedByOpen(false);
            setBlockedBySearch("");
          }}
        >
          No blockers
        </button>
        {blockerOptions.map((candidate) => {
          const selected = blockedByIds.includes(candidate.id);
          return (
            <button
              key={candidate.id}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
                selected && "bg-accent",
              )}
              onClick={() => toggleBlockedBy(candidate.id)}
            >
              <StatusIcon status={candidate.boardPresentationStatus} className="h-3 w-3" />
              <span className="truncate">
                {candidate.identifier ? `${candidate.identifier} ` : ""}
                {candidate.title}
              </span>
              {selected && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />}
            </button>
          );
        })}
        {blockerOptionsLoading ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">Searching tasks...</div>
        ) : blockerOptions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No matching tasks.</div>
        ) : null}
      </div>
    </>
  );
  const renderAddBlockedByButton = (onClick?: () => void) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      onClick={onClick}
    >
      <Plus className="h-3 w-3" />
      Add blocker
    </button>
  );

  return (
    <div>
      <PropertySection title="Triage" first>
        <PropertyRow label="Status">
          <StatusIcon
            status={task.boardPresentationStatus}
            size="lg"
            blockerAttention={task.blockerAttention}
            onChange={(status) => onUpdate({ status })}
            showLabel
          />
        </PropertyRow>

        <PropertyRow label="Priority">
          <PriorityIcon
            priority={task.priority}
            onChange={(priority) => onUpdate({ priority })}
            showLabel
          />
        </PropertyRow>

        <PropertyPicker
          inline={inline}
          label="Labels"
          open={labelsOpen}
          onOpenChange={(open) => { setLabelsOpen(open); if (!open) setLabelSearch(""); }}
          triggerContent={labelsTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-64"
          extra={labelsExtra}
        >
          {labelsContent}
        </PropertyPicker>

        <PropertyPicker
          inline={inline}
          label="Owner"
          open={ownerOpen}
          onOpenChange={(open) => { setOwnerOpen(open); if (!open) { setOwnerSearch(""); setPendingOwner(null); } }}
          triggerContent={ownerTrigger}
          popoverClassName="w-52"
          extra={task.ownerAgentId ? (
            <Link
              to={`/agents/${task.ownerAgentId}`}
              aria-label={`Open ${agentName(task.ownerAgentId) ?? "owner"} agent`}
              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : undefined}
        >
          {ownerContent}
        </PropertyPicker>

        <PropertyPicker
          inline={inline}
          label="Project"
          open={projectOpen}
          onOpenChange={(open) => { setProjectOpen(open); if (!open) setProjectSearch(""); }}
          triggerContent={projectTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-fit min-w-(--sz-11rem)"
          extra={task.projectId ? (
            <Link
              to={projectLink(task.projectId)!}
              aria-label="Open project"
              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : undefined}
        >
          {projectContent}
        </PropertyPicker>
      </PropertySection>

      <PropertySection title="Relationships">
        <PropertyPicker
          inline={inline}
          label="Parent"
          open={parentOpen}
          onOpenChange={(open) => {
            setParentOpen(open);
            if (!open) setParentSearch("");
          }}
          triggerContent={parentTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-72"
          extra={parentLink}
        >
          {parentContent}
        </PropertyPicker>

        {inline ? (
          <div>
            <PropertyRow label="Blocked by" wrap>
              {visibleBlockedByRelations.map((relation) => (
                <RemovableTaskReferencePill key={relation.id} task={relation} onRemove={removeBlockedBy} />
              ))}
              <ExpandRelationListButton
                hiddenCount={hiddenBlockedByCount}
                expanded={blockedByExpanded}
                onClick={() => setBlockedByExpanded((expanded) => !expanded)}
              />
              {renderAddBlockedByButton(() => setBlockedByOpen((open) => !open))}
            </PropertyRow>
            {blockedByOpen && (
              <div className="rounded-md border border-border bg-popover p-1 mb-2">
                {blockedByContent}
              </div>
            )}
          </div>
        ) : (
          <PropertyRow label="Blocked by" wrap>
            {visibleBlockedByRelations.map((relation) => (
              <RemovableTaskReferencePill key={relation.id} task={relation} onRemove={removeBlockedBy} />
            ))}
            <ExpandRelationListButton
              hiddenCount={hiddenBlockedByCount}
              expanded={blockedByExpanded}
              onClick={() => setBlockedByExpanded((expanded) => !expanded)}
            />
            <Popover
              open={blockedByOpen}
              onOpenChange={(open) => {
                setBlockedByOpen(open);
                if (!open) setBlockedBySearch("");
              }}
            >
              <PopoverTrigger asChild>
                {renderAddBlockedByButton()}
              </PopoverTrigger>
              <PopoverContent className="w-72 p-1" align="end" collisionPadding={16}>
                {blockedByContent}
              </PopoverContent>
            </Popover>
          </PropertyRow>
        )}

        <PropertyRow label="Blocking" wrap>
          {blockingTasks.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {visibleBlockingTasks.map((relation) => (
                <TaskReferencePill key={relation.id} task={relation} />
              ))}
              <ExpandRelationListButton
                hiddenCount={hiddenBlockingTaskCount}
                expanded={blockingExpanded}
                onClick={() => setBlockingExpanded((expanded) => !expanded)}
              />
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>

        <PropertyRow label="Sub-tasks" wrap>
          <div className="flex flex-wrap items-center gap-1.5">
            {childTasks.length > 0
              ? visibleChildTasks.map((child) => (
                <TaskReferencePill key={child.id} task={child} />
              ))
              : null}
            <ExpandRelationListButton
              hiddenCount={hiddenChildTaskCount}
              expanded={subTasksExpanded}
              onClick={() => setSubTasksExpanded((expanded) => !expanded)}
            />
            {onAddSubTask ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                onClick={onAddSubTask}
              >
                <Plus className="h-3 w-3" />
                Add sub-task
              </button>
            ) : null}
          </div>
        </PropertyRow>

        {relatedTasks.length > 0 ? (
          <PropertyRow label="Related tasks" wrap>
            <div className="flex flex-wrap items-center gap-1.5">
              {visibleRelatedTasks.map((related) => (
                <TaskReferencePill key={related.id} task={related} />
              ))}
              <ExpandRelationListButton
                hiddenCount={hiddenRelatedTaskCount}
                expanded={relatedTasksExpanded}
                onClick={() => setRelatedTasksExpanded((expanded) => !expanded)}
              />
            </div>
          </PropertyRow>
        ) : null}

      </PropertySection>

      <PropertySection title="Execution">
        <PropertyPicker
          inline={inline}
          label="Reviewers"
          open={reviewersOpen}
          onOpenChange={(open) => { setReviewersOpen(open); if (!open) setReviewerSearch(""); }}
          triggerContent={reviewerTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-56"
        >
          {executionParticipantsContent(
            "review",
            reviewerValues,
            reviewerSearch,
            setReviewerSearch,
            () => updateExecutionPolicy([], approverValues),
          )}
        </PropertyPicker>
        <PropertyPicker
          inline={inline}
          label="Approvers"
          open={approversOpen}
          onOpenChange={(open) => { setApproversOpen(open); if (!open) setApproverSearch(""); }}
          triggerContent={approverTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-56"
        >
          {executionParticipantsContent(
            "approval",
            approverValues,
            approverSearch,
            setApproverSearch,
            () => updateExecutionPolicy(reviewerValues, []),
          )}
        </PropertyPicker>
        <PropertyPicker
          inline={inline}
          label="Monitor"
          open={monitorOpen}
          onOpenChange={setMonitorOpen}
          triggerContent={monitorTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName={cn("max-w-full", inline ? "w-full" : "w-80 sm:w-(--sz-32rem)")}
        >
          {monitorContent}
        </PropertyPicker>
        {currentExecutionLabel && (
          <PropertyRow label="Execution">
            <div className="flex min-w-0 flex-col items-start gap-1.5">
              <span className="text-sm truncate min-w-0" title={currentExecutionLabel}>{currentExecutionLabel}</span>
              {canCurrentUserDecideExecutionStage ? (
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7"
                    disabled={decideExecutionStage.isPending}
                    onClick={() => requestExecutionStageDecision("approved")}
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={decideExecutionStage.isPending}
                    onClick={() => requestExecutionStageDecision("changes_requested")}
                  >
                    Request changes
                  </Button>
                </div>
              ) : null}
              {decideExecutionStage.error instanceof Error ? (
                <span className="text-xs text-destructive" role="alert">
                  {decideExecutionStage.error.message}
                </span>
              ) : null}
            </div>
          </PropertyRow>
        )}

      </PropertySection>

      <PropertySection title="About">
        {originatingActor ? (
          <PropertyRow label="Originating">
            {originatingActor.kind === "agent" ? (
              <Link
                to={`/agents/${originatingActor.id}`}
                aria-label={`Open ${agentName(originatingActor.id) ?? "originating"} agent`}
                className="hover:underline"
              >
                <Identity
                  name={agentName(originatingActor.id) ?? originatingActor.id.slice(0, 8)}
                  size="sm"
                />
              </Link>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <Identity
                  name={actualUserLabel(originatingActor.id) ?? originatingUserProfile?.label ?? "User"}
                  avatarUrl={originatingUserProfile?.image ?? null}
                  size="sm"
                />
                {originatingViaAgentName ? (
                  <span className="shrink-0 truncate text-xs text-muted-foreground">
                    via {originatingViaAgentName}
                  </span>
                ) : null}
              </span>
            )}
          </PropertyRow>
        ) : null}
        {task.startedAt && (
          <PropertyRow label="Started">
            <span className="text-sm">{formatDateTime(task.startedAt)}</span>
          </PropertyRow>
        )}
        {task.completedAt && (
          <PropertyRow label="Completed">
            <span className="text-sm">{formatDateTime(task.completedAt)}</span>
          </PropertyRow>
        )}
        <PropertyRow label="Created">
          <span className="text-sm">{formatDateTime(task.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{timeAgo(task.updatedAt)}</span>
        </PropertyRow>
        {task.archivedAt && task.archivedByActorType === "agent" && task.archivedByAgentId ? (
          (() => {
            const archivedByAgent = (agents ?? []).find((candidate) => candidate.id === task.archivedByAgentId);
            const archivedByName = agentName(task.archivedByAgentId);
            return (
              <PropertyRow label="Archived">
                <div className="flex min-w-0 max-w-full flex-col items-start gap-1">
                  {/* The row label already reads "Archived", so the value shows just
                      the attributing agent (icon + name) — this gives the name the
                      full ~164px value column at the real 320px pane width, where an
                      "Archived by …" prefix would clip even short names. The full
                      phrasing + timestamp live in the tooltip so any residual
                      truncation on genuinely long names is recoverable. */}
                  <span
                    className="flex min-w-0 max-w-full items-center gap-1.5 text-sm"
                    title={`Archived by ${archivedByName} · ${formatDateTime(task.archivedAt)}`}
                  >
                    {archivedByAgent
                      ? <AgentIcon icon={archivedByAgent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      : null}
                    <span className="min-w-0 truncate">
                      {archivedByName}
                    </span>
                  </span>
                  <div className="flex min-w-0 max-w-full items-center gap-2">
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(task.archivedAt)}</span>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
                      onClick={() => unarchiveFromInbox.mutate()}
                      disabled={unarchiveFromInbox.isPending}
                    >
                      <ArchiveRestore className="h-3 w-3" />
                      {unarchiveFromInbox.isPending ? "Unarchiving…" : "Unarchive"}
                    </button>
                  </div>
                  {unarchiveErrorMessage ? (
                    <p className="text-xs text-destructive" role="alert">
                      {unarchiveErrorMessage}
                    </p>
                  ) : null}
                </div>
              </PropertyRow>
            );
          })()
        ) : null}
        {task.requestDepth > 0 && (
          <PropertyRow label="Depth">
            <span className="text-sm font-mono">{task.requestDepth}</span>
          </PropertyRow>
        )}
      </PropertySection>

    </div>
  );
}
