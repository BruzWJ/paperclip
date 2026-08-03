import type { IssueSessionMessage } from "@paperclipai/shared";

/**
 * Derives the persisted checkpoint text from the canonical V2 assistant
 * message. This uses the canonical text-part-only summary selection:
 * reasoning, tool state, provider metadata, and envelope fields
 * never become compaction context.
 */
export function deriveCanonicalCompactionSummaryText(
  assistant: Extract<IssueSessionMessage, { type: "assistant" }>,
): string {
  return assistant.content
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
