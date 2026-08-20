import type {
  Agent,
  CreateTaskUserComment,
  SourceTrustMetadata,
  TaskAttachment,
  TaskCommentMetadata,
  TaskCommentPresentation,
  TaskRelationTaskSummary,
} from "@paperclipai/shared";
import { createContext, type ReactNode, type RefObject } from "react";
import type { CompanyUserProfile } from "@/lib/company-members";
import { type TaskChatComment, type TaskChatMessage } from "@/lib/task-chat-messages";

/** Returns the plain-text content used by message copy and reply previews. */
export function getThreadMessageCopyText(message: TaskChatMessage): string {
  return message.content
    .filter(
      (part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n");
}

export function isTaskCommentPresentation(value: unknown): value is TaskCommentPresentation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "system_notice" || candidate.kind === "message";
}

export function isTaskCommentMetadata(value: unknown): value is TaskCommentMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && Array.isArray(candidate.sections);
}

export function isSourceTrustMetadata(value: unknown): value is SourceTrustMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.preset === "low_trust_review" &&
    (candidate.disposition === "quarantined" || candidate.disposition === "promoted")
  );
}

export interface TaskChatMessageContext {
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  onImageClick?: (src: string) => void;
  onReply?: (target: TaskChatReplyTarget) => void;
  onLoadMoreCommentGroup?: (rootCommentId: string) => Promise<void> | void;
}

export const TaskChatCtx = createContext<TaskChatMessageContext>({});

function truncateReplyPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 119)}…`;
}

export function replyTargetForMessage(
  message: TaskChatMessage,
  authorLabel: string,
): TaskChatReplyTarget | null {
  const custom = message.metadata.custom as Record<string, unknown>;
  const commentId = typeof custom.commentId === "string" ? custom.commentId : null;
  if (!commentId || custom.canReply !== true) return null;
  return {
    commentId,
    authorLabel,
    preview: truncateReplyPreview(getThreadMessageCopyText(message)),
  };
}

export interface TaskChatReplyTarget {
  commentId: string;
  authorLabel: string;
  preview: string;
}

export interface TaskChatComposerHandle {
  focus: () => void;
}

export type TaskChatAgentMention = NonNullable<CreateTaskUserComment["mention"]>;

export interface TaskChatMentionTarget extends TaskChatAgentMention {
  name: string;
  icon?: string | null;
}

type TaskChatSubmit = (
  body: string,
  mention?: TaskChatAgentMention,
  replyToCommentId?: string,
) => Promise<void>;

export interface TaskChatComposerProps {
  onSubmit: TaskChatSubmit;
  onAttachFile?: (file: File) => Promise<TaskAttachment | void>;
  draftKey?: string;
  mentionTarget?: TaskChatMentionTarget | null;
  mentionIsResponseOnly: boolean;
  composerHint?: string | null;
  replyTarget?: TaskChatReplyTarget | null;
  onClearReply?: () => void;
  onReplySubmitted?: () => void;
  onReplyPendingChange?: (pending: boolean) => void;
}

export type TaskChatThreadProps = Omit<
  TaskChatComposerProps,
  "onSubmit" | "replyTarget" | "onClearReply" | "onReplySubmitted" | "onReplyPendingChange"
> & {
  comments: TaskChatComment[];
  taskId?: string | null;
  blockedBy?: TaskRelationTaskSummary[];
  /** Company-wide set of task ids with a live (queued/running) run. */
  liveTaskIds?: ReadonlySet<string>;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  taskStatus?: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  onAdd: TaskChatSubmit;
  onLoadMoreCommentGroup?: (rootCommentId: string) => Promise<void> | void;
  hasOlderComments?: boolean;
  commentsLoadingOlder?: boolean;
  onLoadOlderComments?: () => Promise<unknown> | void;
  footer?: ReactNode;
  onImageClick?: (src: string) => void;
  composerRef?: RefObject<TaskChatComposerHandle | null>;
  /** Optional node rendered inline directly above the sticky composer dock (e.g. the monitor strip). */
  composerAccessory?: ReactNode;
  /**
   * Hook for the parent to refetch comments when the user explicitly asks
   * to jump to the latest comment. Used to make sure the absolute newest
   * comment is in the loaded set before we scroll to it.
   */
  onRefreshLatestComments?: () => Promise<unknown> | void;
};
