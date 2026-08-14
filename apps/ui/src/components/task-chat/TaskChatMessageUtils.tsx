import type { ThreadMessage, ToolCallMessagePart } from "@assistant-ui/react";
import { memo, useContext } from "react";
import { type PaperclipTaskRuntimeOwnerChange } from "../../hooks/usePaperclipTaskRuntime";
import type { CompanyUserProfile } from "../../lib/company-members";
import { timeAgo } from "../../lib/timeAgo";
import { displayToolName, isCommandTool, summarizeToolInput } from "../../lib/transcriptPresentation";
import { cn, formatShortDate } from "../../lib/utils";
import { MarkdownBody } from "../MarkdownBody";

import { TaskChatCtx } from "./TaskChatShared";

export const DRAFT_DEBOUNCE_MS = 800;

export const COMPOSER_FOCUS_SCROLL_PADDING_PX = 96;

export type ComposerAttachmentItem = {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "attached" | "error";
  inline: boolean;
  contentPath?: string;
  error?: string;
};

export function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(draftKey: string, value: string) {
  try {
    if (value.trim()) {
      localStorage.setItem(draftKey, value);
    } else {
      localStorage.removeItem(draftKey);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

export function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}

export function parseOwnerChange(target: string): PaperclipTaskRuntimeOwnerChange | null {
  if (!target.startsWith("agent:")) return null;
  const ownerAgentId = target.slice("agent:".length);
  return ownerAgentId ? { ownerAgentId } : null;
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function commentDateLabel(date: Date | string | undefined): string {
  if (!date) return "";
  const then = new Date(date).getTime();
  if (Date.now() - then < WEEK_MS) return timeAgo(date);
  return formatShortDate(date);
}

export const TaskChatTextPart = memo(function TaskChatTextPart({
  text,
  recessed,
  onAccent,
}: {
  text: string;
  recessed?: boolean;
  onAccent?: boolean;
}) {
  const { onImageClick } = useContext(TaskChatCtx);
  return (
    <MarkdownBody
      className={cn("text-sm leading-6", onAccent && "paperclip-markdown-on-accent")}
      style={recessed ? { opacity: 0.55 } : undefined}
      softBreaks
      onImageClick={onImageClick}
    >
      {text}
    </MarkdownBody>
  );
});

export function humanizeValue(value: string | null) {
  if (!value) return "None";
  return value.replace(/_/g, " ");
}

export function taskChatMessageCustom(message: ThreadMessage): Record<string, unknown> {
  return (message.metadata?.custom ?? {}) as Record<string, unknown>;
}

export function taskChatMessageKind(message: ThreadMessage): string {
  const custom = taskChatMessageCustom(message);
  return typeof custom.kind === "string" ? custom.kind : message.role;
}

export function taskChatMessageAnchorId(message: ThreadMessage): string | null {
  const custom = taskChatMessageCustom(message);
  return typeof custom.anchorId === "string" ? custom.anchorId : null;
}

export function taskChatMessageRunIsActive(message: ThreadMessage, activeRunIds: ReadonlySet<string>) {
  const runId = taskChatMessageCustom(message).runId;
  return typeof runId === "string" && activeRunIds.has(runId);
}

export function taskChatMessageRunIsStopping(
  message: ThreadMessage,
  stoppingRunId: string | null | undefined,
) {
  const runId = taskChatMessageCustom(message).runId;
  return typeof runId === "string" && stoppingRunId === runId;
}

export function taskChatMessageQueuedRunIsInterrupting(
  message: ThreadMessage,
  interruptingQueuedRunId: string | null | undefined,
) {
  const targetRunId = taskChatMessageCustom(message).queueTargetRunId;
  return typeof targetRunId === "string" && interruptingQueuedRunId === targetRunId;
}

export function initialsForName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function resolveTaskChatHumanAuthor(args: {
  authorName?: string | null;
  authorUserId?: string | null;
  currentUserId?: string | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
}) {
  const { authorName, authorUserId, currentUserId, userProfileMap } = args;
  const profile = authorUserId ? (userProfileMap?.get(authorUserId) ?? null) : null;
  const isCurrentUser = Boolean(authorUserId && currentUserId && authorUserId === currentUserId);
  const resolvedAuthorName = profile?.label?.trim() || authorName?.trim() || (isCurrentUser ? "You" : "User");

  return {
    isCurrentUser,
    authorName: resolvedAuthorName,
    avatarUrl: profile?.image ?? null,
  };
}

export function toolCountSummary(toolParts: ToolCallMessagePart[]): string | null {
  if (toolParts.length === 0) return null;
  let commands = 0;
  let other = 0;
  for (const tool of toolParts) {
    if (isCommandTool(tool.toolName, tool.args)) commands++;
    else other++;
  }
  const parts: string[] = [];
  if (commands > 0) parts.push(`ran ${commands} command${commands === 1 ? "" : "s"}`);
  if (other > 0) parts.push(`called ${other} tool${other === 1 ? "" : "s"}`);
  return parts.join(", ");
}

export function cleanToolDisplayText(tool: ToolCallMessagePart): string {
  const name = displayToolName(tool.toolName, tool.args);
  if (isCommandTool(tool.toolName, tool.args)) return name;
  const summary = tool.result === undefined ? summarizeToolInput(tool.toolName, tool.args) : null;
  return summary ? `${name} ${summary}` : name;
}
