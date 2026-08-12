import type { Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "./company-members";

type ActivityDetails = Record<string, unknown> | null | undefined;

type ActivityParticipant = {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
};

type ActivityTaskReference = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
};

interface ActivityFormatOptions {
  agentMap?: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  currentUserId?: string | null;
}

const ACTIVITY_ROW_VERBS: Record<string, string> = {
  "task.created": "created",
  "task.updated": "updated",
  "task.comment_added": "commented on",
  "task.attachment_added": "attached file to",
  "task.attachment_removed": "removed attachment from",
  "task.document_created": "created document for",
  "task.document_updated": "updated document on",
  "task.document_locked": "locked document on",
  "task.document_unlocked": "unlocked document on",
  "task.document_deleted": "deleted document from",
  "task.commented": "commented on",
  "agent.created": "created",
  "agent.updated": "updated",
  "agent.paused": "paused",
  "agent.resumed": "resumed",
  "agent.error_cleared": "cleared error on",
  "agent.terminated": "terminated",
  "agent.budget_updated": "updated budget for",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "project.created": "created",
  "project.updated": "updated",
  "project.deleted": "deleted",
  "goal.created": "created",
  "goal.updated": "updated",
  "goal.deleted": "deleted",
  "cost.reported": "reported cost for",
  "cost.recorded": "recorded cost for",
  "company.created": "created company",
  "company.updated": "updated company",
  "company.archived": "archived",
  "company.reactivated": "reactivated",
  "company.budget_updated": "updated budget for",
};

const TASK_ACTIVITY_LABELS: Record<string, string> = {
  "task.created": "created the task",
  "task.updated": "updated the task",
  "task.comment_added": "added a comment",
  "task.attachment_added": "added an attachment",
  "task.attachment_removed": "removed an attachment",
  "task.document_created": "created a document",
  "task.document_updated": "updated a document",
  "task.document_locked": "locked a document",
  "task.document_unlocked": "unlocked a document",
  "task.document_deleted": "deleted a document",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.error_cleared": "cleared the agent error",
  "agent.terminated": "terminated the agent",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function isActivityParticipant(value: unknown): value is ActivityParticipant {
  const record = asRecord(value);
  if (!record) return false;
  return record.type === "agent" || record.type === "user";
}

function isActivityTaskReference(
  value: unknown,
): value is ActivityTaskReference {
  return asRecord(value) !== null;
}

function readParticipants(
  details: ActivityDetails,
  key: string,
): ActivityParticipant[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityParticipant);
}

function readTaskReferences(
  details: ActivityDetails,
  key: string,
): ActivityTaskReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityTaskReference);
}

function formatUserLabel(
  userId: string | null | undefined,
  options: ActivityFormatOptions = {},
): string {
  if (!userId) return "Board";
  if (options.currentUserId && userId === options.currentUserId) return "You";
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  return `user ${userId.slice(0, 5)}`;
}

function formatParticipantLabel(
  participant: ActivityParticipant,
  options: ActivityFormatOptions,
): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? "agent";
  }
  return formatUserLabel(participant.userId, options);
}

function formatTaskReferenceLabel(reference: ActivityTaskReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  return "task";
}

function formatChangedEntityLabel(
  singular: string,
  plural: string,
  labels: string[],
): string {
  if (labels.length <= 0) return plural;
  if (labels.length === 1) return `${singular} ${labels[0]}`;
  return `${labels.length} ${plural}`;
}

function formatTaskUpdatedVerb(details: ActivityDetails): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.lifecycleStatus !== undefined) {
    const from = previous.lifecycleStatus;
    return from
      ? `changed lifecycle from ${humanizeValue(from)} to ${humanizeValue(details.lifecycleStatus)} on`
      : `changed lifecycle to ${humanizeValue(details.lifecycleStatus)} on`;
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? `changed priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)} on`
      : `changed priority to ${humanizeValue(details.priority)} on`;
  }
  return null;
}

