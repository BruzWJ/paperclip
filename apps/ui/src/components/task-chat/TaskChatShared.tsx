import type { TextMessagePart, ThreadMessage } from "@assistant-ui/react";
import type {
  Agent,
  SourceTrustMetadata,
  TaskAttachment,
  TaskBlockerAttention,
  TaskCommentMetadata,
  TaskCommentPresentation,
  TaskRelationTaskSummary,
  TaskWorkMode,
} from "@paperclipai/shared";
import { createContext, useLayoutEffect, useMemo, useRef, type ReactNode, type Ref } from "react";
import type { CompanyUserProfile } from "../../lib/company-members";
import { type ComposerOwnerPreview } from "../../lib/owner-transition";
import { type TaskChatComment } from "../../lib/task-chat-messages";
import { type TaskTimelineEvent } from "../../lib/task-timeline-events";
import type { EntityOption } from "@/lib/entity-selector";
import { type MentionOption } from "../MarkdownEditor";
/** Returns the plain-text content used by message copy and reply previews. */
export function getThreadMessageCopyText(message: ThreadMessage): string {
  return message.content
    .filter((part): part is TextMessagePart => part.type === "text")
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
  userLabelMap?: ReadonlyMap<string, string> | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  onStopRun?: (runId: string) => Promise<void>;
  stopRunLabel?: string;
  stoppingRunLabel?: string;
  stopRunVariant?: "stop" | "pause";
  onInterruptQueued?: (runId: string) => Promise<void>;
  onCancelQueued?: (commentId: string) => void;
  onImageClick?: (src: string) => void;
  onUploadImage?: (file: File) => Promise<string>;
  onReply?: (target: TaskChatReplyTarget) => void;
  onLoadMoreCommentGroup?: (rootCommentId: string) => Promise<void> | void;
}

export const TaskChatCtx = createContext<TaskChatMessageContext>({});

export function truncateReplyPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 119)}…`;
}

export function replyTargetForMessage(
  message: ThreadMessage,
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

export function TaskChatImmediateParentLabel({ custom }: { custom: Record<string, unknown> }) {
  const value = custom.immediateParentDisplayReference;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  if (typeof reference.authorLabel !== "string" || typeof reference.excerpt !== "string") return null;
  return (
    <div className="mb-1 ml-2 max-w-(--pct-85) border-l-2 border-border pl-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground/80">{reference.authorLabel}</span>
      <span aria-hidden> · </span>
      <span>{reference.excerpt}</span>
    </div>
  );
}

export const AGENT_COMMENT_BUBBLE_WIDTH_CLASS = "max-w-(--sz-calc-7) sm:max-w-(--pct-85)";

export interface TaskChatReplyTarget {
  commentId: string;
  authorLabel: string;
  preview: string;
}

export function resolveAssistantMessageFoldedState(args: {
  messageId: string;
  currentFolded: boolean;
  isFoldable: boolean;
  previousMessageId: string | null;
  previousIsFoldable: boolean;
}) {
  const { messageId, currentFolded, isFoldable, previousMessageId, previousIsFoldable } = args;

  if (messageId !== previousMessageId) return isFoldable;
  if (!isFoldable) return false;
  if (!previousIsFoldable) return true;
  return currentFolded;
}

export function canStopTaskChatRun(args: {
  runId: string | null;
  runStatus: string | null;
  activeRunIds: ReadonlySet<string>;
}) {
  const { runId, runStatus, activeRunIds } = args;
  if (!runId) return false;
  if (activeRunIds.has(runId)) return true;
  return runStatus === "queued" || runStatus === "running";
}

export function findCoTSegmentIndex(
  messageParts: ReadonlyArray<{ type: string }>,
  cotParts: ReadonlyArray<{ type: string }>,
): number {
  if (cotParts.length === 0) return -1;
  const firstPart = cotParts[0];
  let segIdx = -1;
  let inCoT = false;
  for (const part of messageParts) {
    if (part.type === "reasoning" || part.type === "tool-call") {
      if (!inCoT) {
        segIdx++;
        inCoT = true;
      }
      if (part === firstPart) return segIdx;
    } else {
      inCoT = false;
    }
  }
  return -1;
}

export function countCoTSegments(parts: ReadonlyArray<{ type: string }>) {
  let count = 0;
  let inSegment = false;
  for (const part of parts) {
    const isCoT = part.type === "reasoning" || part.type === "tool-call";
    if (isCoT && !inSegment) count += 1;
    inSegment = isCoT;
  }
  return count;
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

export interface CommentOwnerChange {
  ownerAgentId: string;
}

export function shouldRenderComposerOwnerPreview(body: string, preview: ComposerOwnerPreview): boolean {
  return Boolean(body.trim()) && preview.kind !== "none";
}

export interface TaskChatComposerHandle {
  focus: () => void;
  restoreDraft: (submittedBody: string) => void;
}

export interface TaskChatComposerProps {
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
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
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
  timelineEvents?: TaskTimelineEvent[];
  hasActiveRun?: boolean;
  taskId?: string | null;
  blockedBy?: TaskRelationTaskSummary[];
  /** Company-wide set of task ids with a live (queued/running) run. */
  liveTaskIds?: ReadonlySet<string>;
  blockerAttention?: TaskBlockerAttention | null;
  ownerUserId?: string | null;
  onResumeFromBacklog?: () => Promise<void> | void;
  resumeFromBacklogPending?: boolean;
  companyId?: string | null;
  projectId?: string | null;
  taskStatus?: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  onAdd: (
    body: string,
    ownerChange?: CommentOwnerChange,
    mentionAgentId?: string,
    replyToCommentId?: string,
  ) => Promise<void>;
  onLoadMoreCommentGroup?: (rootCommentId: string) => Promise<void> | void;
  onCancelRun?: () => Promise<void>;
  onStopRun?: (runId: string) => Promise<void>;
  stopRunLabel?: string;
  stoppingRunLabel?: string;
  stopRunVariant?: "stop" | "pause";
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
  showJumpToLatest?: boolean;
  autoScrollToHashOnInitialLoad?: boolean;
  emptyMessage?: string;
  footer?: ReactNode;
  variant?: "full" | "embedded";
  onInterruptQueued?: (runId: string) => Promise<void>;
  onCancelQueued?: (commentId: string) => void;
  interruptingQueuedRunId?: string | null;
  stoppingRunId?: string | null;
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
