import * as d from "./tasks-dependencies.js";

import type { TaskFilters } from "./tasks-shared-part-1.js";
import { listTaskBlockerAttentionMap } from "./tasks-shared-part-5.js";
import {
  type BlockedInboxApprovalRow,
  type BlockedInboxTaskRow,
  BLOCKED_INBOX_PENDING_APPROVAL_STATUSES,
  BLOCKED_INBOX_TERMINAL_STATUSES,
  isoDate,
  taskRef,
} from "./tasks-shared-part-6-section-1.js";
export function attentionBase(input: {
  state: d.TaskBlockedInboxAttention["state"];
  reason: d.TaskBlockedInboxAttention["reason"];
  severity: d.TaskBlockedInboxAttention["severity"];
  stoppedSinceAt: Date | string | null | undefined;
  owner: d.TaskBlockedInboxAttention["owner"];
  action: d.TaskBlockedInboxAttention["action"];
  sourceTask: d.TaskBlockedInboxTaskRef | null;
  leafTask?: d.TaskBlockedInboxTaskRef | null;
  approvalId?: string | null;
  sampleTaskIdentifier?: string | null;
  externalDetailsRedacted?: boolean;
}): d.TaskBlockedInboxAttention {
  return {
    kind: "blocked",
    state: input.state,
    reason: input.reason,
    severity: input.severity,
    stoppedSinceAt: isoDate(input.stoppedSinceAt),
    owner: input.owner,
    action: input.action,
    sourceTask: input.sourceTask,
    leafTask: input.leafTask ?? null,
    approvalId: input.approvalId ?? null,
    sampleTaskIdentifier:
      input.sampleTaskIdentifier ?? input.leafTask?.identifier ?? input.sourceTask?.identifier ?? null,
    redaction: {
      externalDetailsRedacted: input.externalDetailsRedacted ?? false,
      secretFieldsOmitted: true,
    },
  };
}
export function externalWaitFromRequest(request: string | null): { owner: string; action: string } | null {
  if (!request) return null;
  const owner = request.match(/^\s*external owner\s*:\s*(.+)$/im)?.[1]?.trim();
  const action = request.match(/^\s*external action\s*:\s*(.+)$/im)?.[1]?.trim();
  if (!owner || !action) return null;
  return {
    owner: owner.slice(0, 120),
    action: action.slice(0, 240),
  };
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactExternalWaitRequest(
  request: string | null | undefined,
  external: { owner: string; action: string } | null,
) {
  if (!request) return null;
  let redacted = request
    .split(/\r?\n/)
    .filter((line) => !/^\s*external\s+(?:owner|action)\s*:/i.test(line))
    .join("\n");

  for (const value of [external?.owner, external?.action]) {
    if (!value) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "gi"), "[redacted external wait detail]");
  }

  redacted = redacted.replace(/\n{3,}/g, "\n\n").trim();
  return redacted.length > 0 ? redacted : null;
}

export function blockedInboxResponseRequest(
  attention: d.TaskBlockedInboxAttention,
  row: BlockedInboxTaskRow,
) {
  if (!attention.redaction.externalDetailsRedacted) return row.request;
  return redactExternalWaitRequest(row.request, externalWaitFromRequest(row.request)) ?? "[redacted]";
}

