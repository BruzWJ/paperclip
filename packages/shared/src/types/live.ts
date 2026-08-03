import type { LiveEventType } from "../constants.js";

export const ISSUE_EXECUTION_LIVE_PLAN_PRIORITIES = [
  "high",
  "medium",
  "low",
] as const;

export type IssueExecutionLivePlanPriority =
  (typeof ISSUE_EXECUTION_LIVE_PLAN_PRIORITIES)[number];

export const ISSUE_EXECUTION_LIVE_PLAN_STATUSES = [
  "pending",
  "in_progress",
  "completed",
] as const;

export type IssueExecutionLivePlanStatus =
  (typeof ISSUE_EXECUTION_LIVE_PLAN_STATUSES)[number];

export interface IssueExecutionLivePlanItem {
  content: string;
  priority: IssueExecutionLivePlanPriority;
  status: IssueExecutionLivePlanStatus;
}

export interface IssueExecutionPlanLivePayload {
  companyId: string;
  issueId: string;
  runId: string;
  refId: string;
  runOrdinal: number;
  segmentOrdinal: number;
  replacement: readonly IssueExecutionLivePlanItem[];
}

type GenericLiveEventPayloadMap = {
  [Type in Exclude<
    LiveEventType,
    "issue.execution.plan.live"
  >]: Record<string, unknown>;
};

/**
 * Payload ownership for the company live-event stream. Stable ACP plans are
 * deliberately the first exact payload in this map; existing operational
 * events remain generic until their owning migrations close them separately.
 */
export type LiveEventPayloadMap = GenericLiveEventPayloadMap & {
  "issue.execution.plan.live": IssueExecutionPlanLivePayload;
};

export type LiveEventOf<Type extends LiveEventType> = {
  [EventType in Type]: {
    id: number;
    companyId: string;
    type: EventType;
    createdAt: string;
    payload: LiveEventPayloadMap[EventType];
  };
}[Type];

export type LiveEvent = LiveEventOf<LiveEventType>;

const PLAN_PAYLOAD_KEYS = new Set([
  "companyId",
  "issueId",
  "runId",
  "refId",
  "runOrdinal",
  "segmentOrdinal",
  "replacement",
]);

const PLAN_ITEM_KEYS = new Set(["content", "priority", "status"]);
const LIVE_EVENT_KEYS = new Set([
  "id",
  "companyId",
  "type",
  "createdAt",
  "payload",
]);

function isExactRecord(
  value: unknown,
  keys: ReadonlySet<string>,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.size &&
    Object.keys(value).every((key) => keys.has(key))
  );
}

function isNonEmptyIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isLivePlanItem(value: unknown): value is IssueExecutionLivePlanItem {
  if (!isExactRecord(value, PLAN_ITEM_KEYS)) return false;
  return (
    typeof value.content === "string" &&
    typeof value.priority === "string" &&
    (ISSUE_EXECUTION_LIVE_PLAN_PRIORITIES as readonly string[]).includes(
      value.priority,
    ) &&
    typeof value.status === "string" &&
    (ISSUE_EXECUTION_LIVE_PLAN_STATUSES as readonly string[]).includes(
      value.status,
    )
  );
}

/**
 * Decode the exact public live-plan payload. Unknown fields (including
 * `_meta`), malformed entries, and noncanonical ordinals fail closed.
 */
export function decodeIssueExecutionPlanLivePayload(
  value: unknown,
): IssueExecutionPlanLivePayload | null {
  if (!isExactRecord(value, PLAN_PAYLOAD_KEYS)) return null;
  if (
    !isNonEmptyIdentity(value.companyId) ||
    !isNonEmptyIdentity(value.issueId) ||
    !isNonEmptyIdentity(value.runId) ||
    !isNonEmptyIdentity(value.refId) ||
    !Number.isSafeInteger(value.runOrdinal) ||
    (value.runOrdinal as number) < 1 ||
    !Number.isSafeInteger(value.segmentOrdinal) ||
    (value.segmentOrdinal as number) < 0 ||
    !Array.isArray(value.replacement) ||
    !value.replacement.every(isLivePlanItem)
  ) {
    return null;
  }
  return {
    companyId: value.companyId,
    issueId: value.issueId,
    runId: value.runId,
    refId: value.refId,
    runOrdinal: value.runOrdinal as number,
    segmentOrdinal: value.segmentOrdinal as number,
    replacement: value.replacement.map((item) => ({
      content: item.content,
      priority: item.priority,
      status: item.status,
    })),
  };
}

export function decodeIssueExecutionPlanLiveEvent(
  value: unknown,
): LiveEventOf<"issue.execution.plan.live"> | null {
  if (!isExactRecord(value, LIVE_EVENT_KEYS)) return null;
  const candidate = value;
  if (
    candidate.type !== "issue.execution.plan.live" ||
    !Number.isSafeInteger(candidate.id) ||
    (candidate.id as number) < 1 ||
    !isNonEmptyIdentity(candidate.companyId) ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }
  const payload = decodeIssueExecutionPlanLivePayload(candidate.payload);
  if (!payload || payload.companyId !== candidate.companyId) return null;
  return {
    id: candidate.id as number,
    companyId: candidate.companyId,
    type: "issue.execution.plan.live",
    createdAt: candidate.createdAt,
    payload,
  };
}
