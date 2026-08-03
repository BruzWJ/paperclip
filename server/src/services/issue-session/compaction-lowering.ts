import type { IssueSessionMessage } from "@paperclipai/shared/issue-session";
import { PAPERCLIP_SESSION_COMPACTION_VERSION } from "../issue-session-compaction-contract.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The canonical compaction request is stored as an empty V2 user marker and
 * receives its provider-facing text only at the lowering boundary.
 */
export function lowerCanonicalCompactionMarker(
  message: IssueSessionMessage,
): IssueSessionMessage {
  const compaction = record(
    record(record(message.metadata).paperclip).compaction,
  );
  if (
    message.type !== "user" ||
    compaction.version !== PAPERCLIP_SESSION_COMPACTION_VERSION ||
    compaction.role !== "request-marker"
  ) {
    return message;
  }
  return {
    ...message,
    text: "What did we do so far?",
  };
}
