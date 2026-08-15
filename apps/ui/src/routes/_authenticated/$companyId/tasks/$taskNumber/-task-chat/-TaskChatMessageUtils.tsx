import type { CompanyUserProfile } from "@/lib/company-members";
import type { TaskChatMessage } from "@/lib/task-chat-messages";
import { timeAgo } from "@/lib/timeAgo";
import { formatShortDate } from "@/lib/utils";
import type { CommentOwnerChange } from "../-task-detail-model";

export const DRAFT_DEBOUNCE_MS = 800;
export const COMPOSER_FOCUS_SCROLL_PADDING_PX = 96;

export function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(draftKey: string, value: string) {
  try {
    if (value.trim()) localStorage.setItem(draftKey, value);
    else localStorage.removeItem(draftKey);
  } catch {
    // Draft persistence must never block composing.
  }
}

export function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Draft persistence must never block composing.
  }
}

export function parseOwnerChange(target: string): CommentOwnerChange | null {
  if (!target.startsWith("agent:")) return null;
  const ownerAgentId = target.slice("agent:".length);
  return ownerAgentId ? { ownerAgentId } : null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function commentDateLabel(date: Date | string): string {
  return Date.now() - new Date(date).getTime() < WEEK_MS ? timeAgo(date) : formatShortDate(date);
}

export function taskChatMessageCustom(message: TaskChatMessage): Record<string, unknown> {
  return message.metadata.custom;
}

export function taskChatMessageKind(message: TaskChatMessage): string {
  const custom = taskChatMessageCustom(message);
  return typeof custom.kind === "string" ? custom.kind : message.role;
}

export function taskChatMessageAnchorId(message: TaskChatMessage): string | null {
  const custom = taskChatMessageCustom(message);
  return typeof custom.anchorId === "string" ? custom.anchorId : null;
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
  return {
    isCurrentUser,
    authorName: profile?.label?.trim() || authorName?.trim() || (isCurrentUser ? "You" : "User"),
    avatarUrl: profile?.image ?? null,
  };
}
