import {
  compareMoneyAmounts,
  parseMoneyAmount,
  type Approval,
  type DashboardSummary,
  type JoinRequest,
  type Task,
  type TaskExecutionRunEnvelopeRecord,
} from "@paperclipai/shared";
import {
  ACTIONABLE_APPROVAL_STATUSES,
  FAILED_RUN_STATUSES,
  RECENT_TASKS_LIMIT,
  type InboxApprovalFilter,
  type InboxBadgeData,
  type InboxTab,
  type InboxWorkItem,
  normalizeTimestamp,
  sortTasksByMostRecentActivity,
  taskLastActivityTimestamp,
} from "./inbox-model";
import { isInboxEntityDismissed } from "./inbox-storage";

const ZERO_AMOUNT = parseMoneyAmount("0");

export function getLatestFailedRunsByAgent(
  runs: TaskExecutionRunEnvelopeRecord[],
): TaskExecutionRunEnvelopeRecord[] {
  const sorted = [...runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const latestByAgent = new Map<string, TaskExecutionRunEnvelopeRecord>();

  for (const run of sorted) {
    const agentKey = run.targetAgentId;
    if (!latestByAgent.has(agentKey)) {
      latestByAgent.set(agentKey, run);
    }
  }

  return Array.from(latestByAgent.values()).filter((run) => FAILED_RUN_STATUSES.has(run.status));
}

export function getRecentTouchedTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(sortTasksByMostRecentActivity).slice(0, RECENT_TASKS_LIMIT);
}

export function getApprovalsForTab(
  approvals: Approval[],
  tab: InboxTab,
  filter: InboxApprovalFilter,
  currentUserId?: string | null,
): Approval[] {
  const sortedApprovals = [...approvals].sort(
    (a, b) => normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt),
  );

  if (tab === "mine") {
    return sortedApprovals.filter((approval) => isApprovalVisibleInMine(approval, currentUserId));
  }
  if (tab === "recent") return sortedApprovals;
  if (tab === "unread") {
    return sortedApprovals.filter((approval) => ACTIONABLE_APPROVAL_STATUSES.has(approval.status));
  }
  if (filter === "all") return sortedApprovals;

  return sortedApprovals.filter((approval) => {
    const isActionable = ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
    return filter === "actionable" ? isActionable : !isActionable;
  });
}

export function isApprovalVisibleInMine(approval: Approval, currentUserId?: string | null): boolean {
  if (ACTIONABLE_APPROVAL_STATUSES.has(approval.status)) return true;
  if (!currentUserId) return false;
  return approval.requestedByUserId === currentUserId || approval.decidedByUserId === currentUserId;
}

export function approvalActivityTimestamp(approval: Approval): number {
  const updatedAt = normalizeTimestamp(approval.updatedAt);
  if (updatedAt > 0) return updatedAt;
  return normalizeTimestamp(approval.createdAt);
}

export function getInboxWorkItems({
  tasks,
  approvals,
  failedRuns = [],
  joinRequests = [],
}: {
  tasks: Task[];
  approvals: Approval[];
  failedRuns?: TaskExecutionRunEnvelopeRecord[];
  joinRequests?: JoinRequest[];
}): InboxWorkItem[] {
  return [
    ...tasks.map((task) => ({
      kind: "task" as const,
      timestamp: taskLastActivityTimestamp(task),
      task,
    })),
    ...approvals.map((approval) => ({
      kind: "approval" as const,
      timestamp: approvalActivityTimestamp(approval),
      approval,
    })),
    ...failedRuns.map((run) => ({
      kind: "failed_run" as const,
      timestamp: normalizeTimestamp(run.createdAt),
      run,
    })),
    ...joinRequests.map((joinRequest) => ({
      kind: "join_request" as const,
      timestamp: normalizeTimestamp(joinRequest.createdAt),
      joinRequest,
    })),
  ].sort((a, b) => {
    const timestampDiff = b.timestamp - a.timestamp;
    if (timestampDiff !== 0) return timestampDiff;

    if (a.kind === "task" && b.kind === "task") {
      return sortTasksByMostRecentActivity(a.task, b.task);
    }
    if (a.kind === "approval" && b.kind === "approval") {
      return approvalActivityTimestamp(b.approval) - approvalActivityTimestamp(a.approval);
    }

    return a.kind === "approval" ? -1 : 1;
  });
}

export function computeInboxBadgeData({
  approvals,
  joinRequests,
  dashboard,
  runs,
  mineTasks,
  dismissedAlerts,
  dismissedAtByKey,
  currentUserId,
}: {
  approvals: Approval[];
  joinRequests: JoinRequest[];
  dashboard: DashboardSummary | undefined;
  runs: TaskExecutionRunEnvelopeRecord[];
  mineTasks: Task[];
  dismissedAlerts: Set<string>;
  dismissedAtByKey: ReadonlyMap<string, number>;
  currentUserId?: string | null;
}): InboxBadgeData {
  const actionableApprovals = approvals.filter(
    (approval) =>
      isApprovalVisibleInMine(approval, currentUserId) &&
      ACTIONABLE_APPROVAL_STATUSES.has(approval.status) &&
      !isInboxEntityDismissed(dismissedAtByKey, `approval:${approval.id}`, approval.updatedAt),
  ).length;
  const failedRuns = getLatestFailedRunsByAgent(runs).filter(
    (run) => !isInboxEntityDismissed(dismissedAtByKey, `run:${run.id}`, run.createdAt),
  ).length;
  const visibleJoinRequests = joinRequests.filter(
    (jr) => !isInboxEntityDismissed(dismissedAtByKey, `join:${jr.id}`, jr.updatedAt ?? jr.createdAt),
  ).length;
  const visibleMineTasks = mineTasks.filter((task) => task.isUnreadForMe).length;
  const agentErrorCount = dashboard?.agents.error ?? 0;
  const monthBudgetAmount = dashboard?.costs.monthBudgetAmount ?? ZERO_AMOUNT;
  const monthUtilizationPercent = dashboard?.costs.monthUtilizationPercent ?? 0;
  const showAggregateAgentError =
    agentErrorCount > 0 && failedRuns === 0 && !dismissedAlerts.has("alert:agent-errors");
  const showBudgetAlert =
    compareMoneyAmounts(monthBudgetAmount, ZERO_AMOUNT) > 0 &&
    monthUtilizationPercent >= 80 &&
    !dismissedAlerts.has("alert:budget");
  const alerts = Number(showAggregateAgentError) + Number(showBudgetAlert);

  return {
    // The inbox badge reflects personal/actionable work, not company-wide health alerts.
    inbox: actionableApprovals + visibleJoinRequests + failedRuns + visibleMineTasks,
    approvals: actionableApprovals,
    failedRuns,
    joinRequests: visibleJoinRequests,
    mineTasks: visibleMineTasks,
    alerts,
  };
}