export function blockedInboxSearchText(attention: d.TaskBlockedInboxAttention, row: BlockedInboxTaskRow) {
  return [
    row.identifier,
    row.title,
    blockedInboxResponseRequest(attention, row),
    attention.sourceTask?.identifier,
    attention.sourceTask?.title,
    attention.leafTask?.identifier,
    attention.leafTask?.title,
    attention.sampleTaskIdentifier,
    attention.action.label,
    attention.action.detail,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

export function blockedInboxSeverityRank(severity: d.TaskBlockedInboxAttention["severity"]) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
}

export function taskPriorityRank(priority: string) {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

export function compareBlockedInboxRows(
  left: BlockedInboxTaskRow & {
    blockedInboxAttention: d.TaskBlockedInboxAttention;
    lastActivityAt?: Date | null;
  },
  right: BlockedInboxTaskRow & {
    blockedInboxAttention: d.TaskBlockedInboxAttention;
    lastActivityAt?: Date | null;
  },
) {
  const leftAttention = left.blockedInboxAttention;
  const rightAttention = right.blockedInboxAttention;
  const severity =
    blockedInboxSeverityRank(leftAttention.severity) - blockedInboxSeverityRank(rightAttention.severity);
  if (severity !== 0) return severity;

  const leftStopped = leftAttention.stoppedSinceAt
    ? new Date(leftAttention.stoppedSinceAt).getTime()
    : Number.POSITIVE_INFINITY;
  const rightStopped = rightAttention.stoppedSinceAt
    ? new Date(rightAttention.stoppedSinceAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (leftStopped !== rightStopped) return leftStopped - rightStopped;

  const priority = taskPriorityRank(left.priority) - taskPriorityRank(right.priority);
  if (priority !== 0) return priority;

  const leftActivity = left.lastActivityAt
    ? new Date(left.lastActivityAt).getTime()
    : new Date(left.updatedAt).getTime();
  const rightActivity = right.lastActivityAt
    ? new Date(right.lastActivityAt).getTime()
    : new Date(right.updatedAt).getTime();
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;

  return right.id.localeCompare(left.id);
}

export async function listTaskBlockedInboxAttentionMap(
  dbOrTx: any,
  companyId: string,
  taskRows: BlockedInboxTaskRow[],
): Promise<Map<string, d.TaskBlockedInboxAttention>> {
  const rowTaskIds = [...new Set(taskRows.map((row) => row.id))];
  const result = new Map<string, d.TaskBlockedInboxAttention>();
  if (rowTaskIds.length === 0) return result;

  const approvalRows: BlockedInboxApprovalRow[] = await dbOrTx
    .select({
      approvalId: d.approvals.id,
      taskId: d.taskApprovals.taskId,
      createdAt: d.approvals.createdAt,
    })
    .from(d.taskApprovals)
    .innerJoin(d.approvals, d.eq(d.taskApprovals.approvalId, d.approvals.id))
    .where(
      d.and(
        d.eq(d.taskApprovals.companyId, companyId),
        d.eq(d.approvals.companyId, companyId),
        d.inArray(d.approvals.status, [...BLOCKED_INBOX_PENDING_APPROVAL_STATUSES]),
        d.inArray(d.taskApprovals.taskId, rowTaskIds),
      ),
    );
  const blockerAttention = await listTaskBlockerAttentionMap(dbOrTx, companyId, taskRows);

  const approvalByTaskId = new Map<string, BlockedInboxApprovalRow>();
  for (const row of approvalRows) {
    if (!approvalByTaskId.has(row.taskId)) approvalByTaskId.set(row.taskId, row);
  }
  for (const row of taskRows) {
    if (
      row.companyId !== companyId ||
      BLOCKED_INBOX_TERMINAL_STATUSES.includes(
        row.boardPresentationStatus as (typeof BLOCKED_INBOX_TERMINAL_STATUSES)[number],
      ) ||
      row.hiddenAt
    ) {
      continue;
    }
    const source = taskRef(row);

    const approval = approvalByTaskId.get(row.id);
    if (approval) {
      result.set(
        row.id,
        attentionBase({
          state: "awaiting_decision",
          reason: "pending_board_decision",
          severity: "medium",
          stoppedSinceAt: approval.createdAt,
          owner: { type: "board", agentId: null, userId: null, label: "Board" },
          action: {
            label: "Decide approval",
            detail: "Approve, reject, or request revision on the linked approval.",
          },
          sourceTask: source,
          approvalId: approval.approvalId,
        }),
      );
      continue;
    }

    const hasMonitor = Boolean(row.monitorNextCheckAt && row.monitorNextCheckAt.getTime() > Date.now());
    const external =
      row.boardPresentationStatus === "blocked" && !hasMonitor ? externalWaitFromRequest(row.request) : null;
    if (external) {
      result.set(
        row.id,
        attentionBase({
          state: "external_wait",
          reason: "external_owner_action",
          severity: "medium",
          stoppedSinceAt: row.updatedAt,
          owner: { type: "external", agentId: null, userId: null, label: null },
          action: {
            label: "External owner action",
            detail: null,
          },
          sourceTask: source,
          externalDetailsRedacted: true,
        }),
      );
      continue;
    }

    const blockerState = blockerAttention.get(row.id);
    if (
      row.boardPresentationStatus === "blocked" &&
      (blockerState?.state === "needs_attention" || blockerState?.state === "stalled")
    ) {
      result.set(
        row.id,
        attentionBase({
          state: "needs_attention",
          reason: "blocked_chain_stalled",
          severity: "high",
          stoppedSinceAt: row.updatedAt,
          owner: { type: "unknown", agentId: null, userId: null, label: null },
          action: {
            label: "Inspect blocker chain",
            detail: "Inspect the stalled blocker or review leaf and make the next owner/action explicit.",
          },
          sourceTask: source,
          sampleTaskIdentifier:
            blockerState.sampleStalledBlockerIdentifier ?? blockerState.sampleBlockerIdentifier,
        }),
      );
    }
  }

  return result;
}

export function taskOwnerAgentFilter(ownerAgentId: TaskFilters["ownerAgentId"]): string | null | undefined {
  if (typeof ownerAgentId === "string" && !d.isCanonicalUuid(ownerAgentId)) {
    throw d.unprocessable("ownerAgentId must be an exact canonical UUID");
  }
  return ownerAgentId;
}