function formatOwnerName(
  details: ActivityDetails,
  options: ActivityFormatOptions,
): string {
  if (!details) return "the board";
  const agentId = details.ownerAgentId;
  const userId = details.ownerUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? "agent";
  }
  if (typeof userId === "string" && userId) {
    return formatUserLabel(userId, options);
  }
  return "the board";
}

function formatTaskUpdatedAction(
  details: ActivityDetails,
  options: ActivityFormatOptions = {},
): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.lifecycleStatus !== undefined) {
    const from = previous.lifecycleStatus;
    parts.push(
      from
        ? `changed the lifecycle from ${humanizeValue(from)} to ${humanizeValue(details.lifecycleStatus)}`
        : `changed the lifecycle to ${humanizeValue(details.lifecycleStatus)}`,
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
        : `changed the priority to ${humanizeValue(details.priority)}`,
    );
  }
  if (
    details.ownerKind !== undefined ||
    details.ownerAgentId !== undefined ||
    details.ownerUserId !== undefined
  ) {
    parts.push(`changed the owner to ${formatOwnerName(details, options)}`);
  }
  if (details.title !== undefined) parts.push("updated the title");

  return parts.length > 0 ? parts.join(", ") : null;
}

function formatStructuredTaskChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forTaskDetail: boolean;
}): string | null {
  const details = input.details;
  if (!details) return null;

  if (input.action === "task.blockers_updated") {
    const added = readTaskReferences(details, "addedBlockedByTasks").map(
      formatTaskReferenceLabel,
    );
    const removed = readTaskReferences(details, "removedBlockedByTasks").map(
      formatTaskReferenceLabel,
    );
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", added);
      return input.forTaskDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", removed);
      return input.forTaskDetail
        ? `removed ${changed}`
        : `removed ${changed} from`;
    }
    return input.forTaskDetail ? "updated blockers" : "updated blockers on";
  }

  if (
    input.action === "task.reviewers_updated" ||
    input.action === "task.approvers_updated"
  ) {
    const added = readParticipants(details, "addedParticipants").map(
      (participant) => formatParticipantLabel(participant, input.options),
    );
    const removed = readParticipants(details, "removedParticipants").map(
      (participant) => formatParticipantLabel(participant, input.options),
    );
    const singular =
      input.action === "task.reviewers_updated" ? "reviewer" : "approver";
    const plural =
      input.action === "task.reviewers_updated" ? "reviewers" : "approvers";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return input.forTaskDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return input.forTaskDetail
        ? `removed ${changed}`
        : `removed ${changed} from`;
    }
    return input.forTaskDetail ? `updated ${plural}` : `updated ${plural} on`;
  }

  return null;
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "task.updated") {
    const taskUpdatedVerb = formatTaskUpdatedVerb(details);
    if (taskUpdatedVerb) return taskUpdatedVerb;
  }

  const structuredChange = formatStructuredTaskChange({
    action,
    details,
    options,
    forTaskDetail: false,
  });
  if (structuredChange) return structuredChange;

  return ACTIVITY_ROW_VERBS[action] ?? action.replace(/[._]/g, " ");
}

export function formatTaskActivityAction(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "task.updated") {
    const taskUpdatedAction = formatTaskUpdatedAction(details, options);
    if (taskUpdatedAction) return taskUpdatedAction;
  }

  const structuredChange = formatStructuredTaskChange({
    action,
    details,
    options,
    forTaskDetail: true,
  });
  if (structuredChange) return structuredChange;

  if (
    (action === "task.document_created" ||
      action === "task.document_updated" ||
      action === "task.document_locked" ||
      action === "task.document_unlocked" ||
      action === "task.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title =
      typeof details.title === "string" && details.title
        ? ` (${details.title})`
        : "";
    return `${TASK_ACTIVITY_LABELS[action] ?? action} ${key}${title}`;
  }

  return TASK_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
}
