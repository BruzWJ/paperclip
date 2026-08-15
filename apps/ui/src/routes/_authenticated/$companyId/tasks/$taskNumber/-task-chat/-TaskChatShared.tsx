import type {
  Agent,
  SourceTrustMetadata,
  TaskAttachment,
  TaskCommentMetadata,
  TaskCommentPresentation,
  TaskRelationTaskSummary,
  TaskWorkMode,
} from "@paperclipai/shared";
import { createContext, useLayoutEffect, useMemo, useRef, type ReactNode, type Ref } from "react";
import type { CompanyUserProfile } from "@/lib/company-members";
import { type ComposerOwnerPreview } from "@/lib/owner-transition";
import { type TaskChatComment, type TaskChatMessage } from "@/lib/task-chat-messages";
import type { EntityOption } from "@/lib/entity-selector";
import { type MentionOption } from "../../../-markdown/-MarkdownEditor";
import type { CommentOwnerChange } from "../-task-detail-model";
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

export function useStableEvent<T extends (...args: never[]) => unknown>(
  callback: T | undefined,
): T | undefined {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useMemo(() => {
    if (!callback) return undefined;
    return ((...args: Parameters<T>) => callbackRef.current?.(...args)) as T;
    // Keep the wrapper stable while the callback identity changes; the ref above
    // carries the current callback implementation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(callback)]);
}

export function shouldRenderComposerOwnerPreview(body: string, preview: ComposerOwnerPreview): boolean {
  return Boolean(body.trim()) && preview.kind !== "none";
}

export interface TaskChatComposerHandle {
  focus: () => void;
  restoreDraft: (submittedBody: string) => void;
  setDraft: (body: string) => void;
}

export interface TaskChatComposerProps {
  onSubmit: (
    body: string,
    ownerChange?: CommentOwnerChange,
    mentionAgentId?: string,
    replyToCommentId?: string,
  ) => Promise<void>;
  onImageUpload?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<TaskAttachment | void>;
  draftKey?: string;
  enableOwnerChange?: boolean;
  ownerOptions?: EntityOption[];
  currentOwnerValue?: string;
  suggestedOwnerValue?: string;
  mentions?: MentionOption[];
  agentMap?: Map<string, Agent>;
  /** Whether an agent run is currently in flight, so the composer can preview an interrupt. */
  hasActiveRun?: boolean;
  composerDisabledReason?: string | null;
  composerHint?: string | null;
  taskWorkMode?: TaskWorkMode;
  replyTarget?: TaskChatReplyTarget | null;
  onClearReply?: () => void;
  onReplySubmitted?: () => void;
  onReplyPendingChange?: (pending: boolean) => void;
}

export interface TaskChatThreadProps {
  comments: TaskChatComment[];
  hasActiveRun?: boolean;
  taskId?: string | null;
  blockedBy?: TaskRelationTaskSummary[];
  /** Company-wide set of task ids with a live (queued/running) run. */
  liveTaskIds?: ReadonlySet<string>;
  ownerUserId?: string | null;
  taskStatus?: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  onAdd: (
    body: string,
    ownerChange?: CommentOwnerChange,
    mentionAgentId?: string,
    replyToCommentId?: string,
  ) => Promise<void>;
  onLoadMoreCommentGroup?: (rootCommentId: string) => Promise<void> | void;
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<TaskAttachment | void>;
  draftKey?: string;
  enableOwnerChange?: boolean;
  ownerOptions?: EntityOption[];
  currentOwnerValue?: string;
  suggestedOwnerValue?: string;
  mentions?: MentionOption[];
  composerDisabledReason?: string | null;
  composerHint?: string | null;
  showComposer?: boolean;
  hasOlderComments?: boolean;
  commentsLoadingOlder?: boolean;
  onLoadOlderComments?: () => Promise<unknown> | void;
  footer?: ReactNode;
  onImageClick?: (src: string) => void;
  composerRef?: Ref<TaskChatComposerHandle>;
  /** Optional node rendered inline directly above the sticky composer dock (e.g. the monitor strip). */
  composerAccessory?: ReactNode;
  taskWorkMode?: TaskWorkMode;
  /**
   * Hook for the parent to refetch comments when the user explicitly asks
   * to jump to the latest comment. Used to make sure the absolute newest
   * comment is in the loaded set before we scroll to it.
   */
  onRefreshLatestComments?: () => Promise<unknown> | void;
}
