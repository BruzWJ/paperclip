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

function formatStructuredTaskChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
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
      return `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", removed);
      return `removed ${changed} from`;
    }
    return "updated blockers on";
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
      return `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return `removed ${changed} from`;
    }
    return `updated ${plural} on`;
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
  });
  if (structuredChange) return structuredChange;

  return ACTIVITY_ROW_VERBS[action] ?? action.replace(/[._]/g, " ");
}
