import { AssistantRuntimeProvider, useAui } from "@assistant-ui/react";
import type {
  ReasoningMessagePart,
  TextMessagePart,
  ThreadMessage,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import {
  createContext,
  Component,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type ErrorInfo,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type ReactNode,
} from "react";
import { Link, useLocation } from "@/lib/router";
import type {
  Agent,
  IssueAttachment,
  IssueBlockerAttention,
  IssueRelationIssueSummary,
  IssueWorkMode,
} from "@paperclipai/shared";
import {
  usePaperclipIssueRuntime,
  type PaperclipIssueRuntimeOwnerChange,
} from "../hooks/usePaperclipIssueRuntime";
import { useOptionalToastActions } from "../context/ToastContext";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  buildIssueChatMessages,
  isCoTSegmentActive,
  stabilizeThreadMessages,
  type IssueChatComment,
  type StableThreadMessageCacheEntry,
} from "../lib/issue-chat-messages";
import {
  type IssueTimelineOwner,
  type IssueTimelineEvent,
} from "../lib/issue-timeline-events";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownBody } from "./MarkdownBody";
import {
  MarkdownEditor,
  type MentionOption,
  type MarkdownEditorRef,
} from "./MarkdownEditor";
import {
  InlineEntitySelector,
  type InlineEntityOption,
} from "./InlineEntitySelector";
import { AgentIcon } from "./AgentIconPicker";
import {
  OwnerChip,
  ComposerOwnerPreviewRow,
  ComposerMentionCoach,
  OwnerDispatchRow,
  RunStatusBadge,
  type OwnerChipResolvers,
} from "./owner-transition/OwnerTransitionViews";
import {
  computeComposerOwnerPreview,
  extractAgentMentionIds,
  findPlainAgentNameCandidate,
  type ComposerOwnerPreview,
  type OwnerAgentMention,
} from "../lib/owner-transition";
import { restoreSubmittedCommentDraft } from "../lib/comment-submit-draft";
import {
  captureComposerViewportSnapshot,
  restoreComposerViewportSnapshot,
  shouldPreserveComposerViewport,
} from "../lib/issue-chat-scroll";
import { formatOwnerUserLabel } from "../lib/issue-owners";
import type { CompanyUserProfile } from "../lib/company-members";
import { timeAgo } from "../lib/timeAgo";
import { SystemNotice } from "./SystemNotice";
import { buildSystemNoticeProps } from "../lib/system-notice-comment";
import type {
  IssueCommentMetadata,
  IssueCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import {
  describeToolInput,
  displayToolName,
  formatToolPayload,
  isCommandTool,
  parseToolPayload,
  summarizeToolInput,
  summarizeToolResult,
} from "../lib/transcriptPresentation";
import { buildAgentMentionHref } from "@paperclipai/shared";
import { cn, formatDateTime, formatShortDate } from "../lib/utils";
import { liveBlueBadge } from "../lib/status-colors";
import {
  nextWorkMode,
  titleForPendingWorkMode,
  workModeMetaFor,
  workModeMetaList,
} from "../lib/work-mode-meta";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  ClipboardList,
  Copy,
  Hammer,
  Loader2,
  MoreHorizontal,
  Paperclip,
  PauseCircle,
  Reply as ReplyIcon,
  Search,
  Square,
  X,
} from "lucide-react";
import { IssueBlockedNotice } from "./IssueBlockedNotice";
import { IssueOwnerBacklogNotice } from "./IssueOwnerBacklogNotice";
import { SourceTrustBadge } from "./SourceTrustBadge";

interface IssueChatMessageContext {
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  onStopRun?: (runId: string) => Promise<void>;
  stopRunLabel?: string;
  stoppingRunLabel?: string;
  stopRunVariant?: "stop" | "pause";
  runFinalizationActions?: readonly IssueChatRunFinalizationAction[];
  onInterruptQueued?: (runId: string) => Promise<void>;
  onCancelQueued?: (commentId: string) => void;
  onImageClick?: (src: string) => void;
  onUploadImage?: (file: File) => Promise<string>;
  issueStatus?: string;
  onReply?: (target: IssueChatReplyTarget) => void;
  onLoadMoreCommentGroup?: (rootCommentId: string) => Promise<void> | void;
}

const IssueChatCtx = createContext<IssueChatMessageContext>({
  issueStatus: undefined,
});

function truncateReplyPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 119)}…`;
}

function replyTargetForMessage(
  message: ThreadMessage,
  authorLabel: string,
): IssueChatReplyTarget | null {
  const custom = message.metadata.custom as Record<string, unknown>;
  const commentId = typeof custom.commentId === "string" ? custom.commentId : null;
  if (!commentId || custom.canReply !== true) return null;
  return {
    commentId,
    authorLabel,
    preview: truncateReplyPreview(getThreadMessageCopyText(message)),
  };
}

function IssueChatImmediateParentLabel({
  custom,
}: {
  custom: Record<string, unknown>;
}) {
  const value = custom.immediateParentDisplayReference;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  if (
    typeof reference.authorLabel !== "string" ||
    typeof reference.excerpt !== "string"
  ) return null;
  return (
    <div className="mb-1 ml-2 max-w-(--pct-85) border-l-2 border-border pl-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground/80">
        {reference.authorLabel}
      </span>
      <span aria-hidden> · </span>
      <span>{reference.excerpt}</span>
    </div>
  );
}

const AGENT_COMMENT_BUBBLE_WIDTH_CLASS =
  "max-w-(--sz-calc-7) sm:max-w-(--pct-85)";

export type IssueChatRunFinalizationAction = {
  id: "cancel" | "done";
  label: string;
  pendingLabel: string;
  onSelect: (runId: string) => Promise<void> | void;
  isPending?: boolean;
  disabled?: boolean;
};

export interface IssueChatReplyTarget {
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
  const {
    messageId,
    currentFolded,
    isFoldable,
    previousMessageId,
    previousIsFoldable,
  } = args;

  if (messageId !== previousMessageId) return isFoldable;
  if (!isFoldable) return false;
  if (!previousIsFoldable) return true;
  return currentFolded;
}

export function canStopIssueChatRun(args: {
  runId: string | null;
  runStatus: string | null;
  activeRunIds: ReadonlySet<string>;
}) {
  const { runId, runStatus, activeRunIds } = args;
  if (!runId) return false;
  if (activeRunIds.has(runId)) return true;
  return runStatus === "queued" || runStatus === "running";
}

function findCoTSegmentIndex(
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

function countCoTSegments(parts: ReadonlyArray<{ type: string }>) {
  let count = 0;
  let inSegment = false;
  for (const part of parts) {
    const isCoT = part.type === "reasoning" || part.type === "tool-call";
    if (isCoT && !inSegment) count += 1;
    inSegment = isCoT;
  }
  return count;
}

function useStableEvent<T extends (...args: never[]) => unknown>(
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

interface CommentOwnerChange {
  ownerAgentId: string;
}

export function shouldRenderComposerOwnerPreview(
  body: string,
  preview: ComposerOwnerPreview,
): boolean {
  return Boolean(body.trim()) && preview.kind !== "none";
}

export interface IssueChatComposerHandle {
  focus: () => void;
  restoreDraft: (submittedBody: string) => void;
}

interface IssueChatComposerProps {
  onImageUpload?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<IssueAttachment | void>;
  draftKey?: string;
  enableOwnerChange?: boolean;
  ownerOptions?: InlineEntityOption[];
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
  issueStatus?: string;
  issueWorkMode?: IssueWorkMode;
  onWorkModeChange?: (workMode: IssueWorkMode) => Promise<void> | void;
  replyTarget?: IssueChatReplyTarget | null;
  onClearReply?: () => void;
  onReplySubmitted?: () => void;
  onReplyPendingChange?: (pending: boolean) => void;
}

interface IssueChatThreadProps {
  comments: IssueChatComment[];
  timelineEvents?: IssueTimelineEvent[];
  hasActiveRun?: boolean;
  issueId?: string | null;
  blockedBy?: IssueRelationIssueSummary[];
  /** Company-wide set of issue ids with a live (queued/running) run. */
  liveIssueIds?: ReadonlySet<string>;
  blockerAttention?: IssueBlockerAttention | null;
  ownerUserId?: string | null;
  onResumeFromBacklog?: () => Promise<void> | void;
  resumeFromBacklogPending?: boolean;
  companyId?: string | null;
  projectId?: string | null;
  issueStatus?: string;
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
  runFinalizationActions?: readonly IssueChatRunFinalizationAction[];
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<IssueAttachment | void>;
  draftKey?: string;
  enableOwnerChange?: boolean;
  ownerOptions?: InlineEntityOption[];
  currentOwnerValue?: string;
  suggestedOwnerValue?: string;
  mentions?: MentionOption[];
  composerDisabledReason?: string | null;
  composerHint?: string | null;
  onWorkModeChange?: (workMode: IssueWorkMode) => Promise<void> | void;
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
  composerRef?: Ref<IssueChatComposerHandle>;
  /** Optional node rendered inline directly above the sticky composer dock (e.g. the monitor strip). */
  composerAccessory?: ReactNode;
  issueWorkMode?: IssueWorkMode;
  /**
   * Hook for the parent to refetch comments when the user explicitly asks
   * to jump to the latest comment. Used to make sure the absolute newest
   * comment is in the loaded set before we scroll to it.
   */
  onRefreshLatestComments?: () => Promise<unknown> | void;
}

type IssueChatErrorBoundaryProps = {
  resetKey: string;
  messages: readonly ThreadMessage[];
  emptyMessage: string;
  variant: "full" | "embedded";
  children: ReactNode;
};

type IssueChatErrorBoundaryState = {
  hasError: boolean;
};

class IssueChatErrorBoundary extends Component<
  IssueChatErrorBoundaryProps,
  IssueChatErrorBoundaryState
> {
  override state: IssueChatErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): IssueChatErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      "Issue chat renderer failed; falling back to safe transcript view",
      {
        error,
        info: info.componentStack,
      },
    );
  }

  override componentDidUpdate(prevProps: IssueChatErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  override render() {
    if (this.state.hasError) {
      return (
        <IssueChatFallbackThread
          messages={this.props.messages}
          emptyMessage={this.props.emptyMessage}
          variant={this.props.variant}
        />
      );
    }
    return this.props.children;
  }
}

function IssueOwnerPausedNotice({ agent }: { agent: Agent | null }) {
  if (!agent || agent.status !== "paused") return null;

  const pauseDetail =
    agent.pauseReason === "budget"
      ? "It was paused by a budget hard stop."
      : agent.pauseReason === "system"
        ? "It was paused by the system."
        : "It was paused manually.";

  return (
    <div className="mb-3 rounded-md border border-orange-300/70 bg-orange-50/90 px-3 py-2.5 text-sm text-orange-950 shadow-sm dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-100">
      <div className="flex items-start gap-2">
        <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
        <p className="min-w-0 leading-5">
          <span className="font-medium">{agent.name}</span> is paused. New runs
          will not start until the agent is resumed. {pauseDetail}
        </p>
      </div>
    </div>
  );
}

function fallbackAuthorLabel(message: ThreadMessage) {
  const custom = message.metadata?.custom as
    Record<string, unknown> | undefined;
  if (typeof custom?.["authorName"] === "string") return custom["authorName"];
  if (typeof custom?.["runAgentName"] === "string")
    return custom["runAgentName"];
  if (message.role === "assistant") return "Agent";
  if (message.role === "user") return "You";
  return "System";
}

function fallbackTextParts(message: ThreadMessage) {
  const contentLines: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text.trim().length > 0) contentLines.push(part.text);
      continue;
    }
    if (part.type === "tool-call") {
      const lines = [`Tool: ${part.toolName}`];
      if (part.argsText?.trim()) lines.push(`Args:\n${part.argsText}`);
      if (typeof part.result === "string" && part.result.trim())
        lines.push(`Result:\n${part.result}`);
      contentLines.push(lines.join("\n\n"));
    }
  }

  const custom = message.metadata?.custom as
    Record<string, unknown> | undefined;
  if (
    contentLines.length === 0 &&
    typeof custom?.["waitingText"] === "string" &&
    custom["waitingText"].trim()
  ) {
    contentLines.push(custom["waitingText"]);
  }
  return contentLines;
}

function IssueChatFallbackThread({
  messages,
  emptyMessage,
  variant,
}: {
  messages: readonly ThreadMessage[];
  emptyMessage: string;
  variant: "full" | "embedded";
}) {
  return (
    <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
      <div className="rounded-xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">
              Chat renderer hit an internal state error.
            </p>
            <p className="text-xs opacity-80">
              Showing a safe fallback transcript instead of crashing the tasks
              page.
            </p>
          </div>
        </div>
      </div>

      {messages.length === 0 ? (
        <Card
          className={cn(
            "block shadow-none text-center text-sm text-muted-foreground",
            variant === "embedded"
              ? "border-dashed border-border/70 bg-background/60 px-4 py-6"
              : "border-dashed px-6 py-10",
          )}
        >
          {emptyMessage}
        </Card>
      ) : (
        <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
          {messages.map((message) => {
            const lines = fallbackTextParts(message);
            return (
              <Card
                key={message.id}
                className="block border-border/60 bg-card/70 px-4 py-3"
              >
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="font-medium text-foreground">
                    {fallbackAuthorLabel(message)}
                  </span>
                  {message.createdAt ? (
                    <span className="text-(length:--text-micro) text-muted-foreground">
                      {commentDateLabel(message.createdAt)}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {lines.length > 0 ? (
                    lines.map((line, index) => (
                      <MarkdownBody
                        key={`${message.id}:fallback:${index}`}
                      >
                        {line}
                      </MarkdownBody>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No message content.
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

const DRAFT_DEBOUNCE_MS = 800;
const COMPOSER_FOCUS_SCROLL_PADDING_PX = 96;
const SUBMIT_SCROLL_RESERVE_VH = 0.4;

type ComposerAttachmentItem = {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "attached" | "error";
  inline: boolean;
  contentPath?: string;
  error?: string;
};

function hasFilePayload(evt: ReactDragEvent<HTMLDivElement>) {
  return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
}

function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(draftKey: string, value: string) {
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

function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}

function parseOwnerChange(
  target: string,
): PaperclipIssueRuntimeOwnerChange | null {
  if (!target.startsWith("agent:")) return null;
  const ownerAgentId = target.slice("agent:".length);
  return ownerAgentId ? { ownerAgentId } : null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function commentDateLabel(date: Date | string | undefined): string {
  if (!date) return "";
  const then = new Date(date).getTime();
  if (Date.now() - then < WEEK_MS) return timeAgo(date);
  return formatShortDate(date);
}

const IssueChatTextPart = memo(function IssueChatTextPart({
  text,
  recessed,
  onAccent,
}: {
  text: string;
  recessed?: boolean;
  onAccent?: boolean;
}) {
  const { onImageClick } = useContext(IssueChatCtx);
  return (
    <MarkdownBody
      className={cn(
        "text-sm leading-6",
        onAccent && "paperclip-markdown-on-accent",
      )}
      style={recessed ? { opacity: 0.55 } : undefined}
      softBreaks
      onImageClick={onImageClick}
    >
      {text}
    </MarkdownBody>
  );
});

function humanizeValue(value: string | null) {
  if (!value) return "None";
  return value.replace(/_/g, " ");
}

function initialsForName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function resolveIssueChatHumanAuthor(args: {
  authorName?: string | null;
  authorUserId?: string | null;
  currentUserId?: string | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
}) {
  const { authorName, authorUserId, currentUserId, userProfileMap } = args;
  const profile = authorUserId
    ? (userProfileMap?.get(authorUserId) ?? null)
    : null;
  const isCurrentUser = Boolean(
    authorUserId && currentUserId && authorUserId === currentUserId,
  );
  const resolvedAuthorName =
    profile?.label?.trim() ||
    authorName?.trim() ||
    (isCurrentUser ? "You" : "User");

  return {
    isCurrentUser,
    authorName: resolvedAuthorName,
    avatarUrl: profile?.image ?? null,
  };
}

function toolCountSummary(toolParts: ToolCallMessagePart[]): string | null {
  if (toolParts.length === 0) return null;
  let commands = 0;
  let other = 0;
  for (const tool of toolParts) {
    if (isCommandTool(tool.toolName, tool.args)) commands++;
    else other++;
  }
  const parts: string[] = [];
  if (commands > 0)
    parts.push(`ran ${commands} command${commands === 1 ? "" : "s"}`);
  if (other > 0) parts.push(`called ${other} tool${other === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function cleanToolDisplayText(tool: ToolCallMessagePart): string {
  const name = displayToolName(tool.toolName, tool.args);
  if (isCommandTool(tool.toolName, tool.args)) return name;
  const summary =
    tool.result === undefined
      ? summarizeToolInput(tool.toolName, tool.args)
      : null;
  return summary ? `${name} ${summary}` : name;
}

type IssueChatCoTPart = ReasoningMessagePart | ToolCallMessagePart;

function IssueChatChainOfThought({
  message,
  cotParts,
}: {
  message: ThreadMessage;
  cotParts: readonly IssueChatCoTPart[];
}) {
  const { agentMap } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const authorAgentId =
    typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  const isMessageRunning =
    message.role === "assistant" && message.status?.type === "running";

  const myIndex = useMemo(
    () => findCoTSegmentIndex(message.content, cotParts),
    [message.content, cotParts],
  );

  const allReasoningText = cotParts
    .filter(
      (p): p is { type: "reasoning"; text: string } =>
        p.type === "reasoning" && !!p.text,
    )
    .map((p) => p.text)
    .join("\n");
  const toolParts = cotParts.filter(
    (p): p is ToolCallMessagePart => p.type === "tool-call",
  );

  const isActive = isCoTSegmentActive({
    isMessageRunning,
    segmentIndex: myIndex,
    segmentCount: countCoTSegments(message.content),
  });
  const [expanded, setExpanded] = useState(isActive);

  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  const headerVerb = isActive ? "Working" : "Worked";

  const toolSummary = toolCountSummary(toolParts);
  const hasContent = allReasoningText.trim().length > 0 || toolParts.length > 0;

  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-start gap-2.5 rounded-lg px-1 py-2 text-left transition-colors hover:bg-accent/5"
        onClick={() => hasContent && setExpanded((v) => !v)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
              {agentIcon ? (
                <AgentIcon icon={agentIcon} className="h-4 w-4 shrink-0" />
              ) : isActive ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
                </span>
              )}
              {isActive ? (
                <span className="shimmer-text">{headerVerb}</span>
              ) : (
                headerVerb
              )}
            </span>
            {toolSummary ? (
              <span className="text-xs text-muted-foreground/40">
                · {toolSummary}
              </span>
            ) : null}
          </div>
        </div>
        {hasContent ? (
          <ChevronDown
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform",
              expanded && "rotate-180",
            )}
          />
        ) : null}
      </button>
      {expanded && hasContent ? (
        <div className="space-y-1 py-1">
          {isActive ? (
            <>
              {allReasoningText ? (
                <IssueChatReasoningPart text={allReasoningText} />
              ) : null}
              {toolParts.length > 0 ? (
                <IssueChatRollingToolPart toolParts={toolParts} />
              ) : null}
            </>
          ) : (
            <>
              {allReasoningText ? (
                <IssueChatReasoningPart text={allReasoningText} />
              ) : null}
              {toolParts.map((tool) => (
                <IssueChatToolPart
                  key={tool.toolCallId}
                  toolName={tool.toolName}
                  args={tool.args}
                  argsText={tool.argsText}
                  result={tool.result}
                  isError={false}
                />
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function IssueChatReasoningPart({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim());
  const lastLine = lines[lines.length - 1] ?? text.slice(-200);
  const prevRef = useRef(lastLine);
  const [ticker, setTicker] = useState<{
    key: number;
    current: string;
    exiting: string | null;
  }>({ key: 0, current: lastLine, exiting: null });

  useEffect(() => {
    if (lastLine !== prevRef.current) {
      const prev = prevRef.current;
      prevRef.current = lastLine;
      setTicker((t) => ({ key: t.key + 1, current: lastLine, exiting: prev }));
    }
  }, [lastLine]);

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null && (
          <span
            key={`out-${ticker.key}`}
            className="cot-line-exit absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-muted-foreground/70"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-muted-foreground/70",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

function IssueChatRollingToolPart({
  toolParts,
}: {
  toolParts: ToolCallMessagePart[];
}) {
  const latest = toolParts[toolParts.length - 1];
  if (!latest) return null;

  const fullText = cleanToolDisplayText(latest);

  const prevRef = useRef(fullText);
  const [ticker, setTicker] = useState<{
    key: number;
    current: string;
    exiting: string | null;
  }>({ key: 0, current: fullText, exiting: null });

  useEffect(() => {
    if (fullText !== prevRef.current) {
      const prev = prevRef.current;
      prevRef.current = fullText;
      setTicker((t) => ({ key: t.key + 1, current: fullText, exiting: prev }));
    }
  }, [fullText]);

  const ToolIcon = getToolIcon(latest.toolName);
  const isRunning = latest.result === undefined;

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/50" />
        ) : (
          <ToolIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        )}
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null && (
          <span
            key={`out-${ticker.key}`}
            className="cot-line-exit absolute inset-x-0 truncate text-(length:--text-compact) leading-5 text-muted-foreground/70"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) leading-5 text-muted-foreground/70",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

function CopyablePreBlock({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const toastActions = useOptionalToastActions();
  return (
    <div className="group/pre relative">
      <pre className={className}>{children}</pre>
      <button
        type="button"
        className={cn(
          "absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground group-hover/pre:opacity-100",
          copied && "opacity-100",
        )}
        title="Copy"
        aria-label="Copy"
        onClick={() => {
          void copyTextToClipboard(children)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch((error) => {
              toastActions?.pushToast({
                title: "Copy failed",
                body:
                  error instanceof Error
                    ? error.message
                    : "Unable to copy text",
                tone: "error",
              });
            });
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

const TOOL_ICON_MAP: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  // Extend with specific tool icons as they become known
};

function getToolIcon(
  toolName: string,
): React.ComponentType<{ className?: string }> {
  return TOOL_ICON_MAP[toolName] ?? Hammer;
}

function IssueChatToolPart({
  toolName,
  args,
  argsText,
  result,
  isError,
}: {
  toolName: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rawArgsText = argsText ?? "";
  const parsedArgs = args ?? parseToolPayload(rawArgsText);
  const resultText =
    typeof result === "string"
      ? result
      : result === undefined
        ? ""
        : formatToolPayload(result);
  const inputDetails = describeToolInput(toolName, parsedArgs);
  const displayName = displayToolName(toolName, parsedArgs);
  const isCommand = isCommandTool(toolName, parsedArgs);
  const summary = isCommand
    ? null
    : result === undefined
      ? summarizeToolInput(toolName, parsedArgs)
      : summarizeToolResult(resultText, false);
  const ToolIcon = getToolIcon(toolName);

  const intentDetail = inputDetails.find((d) => d.label === "Intent");
  const title = intentDetail?.value ?? displayName;
  const nonIntentDetails = inputDetails.filter((d) => d.label !== "Intent");

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-1">
        <ToolIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        {open ? <div className="mt-1 w-px flex-1 bg-border/40" /> : null}
      </div>

      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md py-0.5 text-left transition-colors hover:bg-accent/5"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="min-w-0 flex-1 truncate text-(length:--text-compact) text-muted-foreground/80">
            {title}
            {!intentDetail && summary ? (
              <span className="ml-1.5 text-muted-foreground/50">{summary}</span>
            ) : null}
          </span>
          {result === undefined ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/50" />
          ) : null}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>

        {open ? (
          <div className="mt-1 space-y-2 pb-1">
            {nonIntentDetails.length > 0 ? (
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground/60">
                  Input
                </div>
                <dl className="space-y-1.5">
                  {nonIntentDetails.map((detail) => (
                    <div key={`${detail.label}:${detail.value}`}>
                      <dt className="text-(length:--text-nano) font-medium text-muted-foreground/60">
                        {detail.label}
                      </dt>
                      <dd
                        className={cn(
                          "text-xs leading-5 text-foreground/70",
                          detail.tone === "code" &&
                            "font-mono text-(length:--text-micro)",
                        )}
                      >
                        {detail.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : rawArgsText ? (
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground/60">
                  Input
                </div>
                <CopyablePreBlock className="overflow-x-auto rounded-md bg-accent/30 p-2 text-(length:--text-micro) leading-4 text-foreground/70">
                  {rawArgsText}
                </CopyablePreBlock>
              </div>
            ) : null}
            {result !== undefined ? (
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground/60">
                  Result
                </div>
                <CopyablePreBlock className="overflow-x-auto rounded-md bg-accent/30 p-2 text-(length:--text-micro) leading-4 text-foreground/70">
                  {resultText}
                </CopyablePreBlock>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function getThreadMessageCopyText(message: ThreadMessage) {
  return message.content
    .filter((part): part is TextMessagePart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

const IssueChatTextParts = memo(function IssueChatTextParts({
  message,
  recessed = false,
  onAccent = false,
}: {
  message: ThreadMessage;
  recessed?: boolean;
  onAccent?: boolean;
}) {
  return (
    <>
      {message.content
        .filter((part): part is TextMessagePart => part.type === "text")
        .map((part, index) => (
          <IssueChatTextPart
            key={`${message.id}:text:${index}`}
            text={part.text}
            recessed={recessed}
            onAccent={onAccent}
          />
        ))}
    </>
  );
});

function groupAssistantParts(
  content: readonly ThreadMessage["content"][number][],
): Array<
  | { type: "text"; part: TextMessagePart; index: number }
  | { type: "cot"; parts: IssueChatCoTPart[]; startIndex: number }
> {
  const groups: Array<
    | { type: "text"; part: TextMessagePart; index: number }
    | { type: "cot"; parts: IssueChatCoTPart[]; startIndex: number }
  > = [];
  let pendingCoT: IssueChatCoTPart[] = [];
  let pendingStartIndex = -1;

  const flushCoT = () => {
    if (pendingCoT.length === 0) return;
    groups.push({
      type: "cot",
      parts: pendingCoT,
      startIndex: pendingStartIndex,
    });
    pendingCoT = [];
    pendingStartIndex = -1;
  };

  content.forEach((part, index) => {
    if (part.type === "reasoning" || part.type === "tool-call") {
      if (pendingCoT.length === 0) pendingStartIndex = index;
      pendingCoT.push(part);
      return;
    }
    flushCoT();
    if (part.type === "text") {
      groups.push({ type: "text", part, index });
    }
  });
  flushCoT();

  return groups;
}

const IssueChatAssistantParts = memo(function IssueChatAssistantParts({
  message,
  hasCoT,
}: {
  message: ThreadMessage;
  hasCoT: boolean;
}) {
  const groupedParts = useMemo(
    () => groupAssistantParts(message.content),
    [message.content],
  );
  return (
    <>
      {groupedParts.map((group) => {
        if (group.type === "text") {
          return (
            <IssueChatTextPart
              key={`${message.id}:text:${group.index}`}
              text={group.part.text}
              recessed={hasCoT}
            />
          );
        }
        return (
          <IssueChatChainOfThought
            key={`${message.id}:cot:${group.startIndex}`}
            message={message}
            cotParts={group.parts}
          />
        );
      })}
    </>
  );
});

function IssueChatUserMessage({
  message,
  isInterruptingQueuedRun,
}: {
  message: ThreadMessage;
  isInterruptingQueuedRun: boolean;
}) {
  const { onInterruptQueued, onCancelQueued, currentUserId, userProfileMap, onReply } =
    useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const commentId =
    typeof custom.commentId === "string" ? custom.commentId : message.id;
  const authorName =
    typeof custom.authorName === "string" ? custom.authorName : null;
  const authorUserId =
    typeof custom.authorUserId === "string" ? custom.authorUserId : null;
  const queued =
    custom.queueState === "queued" || custom.clientStatus === "queued";
  const sourceTrust = isSourceTrustMetadata(custom.sourceTrust)
    ? custom.sourceTrust
    : null;
  const followUpRequested = custom.followUpRequested === true;
  const queueReason =
    typeof custom.queueReason === "string" ? custom.queueReason : null;
  const queueBadgeLabel =
    queueReason === "hold" ? "\u23f8 Held" : "Queued";
  const pending = custom.clientStatus === "pending";
  const queueTargetRunId =
    typeof custom.queueTargetRunId === "string"
      ? custom.queueTargetRunId
      : null;
  const [copied, setCopied] = useState(false);
  const toastActions = useOptionalToastActions();
  const {
    isCurrentUser,
    authorName: resolvedAuthorName,
    avatarUrl,
  } = resolveIssueChatHumanAuthor({
    authorName,
    authorUserId,
    currentUserId,
    userProfileMap,
  });
  const authorAvatar = (
    <Avatar size="sm" className="shrink-0">
      {avatarUrl ? (
        <AvatarImage src={avatarUrl} alt={resolvedAuthorName} />
      ) : null}
      <AvatarFallback>{initialsForName(resolvedAuthorName)}</AvatarFallback>
    </Avatar>
  );
  const replyTarget = replyTargetForMessage(message, resolvedAuthorName);
  const messageBody = (
    <div
      className={cn(
        "flex min-w-0 max-w-(--pct-85) flex-col",
        isCurrentUser && "items-end",
      )}
    >
      <IssueChatImmediateParentLabel custom={custom} />
      <div
        className={cn(
          "mb-1 flex items-center gap-2 px-1",
          isCurrentUser ? "justify-end" : "justify-start",
        )}
      >
        <span className="text-sm font-medium text-foreground">
          {resolvedAuthorName}
        </span>
        <SourceTrustBadge sourceTrust={sourceTrust} artifactLabel="comment" />
        {followUpRequested ? (
          <Badge
            variant="outline"
            className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)"
          >
            Follow-up
          </Badge>
        ) : null}
      </div>
      <div
        className={cn(
          "min-w-0 max-w-full overflow-hidden break-all rounded-2xl px-4 py-2.5",
          // Tail-hugging corner: flatten the bottom corner nearest the avatar so
          // the bubble points at it (bottom-right for the right-aligned human).
          isCurrentUser ? "rounded-br-(--rad-4)" : "rounded-bl-(--rad-4)",
          queued
            ? "bg-amber-50/80 dark:bg-amber-500/10"
            : isCurrentUser
              ? // Liveness blue (--liveness-blue, decoupled from --status-task-in_progress
                // in DECISION-SHEET.md A6) for the human's own messages (PAP-95 rev 5).
                "bg-(--liveness-blue) text-white"
              : "bg-muted",
          pending && "opacity-80",
        )}
      >
        {queued ? (
          <div className="mb-1.5 flex items-center gap-2">
            <Badge
              variant="outline"
              className="border-amber-400/60 bg-amber-100/70 text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-200"
            >
              {queueBadgeLabel}
            </Badge>
            {queueTargetRunId && onInterruptQueued ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-red-300 px-2 text-(length:--text-micro) text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                disabled={isInterruptingQueuedRun}
                onClick={() => void onInterruptQueued(queueTargetRunId)}
              >
                {isInterruptingQueuedRun ? "Interrupting..." : "Interrupt"}
              </Button>
            ) : null}
            {onCancelQueued ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-amber-300 px-2 text-(length:--text-micro) text-amber-900 hover:bg-amber-100/80 hover:text-amber-950 dark:border-amber-500/40 dark:text-amber-100 dark:hover:bg-amber-500/10"
                onClick={() => onCancelQueued(commentId)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="min-w-0 max-w-full space-y-3">
          <IssueChatTextParts
            message={message}
            onAccent={isCurrentUser && !queued}
          />
        </div>
      </div>

      {pending ? (
        <div
          className={cn(
            "mt-1 flex px-1 text-(length:--text-micro) text-muted-foreground",
            isCurrentUser ? "justify-end" : "justify-start",
          )}
        >
          Sending...
        </div>
      ) : (
        <div
          className={cn(
            "mt-1 flex items-center gap-1.5 px-1 opacity-0 transition-opacity group-hover:opacity-100",
            isCurrentUser ? "justify-end" : "justify-start",
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={anchorId ? `#${anchorId}` : undefined}
                className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
              >
                {message.createdAt ? commentDateLabel(message.createdAt) : ""}
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {message.createdAt ? formatDateTime(message.createdAt) : ""}
            </TooltipContent>
          </Tooltip>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            title="Copy message"
            aria-label="Copy message"
            onClick={() => {
              const text = message.content
                .filter(
                  (p): p is { type: "text"; text: string } => p.type === "text",
                )
                .map((p) => p.text)
                .join("\n\n");
              void copyTextToClipboard(text)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
                .catch((error) => {
                  toastActions?.pushToast({
                    title: "Copy failed",
                    body:
                      error instanceof Error
                        ? error.message
                        : "Unable to copy message",
                    tone: "error",
                  });
                });
            }}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          {replyTarget && onReply ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title="More actions"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align={isCurrentUser ? "end" : "start"}>
                <DropdownMenuItem onSelect={() => onReply(replyTarget)}>
                  <ReplyIcon className="mr-2 h-3.5 w-3.5" />
                  Reply
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      )}
    </div>
  );

  return (
    <div id={anchorId}>
      <div
        className={cn(
          "group flex items-end gap-2",
          isCurrentUser && "justify-end",
        )}
      >
        {isCurrentUser ? (
          <>
            {messageBody}
            {authorAvatar}
          </>
        ) : (
          <>
            {authorAvatar}
            {messageBody}
          </>
        )}
      </div>
    </div>
  );
}

function IssueChatAssistantMessage({
  message,
  isRunActive,
  isStoppingRun,
}: {
  message: ThreadMessage;
  isRunActive: boolean;
  isStoppingRun: boolean;
}) {
  const {
    agentMap,
    onStopRun,
    stopRunLabel = "Stop run",
    stoppingRunLabel = "Stopping...",
    stopRunVariant = "stop",
    runFinalizationActions = [],
    onReply,
  } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const authorName =
    typeof custom.authorName === "string"
      ? custom.authorName
      : typeof custom.runAgentName === "string"
        ? custom.runAgentName
        : "Agent";
  const authorAgentId =
    typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runStatus =
    typeof custom.runStatus === "string" ? custom.runStatus : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  const commentId =
    typeof custom.commentId === "string" ? custom.commentId : null;
  const sourceTrust = isSourceTrustMetadata(custom.sourceTrust)
    ? custom.sourceTrust
    : null;
  const notices = Array.isArray(custom.notices)
    ? custom.notices.filter(
        (notice): notice is string =>
          typeof notice === "string" && notice.length > 0,
      )
    : [];
  const waitingText =
    typeof custom.waitingText === "string" ? custom.waitingText : "";
  const isRunning =
    message.role === "assistant" && message.status?.type === "running";
  const runHref =
    runId && runAgentId ? `/agents/${runAgentId}/runs/${runId}` : null;
  const canStopRun =
    Boolean(runId) &&
    (isRunActive || runStatus === "queued" || runStatus === "running");
  const chainOfThoughtLabel =
    typeof custom.chainOfThoughtLabel === "string"
      ? custom.chainOfThoughtLabel
      : null;
  const hasCoT = message.content.some(
    (p) => p.type === "reasoning" || p.type === "tool-call",
  );
  const isFoldable = !isRunning && !!chainOfThoughtLabel;
  const [folded, setFolded] = useState(isFoldable);
  const [prevFoldKey, setPrevFoldKey] = useState({
    messageId: message.id,
    isFoldable,
  });
  const [copied, setCopied] = useState(false);
  const toastActions = useOptionalToastActions();
  const copyText = getThreadMessageCopyText(message);
  const replyTarget = replyTargetForMessage(message, authorName);

  // Derive fold state synchronously during render (not in useEffect) so the
  // browser never paints the un-folded intermediate state — prevents the
  // visible "jump" when loading a page with already-folded work sections.
  if (
    message.id !== prevFoldKey.messageId ||
    isFoldable !== prevFoldKey.isFoldable
  ) {
    const nextFolded = resolveAssistantMessageFoldedState({
      messageId: message.id,
      currentFolded: folded,
      isFoldable,
      previousMessageId: prevFoldKey.messageId,
      previousIsFoldable: prevFoldKey.isFoldable,
    });
    setPrevFoldKey({ messageId: message.id, isFoldable });
    if (nextFolded !== folded) {
      setFolded(nextFolded);
    }
  }


  const followUpRequested = custom.followUpRequested === true;

  const kind = typeof custom.kind === "string" ? custom.kind : null;
  const hasCommentText = message.content.some(
    (part) =>
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0,
  );
  // A genuine posted agent comment (kind "comment" with real text) renders in a
  // left-aligned neutral bubble — the mirror of the human blue bubble. Run
  // activity (chain-of-thought, tool calls, waiting shimmer, "worked N min")
  // keeps the existing flat / metadata treatment (PAP-95 rev 6).
  const isGenuineComment =
    kind === "comment" && !!commentId && !isRunning && hasCommentText;

  const agentAvatar = (
    <Avatar size="sm" className="shrink-0">
      {agentIcon ? (
        <AvatarFallback>
          <AgentIcon icon={agentIcon} className="h-3.5 w-3.5" />
        </AvatarFallback>
      ) : (
        <AvatarFallback>{initialsForName(authorName)}</AvatarFallback>
      )}
    </Avatar>
  );

  const messageActionBar = (
    <div className="mt-2 flex items-center gap-1">
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Copy message"
        aria-label="Copy message"
        onClick={() => {
          void copyTextToClipboard(copyText)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch((error) => {
              toastActions?.pushToast({
                title: "Copy failed",
                body:
                  error instanceof Error
                    ? error.message
                    : "Unable to copy message",
                tone: "error",
              });
            });
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
          >
            {message.createdAt ? commentDateLabel(message.createdAt) : ""}
          </a>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {message.createdAt ? formatDateTime(message.createdAt) : ""}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            title="More actions"
            aria-label="More actions"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              void copyTextToClipboard(copyText).catch((error) => {
                toastActions?.pushToast({
                  title: "Copy failed",
                  body:
                    error instanceof Error
                      ? error.message
                      : "Unable to copy message",
                  tone: "error",
                });
              });
            }}
          >
            <Copy className="mr-2 h-3.5 w-3.5" />
            Copy message
          </DropdownMenuItem>
          {replyTarget && onReply ? (
            <DropdownMenuItem onSelect={() => onReply(replyTarget)}>
              <ReplyIcon className="mr-2 h-3.5 w-3.5" />
              Reply
            </DropdownMenuItem>
          ) : null}
          {canStopRun && onStopRun && runId ? (
            <DropdownMenuItem
              disabled={isStoppingRun}
              className={cn(
                stopRunVariant === "pause"
                  ? "text-amber-700 focus:text-amber-800 dark:text-amber-300 dark:focus:text-amber-200"
                  : "text-red-700 focus:text-red-800 dark:text-red-300 dark:focus:text-red-200",
              )}
              onSelect={() => {
                void onStopRun(runId);
              }}
            >
              {stopRunVariant === "pause" ? (
                <PauseCircle className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Square className="mr-2 h-3.5 w-3.5 fill-current" />
              )}
              {isStoppingRun ? stoppingRunLabel : stopRunLabel}
            </DropdownMenuItem>
          ) : null}
          {runHref ? (
            <DropdownMenuItem asChild>
              <Link to={runHref} target="_blank" rel="noreferrer noopener">
                <Search className="mr-2 h-3.5 w-3.5" />
                View run
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  // Genuine agent comment → neutral left-aligned bubble (mirror of the human
  // blue bubble in IssueChatUserMessage). See PAP-95 rev 6.
  if (isGenuineComment) {
    return (
      <div id={anchorId}>
        <IssueChatImmediateParentLabel custom={custom} />
        <div className="group flex flex-col items-start py-1.5">
          {/* Icon + name together in a header ABOVE the bubble (PAP-95 rev 7). */}
          <div className="mb-1 flex items-center gap-1.5 px-1">
            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
              {agentIcon ? (
                <AgentIcon icon={agentIcon} className="h-4 w-4" />
              ) : (
                <Avatar size="sm" className="size-5">
                  <AvatarFallback className="text-(length:--text-nano)">
                    {initialsForName(authorName)}
                  </AvatarFallback>
                </Avatar>
              )}
            </span>
            <span className="text-sm font-medium text-foreground">
              {authorName}
            </span>
            <SourceTrustBadge
              sourceTrust={sourceTrust}
              artifactLabel="comment"
            />
            {followUpRequested ? (
              <Badge
                variant="outline"
                className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)"
              >
                Follow-up
              </Badge>
            ) : null}
          </div>
          {/* Agent response bubble. */}
          <div
            className={cn(
              "min-w-0 break-words px-3 py-2 text-sm overflow-x-auto overflow-y-visible [border-radius:14px_14px_14px_4px]",
              AGENT_COMMENT_BUBBLE_WIDTH_CLASS,
              "border border-border bg-card text-foreground",
            )}
          >
            <div className="min-w-0 max-w-full space-y-3">
              <IssueChatAssistantParts message={message} hasCoT={false} />
              {notices.length > 0 ? (
                <div className="space-y-2">
                  {notices.map((notice, index) => (
                    <div
                      key={`${message.id}:notice:${index}`}
                      className="rounded-sm border border-border/60 bg-accent/20 px-3 py-2 text-sm text-muted-foreground"
                    >
                      {notice}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          {messageActionBar}
        </div>
      </div>
    );
  }

  return (
    <div id={anchorId}>
      <IssueChatImmediateParentLabel custom={custom} />
      <div className="flex items-start gap-2.5 py-1.5">
        {agentAvatar}

        <div className="min-w-0 flex-1">
          {isFoldable ? (
            <button
              type="button"
              className="group flex w-full items-center gap-2 py-0.5 text-left"
              onClick={() => setFolded((v) => !v)}
            >
              <span className="text-sm font-medium text-foreground">
                {authorName}
              </span>
              <SourceTrustBadge
                sourceTrust={sourceTrust}
                artifactLabel="comment"
              />
              <span className="text-xs text-muted-foreground/60">
                {chainOfThoughtLabel?.toLowerCase()}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                {message.createdAt ? (
                  <span className="text-(length:--text-micro) text-muted-foreground/50">
                    {commentDateLabel(message.createdAt)}
                  </span>
                ) : null}
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 text-muted-foreground/40 transition-transform",
                    !folded && "rotate-180",
                  )}
                />
              </span>
            </button>
          ) : (
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {authorName}
              </span>
              <SourceTrustBadge
                sourceTrust={sourceTrust}
                artifactLabel="comment"
              />
              {followUpRequested ? (
                <Badge
                  variant="outline"
                  className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)"
                >
                  Follow-up
                </Badge>
              ) : null}
              {isRunning ? (
                // Running chip shares the liveness-blue badge recipe with the
                // issue header's "Live" badge (one live/running blue).
                <Badge
                  variant="outline"
                  className={cn(
                    "text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)",
                    liveBlueBadge,
                  )}
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Running
                </Badge>
              ) : null}
            </div>
          )}

          {!folded ? (
            <>
              <div className="space-y-3">
                <IssueChatAssistantParts message={message} hasCoT={hasCoT} />
                {message.content.length === 0 && waitingText ? (
                  <div className="rounded-lg px-1 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
                        {agentIcon ? (
                          <AgentIcon
                            icon={agentIcon}
                            className="h-4 w-4 shrink-0"
                          />
                        ) : (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                        )}
                        <span className="shimmer-text">{waitingText}</span>
                      </span>
                    </div>
                  </div>
                ) : null}
                {notices.length > 0 ? (
                  <div className="space-y-2">
                    {notices.map((notice, index) => (
                      <div
                        key={`${message.id}:notice:${index}`}
                        className="rounded-sm border border-border/60 bg-accent/20 px-3 py-2 text-sm text-muted-foreground"
                      >
                        {notice}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {messageActionBar}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function isIssueCommentPresentation(
  value: unknown,
): value is IssueCommentPresentation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.kind === "system_notice" || v.kind === "message";
}

function isIssueCommentMetadata(value: unknown): value is IssueCommentMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && Array.isArray(v.sections);
}

function isSourceTrustMetadata(value: unknown): value is SourceTrustMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.preset === "low_trust_review" &&
    (v.disposition === "quarantined" || v.disposition === "promoted")
  );
}

function SystemNoticeCommentRow({
  message,
  anchorId,
}: {
  message: ThreadMessage;
  anchorId?: string;
}) {
  const { onImageClick, agentMap, onReply } = useContext(IssueChatCtx);
  const toastActions = useOptionalToastActions();
  const custom = message.metadata.custom as Record<string, unknown>;
  const presentation = isIssueCommentPresentation(custom.presentation)
    ? custom.presentation
    : null;
  const commentMetadata = isIssueCommentMetadata(custom.commentMetadata)
    ? custom.commentMetadata
    : null;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const authorType =
    typeof custom.authorType === "string" ? custom.authorType : null;
  const authorName =
    typeof custom.authorName === "string" ? custom.authorName : null;
  const bodyText = message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const replyTarget = replyTargetForMessage(
    message,
    authorName ?? "Paperclip",
  );

  const source = (() => {
    const runAgentName = runAgentId
      ? (agentMap?.get(runAgentId)?.name ?? null)
      : null;
    if (authorType === "system") {
      const label = runAgentName ?? "Paperclip";
      if (runAgentId && runId)
        return { label, href: `/agents/${runAgentId}/runs/${runId}` };
      return { label };
    }
    if (runAgentId && runId) {
      return {
        label: authorName ?? runAgentName ?? "Paperclip",
        href: `/agents/${runAgentId}/runs/${runId}`,
      };
    }
    if (authorName) return { label: authorName };
    return undefined;
  })();

  const props = buildSystemNoticeProps({
    presentation,
    metadata: commentMetadata,
    body: (
      <MarkdownBody
        className="text-sm leading-6"
        softBreaks
        onImageClick={onImageClick}
      >
        {bodyText}
      </MarkdownBody>
    ),
    timestamp: message.createdAt
      ? new Date(message.createdAt).toISOString()
      : undefined,
    source,
    runAgentId,
  });

  const handleCopy = () => {
    void copyTextToClipboard(bodyText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((error) => {
        toastActions?.pushToast({
          title: "Copy failed",
          body:
            error instanceof Error
              ? error.message
              : "Unable to copy system notice",
          tone: "error",
        });
      });
  };

  const handleCopyLink = () => {
    if (!anchorId || typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}#${anchorId}`;
    void copyTextToClipboard(url)
      .then(() => {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      })
      .catch((error) => {
        toastActions?.pushToast({
          title: "Copy failed",
          body:
            error instanceof Error
              ? error.message
              : "Unable to copy system notice link",
          tone: "error",
        });
      });
  };

  return (
    <div id={anchorId} className="group">
      <div className="py-1">
        <IssueChatImmediateParentLabel custom={custom} />
        <SystemNotice {...props} />
        <div className="mt-1 flex items-center justify-end gap-1.5 px-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={anchorId ? `#${anchorId}` : undefined}
                className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
              >
                {message.createdAt ? commentDateLabel(message.createdAt) : ""}
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {message.createdAt ? formatDateTime(message.createdAt) : ""}
            </TooltipContent>
          </Tooltip>
          {anchorId ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              title="Copy link"
              aria-label="Copy link to system notice"
              onClick={handleCopyLink}
            >
              {copiedLink ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Paperclip className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            title="Copy notice text"
            aria-label="Copy system notice"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          {replyTarget && onReply ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title="More actions"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onReply(replyTarget)}>
                  <ReplyIcon className="mr-2 h-3.5 w-3.5" />
                  Reply
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Non-comment timeline items (run/status events, "updated this task",
// "worked for N minutes") render as quiet, subordinate metadata rows hung off a
// left rail — visually distinct from the bubbles used for genuine comments.
// Virtualized rows are absolutely positioned, so each row carries its own rail
// segment; stacked rows read as one continuous rail. See PAP-95 mockup rev 5.
function IssueChatMetadataRow({
  anchorId,
  icon,
  children,
  testid = "issue-chat-metadata-row",
}: {
  anchorId?: string;
  icon: ReactNode;
  children: ReactNode;
  testid?: string;
}) {
  return (
    <div id={anchorId} data-testid={testid}>
      <div className="ml-3 flex items-start gap-2.5 border-l-2 border-border/50 py-0.5 pl-3">
        <span className="mt-px flex size-(--sz-18px) shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/30 text-muted-foreground/60">
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-1">{children}</div>
      </div>
    </div>
  );
}

function IssueChatSystemMessage({ message }: { message: ThreadMessage }) {
  const { agentMap, currentUserId, userLabelMap } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runAgentName =
    typeof custom.runAgentName === "string" ? custom.runAgentName : null;
  const runStatus =
    typeof custom.runStatus === "string" ? custom.runStatus : null;
  const actorName =
    typeof custom.actorName === "string" ? custom.actorName : null;
  const actorType =
    typeof custom.actorType === "string" ? custom.actorType : null;
  const actorId = typeof custom.actorId === "string" ? custom.actorId : null;
  const lifecycleStatusChange =
    typeof custom.lifecycleStatusChange === "object" &&
    custom.lifecycleStatusChange
      ? (custom.lifecycleStatusChange as {
          from: string | null;
          to: string | null;
        })
      : null;
  const ownerChange =
    typeof custom.ownerChange === "object" && custom.ownerChange
      ? (custom.ownerChange as {
          from: IssueTimelineOwner;
          to: IssueTimelineOwner;
        })
      : null;
  if (custom.kind === "system_notice") {
    return <SystemNoticeCommentRow message={message} anchorId={anchorId} />;
  }

  if (custom.kind === "event" && actorName) {
    const isAgent = actorType === "agent";
    const agentIcon =
      isAgent && actorId ? agentMap?.get(actorId)?.icon : undefined;
    const isCurrentUser =
      actorType === "user" && !!currentUserId && actorId === currentUserId;
    const rowIcon = agentIcon ? (
      <AgentIcon icon={agentIcon} className="h-3 w-3" />
    ) : (
      <ClipboardList className="h-3 w-3" />
    );
    const ownerResolvers: OwnerChipResolvers = {
      agentMap,
      currentUserId,
      resolveUserLabel: (userId) =>
        formatOwnerUserLabel(userId, null, userLabelMap),
    };

    return (
      <IssueChatMetadataRow anchorId={anchorId} icon={rowIcon}>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
          <span className="font-medium text-foreground">{actorName}</span>
          <span className="text-muted-foreground">
            {custom.followUpRequested === true
              ? "requested follow-up"
              : "updated this task"}
          </span>
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-xs text-muted-foreground/70 transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(message.createdAt)}
          </a>
        </div>

        {lifecycleStatusChange ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-(length:--text-nano) font-medium uppercase tracking-wider text-muted-foreground/70">
              Lifecycle
            </span>
            <span className="text-muted-foreground">
              {humanizeValue(lifecycleStatusChange.from)}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground/70" />
            <span className="font-medium text-foreground">
              {humanizeValue(lifecycleStatusChange.to)}
            </span>
          </div>
        ) : null}

        {ownerChange ? (
          <div className="space-y-1">
            <div
              className={cn(
                "flex flex-wrap items-center gap-1.5 text-xs",
                isCurrentUser && "justify-end",
              )}
            >
              <span className="text-(length:--text-nano) font-medium uppercase tracking-wider text-muted-foreground/70">
                Owner
              </span>
              <OwnerChip owner={ownerChange.from} resolvers={ownerResolvers} />
              <ArrowRight className="h-3 w-3 text-muted-foreground/70" />
              <OwnerChip owner={ownerChange.to} resolvers={ownerResolvers} />
            </div>
            <div className={cn(isCurrentUser && "flex justify-end")}>
              <OwnerDispatchRow
                to={ownerChange.to}
                resolvers={ownerResolvers}
                interruptedRunAttached={custom.interruptedRunId != null}
              />
            </div>
          </div>
        ) : null}

      </IssueChatMetadataRow>
    );
  }

  const displayedRunAgentName =
    runAgentName ??
    (runAgentId
      ? (agentMap?.get(runAgentId)?.name ?? runAgentId.slice(0, 8))
      : null);
  const runAgentIcon = runAgentId ? agentMap?.get(runAgentId)?.icon : undefined;
  if (
    custom.kind === "run" &&
    runId &&
    runAgentId &&
    displayedRunAgentName &&
    runStatus
  ) {
    const rowIcon = runAgentIcon ? (
      <AgentIcon icon={runAgentIcon} className="h-3 w-3" />
    ) : (
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
    );

    return (
      <IssueChatMetadataRow anchorId={anchorId} icon={rowIcon}>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <Link
            to={`/agents/${runAgentId}`}
            className="font-medium text-foreground transition-colors hover:underline"
          >
            {displayedRunAgentName}
          </Link>
          <span className="text-muted-foreground">run</span>
          <Link
            to={`/agents/${runAgentId}/runs/${runId}`}
            className="inline-flex items-center rounded-md border border-border bg-accent/40 px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            {runId.slice(0, 8)}
          </Link>
          <RunStatusBadge
            status={runStatus}
            operatorInterrupted={custom.runOperatorInterrupted === true}
          />
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-xs text-muted-foreground/70 transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(message.createdAt)}
          </a>
        </div>
      </IssueChatMetadataRow>
    );
  }

  return null;
}

function issueChatMessageCustom(
  message: ThreadMessage,
): Record<string, unknown> {
  return (message.metadata?.custom ?? {}) as Record<string, unknown>;
}

function issueChatMessageKind(message: ThreadMessage): string {
  const custom = issueChatMessageCustom(message);
  return typeof custom.kind === "string" ? custom.kind : message.role;
}

function issueChatMessageCommentId(message: ThreadMessage): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.commentId === "string" ? custom.commentId : null;
}

function issueChatMessageRunId(message: ThreadMessage): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.runId === "string" ? custom.runId : null;
}

function issueChatMessageQueueTargetRunId(
  message: ThreadMessage,
): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.queueTargetRunId === "string"
    ? custom.queueTargetRunId
    : null;
}


function issueChatMessageRunIsActive(
  message: ThreadMessage,
  activeRunIds: ReadonlySet<string>,
): boolean {
  const runId = issueChatMessageRunId(message);
  return Boolean(runId && activeRunIds.has(runId));
}

function issueChatMessageRunIsStopping(
  message: ThreadMessage,
  stoppingRunId: string | null | undefined,
): boolean {
  const runId = issueChatMessageRunId(message);
  return Boolean(runId && stoppingRunId === runId);
}

function issueChatMessageQueuedRunIsInterrupting(
  message: ThreadMessage,
  interruptingQueuedRunId: string | null | undefined,
): boolean {
  const queueTargetRunId = issueChatMessageQueueTargetRunId(message);
  return Boolean(
    queueTargetRunId && interruptingQueuedRunId === queueTargetRunId,
  );
}

// Above ~150 merged rows the direct render path forces React to mount and
// re-render hundreds of Markdown bodies, action controls, and avatars on
// unrelated parent updates. Above this threshold we switch to a windowed
// render path so only visible rows plus overscan stay mounted.
export const VIRTUALIZED_THREAD_ROW_THRESHOLD = 150;
const VIRTUALIZED_THREAD_OVERSCAN = 6;
// Rough "average row" estimate. The virtualizer measures real heights as
// rows mount, so this only affects offscreen rows it has not seen yet.
const VIRTUALIZED_THREAD_ROW_ESTIMATE_PX = 220;
const VIRTUALIZED_THREAD_GAP_FULL_PX = 16;
const VIRTUALIZED_THREAD_GAP_EMBEDDED_PX = 12;

interface VirtualizedIssueChatThreadListProps {
  messages: readonly ThreadMessage[];
  activeRunIds: ReadonlySet<string>;
  stoppingRunId?: string | null;
  interruptingQueuedRunId?: string | null;
  variant: "full" | "embedded";
}

interface VirtualizedIssueChatThreadListHandle {
  scrollToIndex: (
    index: number,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
  ) => void;
  scrollToLatest: (options?: { behavior?: ScrollBehavior }) => void;
  measure: () => void;
}

function issueChatMessageAnchorId(message: ThreadMessage): string | null {
  const custom = message.metadata.custom as { anchorId?: unknown } | undefined;
  return typeof custom?.anchorId === "string" ? custom.anchorId : null;
}

function findMessageAnchorIndex(
  messages: readonly ThreadMessage[],
  anchorId: string,
): number {
  return messages.findIndex(
    (message) => issueChatMessageAnchorId(message) === anchorId,
  );
}

export function findLatestCommentMessageIndex(
  messages: readonly ThreadMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const anchorId = issueChatMessageAnchorId(messages[index]);
    if (anchorId && anchorId.startsWith("comment-")) return index;
  }
  return -1;
}

type VirtualizedVisibleAnchorSnapshot = {
  anchorId: string;
  index: number;
  viewportTop: number;
};

type VirtualizedScrollMode =
  { kind: "window" } | { kind: "element"; element: HTMLElement };

type SimpleVirtualItem = {
  index: number;
  key: React.Key;
  start: number;
  size: number;
};

export function getVirtualizedMeasurementScrollAdjustment(args: {
  itemStart: number;
  previousSize: number;
  nextSize: number;
  viewportStart: number;
}) {
  const { itemStart, previousSize, nextSize, viewportStart } = args;
  const previousEnd = itemStart + previousSize;
  if (previousEnd > viewportStart) return 0;
  return nextSize - previousSize;
}

function useIssueThreadVirtualizer({
  count,
  estimateSize,
  overscan,
  scrollMargin,
  gap,
  getItemKey,
  mode,
}: {
  count: number;
  estimateSize: () => number;
  overscan: number;
  scrollMargin: number;
  gap: number;
  getItemKey: (index: number) => React.Key;
  mode: VirtualizedScrollMode;
}) {
  const measuredSizeByKeyRef = useRef(new Map<React.Key, number>());
  const [, rerender] = useState(0);
  const estimatedSize = estimateSize();

  const itemStarts: number[] = [];
  const itemSizes: number[] = [];
  let nextStart = scrollMargin;
  for (let index = 0; index < count; index += 1) {
    const key = getItemKey(index);
    const size = measuredSizeByKeyRef.current.get(key) ?? estimatedSize;
    itemStarts.push(nextStart);
    itemSizes.push(size);
    nextStart += size + gap;
  }
  const totalSize = Math.max(0, nextStart - scrollMargin - gap);

  const viewportHeight = () =>
    mode.kind === "window" ? window.innerHeight : mode.element.clientHeight;
  const scrollOffset = () =>
    mode.kind === "window" ? window.scrollY : mode.element.scrollTop;
  const maxScrollOffset = () => {
    const targetScrollHeight =
      mode.kind === "window"
        ? document.documentElement.scrollHeight
        : mode.element.scrollHeight;
    return Math.max(
      0,
      Math.max(targetScrollHeight, totalSize) - viewportHeight(),
    );
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const target: Window | HTMLElement =
      mode.kind === "window" ? window : mode.element;
    const update = () => rerender((value) => value + 1);
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [mode]);

  const rawStart = Math.max(scrollMargin, scrollOffset());
  const rawEnd = rawStart + viewportHeight();
  let visibleStartIndex = 0;
  while (
    visibleStartIndex < count - 1 &&
    itemStarts[visibleStartIndex] + itemSizes[visibleStartIndex] < rawStart
  ) {
    visibleStartIndex += 1;
  }
  let visibleEndIndex = visibleStartIndex;
  while (visibleEndIndex < count - 1 && itemStarts[visibleEndIndex] <= rawEnd) {
    visibleEndIndex += 1;
  }
  const startIndex = Math.max(0, visibleStartIndex - overscan);
  const endIndex = Math.min(count - 1, visibleEndIndex + overscan);
  const virtualItems: SimpleVirtualItem[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    virtualItems.push({
      index,
      key: getItemKey(index),
      start: itemStarts[index] ?? scrollMargin,
      size: itemSizes[index] ?? estimatedSize,
    });
  }

  const scrollToIndex = (
    index: number,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
  ) => {
    const clampedIndex = Math.max(0, Math.min(index, count - 1));
    const targetMax = maxScrollOffset();
    let top = itemStarts[clampedIndex] ?? scrollMargin;
    if (options?.align === "center") {
      top =
        top -
        viewportHeight() / 2 +
        (itemSizes[clampedIndex] ?? estimatedSize) / 2;
    } else if (options?.align === "end") {
      top = top + (itemSizes[clampedIndex] ?? estimatedSize) - viewportHeight();
    }
    top = Math.max(0, Math.min(top, targetMax));
    if (mode.kind === "window") {
      window.scrollTo({ top, behavior: options?.behavior });
    } else {
      mode.element.scrollTo({ top, behavior: options?.behavior });
    }
    rerender((value) => value + 1);
  };

  return {
    getVirtualItems: () => virtualItems,
    getTotalSize: () => totalSize,
    scrollToIndex,
    measure: () => undefined,
    measureElement: (element?: HTMLElement | null) => {
      if (!element) return;
      const index = Number(element.dataset.index);
      if (!Number.isInteger(index) || index < 0 || index >= count) return;
      const measuredSize =
        element.getBoundingClientRect().height || element.offsetHeight;
      if (!Number.isFinite(measuredSize) || measuredSize <= 0) return;
      const key = getItemKey(index);
      const previousSize =
        measuredSizeByKeyRef.current.get(key) ?? estimatedSize;
      if (Math.abs(previousSize - measuredSize) < 1) return;
      const scrollAdjustment = getVirtualizedMeasurementScrollAdjustment({
        itemStart: itemStarts[index] ?? scrollMargin,
        previousSize,
        nextSize: measuredSize,
        viewportStart: Math.max(scrollMargin, scrollOffset()),
      });
      measuredSizeByKeyRef.current.set(key, measuredSize);
      if (Math.abs(scrollAdjustment) >= 1) {
        if (mode.kind === "window") {
          window.scrollBy({ top: scrollAdjustment, behavior: "auto" });
        } else {
          mode.element.scrollBy({ top: scrollAdjustment, behavior: "auto" });
        }
      }
      rerender((value) => value + 1);
    },
  };
}

// The chat thread renders inside `<main id="main-content">` on the real issue
// page (overflow-auto on desktop), but lives at document scope on mobile (main
// is overflow-visible) and in the auth-free perf fixture. Walk the DOM to find
// the actual scroll container so the virtualizer binds to the right offset
// source — otherwise it stays anchored at offset 0 forever and the visible
// chat area renders blank past the first viewport (PAP-2660).
function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  if (!el || typeof window === "undefined") return null;
  let current: HTMLElement | null = el.parentElement;
  while (
    current &&
    current !== document.body &&
    current !== document.documentElement
  ) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

const VirtualizedIssueChatThreadList = forwardRef<
  VirtualizedIssueChatThreadListHandle,
  VirtualizedIssueChatThreadListProps
>(function VirtualizedIssueChatThreadList(props, ref) {
  const probeRef = useRef<HTMLDivElement | null>(null);
  // Default to window scroll on first render so the imperative handle is
  // available immediately for hash-target / submit-scroll effects. After mount
  // we probe the DOM and remount via key={modeKey} if the actual scroll
  // container is an element ancestor (e.g. desktop <main id="main-content">).
  const [mode, setMode] = useState<VirtualizedScrollMode>({ kind: "window" });

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const detect = () => {
      const probe = probeRef.current;
      if (!probe) return;
      const container = findScrollContainer(probe);
      setMode((prev) => {
        if (container === null) {
          return prev.kind === "window" ? prev : { kind: "window" };
        }
        if (prev.kind === "element" && prev.element === container) return prev;
        return { kind: "element", element: container };
      });
    };
    detect();
    window.addEventListener("resize", detect);
    return () => {
      window.removeEventListener("resize", detect);
    };
  }, []);

  return (
    <VirtualizedIssueChatThreadListInner
      key={mode.kind === "window" ? "window" : "element"}
      ref={ref}
      probeRef={probeRef}
      mode={mode}
      {...props}
    />
  );
});

interface VirtualizedIssueChatThreadListInnerProps extends VirtualizedIssueChatThreadListProps {
  mode: VirtualizedScrollMode;
  probeRef: React.MutableRefObject<HTMLDivElement | null>;
}

const VirtualizedIssueChatThreadListInner = forwardRef<
  VirtualizedIssueChatThreadListHandle,
  VirtualizedIssueChatThreadListInnerProps
>(function VirtualizedIssueChatThreadListInner(
  {
    messages,
    activeRunIds,
    stoppingRunId,
    interruptingQueuedRunId,
    variant,
    mode,
    probeRef,
  },
  ref,
) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const pendingPrependAnchorRef =
    useRef<VirtualizedVisibleAnchorSnapshot | null>(null);

  const setRefs = useCallback(
    (element: HTMLDivElement | null) => {
      parentRef.current = element;
      probeRef.current = element;
    },
    [probeRef],
  );

  useLayoutEffect(() => {
    const element = parentRef.current;
    if (!element || typeof window === "undefined") return;
    const update = () => {
      if (!parentRef.current) return;
      const rect = parentRef.current.getBoundingClientRect();
      const offset =
        mode.kind === "window"
          ? rect.top + window.scrollY
          : rect.top -
            mode.element.getBoundingClientRect().top +
            mode.element.scrollTop;
      setScrollMargin((previous) =>
        Math.abs(previous - offset) < 0.5 ? previous : offset,
      );
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, [mode]);

  const gap =
    variant === "embedded"
      ? VIRTUALIZED_THREAD_GAP_EMBEDDED_PX
      : VIRTUALIZED_THREAD_GAP_FULL_PX;

  const virtualizer = useIssueThreadVirtualizer({
    count: messages.length,
    estimateSize: () => VIRTUALIZED_THREAD_ROW_ESTIMATE_PX,
    overscan: VIRTUALIZED_THREAD_OVERSCAN,
    scrollMargin,
    gap,
    getItemKey: (index) => messages[index]?.id ?? index,
    mode,
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index, options) => {
        if (index < 0 || index >= messages.length) return;
        virtualizer.scrollToIndex(index, {
          align: options?.align ?? "center",
          behavior: options?.behavior ?? "smooth",
        });
      },
      scrollToLatest: (options) => {
        if (messages.length === 0) return;
        virtualizer.scrollToIndex(messages.length - 1, {
          align: "end",
          behavior: options?.behavior ?? "smooth",
        });
      },
      measure: () => {
        virtualizer.measure();
      },
    }),
    [messages.length, virtualizer],
  );

  useLayoutEffect(() => {
    return () => {
      const element = parentRef.current;
      if (!element || typeof window === "undefined") return;
      const rows = Array.from(
        element.querySelectorAll<HTMLElement>("[data-anchor-id][data-index]"),
      );
      const visibleRow = rows.find(
        (row) => row.getBoundingClientRect().bottom >= 0,
      );
      if (!visibleRow) return;
      const anchorId = visibleRow.dataset.anchorId;
      const index = Number(visibleRow.dataset.index);
      if (!anchorId || !Number.isFinite(index)) return;
      pendingPrependAnchorRef.current = {
        anchorId,
        index,
        viewportTop: visibleRow.getBoundingClientRect().top,
      };
    };
  }, [messages]);

  useLayoutEffect(() => {
    const pendingAnchor = pendingPrependAnchorRef.current;
    pendingPrependAnchorRef.current = null;
    virtualizer.measure();
    if (!pendingAnchor || typeof window === "undefined") return;
    const nextIndex = findMessageAnchorIndex(messages, pendingAnchor.anchorId);
    if (nextIndex <= pendingAnchor.index) return;

    virtualizer.scrollToIndex(nextIndex, { align: "start", behavior: "auto" });
    requestAnimationFrame(() => {
      const element = document.getElementById(pendingAnchor.anchorId);
      if (!element) return;
      const delta =
        element.getBoundingClientRect().top - pendingAnchor.viewportTop;
      if (Math.abs(delta) > 1) {
        if (mode.kind === "window") {
          window.scrollBy({ top: delta, behavior: "auto" });
        } else {
          mode.element.scrollBy({ top: delta, behavior: "auto" });
        }
      }
      virtualizer.measure();
    });
  }, [messages, virtualizer, mode]);

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      ref={setRefs}
      data-testid="issue-chat-thread-virtualizer"
      data-virtual-count={messages.length}
      style={{ position: "relative", width: "100%", height: totalSize }}
    >
      {virtualItems.map((virtualItem) => {
        const message = messages[virtualItem.index];
        if (!message) return null;
        const anchorId = issueChatMessageAnchorId(message);
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            data-anchor-id={anchorId ?? undefined}
            data-testid="issue-chat-thread-virtual-row"
            ref={(element) => {
              if (element) virtualizer.measureElement(element);
            }}
            onLoadCapture={(event) => {
              virtualizer.measureElement(event.currentTarget);
            }}
            onClickCapture={(event) => {
              const row = event.currentTarget;
              requestAnimationFrame(() => {
                virtualizer.measureElement(row);
              });
            }}
            onTransitionEndCapture={(event) => {
              virtualizer.measureElement(event.currentTarget);
            }}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
            }}
          >
            <IssueChatMessageRow
              message={message}
              activeRunIds={activeRunIds}
              stoppingRunId={stoppingRunId}
              interruptingQueuedRunId={interruptingQueuedRunId}
            />
          </div>
        );
      })}
    </div>
  );
});

interface IssueChatMessageRowProps {
  message: ThreadMessage;
  activeRunIds: ReadonlySet<string>;
  stoppingRunId?: string | null;
  interruptingQueuedRunId?: string | null;
}

function IssueChatCommentGroupContinuation({
  message,
}: {
  message: ThreadMessage;
}) {
  const { onLoadMoreCommentGroup } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const rootCommentId =
    typeof custom.boardGroupRootId === "string"
      ? custom.boardGroupRootId
      : null;
  const hasMore = custom.boardGroupHasMore === true;
  const loading = custom.boardGroupContinuationLoading === true;
  const error =
    typeof custom.boardGroupContinuationError === "string"
      ? custom.boardGroupContinuationError
      : null;
  if (!rootCommentId || (!hasMore && !loading && !error)) return null;

  return (
    <div
      className="ml-10 mt-2 flex items-center gap-2"
      data-testid="issue-chat-comment-group-continuation"
      data-root-comment-id={rootCommentId}
    >
      {error ? (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      ) : null}
      {hasMore && onLoadMoreCommentGroup ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void onLoadMoreCommentGroup(rootCommentId)}
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          {loading ? "Loading replies…" : error ? "Retry replies" : "Load more replies"}
        </Button>
      ) : null}
    </div>
  );
}

const IssueChatMessageRow = memo(function IssueChatMessageRow({
  message,
  activeRunIds,
  stoppingRunId,
  interruptingQueuedRunId,
}: IssueChatMessageRowProps) {
  const kind = issueChatMessageKind(message);
  const custom = message.metadata.custom as Record<string, unknown>;
  const isGroupedEntry =
    typeof custom.boardGroupRootId === "string" &&
    custom.boardIsRoot !== true;
  const isRunActive = issueChatMessageRunIsActive(message, activeRunIds);
  const isStoppingRun = issueChatMessageRunIsStopping(message, stoppingRunId);
  const isInterruptingQueuedRun = issueChatMessageQueuedRunIsInterrupting(
    message,
    interruptingQueuedRunId,
  );
  const renderedMessage =
    message.role === "user" ? (
      <IssueChatUserMessage
        message={message}
        isInterruptingQueuedRun={isInterruptingQueuedRun}
      />
    ) : message.role === "assistant" ? (
      <IssueChatAssistantMessage
        message={message}
        isRunActive={isRunActive}
        isStoppingRun={isStoppingRun}
      />
    ) : (
      <IssueChatSystemMessage message={message} />
    );

  return (
    <div
      className={cn(
        isGroupedEntry && "ml-4 border-l border-border/60 pl-3",
      )}
      data-testid="issue-chat-message-row"
      data-message-role={message.role}
      data-message-kind={kind}
      data-board-group-entry={isGroupedEntry ? "true" : undefined}
    >
      {renderedMessage}
      <IssueChatCommentGroupContinuation message={message} />
    </div>
  );
}, areIssueChatMessageRowPropsEqual);

function areIssueChatMessageRowPropsEqual(
  prev: IssueChatMessageRowProps,
  next: IssueChatMessageRowProps,
) {
  if (prev.message !== next.message) return false;
  if (
    issueChatMessageRunIsActive(prev.message, prev.activeRunIds) !==
    issueChatMessageRunIsActive(next.message, next.activeRunIds)
  )
    return false;
  if (
    issueChatMessageRunIsStopping(prev.message, prev.stoppingRunId) !==
    issueChatMessageRunIsStopping(next.message, next.stoppingRunId)
  )
    return false;
  if (
    issueChatMessageQueuedRunIsInterrupting(
      prev.message,
      prev.interruptingQueuedRunId,
    ) !==
    issueChatMessageQueuedRunIsInterrupting(
      next.message,
      next.interruptingQueuedRunId,
    )
  )
    return false;
  return true;
}

const IssueChatComposer = forwardRef<
  IssueChatComposerHandle,
  IssueChatComposerProps
>(function IssueChatComposer(
  {
    onImageUpload,
    onAttachImage,
    draftKey,
    enableOwnerChange = false,
    ownerOptions = [],
    currentOwnerValue = "",
    suggestedOwnerValue,
    mentions = [],
    agentMap,
    hasActiveRun = false,
    currentUserId = null,
    userLabelMap = null,
    composerDisabledReason = null,
    composerHint = null,
    issueStatus,
    issueWorkMode,
    onWorkModeChange,
    replyTarget = null,
    onClearReply,
    onReplySubmitted,
    onReplyPendingChange,
  },
  forwardedRef,
) {
  const api = useAui();
  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [composerAttachments, setComposerAttachments] = useState<
    ComposerAttachmentItem[]
  >([]);
  const dragDepthRef = useRef(0);
  const effectiveSuggestedOwnerValue = suggestedOwnerValue ?? currentOwnerValue;
  const [ownerTarget, setOwnerTarget] = useState(effectiveSuggestedOwnerValue);
  const [dismissedCoachToken, setDismissedCoachToken] = useState<string | null>(
    null,
  );
  const resolvedIssueWorkMode: IssueWorkMode = issueWorkMode ?? "standard";
  const [pendingWorkMode, setPendingWorkMode] = useState<IssueWorkMode>(
    resolvedIssueWorkMode,
  );
  const [workModeMenuOpen, setWorkModeMenuOpen] = useState(false);
  const canToggleWorkMode = typeof onWorkModeChange === "function";
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const attachInputId = useId();
  const ownerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canAcceptFiles = Boolean(onImageUpload || onAttachImage);

  function queueViewportRestore(
    snapshot: ReturnType<typeof captureComposerViewportSnapshot>,
  ) {
    if (!snapshot) return;
    requestAnimationFrame(() => {
      restoreComposerViewportSnapshot(snapshot, composerContainerRef.current);
    });
  }

  function focusComposer() {
    if (typeof composerContainerRef.current?.scrollIntoView === "function") {
      composerContainerRef.current.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
    requestAnimationFrame(() => {
      window.scrollBy({
        top: COMPOSER_FOCUS_SCROLL_PADDING_PX,
        behavior: "smooth",
      });
      editorRef.current?.focus();
    });
  }

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  useEffect(() => {
    setOwnerTarget(effectiveSuggestedOwnerValue);
  }, [effectiveSuggestedOwnerValue]);

  useEffect(() => {
    setPendingWorkMode(resolvedIssueWorkMode);
  }, [resolvedIssueWorkMode]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: focusComposer,
      restoreDraft: (submittedBody: string) => {
        setBody((current) =>
          restoreSubmittedCommentDraft({
            currentBody: current,
            submittedBody,
          }),
        );
        focusComposer();
      },
    }),
    [],
  );

  async function handleSubmit() {
    if (!body.trim() || isSubmitting) return;

    const composerHasOwnerPicker = enableOwnerChange && ownerOptions.length > 0;
    if (composerHasOwnerPicker && !parseOwnerChange(ownerTarget)) {
      ownerTriggerRef.current?.focus();
      return;
    }

    await submitComment();
  }

  async function submitComment() {
    if (!body.trim() || isSubmitting) return;

    const hasOwnerChange =
      enableOwnerChange && ownerTarget !== currentOwnerValue;
    const ownerChange = hasOwnerChange
      ? (parseOwnerChange(ownerTarget) ?? undefined)
      : undefined;
    const mentionAgentId = replyTarget
      ? undefined
      : mentionedAgentIds.length === 1
        ? mentionedAgentIds[0]
        : undefined;
    const submittedBody = body;
    const viewportSnapshot = captureComposerViewportSnapshot(
      composerContainerRef.current,
    );

    const workModeChanged = pendingWorkMode !== resolvedIssueWorkMode;
    setIsSubmitting(true);
    onReplyPendingChange?.(true);
    setBody("");
    try {
      if (workModeChanged && onWorkModeChange) {
        await onWorkModeChange(pendingWorkMode);
      }
      const appendPromise = api.thread().append({
        role: "user",
        content: [{ type: "text", text: submittedBody }],
        metadata: { custom: {} },
        attachments: [],
        runConfig: {
          custom: {
            ...(ownerChange ? { ownerChange } : {}),
            ...(mentionAgentId ? { mentionAgentId } : {}),
            ...(replyTarget
              ? { replyToCommentId: replyTarget.commentId }
              : {}),
          },
        },
      });
      queueViewportRestore(viewportSnapshot);
      await appendPromise;
      if (draftKey) clearDraft(draftKey);
      setComposerAttachments([]);
      setOwnerTarget(effectiveSuggestedOwnerValue);
      onReplySubmitted?.();
    } catch {
      setBody((current) =>
        restoreSubmittedCommentDraft({
          currentBody: current,
          submittedBody,
        }),
      );
    } finally {
      setIsSubmitting(false);
      onReplyPendingChange?.(false);
      queueViewportRestore(viewportSnapshot);
    }
  }

  async function attachFile(file: File) {
    const attachmentId = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
    const inline = Boolean(onImageUpload && file.type.startsWith("image/"));
    setComposerAttachments((prev) => [
      ...prev,
      {
        id: attachmentId,
        name: file.name,
        size: file.size,
        status: "uploading",
        inline,
      },
    ]);

    try {
      if (onImageUpload && file.type.startsWith("image/")) {
        const url = await onImageUpload(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        setBody((prev) => (prev ? `${prev}\n\n${markdown}` : markdown));
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? { ...item, status: "attached", contentPath: url }
              : item,
          ),
        );
      } else if (onAttachImage) {
        const attachment = await onAttachImage(file);
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? {
                  ...item,
                  status: "attached",
                  contentPath: attachment?.contentPath,
                  name: attachment?.originalFilename ?? item.name,
                }
              : item,
          ),
        );
      } else {
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? {
                  ...item,
                  status: "error",
                  error: "This file type cannot be attached here",
                }
              : item,
          ),
        );
      }
    } catch (err) {
      setComposerAttachments((prev) =>
        prev.map((item) =>
          item.id === attachmentId
            ? {
                ...item,
                status: "error",
                error: err instanceof Error ? err.message : "Upload failed",
              }
            : item,
        ),
      );
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      await attachFile(file);
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  async function handleDroppedFiles(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    setAttaching(true);
    try {
      for (const file of Array.from(files)) {
        await attachFile(file);
      }
    } finally {
      setAttaching(false);
    }
  }

  function resetDragState() {
    dragDepthRef.current = 0;
    setIsDragOver(false);
  }

  function handleFileDragEnter(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleFileDragOver(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.dataTransfer.dropEffect = "copy";
  }

  function handleFileDragLeave(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function handleFileDrop(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    resetDragState();
    void handleDroppedFiles(evt.dataTransfer?.files);
  }

  // Interrupt-owner clarity (PAP-10669): preview what this comment will durably
  // do, and coach plain agent names toward real mentions.
  const agentMentionOptions = useMemo<OwnerAgentMention[]>(
    () =>
      mentions
        .filter((m) => (m.kind ?? "agent") === "agent" && (m.agentId ?? m.id))
        .map((m) => ({
          agentId: m.agentId ?? m.id.replace(/^agent:/, ""),
          name: m.name,
        })),
    [mentions],
  );
  const ownerResolvers = useMemo<OwnerChipResolvers>(
    () => ({
      agentMap,
      currentUserId,
      resolveUserLabel: (userId: string) =>
        formatOwnerUserLabel(userId, null, userLabelMap),
    }),
    [agentMap, currentUserId, userLabelMap],
  );
  const mentionedAgentIds = useMemo(() => extractAgentMentionIds(body), [body]);
  const plainNameCandidate = useMemo(
    () =>
      mentionedAgentIds.length > 0
        ? null
        : findPlainAgentNameCandidate(body, agentMentionOptions),
    [body, mentionedAgentIds, agentMentionOptions],
  );
  const ownerPreview = useMemo(
    () =>
      computeComposerOwnerPreview({
        ownerTarget,
        currentOwnerValue,
        hasActiveRun,
        bodyHasAgentMention: mentionedAgentIds.length > 0,
        mentionedAgentId: mentionedAgentIds[0] ?? null,
        plainNameCandidate,
      }),
    [
      ownerTarget,
      currentOwnerValue,
      hasActiveRun,
      mentionedAgentIds,
      plainNameCandidate,
    ],
  );
  const coachVisible = Boolean(
    plainNameCandidate &&
    plainNameCandidate.matchedText !== dismissedCoachToken,
  );
  const coachAgentName = plainNameCandidate
    ? (agentMap?.get(plainNameCandidate.agentId)?.name ??
      plainNameCandidate.matchedText)
    : "";

  function insertCoachMention() {
    if (!plainNameCandidate) return;
    const option = mentions.find(
      (m) =>
        (m.agentId ?? m.id.replace(/^agent:/, "")) ===
        plainNameCandidate.agentId,
    );
    const agentId = plainNameCandidate.agentId;
    const name = option?.name ?? plainNameCandidate.matchedText;
    const markdown = `[@${name}](${buildAgentMentionHref(agentId, option?.agentIcon ?? null)}) `;
    // Replace the first bare occurrence of the matched token (outside links).
    const tokenRe = new RegExp(
      `(?<![\\w@/])${plainNameCandidate.matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`,
      "i",
    );
    setBody((current) => {
      if (tokenRe.test(current))
        return current.replace(tokenRe, markdown.trimEnd());
      return current ? `${current} ${markdown}` : markdown;
    });
    setDismissedCoachToken(plainNameCandidate.matchedText);
  }

  if (composerDisabledReason) {
    return (
      <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
        {composerDisabledReason}
      </div>
    );
  }

  const workModeOptions = workModeMetaList();
  const pendingWorkModeMeta = workModeMetaFor(pendingWorkMode);
  const PendingWorkModeIcon = pendingWorkModeMeta.icon;

  function handleComposerKeyDown(evt: ReactKeyboardEvent<HTMLDivElement>) {
    // Match the period via both `code` and `key`: iOS Safari with a hardware
    // keyboard often leaves `code` empty for cmd-period, so relying on it alone
    // lets the event fall through and triggers Safari's default cancel/dismiss
    // (which closes the view). Catching `key === "."` keeps the shortcut working
    // on iOS while preserving desktop behavior.
    const isPeriod = evt.code === "Period" || evt.key === ".";
    if (!(evt.metaKey || evt.ctrlKey) || !isPeriod) return;
    evt.preventDefault();
    setPendingWorkMode((current) => nextWorkMode(current));
  }

  return (
    <div
      ref={composerContainerRef}
      data-testid="issue-chat-composer"
      data-pending-work-mode={pendingWorkMode}
      className={cn(
        "relative rounded-md border border-border/70 bg-background/95 p-(--sz-15px) shadow-(--shadow-extract-4) backdrop-blur transition-(--tp-border-color-background-color-box-shadow) duration-150 supports-[backdrop-filter]:bg-background/85 dark:shadow-(--shadow-extract-5)",
        pendingWorkModeMeta.classes.container,
        isDragOver &&
          "border-primary/45 bg-background shadow-(--shadow-extract-7)",
      )}
      onKeyDownCapture={handleComposerKeyDown}
      onDragEnterCapture={handleFileDragEnter}
      onDragOverCapture={handleFileDragOver}
      onDragLeaveCapture={handleFileDragLeave}
      onDropCapture={handleFileDrop}
    >
      {isDragOver && canAcceptFiles ? (
        <div
          data-testid="issue-chat-composer-drop-overlay"
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-sm border border-dashed border-primary/55 bg-background/75 px-4 py-3 text-center shadow-sm backdrop-blur-(--blur-2px) dark:bg-background/65"
        >
          <div className="flex max-w-md items-center gap-3 rounded-md bg-background/80 px-3 py-2 text-left shadow-sm ring-1 ring-border/60">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Paperclip className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                Drop to upload
              </div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Images insert into the reply. Other files are added to this
                task.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {replyTarget ? (
        <div
          data-testid="issue-chat-reply-target"
          className="mb-2 flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/35 px-2.5 py-2"
          aria-label={`Replying to ${replyTarget.authorLabel}`}
        >
          <ReplyIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 truncate text-xs">
            <span className="font-medium text-foreground">
              {replyTarget.authorLabel}
            </span>
            <span className="text-muted-foreground"> · {replyTarget.preview}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={isSubmitting}
            onClick={onClearReply}
            aria-label="Cancel reply"
            title="Cancel reply"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}

      <MarkdownEditor
        ref={editorRef}
        value={body}
        onChange={setBody}
        placeholder="Reply"
        mentions={replyTarget ? [] : mentions}
        onSubmit={handleSubmit}
        readOnly={isSubmitting}
        imageUploadHandler={onImageUpload}
        fileDropTarget="parent"
        bordered={false}
        contentClassName="max-h-(--sz-28dvh) overflow-y-auto pr-1 pb-2 text-sm scrollbar-auto-hide"
      />

      {coachVisible && plainNameCandidate ? (
        <div className="mt-2">
          <ComposerMentionCoach
            candidate={plainNameCandidate}
            agentDisplayName={coachAgentName}
            onInsert={insertCoachMention}
            onDismiss={() =>
              setDismissedCoachToken(plainNameCandidate.matchedText)
            }
          />
        </div>
      ) : null}

      {composerHint ? (
        <div className="inline-flex items-center rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-(length:--text-micro) text-muted-foreground">
          {composerHint}
        </div>
      ) : null}

      {composerAttachments.length > 0 ? (
        <div
          data-testid="issue-chat-composer-attachments"
          className="mb-3 mt-2 space-y-1.5 rounded-md border border-dashed border-border/80 bg-muted/20 p-2"
        >
          {composerAttachments.map((attachment) => {
            const sizeLabel = formatAttachmentSize(attachment.size);
            const statusLabel =
              attachment.status === "uploading"
                ? "Uploading to task"
                : attachment.status === "error"
                  ? (attachment.error ?? "Upload failed")
                  : attachment.inline
                    ? "Inserted inline"
                    : "Attached to task";
            return (
              <div
                key={attachment.id}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs",
                  attachment.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-background/70 text-muted-foreground",
                )}
              >
                {attachment.status === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : attachment.status === "attached" ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {attachment.name}
                </span>
                {sizeLabel ? (
                  <span className="shrink-0 text-muted-foreground">
                    {sizeLabel}
                  </span>
                ) : null}
                <span className="shrink-0 text-muted-foreground">
                  {statusLabel}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {shouldRenderComposerOwnerPreview(body, ownerPreview) ? (
        <div className="my-2">
          <ComposerOwnerPreviewRow
            preview={ownerPreview}
            resolvers={ownerResolvers}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="mr-auto flex items-center gap-2">
          {onImageUpload || onAttachImage ? (
            <>
              <label className="sr-only" htmlFor={attachInputId}>
                Attach file
              </label>
              <input
                id={attachInputId}
                ref={attachInputRef}
                type="file"
                className="hidden"
                onChange={handleAttachFile}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => attachInputRef.current?.click()}
                disabled={attaching}
                aria-label="Attach file"
                title="Attach file"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          {canToggleWorkMode ? (
            <Popover open={workModeMenuOpen} onOpenChange={setWorkModeMenuOpen}>
              <PopoverTrigger asChild>
                {/* Single persistent mode chip (PAP-95b mockup rev 5): yellow in
                    planning, neutral in standard, caret opens the switch menu. */}
                <button
                  type="button"
                  data-testid="issue-chat-composer-work-mode-toggle"
                  data-pending-work-mode={pendingWorkMode}
                  aria-haspopup="menu"
                  aria-expanded={workModeMenuOpen}
                  aria-pressed={pendingWorkMode !== "standard"}
                  aria-keyshortcuts="Meta+Period Control+Period"
                  title={titleForPendingWorkMode(pendingWorkMode)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-(length:--text-micro) font-semibold transition-colors",
                    pendingWorkModeMeta.classes.chip,
                  )}
                >
                  <PendingWorkModeIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>{pendingWorkModeMeta.label}</span>
                  <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-44 p-1"
                align="start"
                data-testid="issue-chat-composer-work-mode-menu"
              >
                {workModeOptions.map((option) => {
                  const Icon = option.icon;
                  const active = option.value === pendingWorkMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-testid={`issue-chat-composer-work-mode-menu-${option.value}`}
                      data-pending-work-mode={pendingWorkMode}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                        active && "bg-accent",
                        option.classes.menuItem,
                      )}
                      onClick={() => {
                        setPendingWorkMode(option.value);
                        setWorkModeMenuOpen(false);
                      }}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>{option.label}</span>
                      {active ? (
                        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      ) : null}
                    </button>
                  );
                })}
                <div className="mt-1 border-t px-2 py-1.5 text-(length:--text-nano) text-muted-foreground">
                  Cmd/Ctrl+. cycles modes
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>

        {enableOwnerChange && ownerOptions.length > 0 ? (
          <InlineEntitySelector
            ref={ownerTriggerRef}
            value={ownerTarget}
            options={ownerOptions}
            placeholder="Owner"
            noneLabel="Choose owner"
            includeNone={false}
            searchPlaceholder="Search agent owners..."
            emptyMessage="No agent owners found."
            onChange={setOwnerTarget}
            className="h-8 text-xs"
            renderTriggerValue={(option) => {
              if (!option)
                return <span className="text-muted-foreground">Owner</span>;
              const agentId = option.id.startsWith("agent:")
                ? option.id.slice("agent:".length)
                : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentIcon
                      icon={agent.icon}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
            renderOption={(option) => {
              if (!option.id)
                return <span className="truncate">{option.label}</span>;
              const agentId = option.id.startsWith("agent:")
                ? option.id.slice("agent:".length)
                : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentIcon
                      icon={agent.icon}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        ) : null}

        <Button
          size="sm"
          disabled={isSubmitting || !body.trim()}
          onClick={() => void handleSubmit()}
        >
          {isSubmitting ? "Posting..." : "Send"}
        </Button>
      </div>
    </div>
  );
});

export function IssueChatThread({
  comments,
  timelineEvents = [],
  hasActiveRun = false,
  issueId = null,
  blockedBy = [],
  liveIssueIds,
  blockerAttention = null,
  companyId,
  projectId,
  issueStatus,
  agentMap,
  currentUserId,
  userLabelMap,
  userProfileMap,
  onAdd,
  onLoadMoreCommentGroup,
  onCancelRun,
  onStopRun,
  stopRunLabel,
  stoppingRunLabel,
  stopRunVariant,
  runFinalizationActions,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  enableOwnerChange = false,
  ownerOptions = [],
  currentOwnerValue = "",
  suggestedOwnerValue,
  mentions = [],
  composerDisabledReason = null,
  composerHint = null,
  showComposer = true,
  showJumpToLatest,
  autoScrollToHashOnInitialLoad = false,
  emptyMessage,
  footer,
  variant = "full",
  onInterruptQueued,
  onCancelQueued,
  interruptingQueuedRunId = null,
  stoppingRunId = null,
  onImageClick,
  composerRef,
  composerAccessory,
  issueWorkMode,
  onWorkModeChange,
  onRefreshLatestComments,
  ownerUserId = null,
  onResumeFromBacklog,
  resumeFromBacklogPending = false,
}: IssueChatThreadProps) {
  const location = useLocation();
  const lastScrolledHashRef = useRef<string | null>(null);
  const didInitialHashScrollDecisionRef = useRef(false);
  const virtualizedThreadRef =
    useRef<VirtualizedIssueChatThreadListHandle | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const composerViewportAnchorRef = useRef<HTMLDivElement | null>(null);
  const composerViewportSnapshotRef =
    useRef<ReturnType<typeof captureComposerViewportSnapshot>>(null);
  const preserveComposerViewportRef = useRef(false);
  const pendingSubmitScrollRef = useRef(false);
  const lastUserMessageIdRef = useRef<string | null>(null);
  const spacerBaselineAnchorRef = useRef<string | null>(null);
  const spacerInitialReserveRef = useRef(0);
  const latestSettleTimeoutsRef = useRef<number[]>([]);
  const latestSettleCleanupRef = useRef<(() => void) | null>(null);
  const [bottomSpacerHeight, setBottomSpacerHeight] = useState(0);
  const [replyTarget, setReplyTarget] = useState<IssueChatReplyTarget | null>(null);
  const [replyPending, setReplyPending] = useState(false);
  useEffect(() => {
    setReplyTarget(null);
    setReplyPending(false);
  }, [issueId]);
  const selectReplyTarget = useCallback((target: IssueChatReplyTarget) => {
    if (replyPending) return;
    setReplyTarget(target);
    composerRef && typeof composerRef === "object" && composerRef.current?.focus();
  }, [composerRef, replyPending]);
  const activeRunIds = useMemo(() => new Set<string>(), []);
  const clearLatestSettleTimeouts = useCallback(() => {
    for (const timeout of latestSettleTimeoutsRef.current) {
      window.clearTimeout(timeout);
    }
    latestSettleTimeoutsRef.current = [];
    latestSettleCleanupRef.current?.();
    latestSettleCleanupRef.current = null;
  }, []);

  useEffect(() => clearLatestSettleTimeouts, [clearLatestSettleTimeouts]);

  const rawMessages = useMemo(
    () =>
      buildIssueChatMessages({
        comments,
        timelineEvents,
        companyId,
        projectId,
        agentMap,
        currentUserId,
        userLabelMap,
      }),
    [
      comments,
      timelineEvents,
      companyId,
      projectId,
      agentMap,
      currentUserId,
      userLabelMap,
    ],
  );
  const stableMessagesRef = useRef<readonly ThreadMessage[]>([]);
  const stableMessageCacheRef = useRef<
    Map<string, StableThreadMessageCacheEntry>
  >(new Map());
  const messages = useMemo(() => {
    const stabilized = stabilizeThreadMessages(
      rawMessages,
      stableMessagesRef.current,
      stableMessageCacheRef.current,
    );
    stableMessagesRef.current = stabilized.messages;
    stableMessageCacheRef.current = stabilized.cache;
    return stabilized.messages;
  }, [rawMessages]);
  const latestMessagesRef = useRef<readonly ThreadMessage[]>(messages);
  latestMessagesRef.current = messages;

  const isRunning = hasActiveRun;
  const unresolvedBlockers = useMemo(
    () =>
      blockedBy.filter(
        (blocker) =>
          blocker.boardPresentationStatus !== "done" &&
          blocker.boardPresentationStatus !== "cancelled",
      ),
    [blockedBy],
  );
  const ownerAgent = useMemo(() => {
    if (!currentOwnerValue.startsWith("agent:")) return null;
    const ownerAgentId = currentOwnerValue.slice("agent:".length);
    return agentMap?.get(ownerAgentId) ?? null;
  }, [agentMap, currentOwnerValue]);
  const useVirtualizedThread =
    messages.length >= VIRTUALIZED_THREAD_ROW_THRESHOLD;
  const messageAnchorIndex = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((message, index) => {
      const anchorId = issueChatMessageAnchorId(message);
      if (anchorId) map.set(anchorId, index);
    });
    return map;
  }, [messages]);

  function scrollToThreadAnchor(
    anchorId: string,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
    messageSnapshot: readonly ThreadMessage[] = messages,
  ) {
    const snapshotUsesVirtualizer =
      messageSnapshot.length >= VIRTUALIZED_THREAD_ROW_THRESHOLD;
    const virtualIndex =
      messageSnapshot === messages
        ? messageAnchorIndex.get(anchorId)
        : findMessageAnchorIndex(messageSnapshot, anchorId);
    if (
      snapshotUsesVirtualizer &&
      virtualIndex !== undefined &&
      virtualIndex >= 0
    ) {
      if (!virtualizedThreadRef.current) return false;
      virtualizedThreadRef.current.scrollToIndex(virtualIndex, {
        align: options?.align ?? "center",
        behavior: options?.behavior ?? "smooth",
      });
      return true;
    }

    const element = document.getElementById(anchorId);
    if (!element) return false;
    element.scrollIntoView({
      behavior: options?.behavior ?? "smooth",
      block:
        options?.align === "start"
          ? "start"
          : options?.align === "end"
            ? "end"
            : "center",
    });
    return true;
  }

  const runtime = usePaperclipIssueRuntime({
    messages,
    isRunning,
    onSend: ({ body, ownerChange, mentionAgentId, replyToCommentId }) => {
      pendingSubmitScrollRef.current = true;
      return onAdd(body, ownerChange, mentionAgentId, replyToCommentId);
    },
    onCancel: onCancelRun,
  });

  useEffect(() => {
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const lastUserId = lastUserMessage?.id ?? null;

    if (
      pendingSubmitScrollRef.current &&
      lastUserId &&
      lastUserId !== lastUserMessageIdRef.current
    ) {
      pendingSubmitScrollRef.current = false;
      const custom = lastUserMessage?.metadata.custom as
        { anchorId?: unknown } | undefined;
      const anchorId =
        typeof custom?.anchorId === "string" ? custom.anchorId : null;
      if (anchorId) {
        const reserve = Math.round(
          window.innerHeight * SUBMIT_SCROLL_RESERVE_VH,
        );
        spacerBaselineAnchorRef.current = anchorId;
        spacerInitialReserveRef.current = reserve;
        setBottomSpacerHeight(reserve);
        requestAnimationFrame(() => {
          scrollToThreadAnchor(anchorId, {
            align: "start",
            behavior: "smooth",
          });
        });
      }
    }

    lastUserMessageIdRef.current = lastUserId;
  }, [messageAnchorIndex, messages, useVirtualizedThread]);

  useLayoutEffect(() => {
    const anchorId = spacerBaselineAnchorRef.current;
    if (!anchorId || spacerInitialReserveRef.current <= 0) return;
    const userEl = document.getElementById(anchorId);
    const bottomEl = bottomAnchorRef.current;
    if (!userEl || !bottomEl) return;
    const contentBelow = Math.max(
      0,
      bottomEl.getBoundingClientRect().top -
        userEl.getBoundingClientRect().bottom,
    );
    const next = Math.max(0, spacerInitialReserveRef.current - contentBelow);
    setBottomSpacerHeight((prev) => (prev === next ? prev : next));
    if (next === 0) {
      spacerBaselineAnchorRef.current = null;
      spacerInitialReserveRef.current = 0;
    }
  }, [messages]);
  useLayoutEffect(() => {
    const composerElement = composerViewportAnchorRef.current;
    if (preserveComposerViewportRef.current) {
      restoreComposerViewportSnapshot(
        composerViewportSnapshotRef.current,
        composerElement,
      );
    }

    composerViewportSnapshotRef.current =
      captureComposerViewportSnapshot(composerElement);
    preserveComposerViewportRef.current =
      shouldPreserveComposerViewport(composerElement);
  }, [messages]);

  useEffect(() => {
    const hash =
      location.hash ||
      (typeof window !== "undefined" ? window.location.hash : "");
    const isThreadHash =
      hash.startsWith("#comment-") ||
      hash.startsWith("#activity-") ||
      hash.startsWith("#run-");
    if (messages.length === 0) return;
    if (!isThreadHash) {
      if (!didInitialHashScrollDecisionRef.current) {
        didInitialHashScrollDecisionRef.current = true;
      }
      return;
    }
    if (lastScrolledHashRef.current === hash) return;
    if (!didInitialHashScrollDecisionRef.current) {
      didInitialHashScrollDecisionRef.current = true;
      if (!autoScrollToHashOnInitialLoad) {
        lastScrolledHashRef.current = hash;
        return;
      }
    }
    const targetId = hash.slice(1);
    let cancelled = false;
    const attemptScroll = (finalAttempt = false) => {
      if (cancelled || lastScrolledHashRef.current === hash) return;
      const didScroll = scrollToThreadAnchor(targetId, {
        align: "center",
        behavior: "smooth",
      });
      if (!didScroll) return;
      if (
        finalAttempt ||
        !useVirtualizedThread ||
        document.getElementById(targetId)
      ) {
        lastScrolledHashRef.current = hash;
      }
    };

    attemptScroll();
    const frame = requestAnimationFrame(() => attemptScroll());
    const timeout = window.setTimeout(() => attemptScroll(true), 250);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [
    autoScrollToHashOnInitialLoad,
    location.hash,
    messageAnchorIndex,
    messages,
    useVirtualizedThread,
  ]);

  function jumpToLatestFallback() {
    if (useVirtualizedThread) {
      virtualizedThreadRef.current?.scrollToLatest({ behavior: "smooth" });
      return;
    }
    bottomAnchorRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }

  // Lands on the latest `comment-*` row and then drives the scroll the rest
  // of the way home as the virtualizer's per-row measurements arrive.
  //
  // The virtualizer estimates 220px for unmeasured rows. On long threads
  // with tall markdown comments (PAP-2536 et al.), totalSize is hugely
  // underestimated until rows render and get measured. A single scroll
  // lands above the actual bottom; rendered rows then expand, the layout
  // grows, and the user has to keep clicking Jump-to-latest to walk closer
  // to the real bottom. The convergence loop below issues `scrollIntoView`
  // on the latest comment element on every tick until the DOM bottom of
  // that element is at the scroll container's bottom (or scroll position
  // and content height stop changing).
  function scrollToLatestCommentWithSettle(
    messageSnapshot: readonly ThreadMessage[] = latestMessagesRef.current,
  ) {
    const latestCommentIndex = findLatestCommentMessageIndex(messageSnapshot);
    if (latestCommentIndex < 0) {
      jumpToLatestFallback();
      return;
    }
    const latestCommentAnchor = issueChatMessageAnchorId(
      messageSnapshot[latestCommentIndex],
    );
    if (!latestCommentAnchor) {
      jumpToLatestFallback();
      return;
    }

    const initial = scrollToThreadAnchor(
      latestCommentAnchor,
      { align: "end", behavior: "smooth" },
      messageSnapshot,
    );
    if (!initial) {
      jumpToLatestFallback();
      return;
    }

    if (typeof window === "undefined") return;

    const startedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const MAX_DURATION_MS = 4000;
    const TICK_MS = 80;
    const TOLERANCE_PX = 4;

    clearLatestSettleTimeouts();
    const resolveScrollContainer = (): HTMLElement | null =>
      document.getElementById("main-content") as HTMLElement | null;
    const cancelTarget = resolveScrollContainer() ?? window;

    let lastScrollTop = -1;
    let lastScrollHeight = -1;
    let stableTicks = 0;
    let cancelled = false;

    const cancel = () => {
      cancelled = true;
    };

    const cleanup = () => {
      cancelTarget.removeEventListener("wheel", cancel);
      cancelTarget.removeEventListener("touchstart", cancel);
    };

    cancelTarget.addEventListener("wheel", cancel, {
      once: true,
      passive: true,
    });
    cancelTarget.addEventListener("touchstart", cancel, {
      once: true,
      passive: true,
    });
    latestSettleCleanupRef.current = cleanup;

    const finish = () => {
      cleanup();
      latestSettleCleanupRef.current = null;
      for (const timeout of latestSettleTimeoutsRef.current) {
        window.clearTimeout(timeout);
      }
      latestSettleTimeoutsRef.current = [];
    };

    const scheduleTick = (delay: number) => {
      const timeout = window.setTimeout(() => {
        latestSettleTimeoutsRef.current =
          latestSettleTimeoutsRef.current.filter((entry) => entry !== timeout);
        tick();
      }, delay);
      latestSettleTimeoutsRef.current.push(timeout);
    };

    const tick = () => {
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      if (cancelled || now - startedAt > MAX_DURATION_MS) {
        finish();
        return;
      }

      if (typeof document === "undefined") {
        finish();
        return;
      }

      const el = document.getElementById(latestCommentAnchor);
      if (!el) {
        // Row hasn't been rendered into the virtualizer's buffer yet — nudge
        // the offset (instant) so it gets mounted, then keep settling.
        virtualizedThreadRef.current?.scrollToIndex(latestCommentIndex, {
          align: "end",
          behavior: "auto",
        });
        scheduleTick(TICK_MS);
        return;
      }

      const container = resolveScrollContainer();
      const containerBottom = container
        ? container.getBoundingClientRect().bottom
        : window.innerHeight;
      const elBottom = el.getBoundingClientRect().bottom;
      const offBottom = elBottom - containerBottom;

      if (Math.abs(offBottom) > TOLERANCE_PX) {
        el.scrollIntoView({ behavior: "smooth", block: "end" });
      }

      const currentScrollTop = container?.scrollTop ?? window.scrollY;
      const currentScrollHeight =
        container?.scrollHeight ?? document.documentElement.scrollHeight;
      const scrollStable = Math.abs(currentScrollTop - lastScrollTop) < 1;
      const heightStable = currentScrollHeight === lastScrollHeight;
      const atBottom = Math.abs(offBottom) <= TOLERANCE_PX;
      if (scrollStable && heightStable && atBottom) {
        stableTicks += 1;
        if (stableTicks >= 3) {
          finish();
          return;
        }
      } else {
        stableTicks = 0;
      }
      lastScrollTop = currentScrollTop;
      lastScrollHeight = currentScrollHeight;
      scheduleTick(TICK_MS);
    };

    // Hold the first iteration off for one frame so the initial smooth
    // scroll has begun (and the virtualizer has rendered the buffer around
    // the target) before we start settling.
    scheduleTick(120);
  }

  function handleJumpToLatest() {
    if (onRefreshLatestComments) {
      // Refetching the comments query (page 0 first) brings any comment that
      // arrived after the initial load — including ones live updates may
      // have missed during reconnects — into the loaded set before we
      // resolve the latest target. Otherwise we'd land on the latest
      // *loaded* comment but not the absolute newest. (PAP-2672 follow-up.)
      const refreshed = onRefreshLatestComments();
      if (
        refreshed &&
        typeof (refreshed as Promise<unknown>).then === "function"
      ) {
        (refreshed as Promise<unknown>).then(
          () => scrollToLatestCommentWithSettle(latestMessagesRef.current),
          () => scrollToLatestCommentWithSettle(latestMessagesRef.current),
        );
        return;
      }
    }
    scrollToLatestCommentWithSettle(latestMessagesRef.current);
  }

  const stableOnStopRun = useStableEvent(onStopRun);
  const stableOnInterruptQueued = useStableEvent(onInterruptQueued);
  const stableOnCancelQueued = useStableEvent(onCancelQueued);
  const stableOnImageClick = useStableEvent(onImageClick);
  const stableOnUploadImage = useStableEvent(imageUploadHandler);

  const chatCtx = useMemo<IssueChatMessageContext>(
    () => ({
      agentMap,
      currentUserId,
      userLabelMap,
      onStopRun: stableOnStopRun,
      stopRunLabel,
      stoppingRunLabel,
      stopRunVariant,
      runFinalizationActions,
      onInterruptQueued: stableOnInterruptQueued,
      onCancelQueued: stableOnCancelQueued,
      onImageClick: stableOnImageClick,
      onUploadImage: stableOnUploadImage,
      issueStatus,
      onReply: selectReplyTarget,
      onLoadMoreCommentGroup,
    }),
    [
      agentMap,
      currentUserId,
      userLabelMap,
      userProfileMap,
      stableOnStopRun,
      stopRunLabel,
      stoppingRunLabel,
      stopRunVariant,
      runFinalizationActions,
      stableOnInterruptQueued,
      stableOnCancelQueued,
      stableOnImageClick,
      stableOnUploadImage,
      issueStatus,
      selectReplyTarget,
      onLoadMoreCommentGroup,
    ],
  );

  const resolvedShowJumpToLatest = showJumpToLatest ?? variant === "full";
  const resolvedEmptyMessage =
    emptyMessage ??
    (variant === "embedded"
      ? "No run output yet."
      : "This task conversation is empty. Start with a message below.");
  const previousErrorBoundaryMessagesRef = useRef<
    readonly ThreadMessage[] | null
  >(null);
  const errorBoundaryResetVersionRef = useRef(0);
  if (previousErrorBoundaryMessagesRef.current !== messages) {
    previousErrorBoundaryMessagesRef.current = messages;
    errorBoundaryResetVersionRef.current += 1;
  }
  const errorBoundaryResetKey = String(errorBoundaryResetVersionRef.current);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <IssueChatCtx.Provider value={chatCtx}>
        <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
          {resolvedShowJumpToLatest ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleJumpToLatest}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Jump to latest
              </button>
            </div>
          ) : null}

          <IssueChatErrorBoundary
            resetKey={errorBoundaryResetKey}
            messages={messages}
            emptyMessage={resolvedEmptyMessage}
            variant={variant}
          >
            <div data-testid="thread-root">
              <div
                data-testid="thread-viewport"
                className={variant === "embedded" ? "space-y-3" : "space-y-4"}
              >
                {messages.length === 0 ? (
                  <Card
                    className={cn(
                      "block shadow-none text-center text-sm text-muted-foreground",
                      variant === "embedded"
                        ? "border-dashed border-border/70 bg-background/60 px-4 py-6"
                        : "border-dashed px-6 py-10",
                    )}
                  >
                    {resolvedEmptyMessage}
                  </Card>
                ) : messages.length >= VIRTUALIZED_THREAD_ROW_THRESHOLD ? (
                  <VirtualizedIssueChatThreadList
                    ref={virtualizedThreadRef}
                    messages={messages}
                    activeRunIds={activeRunIds}
                    stoppingRunId={stoppingRunId}
                    interruptingQueuedRunId={interruptingQueuedRunId}
                    variant={variant}
                  />
                ) : (
                  // Keep transcript rendering independent from assistant-ui's
                  // index-scoped message providers; live transcripts can shrink
                  // or regroup while the runtime still holds stale indices.
                  messages.map((message) => (
                    <IssueChatMessageRow
                      key={message.id}
                      message={message}
                      activeRunIds={activeRunIds}
                      stoppingRunId={stoppingRunId}
                      interruptingQueuedRunId={interruptingQueuedRunId}
                    />
                  ))
                )}
                {showComposer ? (
                  <div
                    data-testid="issue-chat-thread-notices"
                    className="space-y-2"
                  >
                    <IssueOwnerBacklogNotice
                      issueStatus={issueStatus ?? ""}
                      ownerAgent={ownerAgent}
                      ownerUserId={ownerUserId}
                      onResume={onResumeFromBacklog}
                      resuming={resumeFromBacklogPending}
                    />
                    <IssueBlockedNotice
                      issueStatus={issueStatus}
                      blockers={unresolvedBlockers}
                      allBlockers={blockedBy}
                      liveIssueIds={liveIssueIds}
                      blockerAttention={blockerAttention}
                    />
                    <IssueOwnerPausedNotice agent={ownerAgent} />
                  </div>
                ) : null}
                {footer ? (
                  <div data-testid="issue-chat-thread-footer">{footer}</div>
                ) : null}
                <div ref={bottomAnchorRef} />
                {showComposer ? (
                  <div
                    aria-hidden
                    data-testid="issue-chat-bottom-spacer"
                    style={{ height: bottomSpacerHeight }}
                  />
                ) : null}
              </div>
            </div>
          </IssueChatErrorBoundary>

          {showComposer && composerAccessory ? (
            <div data-testid="issue-chat-composer-accessory" className="mb-2">
              {composerAccessory}
            </div>
          ) : null}

          {showComposer ? (
            <div
              ref={composerViewportAnchorRef}
              data-testid="issue-chat-composer-dock"
              className="sticky bottom-(--sz-calc-8) z-20 space-y-2 bg-gradient-to-t from-background via-background/95 to-background/0 pt-6"
            >
              <IssueChatComposer
                ref={composerRef}
                onImageUpload={imageUploadHandler}
                onAttachImage={onAttachImage}
                draftKey={draftKey}
                enableOwnerChange={enableOwnerChange}
                ownerOptions={ownerOptions}
                currentOwnerValue={currentOwnerValue}
                suggestedOwnerValue={suggestedOwnerValue}
                mentions={mentions}
                agentMap={agentMap}
                hasActiveRun={!!hasActiveRun}
                currentUserId={currentUserId}
                userLabelMap={userLabelMap}
                composerDisabledReason={composerDisabledReason}
                composerHint={composerHint}
                issueStatus={issueStatus}
                issueWorkMode={issueWorkMode}
                onWorkModeChange={onWorkModeChange}
                replyTarget={replyTarget}
                onClearReply={() => {
                  if (!replyPending) setReplyTarget(null);
                }}
                onReplySubmitted={() => setReplyTarget(null)}
                onReplyPendingChange={setReplyPending}
              />
            </div>
          ) : null}
        </div>
      </IssueChatCtx.Provider>
    </AssistantRuntimeProvider>
  );
}
