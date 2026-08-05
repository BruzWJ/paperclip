import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode, type Ref } from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Link, useLocation, useNavigate, useNavigationType, useParams } from "@/lib/router";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { usePublishSharedQueryData, useSharedPollingQuery } from "@/hooks/useSharedPolling";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { approvalsApi } from "../api/approvals";
import { activityApi } from "../api/activity";
import {
  ACTIVE_ISSUE_EXECUTION_RUN_STATUSES,
  runsApi,
} from "../api/runs";
import { instanceSettingsApi } from "../api/instanceSettings";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { formatUserLabel } from "../lib/issue-owners";
import { buildCompanyUserInlineOptions, buildCompanyUserLabelMap, buildCompanyUserProfileMap, buildMarkdownMentionOptions } from "../lib/company-members";
import { extractIssueTimelineEvents } from "../lib/issue-timeline-events";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import {
  createIssueDetailPath,
  readIssueDetailLocationState,
  readIssueDetailBreadcrumb,
  readIssueDetailHeaderSeed,
  rememberIssueDetailLocationState,
} from "../lib/issueDetailBreadcrumb";
import { issueDisplayTitle } from "../lib/issue-display";
import { getIssueDetailQueryOptions } from "../lib/issueDetailCache";
import {
  beginLocalInboxArchive,
  boundLocalInboxArchive,
  cancelInboxIssueQueries,
  clearLocalInboxArchive,
  confirmLocalInboxArchive,
  invalidateInboxIssueQueries,
  getIssuePresenceInActiveInboxCaches,
  removeIssueFromInboxCaches,
  restoreIssueToInboxCaches,
  snapshotInboxIssueCaches,
  type InboxIssueCacheSnapshot,
} from "../lib/inboxArchiveCache";
import {
  hasBlockingShortcutDialog,
  resolveIssueDetailGoKeyAction,
  resolveInboxQuickArchiveKeyAction,
} from "../lib/keyboardShortcuts";
import {
  applyOptimisticIssueFieldUpdate,
  applyOptimisticIssueFieldUpdateToCollection,
  applyLocalQueuedIssueCommentState,
  createOptimisticIssueComment,
  flattenBoardIssueCommentGroupPages,
  matchesIssueRef,
  mergeIssueComments,
  shouldAutoloadOlderIssueComments,
  takeOptimisticIssueComment,
  type ClientIssueComment,
  type BoardIssueCommentGroupContinuation,
  type OptimisticIssueComment,
} from "../lib/optimistic-issue-comments";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatDurationMs, formatMoneyAmount } from "../lib/utils";
import { liveBlueBadge } from "../lib/status-colors";
import { ApprovalCard } from "../components/ApprovalCard";
import { InlineEditor } from "../components/InlineEditor";
import {
  IssueChatThread,
  type IssueChatComposerHandle,
} from "../components/IssueChatThread";
import { workModeMetaFor } from "../lib/work-mode-meta";
import { IssueAttachmentsSection } from "../components/IssueAttachmentsSection";
import { IssueDocumentsSection } from "../components/IssueDocumentsSection";
import { IssueOutputSection } from "../components/issue-output/IssueOutputSection";
import { isImageAttachment, isVideoAttachment } from "../lib/issue-attachments";
import {
  getIssueOutputs,
  getPromotedOutputAttachmentIds,
  isImageContentType,
  isVideoLikeOutput,
} from "../lib/issue-output";
import { IssueSiblingNavigation } from "../components/IssueSiblingNavigation";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "../components/MarkdownBody";
import { IssuesList } from "../components/IssuesList";
import { AgentIcon } from "../components/AgentIconPicker";
import { IssueReferenceActivitySummary } from "../components/IssueReferenceActivitySummary";
import { IssueRelatedWorkPanel } from "../components/IssueRelatedWorkPanel";
import {
  IssueMonitorBanner,
  IssueMonitorComposerStrip,
  hasVisibleMonitorSurface,
} from "../components/IssueMonitorBanner";
import { IssueProperties } from "../components/IssueProperties";
import { PauseAffectsSummaryView } from "../components/owner-transition/OwnerTransitionViews";
import { computePauseAffectsSummary } from "../lib/owner-transition";
import { useIssueExternalObjects } from "../hooks/useIssueExternalObjects";
import { IssueRunLedger } from "../components/IssueRunLedger";
import { IssueWorkspaceCard } from "../components/IssueWorkspaceCard";
import type { MentionOption } from "../components/MarkdownEditor";
import { ImageGalleryModal, type GalleryMediaItem } from "../components/ImageGalleryModal";
import { FileViewerProvider, useRequiredFileViewer } from "../context/FileViewerContext";
import { FileViewerSheet } from "../components/FileViewerSheet";
import { ArtifactFileChip } from "../components/ArtifactFileChip";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { Identity } from "../components/Identity";
import { IssueContextAccessMaskMatrix } from "../components/IssueContextAccessMaskMatrix";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatIssueActivityAction } from "@/lib/activity-format";
import { copyTextToClipboard } from "../lib/clipboard";
import { buildIssuePropertiesPanelKey } from "../lib/issue-properties-panel-key";
import { buildIssueSiblingNavigation, shouldRenderRichSubIssuesSection } from "../lib/issue-detail-subissues";
import { filterIssueDescendants } from "../lib/issue-tree";
import { buildSubIssueDefaultsForViewer } from "../lib/subIssueDefaults";
import { hasAssignedBacklogBlocker } from "../lib/issue-blockers";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  EyeOff,
  Flag,
  FileCode2,
  Hexagon,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  MoreVertical,
  PauseCircle,
  Paperclip,
  PlayCircle,
  Plus,
  Repeat,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  deriveOriginatingActor,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  type ActivityEvent,
  type Agent,
  type BoardIssueCommentGroupPage,
  type BoardIssueThreadEntry,
  type FeedbackVote,
  type Issue,
  type IssueExecutionRunEnvelopeRecord,
  type IssueExecutionRunListPageRecord,
  type IssueAttachment,
  type IssueWorkProduct,
  type IssueWorkMode,
  type IssueTreeControlMode,
  type WorkspaceFileRef,
  workspaceFileRefSchema,
} from "@paperclipai/shared";

type CommentOwnerChange = {
  ownerAgentId: string;
};
type IssueDetailComment = ClientIssueComment & {
  runId?: string | null;
  runAgentId?: string | null;
  interruptedRunId?: string | null;
  queueState?: "queued";
  queueTargetRunId?: string | null;
  queueReason?: "hold" | "active_run" | "other";
};

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";
const ISSUE_COMMENT_PAGE_SIZE = 50;
const ISSUE_COMMENT_AUTOLOAD_LIMIT = ISSUE_COMMENT_PAGE_SIZE * 3;
const JUMP_TO_LATEST_MAX_COMMENT_PAGES = 10;
const TREE_CONTROL_MODE_LABEL: Record<IssueTreeControlMode, string> = {
  pause: "Pause subtree",
  resume: "Resume subtree",
  cancel: "Cancel subtree",
  restore: "Restore subtree",
};
const LEAF_WORK_CONTROL_MODE_LABEL: Partial<Record<IssueTreeControlMode, string>> = {
  pause: "Pause work",
  resume: "Resume work",
};
const TREE_CONTROL_MODE_HELP_TEXT: Record<IssueTreeControlMode, string> = {
  pause: "Pause active execution in this task subtree until an explicit resume.",
  resume: "Release the active subtree pause hold so held work can continue.",
  cancel: "Cancel non-terminal tasks in this subtree and stop queued/running work where possible.",
  restore: "Restore tasks cancelled by this subtree operation so work can resume.",
};
const LEAF_WORK_CONTROL_MODE_HELP_TEXT: Partial<Record<IssueTreeControlMode, string>> = {
  pause: "Pause active execution on this task until an explicit resume.",
  resume: "Release the active pause hold so this task can continue.",
};
function issueTreeControlLabel(mode: IssueTreeControlMode, scope: "leaf" | "subtree") {
  return scope === "leaf"
    ? LEAF_WORK_CONTROL_MODE_LABEL[mode] ?? TREE_CONTROL_MODE_LABEL[mode]
    : TREE_CONTROL_MODE_LABEL[mode];
}

function issueTreeControlHelpText(mode: IssueTreeControlMode, scope: "leaf" | "subtree") {
  return scope === "leaf"
    ? LEAF_WORK_CONTROL_MODE_HELP_TEXT[mode] ?? TREE_CONTROL_MODE_HELP_TEXT[mode]
    : TREE_CONTROL_MODE_HELP_TEXT[mode];
}

function treeControlPreviewErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Only board users can preview subtree controls.";
    if (error.status === 409) return "Preview is stale because subtree hold state changed. Retry to refresh.";
    if (error.status === 422) return "This subtree action is currently invalid for the selected tasks.";
  }
  return error instanceof Error ? error.message : "Unable to load preview.";
}

export function shouldScrollIssueDetailToTopOnNavigation(input: {
  previousIssueId: string | undefined;
  nextIssueId: string | undefined;
  navigationType: ReturnType<typeof useNavigationType>;
}): boolean {
  if (input.navigationType === "POP") return false;
  return input.previousIssueId !== input.nextIssueId;
}

function resolveInterruptibleIssueRun(
  runs: readonly IssueExecutionRunEnvelopeRecord[] | undefined,
) {
  return (runs ?? []).find((run) => run.status === "running") ??
    (runs ?? []).find((run) => run.status === "queued") ??
    (runs ?? []).find((run) => run.status === "scheduled_retry") ??
    null;
}

function readIssueRunStateFromCache(
  queryClient: QueryClient,
  issueId: string,
) {
  const page = queryClient.getQueryData<IssueExecutionRunListPageRecord>(
    queryKeys.issues.runs(issueId, ACTIVE_ISSUE_EXECUTION_RUN_STATUSES),
  );
  const activeRuns = page?.items ?? [];
  return {
    activeRuns,
    interruptibleIssueRun: resolveInterruptibleIssueRun(activeRuns),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractWorkspaceFileRefFromWorkProduct(
  workProduct: { metadata: Record<string, unknown> | null },
): WorkspaceFileRef | null {
  const metadata = asRecord(workProduct.metadata);
  if (!metadata) return null;
  const parsed = workspaceFileRefSchema.safeParse(metadata.resourceRef);
  return parsed.success ? parsed.data : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function isMarkdownFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mergeOptimisticFeedbackVote(
  previousVotes: FeedbackVote[] | undefined,
  nextVote: {
    issueId: string;
    targetType: "issue_comment" | "issue_document_revision";
    targetId: string;
    vote: "up" | "down";
    reason?: string;
  },
  currentUserId: string | null,
): FeedbackVote[] {
  const now = new Date();
  const existingVotes = previousVotes ?? [];
  const existingIndex = existingVotes.findIndex(
    (feedbackVote) =>
      feedbackVote.targetType === nextVote.targetType &&
      feedbackVote.targetId === nextVote.targetId &&
      (!currentUserId || feedbackVote.authorUserId === currentUserId),
  );

  if (existingIndex >= 0) {
    const existingVote = existingVotes[existingIndex]!;
    const updatedVote: FeedbackVote = {
      ...existingVote,
      vote: nextVote.vote,
      reason:
        nextVote.reason !== undefined
          ? nextVote.reason.trim() || null
          : existingVote.reason,
      updatedAt: now,
    };
    const nextVotes = [...existingVotes];
    nextVotes[existingIndex] = updatedVote;
    return nextVotes;
  }

  return [
    ...existingVotes,
    {
      id: `optimistic:${nextVote.targetType}:${nextVote.targetId}`,
      companyId: "",
      issueId: nextVote.issueId,
      targetType: nextVote.targetType,
      targetId: nextVote.targetId,
      authorUserId: currentUserId ?? "current-user",
      vote: nextVote.vote,
      reason: nextVote.reason?.trim() || null,
      sharedWithLabs: false,
      sharedAt: null,
      consentVersion: null,
      redactionSummary: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function ActorIdentity({ evt, agentMap, userProfileMap }: { evt: ActivityEvent; agentMap: Map<string, Agent>; userProfileMap?: Map<string, import("../lib/company-members").CompanyUserProfile> }) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") {
    const profile = userProfileMap?.get(id);
    return <Identity name={profile?.label ?? "Board"} avatarUrl={profile?.image} size="sm" />;
  }
  return <Identity name={id || "Unknown"} size="sm" />;
}

export type AttributionActor = {
  kind: "agent" | "user";
  id: string;
  name: string;
  avatarUrl?: string | null;
};

function attributionInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function AttributionAvatar({
  label,
  actor,
  via,
}: {
  label: "Owner" | "Originating";
  actor: AttributionActor;
  via?: string | null;
}) {
  const accessibleLabel = via ? `${label}: ${actor.name} · via ${via}` : `${label}: ${actor.name}`;
  const testIdLabel = label.toLowerCase();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar
          size="xs"
          shape={actor.kind === "agent" ? "square" : "circle"}
          aria-label={accessibleLabel}
          data-testid={`issue-${testIdLabel}-avatar`}
          className="ring-2 ring-background"
        >
          {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt="" /> : null}
          <AvatarFallback>{attributionInitials(actor.name)}</AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="px-2 py-1.5">
        <div className="flex items-center gap-2" data-testid={`issue-${testIdLabel}-tooltip`}>
          <Avatar
            size="sm"
            shape={actor.kind === "agent" ? "square" : "circle"}
            className="ring-1 ring-background/30"
          >
            {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt="" /> : null}
            <AvatarFallback className="bg-background/20 text-background">
              {attributionInitials(actor.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="text-(length:--text-nano) font-medium uppercase leading-none text-background/70">{label}</div>
            <div className="max-w-48 truncate text-xs font-medium leading-4 text-background">{actor.name}</div>
            {via ? (
              <div className="max-w-48 truncate text-(length:--text-nano) leading-3 text-background/60">via {via}</div>
            ) : null}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function IssueAttributionByline({
  issue,
  agentMap,
  userProfileMap,
  userLabelMap,
}: {
  issue: Issue;
  agentMap: Map<string, Agent>;
  userProfileMap: ReadonlyMap<string, import("../lib/company-members").CompanyUserProfile>;
  userLabelMap: ReadonlyMap<string, string>;
}) {
  const owner: AttributionActor | null = issue.ownerAgentId
    ? {
        kind: "agent",
        id: issue.ownerAgentId,
        name: agentMap.get(issue.ownerAgentId)?.name ?? issue.ownerAgentId.slice(0, 8),
      }
    : issue.ownerUserId
      ? {
          kind: "user",
          id: issue.ownerUserId,
          name: formatUserLabel(issue.ownerUserId, userLabelMap)
            ?? userProfileMap.get(issue.ownerUserId)?.label
            ?? "User",
          avatarUrl: userProfileMap.get(issue.ownerUserId)?.image ?? null,
        }
      : null;
  const originatingActor = deriveOriginatingActor(issue);
  const originator: AttributionActor | null = originatingActor
    ? originatingActor.kind === "agent"
      ? {
          kind: "agent",
          id: originatingActor.id,
          name: agentMap.get(originatingActor.id)?.name ?? originatingActor.id.slice(0, 8),
        }
      : {
          kind: "user",
          id: originatingActor.id,
          name: formatUserLabel(originatingActor.id, userLabelMap)
            ?? userProfileMap.get(originatingActor.id)?.label
            ?? "User",
          avatarUrl: userProfileMap.get(originatingActor.id)?.image ?? null,
        }
    : null;
  const originatorVia =
    originatingActor?.kind === "user" && originatingActor.viaAgentId
      ? agentMap.get(originatingActor.viaAgentId)?.name ?? originatingActor.viaAgentId.slice(0, 8)
      : null;
  if (!owner && !originator) return null;

  return (
    <TooltipProvider>
      <AvatarGroup className="-space-x-1.5" aria-label="Task people" data-testid="issue-attribution-avatar-stack">
        {owner ? <AttributionAvatar label="Owner" actor={owner} /> : null}
        {originator ? <AttributionAvatar label="Originating" actor={originator} via={originatorVia} /> : null}
      </AvatarGroup>
    </TooltipProvider>
  );
}

function IssueSectionSkeleton({
  titleWidth = "w-28",
  rows = 3,
}: {
  titleWidth?: string;
  rows?: number;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <Skeleton className={cn("h-4", titleWidth)} />
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}

function IssueChatSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-end gap-2">
          <div className="space-y-2 text-right">
            <Skeleton className="ml-auto h-3 w-20" />
            <Skeleton className="ml-auto h-3 w-14" />
          </div>
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
        <Skeleton className="ml-auto h-16 w-(--pct-85) rounded-xl" />
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  );
}

function IssueDetailLoadingState({
  headerSeed,
}: {
  headerSeed: ReturnType<typeof readIssueDetailHeaderSeed>;
}) {
  const identifier = headerSeed?.identifier ?? headerSeed?.id.slice(0, 8) ?? null;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-3 w-40" />

        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {headerSeed ? (
            <>
              <StatusIcon status={headerSeed.boardPresentationStatus} blockerAttention={headerSeed.blockerAttention} />
              <PriorityIcon priority={headerSeed.priority} />
              {identifier ? (
                <span className="text-sm font-mono text-muted-foreground shrink-0">{identifier}</span>
              ) : null}
              {headerSeed.originKind === "routine_execution" && headerSeed.originId ? (
                <Badge variant="outline"
                  className="border-violet-500/30 bg-violet-500/10 text-(length:--text-nano) text-violet-600 dark:text-violet-400"
                  title={`Routine execution from routine ${headerSeed.originId}`}
                >
                  <Repeat className="h-3 w-3" />
                  Routine
                </Badge>
              ) : null}
              {headerSeed.projectId ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground rounded px-1 -mx-1 py-0.5 min-w-0">
                  <Hexagon className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {headerSeed.projectName ?? headerSeed.projectId.slice(0, 8)}
                  </span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
                  <Hexagon className="h-3 w-3 shrink-0" />
                  No project
                </span>
              )}
            </>
          ) : (
            <>
              <Skeleton className="h-6 w-6" />
              <Skeleton className="h-6 w-6" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-28" />
            </>
          )}
        </div>

        {headerSeed ? (
          <>
            <h2 className="text-xl font-bold leading-tight">{headerSeed.title}</h2>
            <div className="space-y-2">
              <Skeleton className="h-4 w-full max-w-xl" />
              <Skeleton className="h-4 w-(--pct-72)" />
            </div>
          </>
        ) : (
          <>
            <Skeleton className="h-8 w-(--sz-calc-37)" />
            <Skeleton className="h-16 w-full" />
          </>
        )}
      </div>

      <Skeleton className="h-28 w-full rounded-lg border border-border" />

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
        <IssueChatSkeleton />
      </div>

      <IssueSectionSkeleton titleWidth="w-24" rows={3} />
    </div>
  );
}

interface InboxMobileToolbarProps {
  backHref: string;
  issueId: string | undefined;
  issueHidden: boolean;
  onArchive: () => void;
  archivePending: boolean;
  onCopy: () => void;
  onProperties: () => void;
}

function InboxMobileToolbar({
  backHref,
  issueId: issueIdProp,
  issueHidden,
  onArchive,
  archivePending,
  onCopy,
  onProperties,
}: InboxMobileToolbarProps) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex items-center w-full">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => {
          // Use browser back when we have real history so the inbox
          // restores its scroll position. Fall back to a PUSH to
          // backHref when there's no prior entry (e.g. deep-link).
          if (window.history.length > 1) {
            navigate(-1);
          } else {
            navigate(backHref);
          }
        }}
        aria-label="Back to inbox"
      >
        <ArrowLeft className="h-5 w-5" />
      </Button>

      <div className="ml-auto flex items-center gap-0.5">
        {issueIdProp && !issueHidden && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onArchive}
            disabled={archivePending}
            aria-label="Archive from inbox"
          >
            <Archive className="h-5 w-5" />
          </Button>
        )}

        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              <MoreVertical className="h-5 w-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-1" align="end">
            <button
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
              onClick={() => { onCopy(); setMenuOpen(false); }}
            >
              <Copy className="h-3 w-3" />
              Copy as markdown
            </button>
            <button
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
              onClick={() => { onProperties(); setMenuOpen(false); }}
            >
              <SlidersHorizontal className="h-3 w-3" />
              Properties
            </button>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

type IssueDetailChatTabProps = {
  issueId: string;
  companyId: string;
  projectId: string | null;
  issueStatus: Issue["boardPresentationStatus"];
  issueLifecycleStatus: Issue["lifecycleStatus"];
  issueWorkMode: IssueWorkMode;
  blockedBy: Issue["blockedBy"];
  liveIssueIds: ReadonlySet<string>;
  blockerAttention: Issue["blockerAttention"] | null;
  comments: IssueDetailComment[];
  locallyQueuedCommentRunIds: ReadonlyMap<string, string>;
  hasOlderComments: boolean;
  commentsLoadingOlder: boolean;
  onLoadOlderComments: () => void;
  onRefreshLatestComments: () => Promise<unknown> | void;
  onLoadMoreCommentGroup: (rootCommentId: string) => Promise<void> | void;
  onWorkModeChange?: (workMode: IssueWorkMode) => Promise<void> | void;
  composerRef: Ref<IssueChatComposerHandle>;
  /** Optional node rendered inline directly above the reply composer (e.g. the monitor strip). */
  composerAccessory?: ReactNode;
  footer?: ReactNode;
  feedbackVotes?: FeedbackVote[];
  feedbackDataSharingPreference: "allowed" | "not_allowed" | "prompt";
  feedbackTermsUrl: string | null;
  agentMap: Map<string, Agent>;
  currentUserId: string | null;
  userLabelMap: ReadonlyMap<string, string> | null;
  userProfileMap: ReadonlyMap<string, import("../lib/company-members").CompanyUserProfile> | null;
  draftKey: string;
  ownerOptions: Array<{ id: string; label: string; searchText?: string }>;
  currentOwnerValue: string;
  suggestedOwnerValue: string;
  mentions: MentionOption[];
  composerDisabledReason: string | null;
  composerHint: string | null;
  onVote: (
    commentId: string,
    vote: "up" | "down",
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onAdd: (
    body: string,
    ownerChange?: CommentOwnerChange,
    mentionAgentId?: string,
    replyToCommentId?: string,
  ) => Promise<void>;
  onImageUpload: (file: File) => Promise<string>;
  onAttachImage: (file: File) => Promise<IssueAttachment | void>;
  onCancelQueued?: (commentId: string) => void;
  onImageClick: (src: string) => void;
  ownerUserId: string | null;
  onResumeFromBacklog?: () => Promise<void> | void;
  resumeFromBacklogPending?: boolean;
  externalReferences?: MarkdownExternalReferenceMap;
  linkCaseReferences?: boolean;
};

const IssueDetailChatTab = memo(function IssueDetailChatTab({
  issueId,
  companyId,
  projectId,
  issueWorkMode,
  issueStatus,
  issueLifecycleStatus,
  blockedBy,
  liveIssueIds,
  blockerAttention,
  comments,
  locallyQueuedCommentRunIds,
  hasOlderComments,
  commentsLoadingOlder,
  onLoadOlderComments,
  onRefreshLatestComments,
  onLoadMoreCommentGroup,
  onWorkModeChange,
  composerRef,
  composerAccessory,
  footer,
  feedbackVotes,
  feedbackDataSharingPreference,
  feedbackTermsUrl,
  agentMap,
  currentUserId,
  userLabelMap,
  userProfileMap,
  draftKey,
  ownerOptions,
  currentOwnerValue,
  suggestedOwnerValue,
  mentions,
  composerDisabledReason,
  composerHint,
  onVote,
  onAdd,
  onImageUpload,
  onAttachImage,
  onCancelQueued,
  onImageClick,
  ownerUserId,
  onResumeFromBacklog,
  resumeFromBacklogPending,
  externalReferences,
  linkCaseReferences,
}: IssueDetailChatTabProps) {
  const ThreadComponent = IssueChatThread;
  const { data: activity } = useQuery({
    queryKey: queryKeys.issues.activity(issueId),
    queryFn: () => activityApi.forIssue(issueId),
    placeholderData: keepPreviousDataForSameQueryTail<ActivityEvent[]>(issueId),
  });
  const { data: activeRunPage } = useQuery({
    queryKey: queryKeys.issues.runs(
      issueId,
      ACTIVE_ISSUE_EXECUTION_RUN_STATUSES,
    ),
    queryFn: () => runsApi.listForIssue(issueId, {
      status: ACTIVE_ISSUE_EXECUTION_RUN_STATUSES,
      limit: 200,
    }),
    enabled: issueLifecycleStatus === "open",
    refetchInterval: 3000,
    placeholderData:
      keepPreviousDataForSameQueryTail<IssueExecutionRunListPageRecord>(issueId),
  });
  const activeRuns = activeRunPage?.items ?? [];
  const resolvedActivity = activity ?? [];
  const interruptibleIssueRun = resolveInterruptibleIssueRun(activeRuns);
  const activeRunIds = useMemo(
    () => new Set(activeRuns.map((run) => run.id)),
    [activeRuns],
  );
  const commentsWithRunMeta = useMemo<IssueDetailComment[]>(() => {
    return comments.map((comment) => {
      const nextComment: IssueDetailComment = { ...comment };
      const queuedTargetRunId = locallyQueuedCommentRunIds.get(comment.id) ?? null;
      const locallyQueuedComment = applyLocalQueuedIssueCommentState(nextComment, {
        queuedTargetRunId,
        targetRunIsLive: queuedTargetRunId ? activeRunIds.has(queuedTargetRunId) : false,
        runningRunId: interruptibleIssueRun?.id ?? null,
      });
      return locallyQueuedComment;
    });
  }, [
    activeRunIds,
    comments,
    locallyQueuedCommentRunIds,
    interruptibleIssueRun,
  ]);
  const timelineEvents = useMemo(
    () => extractIssueTimelineEvents(resolvedActivity),
    [resolvedActivity],
  );

  return (
    <div className="space-y-3">
      {hasOlderComments ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={commentsLoadingOlder}
            onClick={onLoadOlderComments}
          >
            {commentsLoadingOlder ? "Loading earlier comments..." : "Load earlier comments"}
          </Button>
        </div>
      ) : null}
      <ThreadComponent
        composerRef={composerRef}
        composerAccessory={composerAccessory}
        comments={commentsWithRunMeta}
        feedbackVotes={feedbackVotes}
        feedbackDataSharingPreference={feedbackDataSharingPreference}
        feedbackTermsUrl={feedbackTermsUrl}
        timelineEvents={timelineEvents}
        hasActiveRun={activeRuns.length > 0}
        issueId={issueId}
        blockedBy={blockedBy ?? []}
        liveIssueIds={liveIssueIds}
        blockerAttention={blockerAttention}
        companyId={companyId}
        projectId={projectId}
        issueStatus={issueStatus}
        agentMap={agentMap}
        currentUserId={currentUserId}
        userLabelMap={userLabelMap}
        userProfileMap={userProfileMap}
        draftKey={draftKey}
        enableOwnerChange
        ownerOptions={ownerOptions}
        currentOwnerValue={currentOwnerValue}
        suggestedOwnerValue={suggestedOwnerValue}
        mentions={mentions}
        composerDisabledReason={composerDisabledReason}
        composerHint={composerHint}
        onVote={onVote}
        onAdd={onAdd}
        onLoadMoreCommentGroup={onLoadMoreCommentGroup}
        imageUploadHandler={onImageUpload}
        onAttachImage={onAttachImage}
        onCancelQueued={onCancelQueued}
        issueWorkMode={issueWorkMode}
        onWorkModeChange={onWorkModeChange}
        onImageClick={onImageClick}
        onRefreshLatestComments={onRefreshLatestComments}
        ownerUserId={ownerUserId}
        onResumeFromBacklog={onResumeFromBacklog}
        resumeFromBacklogPending={resumeFromBacklogPending}
        footer={footer}
        externalReferences={externalReferences}
        linkCaseReferences={linkCaseReferences}
      />
    </div>
  );
});

type IssueDetailActivityTabProps = {
  issue: Issue;
  issueId: string;
  companyId: string;
  issueStatus: Issue["boardPresentationStatus"];
  childIssues: Issue[];
  agentMap: Map<string, Agent>;
  hasLiveRuns: boolean;
  currentUserId: string | null;
  userProfileMap: Map<string, import("../lib/company-members").CompanyUserProfile>;
  pendingApprovalAction: { approvalId: string; action: "approve" | "reject" } | null;
  onApprovalAction: (approvalId: string, action: "approve" | "reject") => void;
  externalReferences?: MarkdownExternalReferenceMap;
};

function IssueDetailActivityTab({
  issue,
  issueId,
  companyId,
  issueStatus,
  childIssues,
  agentMap,
  hasLiveRuns,
  currentUserId,
  userProfileMap,
  pendingApprovalAction,
  onApprovalAction,
  externalReferences,
}: IssueDetailActivityTabProps) {
  const { data: activity, isLoading: activityLoading } = useQuery({
    queryKey: queryKeys.issues.activity(issueId),
    queryFn: () => activityApi.forIssue(issueId),
    placeholderData: keepPreviousDataForSameQueryTail<ActivityEvent[]>(issueId),
  });
  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId),
    queryFn: () => issuesApi.listApprovals(issueId),
    placeholderData: keepPreviousDataForSameQueryTail<Awaited<ReturnType<typeof issuesApi.listApprovals>>>(issueId),
  });
  const { data: issueTreeCostSummary } = useQuery({
    queryKey: queryKeys.issues.costSummary(issueId),
    queryFn: () => issuesApi.getCostSummary(issueId),
    placeholderData: keepPreviousDataForSameQueryTail<Awaited<ReturnType<typeof issuesApi.getCostSummary>>>(issueId),
  });
  const initialLoading = activityLoading && activity === undefined;
  const hasIssueTreeCost =
    !!issueTreeCostSummary
    && (issueTreeCostSummary.pricedPromptCount > 0
      || issueTreeCostSummary.unpricedPromptCount > 0
      || issueTreeCostSummary.runtimeMs > 0
      || issueTreeCostSummary.issueCount > 1);

  if (initialLoading) {
    return <IssueSectionSkeleton titleWidth="w-20" rows={4} />;
  }

  return (
    <>
      {hasIssueTreeCost && issueTreeCostSummary && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-border">
          <div className="text-sm font-medium text-muted-foreground mb-1">Cost Summary</div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground">
              {issueTreeCostSummary.issueCount > 1 ? "This task and sub-tasks" : "This task"}
            </span>
            <span className="font-medium text-foreground">
              {formatMoneyAmount(
                issueTreeCostSummary.knownCostAmount,
                issueTreeCostSummary.budgetCurrency,
              )}
            </span>
            <span>{issueTreeCostSummary.pricedPromptCount} priced prompts</span>
            <span>{issueTreeCostSummary.unpricedPromptCount} unpriced prompts</span>
            {issueTreeCostSummary.runCount > 0 ? (
              <span>
                Runtime {formatDurationMs(issueTreeCostSummary.runtimeMs)}
                {` (${issueTreeCostSummary.runCount} run${issueTreeCostSummary.runCount === 1 ? "" : "s"})`}
              </span>
            ) : null}
            <span>{issueTreeCostSummary.issueCount} task{issueTreeCostSummary.issueCount === 1 ? "" : "s"}</span>
          </div>
        </div>
      )}
      <div className="mb-3">
        <IssueRunLedger
          issueId={issueId}
          companyId={companyId}
          issueStatus={issueStatus}
          childIssues={childIssues}
          agentMap={agentMap}
          hasLiveRuns={hasLiveRuns}
          activityEvents={activity ?? []}
          resolveUserLabel={(userId) => userProfileMap.get(userId)?.label ?? null}
          renderActivityEvent={(evt) => {
            return (
              <div className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <ActorIdentity evt={evt} agentMap={agentMap} userProfileMap={userProfileMap} />
                  <span>{formatIssueActivityAction(evt.action, evt.details, { agentMap, userProfileMap, currentUserId })}</span>
                  <span className="ml-auto shrink-0">{relativeTime(evt.createdAt)}</span>
                </div>
                <IssueReferenceActivitySummary event={evt} />
              </div>
            );
          }}
        />
      </div>
      {linkedApprovals && linkedApprovals.length > 0 && (
        <div className="mb-3 space-y-3">
          {linkedApprovals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requesterAgent={approval.requestedByAgentId ? agentMap.get(approval.requestedByAgentId) ?? null : null}
              onApprove={() => onApprovalAction(approval.id, "approve")}
              onReject={() => onApprovalAction(approval.id, "reject")}
              detailLink={`/approvals/${approval.id}`}
              isPending={pendingApprovalAction?.approvalId === approval.id}
              pendingAction={
                pendingApprovalAction?.approvalId === approval.id
                  ? pendingApprovalAction.action
                  : null
              }
            />
          ))}
        </div>
      )}
      {/* Waiting-monitor state now lives in the pinned top banner (IssueMonitorBanner) — PAP-14557 decision 1. */}
    </>
  );
}

export function IssueDetail() {
  const { issueId } = useParams<{ issueId: string }>();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs, setMobileToolbar } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const location = useLocation();
  const { pushToast } = useToastActions();
  const { isMobile } = useSidebar();
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [fileViewerPromptOpen, setFileViewerPromptOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("chat");
  const [pendingApprovalAction, setPendingApprovalAction] = useState<{
    approvalId: string;
    action: "approve" | "reject";
  } | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [treeControlOpen, setTreeControlOpen] = useState(false);
  const [treeControlMode, setTreeControlMode] = useState<IssueTreeControlMode>("pause");
  const [treeControlReason, setTreeControlReason] = useState("");
  const [treeControlCancelConfirmed, setTreeControlCancelConfirmed] = useState(false);
  const [reopenDialogOpen, setReopenDialogOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [optimisticComments, setOptimisticComments] = useState<OptimisticIssueComment[]>([]);
  const [locallyQueuedCommentRunIds, setLocallyQueuedCommentRunIds] = useState<Map<string, string>>(() => new Map());
  const [pendingCommentComposerFocusKey, setPendingCommentComposerFocusKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastMarkedReadIssueIdRef = useRef<string | null>(null);
  const lastScrollIssueIdRef = useRef<string | undefined>(undefined);
  const commentComposerRef = useRef<IssueChatComposerHandle | null>(null);
  const resolvedIssueDetailState = useMemo(
    () => readIssueDetailLocationState(issueId, location.state, location.search),
    [issueId, location.state, location.search],
  );
  const issueHeaderSeed = useMemo(
    () => readIssueDetailHeaderSeed(location.state) ?? readIssueDetailHeaderSeed(resolvedIssueDetailState),
    [location.state, resolvedIssueDetailState],
  );

  const { data: issue, isLoading, error } = useQuery({
    ...getIssueDetailQueryOptions(queryClient, issueId!, {
      placeholderIssue: issueHeaderSeed ? {
        id: issueHeaderSeed.id,
        identifier: issueHeaderSeed.identifier,
      } : null,
    }),
    enabled: !!issueId,
  });
  const resolvedCompanyId = issue?.companyId ?? selectedCompanyId;
  const externalObjectsState = useIssueExternalObjects(issue?.id ?? null);
  const commentComposerDisabledReason = useMemo(() => {
    if (!issue?.currentExecutionWorkspace || !isClosedIsolatedExecutionWorkspace(issue.currentExecutionWorkspace)) {
      return null;
    }
    return getClosedIsolatedExecutionWorkspaceMessage(issue.currentExecutionWorkspace);
  }, [issue?.currentExecutionWorkspace]);
  const [commentGroupContinuations, setCommentGroupContinuations] = useState<
    ReadonlyMap<string, BoardIssueCommentGroupContinuation>
  >(() => new Map());
  const loadingCommentGroupRootsRef = useRef(new Set<string>());
  const commentGroupIssueIdRef = useRef(issueId);
  commentGroupIssueIdRef.current = issueId;
  useEffect(() => {
    loadingCommentGroupRootsRef.current.clear();
    setCommentGroupContinuations(new Map());
  }, [issueId]);

  const {
    data: commentPages,
    isLoading: commentsLoading,
    isFetchingNextPage: commentsLoadingOlder,
    hasNextPage: hasOlderComments,
    fetchNextPage: fetchOlderComments,
    refetch: refetchComments,
  } = useInfiniteQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: ({ pageParam }) =>
      issuesApi.listComments(issueId!, {
        limit: ISSUE_COMMENT_PAGE_SIZE,
        entryLimit: ISSUE_COMMENT_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    enabled: !!issueId,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousDataForSameQueryTail<InfiniteData<BoardIssueCommentGroupPage, string | null>>(issueId ?? "pending"),
  });
  const comments = useMemo(
    () => flattenBoardIssueCommentGroupPages(commentPages?.pages, {
      companyId: resolvedCompanyId ?? "",
      issueId: issueId!,
    }, commentGroupContinuations),
    [commentGroupContinuations, commentPages?.pages, issueId, resolvedCompanyId],
  );
  const loadMoreCommentGroup = useCallback(async (rootCommentId: string) => {
    if (!issueId || loadingCommentGroupRootsRef.current.has(rootCommentId)) return;
    const initialGroup = commentPages?.pages
      .flatMap((page) => page.groups)
      .find((group) => group.root.id === rootCommentId);
    const current = commentGroupContinuations.get(rootCommentId);
    const cursor = current?.nextCursor ?? initialGroup?.entriesNextCursor ?? null;
    if (!cursor) return;

    loadingCommentGroupRootsRef.current.add(rootCommentId);
    setCommentGroupContinuations((previous) => {
      const next = new Map(previous);
      next.set(rootCommentId, {
        entries: previous.get(rootCommentId)?.entries ?? [],
        nextCursor: cursor,
        expanded: false,
        loading: true,
        error: null,
      });
      return next;
    });
    let accumulatedEntries = [...(current?.entries ?? [])];
    let nextCursor: string | null = cursor;
    try {
      const seenCursors = new Set<string>();
      while (nextCursor) {
        if (seenCursors.has(nextCursor)) {
          throw new Error("Comment-group cursor repeated");
        }
        seenCursors.add(nextCursor);
        const page = await issuesApi.getCommentThread(issueId, rootCommentId, {
          cursor: nextCursor,
          limit: ISSUE_COMMENT_PAGE_SIZE,
        });
        const entriesByIdentity = new Map<string, BoardIssueThreadEntry>();
        for (const entry of accumulatedEntries) {
          entriesByIdentity.set(`${entry.kind}:${entry.id}`, entry);
        }
        for (const entry of page.entries) {
          entriesByIdentity.set(`${entry.kind}:${entry.id}`, entry);
        }
        accumulatedEntries = [...entriesByIdentity.values()];
        nextCursor = page.nextCursor;
      }
      if (commentGroupIssueIdRef.current !== issueId) return;
      setCommentGroupContinuations((previous) => {
        const next = new Map(previous);
        next.set(rootCommentId, {
          entries: accumulatedEntries,
          nextCursor: null,
          expanded: true,
          loading: false,
          error: null,
        });
        return next;
      });
    } catch {
      if (commentGroupIssueIdRef.current !== issueId) return;
      setCommentGroupContinuations((previous) => {
        const next = new Map(previous);
        next.set(rootCommentId, {
          entries: accumulatedEntries,
          nextCursor,
          expanded: false,
          loading: false,
          error: "Couldn’t load replies.",
        });
        return next;
      });
    } finally {
      loadingCommentGroupRootsRef.current.delete(rootCommentId);
    }
  }, [commentGroupContinuations, commentPages?.pages, issueId]);
  const shouldPrefetchOlderComments = useMemo(
    () =>
      shouldAutoloadOlderIssueComments({
        activeDetailTab: detailTab,
        hasOlderComments: hasOlderComments ?? false,
        loadedCommentCount: comments.length,
        initialPageLoading: commentsLoading,
        olderPageLoading: commentsLoadingOlder,
        autoLoadLimit: ISSUE_COMMENT_AUTOLOAD_LIMIT,
      }),
    [comments.length, commentsLoading, commentsLoadingOlder, detailTab, hasOlderComments],
  );
  const { data: attachments, isLoading: attachmentsLoading } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId!),
    queryFn: () => issuesApi.listAttachments(issueId!),
    enabled: !!issueId,
    placeholderData: keepPreviousDataForSameQueryTail<IssueAttachment[]>(issueId ?? "pending"),
  });

  const { data: workProducts } = useQuery({
    queryKey: queryKeys.issues.workProducts(issueId!),
    queryFn: () => issuesApi.listWorkProducts(issueId!),
    enabled: !!issueId,
    placeholderData: keepPreviousDataForSameQueryTail<IssueWorkProduct[]>(issueId ?? "pending"),
  });

  const { data: activeIssueRunPage } = useQuery({
    queryKey: queryKeys.issues.runs(
      issueId!,
      ACTIVE_ISSUE_EXECUTION_RUN_STATUSES,
    ),
    queryFn: () => runsApi.listForIssue(issueId!, {
      status: ACTIVE_ISSUE_EXECUTION_RUN_STATUSES,
      limit: 200,
    }),
    enabled: !!issueId,
    refetchInterval: 3000,
    placeholderData:
      keepPreviousDataForSameQueryTail<IssueExecutionRunListPageRecord>(issueId ?? "pending"),
  });
  const activeIssueRuns = activeIssueRunPage?.items ?? [];
  const resolvedHasActiveRun =
    issue?.lifecycleStatus === "open" && activeIssueRuns.length > 0;
  const hasLiveRuns = activeIssueRuns.length > 0;
  useEffect(() => {
    if (!hasLiveRuns && locallyQueuedCommentRunIds.size > 0) {
      setLocallyQueuedCommentRunIds(new Map());
    }
  }, [hasLiveRuns, locallyQueuedCommentRunIds.size]);
  const sourceBreadcrumb = useMemo(
    () => readIssueDetailBreadcrumb(issueId, location.state, location.search) ?? { label: "Tasks", href: "/issues" },
    [issueId, location.state, location.search],
  );

  const { data: rawChildIssues = [], isLoading: childIssuesLoading } = useQuery({
    queryKey:
      issue?.id && resolvedCompanyId
        ? queryKeys.issues.listByDescendantRoot(resolvedCompanyId, issue.id)
        : ["issues", "parent", "pending"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { descendantOf: issue!.id, includeBlockedBy: true }),
    enabled: !!resolvedCompanyId && !!issue?.id,
    placeholderData: keepPreviousDataForSameQueryTail<Issue[]>(issue?.id ?? "pending"),
  });
  const {
    data: rawSiblingIssues = [],
    isLoading: siblingIssuesLoading,
    isError: siblingIssuesError,
  } = useQuery({
    queryKey:
      issue?.parentId && resolvedCompanyId
        ? queryKeys.issues.listByParent(resolvedCompanyId, issue.parentId)
        : ["issues", "siblings", "pending"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { parentId: issue!.parentId!, includeBlockedBy: true }),
    enabled: !!resolvedCompanyId && !!issue?.parentId,
  });
  const companyRunsQueryKey = resolvedCompanyId
    ? queryKeys.runs(resolvedCompanyId, {
        status: ACTIVE_ISSUE_EXECUTION_RUN_STATUSES,
      })
    : ["runs", "pending"] as const;
  const sharedCompanyRuns = useSharedPollingQuery<IssueExecutionRunListPageRecord>({
    companyId: resolvedCompanyId,
    resourceKey: "active-runs",
    queryKey: companyRunsQueryKey,
    enabled: !!resolvedCompanyId,
    refetchInterval: 3000,
    leaderOnly: true,
  });
  const { data: companyRunPage, dataUpdatedAt: companyRunsUpdatedAt } = useQuery({
    queryKey: companyRunsQueryKey,
    queryFn: () => runsApi.listForCompany(resolvedCompanyId!, {
      status: ACTIVE_ISSUE_EXECUTION_RUN_STATUSES,
      limit: 200,
    }),
    enabled: sharedCompanyRuns.enabled,
    refetchInterval: sharedCompanyRuns.refetchInterval,
    placeholderData:
      keepPreviousDataForSameQueryTail<IssueExecutionRunListPageRecord>(resolvedCompanyId ?? "pending"),
  });
  usePublishSharedQueryData(sharedCompanyRuns, companyRunPage, companyRunsUpdatedAt);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: issueOwnerCatalog } = useQuery({
    queryKey: queryKeys.agents.issueOwnerCatalog(selectedCompanyId!),
    queryFn: () => agentsApi.listInvokableIssueOwners(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  // Bounded pool of recently-updated issues to back the `@task` reference picker.
  // The picker filters this list client-side by identifier/title.
  const { data: mentionIssues = [] } = useQuery({
    queryKey: resolvedCompanyId ? queryKeys.issues.mentionPool(resolvedCompanyId) : ["issues", "mention-pool", "pending"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { limit: 100, sortField: "updated", sortDir: "desc" }),
    enabled: !!resolvedCompanyId,
    staleTime: 60_000,
    placeholderData: keepPreviousDataForSameQueryTail<Issue[]>(resolvedCompanyId ?? "pending"),
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!session?.user?.id,
    retry: false,
  });
  const canManageTreeControl = Boolean(
    selectedCompanyId
    && boardAccess?.companyIds?.includes(selectedCompanyId),
  );
  const { data: feedbackVotes } = useQuery({
    queryKey: queryKeys.issues.feedbackVotes(issueId!),
    queryFn: () => issuesApi.listFeedbackVotes(issueId!),
    enabled: !!issueId && !!currentUserId,
  });
  const { data: instanceGeneralSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    enabled: !!issueId,
    retry: false,
  });
  const { data: instanceExperimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: !!issueId,
    retry: false,
  });
  const keyboardShortcutsEnabled = instanceGeneralSettings?.keyboardShortcuts === true;
  // Experimental Cases: linkify `PAP-C7` chips in this issue's comment bodies.
  const casesChipsEnabled = instanceExperimentalSettings?.enableCases === true;
  const feedbackDataSharingPreference = instanceGeneralSettings?.feedbackDataSharingPreference ?? "prompt";
  const fileViewerEnabled = instanceExperimentalSettings?.enableExperimentalFileViewer === true;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const { slots: issuePluginDetailSlots } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "issue",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const issuePluginTabItems = useMemo(
    () => issuePluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}`,
      label: slot.displayName,
      slot,
    })),
    [issuePluginDetailSlots],
  );
  const activePluginTab = issuePluginTabItems.find((item) => item.value === detailTab) ?? null;
  const {
    data: treeControlPreview,
    isFetching: treeControlPreviewLoading,
    error: treeControlPreviewError,
    refetch: refetchTreeControlPreview,
  } = useQuery({
    queryKey: [
      "issues",
      "tree-control-preview",
      issueId ?? "pending",
      treeControlMode,
    ],
    queryFn: () =>
      issuesApi.previewTreeControl(issueId!, {
        mode: treeControlMode,
        releasePolicy: {
          strategy: "manual",
        },
      }),
    enabled: treeControlOpen && !!issueId && canManageTreeControl,
    staleTime: 0,
    retry: false,
  });
  const { data: treeControlState } = useQuery({
    queryKey: ["issues", "tree-control-state", issueId ?? "pending"],
    queryFn: () => issuesApi.getTreeControlState(issueId!),
    enabled: !!issueId && canManageTreeControl,
    retry: false,
  });
  const { data: activeRootPauseHolds = [] } = useQuery({
    queryKey: ["issues", "tree-holds", issueId ?? "pending", "active-pause-with-members"],
    queryFn: () =>
      issuesApi.listTreeHolds(issueId!, {
        status: "active",
        mode: "pause",
        includeMembers: true,
      }),
    enabled: !!issueId && treeControlState?.activePauseHold?.isRoot === true,
  });
  const { data: activeCancelHolds = [] } = useQuery({
    queryKey: ["issues", "tree-holds", issueId ?? "pending", "active-cancel"],
    queryFn: () =>
      issuesApi.listTreeHolds(issueId!, {
        status: "active",
        mode: "cancel",
      }),
    enabled: !!issueId && canManageTreeControl,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects: orderedProjects,
      members: companyMembers?.users,
      issues: mentionIssues,
    });
  }, [agents, companyMembers?.users, orderedProjects, mentionIssues]);

  const resolvedProject = useMemo(
    () => (issue?.projectId ? orderedProjects.find((project) => project.id === issue.projectId) ?? issue.project ?? null : null),
    [issue?.project, issue?.projectId, orderedProjects],
  );
  const childIssues = useMemo(
    () => {
      const descendants = issue?.id ? filterIssueDescendants(issue.id, rawChildIssues) : rawChildIssues;
      return [...descendants].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    },
    [issue?.id, rawChildIssues],
  );
  const liveIssueIds = useMemo(
    () => collectLiveIssueIds(companyRunPage?.items),
    [companyRunPage?.items],
  );
  const issuePanelKey = useMemo(
    () => buildIssuePropertiesPanelKey(issue ?? null, childIssues),
    [childIssues, issue],
  );
  const panelIssue = useMemo(
    () => issue ?? null,
    [issue?.id, issuePanelKey],
  );
  const panelChildIssues = useMemo(
    () => childIssues,
    [issuePanelKey],
  );
  const showRichSubIssuesSection = shouldRenderRichSubIssuesSection(childIssuesLoading, childIssues.length);
  const siblingNavigation = useMemo(
    () => issue && !childIssuesLoading && !siblingIssuesLoading && !siblingIssuesError
      ? buildIssueSiblingNavigation(issue, rawSiblingIssues, childIssues)
      : null,
    [childIssues, childIssuesLoading, issue, rawSiblingIssues, siblingIssuesError, siblingIssuesLoading],
  );
  const openNewSubIssue = useCallback(() => {
    if (!issue) return;
    openNewIssue(buildSubIssueDefaultsForViewer(issue));
  }, [
    issue,
    openNewIssue,
  ]);

  const isNamedUserCreator =
    issue?.creatorKind === "user/board" &&
    Boolean(currentUserId) &&
    issue.creatorUserId === currentUserId;
  const isSystemEscalationHumanOwner =
    issue?.creatorKind === "system" &&
    Boolean(issue.escalatedFromAffectedIssueId) &&
    (issue.ownerKind === "board" ||
      (issue.ownerKind === "user" &&
        Boolean(currentUserId) &&
        issue.ownerUserId === currentUserId));
  const isUserCreatorWithdrawalOwner =
    isNamedUserCreator &&
    issue?.ownerKind === "user" &&
    issue.ownerUserId === currentUserId &&
    issue.ownerAssignmentSource === "user_creator_withdrawal";

  const commentOwnerOptions = useMemo(() => {
    if (!isNamedUserCreator || issue?.ownerKind !== "agent") return [];

    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    const activeAgents = [...(issueOwnerCatalog ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    return options;
  }, [isNamedUserCreator, issue?.ownerKind, issueOwnerCatalog]);

  const currentOwnerValue = useMemo(
    () => issue?.ownerAgentId ? `agent:${issue.ownerAgentId}` : "",
    [issue?.ownerAgentId],
  );

  const suggestedOwnerValue = useMemo(
    () => currentOwnerValue,
    [currentOwnerValue],
  );

  const threadComments = useMemo(
    () => mergeIssueComments(comments ?? [], optimisticComments),
    [comments, optimisticComments],
  );
  const breadcrumbTitle = issue?.title ?? issueId ?? "Task";
  const breadcrumbStatus = issue?.boardPresentationStatus;
  const breadcrumbBlockerAttention = issue?.blockerAttention;
  // Stable identity for the breadcrumb status glyph. The glyph's shape/colour
  // depend on status (+ covered state), and its accessible label is derived
  // from the blocker counts — so the key signs over the full blockerAttention,
  // not just `state`, to avoid a stale label when counts change.
  const breadcrumbStatusKey = breadcrumbStatus
    ? `${breadcrumbStatus}|${JSON.stringify(breadcrumbBlockerAttention ?? null)}`
    : undefined;
  const breadcrumbStatusLeading = useMemo(
    () =>
      breadcrumbStatus ? (
        <StatusIcon status={breadcrumbStatus} size="lg" blockerAttention={breadcrumbBlockerAttention} />
      ) : undefined,
    // `breadcrumbStatusKey` is a complete signature of the inputs below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [breadcrumbStatusKey],
  );
  const issueCacheRefs = useMemo(() => {
    const refs = new Set<string>();
    if (issueId) refs.add(issueId);
    if (issue?.id) refs.add(issue.id);
    if (issue?.identifier) refs.add(issue.identifier);
    return [...refs];
  }, [issue?.id, issue?.identifier, issueId]);

  const invalidateIssueDetail = useCallback(() => {
    for (const ref of issueCacheRefs) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(ref) });
    }
  }, [issueCacheRefs, queryClient]);
  const invalidateIssueThreadLazily = useCallback(() => {
    for (const ref of issueCacheRefs) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref), refetchType: "inactive" });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(ref), refetchType: "inactive" });
    }
  }, [issueCacheRefs, queryClient]);

  const invalidateIssueRunState = useCallback(() => {
    for (const ref of issueCacheRefs) {
      queryClient.invalidateQueries({ queryKey: ["issues", "runs", ref] });
    }
  }, [issueCacheRefs, queryClient]);

  const invalidateIssueDocumentAnnotationState = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["issues", "document-annotations", issueId!] });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issueId!) });
  }, [issueId, queryClient]);

  const clearCommentHashIfCurrent = useCallback((commentId: string) => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== `#comment-${commentId}`) return;
    window.history.replaceState(null, "", `${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);

  const upsertCommentInCache = useCallback((_comment: unknown) => {
    for (const ref of issueCacheRefs) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(ref) });
    }
  }, [issueCacheRefs, queryClient]);

  const restoreQueuedCommentDraft = useCallback((body: string) => {
    commentComposerRef.current?.restoreDraft(body);
  }, []);

  const invalidateIssueCollections = useCallback(() => {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
    }
  }, [queryClient, selectedCompanyId]);
  const applyOptimisticIssueCacheUpdate = useCallback((refs: Iterable<string>, data: Record<string, unknown>) => {
    queryClient.setQueriesData<Issue>(
      { queryKey: ["issues", "detail"] },
      (cached) => (cached && matchesIssueRef(cached, refs) ? applyOptimisticIssueFieldUpdate(cached, data) : cached),
    );

    if (!selectedCompanyId) return;
    queryClient.setQueryData<Issue[] | undefined>(
      queryKeys.issues.list(selectedCompanyId),
      (cached) => applyOptimisticIssueFieldUpdateToCollection(cached, refs, data),
    );
  }, [queryClient, selectedCompanyId]);

  const mergeIssueResponseIntoCaches = useCallback((refs: Iterable<string>, nextIssue: Issue) => {
    queryClient.setQueriesData<Issue>(
      { queryKey: ["issues", "detail"] },
      (cached) => (cached && matchesIssueRef(cached, refs) ? { ...cached, ...nextIssue } : cached),
    );

    if (!selectedCompanyId) return;
    queryClient.setQueryData<Issue[] | undefined>(
      queryKeys.issues.list(selectedCompanyId),
      (cached) => cached?.map((item) => (matchesIssueRef(item, refs) ? { ...item, ...nextIssue } : item)),
    );
  }, [queryClient, selectedCompanyId]);

  const markIssueRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
  });

  const updateIssueTitle = useMutation({
    mutationFn: (title: string | null) =>
      issuesApi.updateTitle(issueId!, { title }),
    onMutate: async (title) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.detail(issueId!) });
      if (selectedCompanyId) {
        await queryClient.cancelQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      }

      const previousIssue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueId!));
      const issueRefs = new Set<string>([issueId!]);
      if (previousIssue?.id) issueRefs.add(previousIssue.id);
      if (previousIssue?.identifier) issueRefs.add(previousIssue.identifier);

      const previousDetailQueries = queryClient
        .getQueriesData<Issue>({ queryKey: ["issues", "detail"] })
        .filter(([, cachedIssue]) => cachedIssue && matchesIssueRef(cachedIssue, issueRefs));
      const previousList = selectedCompanyId
        ? queryClient.getQueryData<Issue[]>(queryKeys.issues.list(selectedCompanyId))
        : undefined;

      applyOptimisticIssueCacheUpdate(issueRefs, { title });
      return { previousDetailQueries, previousList, selectedCompanyId };
    },
    onSuccess: (nextIssue) => {
      const issueRefs = new Set<string>([issueId!, nextIssue.id]);
      if (nextIssue.identifier) issueRefs.add(nextIssue.identifier);
      mergeIssueResponseIntoCaches(issueRefs, nextIssue);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
      invalidateIssueCollections();
    },
    onError: (err, _variables, context) => {
      for (const [queryKey, previousIssue] of context?.previousDetailQueries ?? []) {
        queryClient.setQueryData(queryKey, previousIssue);
      }
      if (context?.selectedCompanyId) {
        queryClient.setQueryData(queryKeys.issues.list(context.selectedCompanyId), context.previousList);
      }
      pushToast({
        title: "Title update failed",
        body: err instanceof Error ? err.message : "Unable to save the task title",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      }
    },
  });

  const updateIssueExecutionPolicy = useMutation({
    mutationFn: (
      executionPolicy: NonNullable<Issue["executionPolicy"]> | null,
    ) =>
      issuesApi.updateExecutionPolicy(issueId!, { executionPolicy }),
    onSuccess: (nextIssue) => {
      const issueRefs = new Set<string>([issueId!, nextIssue.id]);
      if (nextIssue.identifier) issueRefs.add(nextIssue.identifier);
      mergeIssueResponseIntoCaches(issueRefs, nextIssue);
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activity(issueId!),
      });
      invalidateIssueCollections();
    },
    onError: (err) => {
      pushToast({
        title: "Execution policy update failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to save the execution policy",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.detail(issueId!),
      });
    },
  });

  const reassignIssue = useMutation({
    mutationFn: (ownerAgentId: string) =>
      issuesApi.creatorReassign(issueId!, {
        ownerAgentId,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: ({ issue: nextIssue }) => {
      const refs = new Set<string>([issueId!, nextIssue.id]);
      if (nextIssue.identifier) refs.add(nextIssue.identifier);
      mergeIssueResponseIntoCaches(refs, nextIssue);
      invalidateIssueDetail();
      invalidateIssueRunState();
      invalidateIssueCollections();
    },
    onError: (err) => {
      pushToast({
        title: "Reassignment failed",
        body: err instanceof Error ? err.message : "Unable to reassign this task",
        tone: "error",
      });
    },
  });

  const commitHumanOwnerStatus = useMutation({
    mutationFn: async (input: {
      status: "open" | "blocked" | "done" | "cancelled";
      message: string;
    }) =>
      issuesApi.commitOwnerFormUpdate({
        issueId: issueId!,
        message: input.message,
        status: input.status,
      }),
    onSuccess: (result) => {
      upsertCommentInCache(result.comment);
      invalidateIssueDetail();
      invalidateIssueRunState();
      invalidateIssueCollections();
    },
    onError: (err) => {
      pushToast({
        title: "Owner update failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to update this task",
        tone: "error",
      });
    },
  });

  const withdrawAndCancelIssue = useMutation({
    mutationFn: async () => {
      if (!issue) throw new Error("Task is still loading");
      let withdrawalIssue = issue;
      if (issue.ownerKind === "agent" && issue.ownerAgentId) {
        const assigned = await issuesApi.selfAssignForWithdrawal(issue.id, {
          idempotencyKey: crypto.randomUUID(),
        });
        withdrawalIssue = assigned.issue;
        mergeIssueResponseIntoCaches(
          new Set([issue.id, issue.identifier].filter(Boolean) as string[]),
          assigned.issue,
        );
      }
      if (
        withdrawalIssue.ownerKind !== "user" ||
        withdrawalIssue.ownerUserId !== currentUserId ||
        withdrawalIssue.ownerAssignmentSource !==
          "user_creator_withdrawal"
      ) {
        throw new Error(
          "Only the named creator can withdraw an agent-owned task",
        );
      }
      return issuesApi.commitOwnerFormUpdate({
        issueId: issue.id,
        message: "Cancelled by the named creator after withdrawal.",
        status: "cancelled",
      });
    },
    onSuccess: (result) => {
      upsertCommentInCache(result.comment);
      invalidateIssueDetail();
      invalidateIssueRunState();
      invalidateIssueCollections();
      pushToast({ title: "Task withdrawn and cancelled", tone: "success" });
    },
    onError: (err) => {
      invalidateIssueDetail();
      pushToast({
        title: "Withdrawal failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to withdraw this task",
        tone: "error",
      });
    },
  });

  const reopenIssue = useMutation({
    mutationFn: (reason: string) =>
      issuesApi.reopen(issueId!, {
        reason,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: ({ issue: nextIssue }) => {
      const refs = new Set<string>([issueId!, nextIssue.id]);
      if (nextIssue.identifier) refs.add(nextIssue.identifier);
      mergeIssueResponseIntoCaches(refs, nextIssue);
      setReopenDialogOpen(false);
      setReopenReason("");
      invalidateIssueDetail();
      invalidateIssueThreadLazily();
      invalidateIssueRunState();
      invalidateIssueCollections();
      pushToast({ title: "Task reopened", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Reopen failed",
        body: err instanceof Error ? err.message : "Unable to reopen this task",
        tone: "error",
      });
    },
  });
  const executeTreeControl = useMutation({
    mutationFn: async () => {
      if (treeControlMode === "resume") {
        const pauseHoldId = treeControlState?.activePauseHold?.holdId;
        if (!pauseHoldId) {
          throw new Error("No active subtree pause hold is available to resume.");
        }
        const releasedHold = await issuesApi.releaseTreeHold(issueId!, pauseHoldId, {
          reason: treeControlReason.trim() || null,
        });
        return { kind: "release" as const, hold: releasedHold };
      }
      const created = await issuesApi.createTreeHold(issueId!, {
        mode: treeControlMode,
        reason: treeControlReason.trim() || null,
        releasePolicy: {
          strategy: "manual",
          ...(treeControlMode === "pause" ? { note: treeControlScope === "leaf" ? "leaf_pause" : "full_pause" } : {}),
        },
      });
      return { kind: "create" as const, hold: created.hold, preview: created.preview };
    },
    onSuccess: async (result) => {
      const modeLabel = issueTreeControlLabel(result.hold.mode, treeControlScope);
      const cancelCount = result.preview?.totals.activeRuns ?? 0;
      pushToast({
        title: result.kind === "release"
          ? treeControlScope === "leaf" ? "Work resumed" : "Subtree resumed"
          : result.hold.mode === "pause"
            ? treeControlScope === "leaf" ? "Work paused" : "Subtree paused"
            : `${modeLabel} applied`,
        body: result.kind === "release"
          ? (result.hold.releaseReason?.trim() || (treeControlScope === "leaf" ? "Active task pause released." : "Active subtree pause released."))
          : result.hold.mode === "pause"
            ? treeControlScope === "leaf"
              ? `Work paused. ${cancelCount} run${cancelCount === 1 ? "" : "s"} cancelled.`
              : `Subtree paused. ${cancelCount} run${cancelCount === 1 ? "" : "s"} cancelled.`
            : result.hold.reason?.trim()
              ? result.hold.reason
              : "Subtree control applied.",
      });
      setTreeControlOpen(false);
      setTreeControlReason("");
      setTreeControlCancelConfirmed(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) }),
        queryClient.invalidateQueries({ queryKey: ["issues", "runs", issueId!] }),
        queryClient.invalidateQueries({ queryKey: ["issues", "tree-control-state", issueId ?? "pending"] }),
        queryClient.invalidateQueries({ queryKey: ["issues", "tree-holds", issueId ?? "pending"] }),
        queryClient.invalidateQueries({ queryKey: ["issues", "tree-control-preview", issueId ?? "pending"] }),
      ]);
      if (selectedCompanyId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) }),
          ...(issue?.id
            ? [
                queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByParent(selectedCompanyId, issue.id) }),
                queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByDescendantRoot(selectedCompanyId, issue.id) }),
              ]
            : []),
        ]);
      }
    },
    onError: (err) => {
      pushToast({
        title: "Unable to apply subtree control",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      });
    },
  });
  const handleIssuePropertiesUpdate = useCallback((data: Record<string, unknown>) => {
    const keys = Object.keys(data);
    if (
      keys.length === 1 &&
      keys[0] === "title" &&
      (typeof data.title === "string" || data.title === null)
    ) {
      updateIssueTitle.mutate(data.title);
      return;
    }
    if (
      keys.length === 1 &&
      keys[0] === "executionPolicy" &&
      (data.executionPolicy === null ||
        (typeof data.executionPolicy === "object" &&
          !Array.isArray(data.executionPolicy)))
    ) {
      updateIssueExecutionPolicy.mutate(
        data.executionPolicy as NonNullable<Issue["executionPolicy"]> | null,
      );
      return;
    }
    pushToast({
      title: "Property is read-only",
      body: "The board can edit title and execution-policy controls. Lifecycle changes belong to the owner runtime.",
      tone: "error",
    });
  }, [pushToast, updateIssueExecutionPolicy, updateIssueTitle]);

  const checkIssueMonitorNow = useMutation({
    mutationFn: () => issuesApi.checkMonitorNow(issueId!),
    onSuccess: () => {
      invalidateIssueDetail();
      invalidateIssueRunState();
      invalidateIssueCollections();
      pushToast({
        title: "Monitor check queued",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Monitor check failed",
        body: err instanceof Error ? err.message : "Unable to trigger the monitor right now",
        tone: "error",
      });
    },
  });

  const approvalDecision = useMutation({
    mutationFn: async ({ approvalId, action }: { approvalId: string; action: "approve" | "reject" }) => {
      if (action === "approve") {
        return approvalsApi.approve(approvalId);
      }
      return approvalsApi.reject(approvalId);
    },
    onMutate: ({ approvalId, action }) => {
      setPendingApprovalAction({ approvalId, action });
    },
    onSuccess: (_approval, variables) => {
      invalidateIssueDetail();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
      invalidateIssueCollections();
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(variables.approvalId) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(resolvedCompanyId) });
      }
      pushToast({
        title: variables.action === "approve" ? "Approval approved" : "Approval rejected",
        tone: "success",
      });
    },
    onError: (err, variables) => {
      pushToast({
        title: variables.action === "approve" ? "Approval failed" : "Rejection failed",
        body: err instanceof Error ? err.message : "Unable to update approval",
        tone: "error",
      });
    },
    onSettled: () => {
      setPendingApprovalAction(null);
    },
  });

  const addComment = useMutation({
    mutationFn: (input: {
      message: string;
      idempotencyKey: string;
      mention?: { targetAgentId: string; ownershipEpoch: number } | null;
      replyToCommentId?: string | null;
    }) => issuesApi.addComment(issueId!, input),
    onMutate: async ({ message, mention }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      const queuedComment = mention
        ? readIssueRunStateFromCache(queryClient, issueId!).interruptibleIssueRun
        : null;
      const optimisticComment = issue
        ? createOptimisticIssueComment({
            companyId: issue.companyId,
            issueId: issue.id,
            body: message,
            authorUserId: currentUserId,
            clientStatus: queuedComment ? "queued" : "pending",
            queueTargetRunId: queuedComment?.id ?? null,
          })
        : null;

      if (optimisticComment) {
        setOptimisticComments((current) => [...current, optimisticComment]);
      }
      return {
        optimisticCommentId: optimisticComment?.clientId ?? null,
        queuedCommentTargetRunId: queuedComment?.id ?? null,
      };
    },
    onSuccess: ({ comment }, variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      if (variables.mention && context?.queuedCommentTargetRunId) {
        setLocallyQueuedCommentRunIds((current) => {
          const next = new Map(current);
          next.set(comment.id, context.queuedCommentTargetRunId!);
          return next;
        });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.comments(issueId!),
      });
    },
    onError: (err, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      pushToast({
        title: "Comment failed",
        body: err instanceof Error ? err.message : "Unable to post comment",
        tone: "error",
      });
    },
    onSettled: (_result, _error, variables) => {
      invalidateIssueThreadLazily();
      if (variables.mention || variables.replyToCommentId) {
        invalidateIssueRunState();
      }
    },
  });

  const feedbackVoteMutation = useMutation({
    mutationFn: (variables: {
      targetType: "issue_comment" | "issue_document_revision";
      targetId: string;
      vote: "up" | "down";
      reason?: string;
      allowSharing?: boolean;
      sharingPreferenceAtSubmit: "allowed" | "not_allowed" | "prompt";
    }) =>
      issuesApi.upsertFeedbackVote(issueId!, {
        targetType: variables.targetType,
        targetId: variables.targetId,
        vote: variables.vote,
        ...(variables.reason ? { reason: variables.reason } : {}),
        ...(variables.allowSharing ? { allowSharing: true } : {}),
      }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.feedbackVotes(issueId!) });
      const previousVotes = queryClient.getQueryData<FeedbackVote[]>(
        queryKeys.issues.feedbackVotes(issueId!),
      );
      queryClient.setQueryData<FeedbackVote[]>(
        queryKeys.issues.feedbackVotes(issueId!),
        mergeOptimisticFeedbackVote(
          previousVotes,
          {
            issueId: issueId!,
            targetType: variables.targetType,
            targetId: variables.targetId,
            vote: variables.vote,
            reason: variables.reason,
          },
          currentUserId,
        ),
      );
      return { previousVotes };
    },
    onSuccess: (_savedVote, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.feedbackVotes(issueId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
      pushToast({
        title:
          variables.sharingPreferenceAtSubmit === "prompt"
            ? variables.allowSharing
              ? "Feedback saved. Future votes will share"
              : "Feedback saved. Future votes will stay local"
            : variables.allowSharing
              ? "Feedback saved and sharing enabled"
              : "Feedback saved",
        tone: "success",
      });
    },
    onError: (err, _variables, context) => {
      if (context?.previousVotes) {
        queryClient.setQueryData(queryKeys.issues.feedbackVotes(issueId!), context.previousVotes);
      }
      pushToast({
        title: "Failed to save feedback",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return issuesApi.uploadAttachment(selectedCompanyId, issueId!, file);
    },
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssueDetail();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const importMarkdownDocument = useMutation({
    mutationFn: async (file: File) => {
      const baseName = fileBaseName(file.name);
      const key = slugifyDocumentKey(baseName);
      const existing = (issue?.documentSummaries ?? []).find((doc) => doc.key === key) ?? null;
      const body = await file.text();
      const inferredTitle = titleizeFilename(baseName);
      const nextTitle = existing?.title ?? inferredTitle ?? null;
      return issuesApi.upsertDocument(issueId!, key, {
        title: key === "plan" ? null : nextTitle,
        format: "markdown",
        body,
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
    },
    onSuccess: () => {
      setAttachmentError(null);
      invalidateIssueDetail();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issueId!) });
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Document import failed");
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => issuesApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssueDetail();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const archiveFromInbox = useMutation({
    mutationFn: (id: string) => issuesApi.archiveFromInbox(id),
    onMutate: async (id) => {
      if (!selectedCompanyId) return { previousData: [] as InboxIssueCacheSnapshot };
      beginLocalInboxArchive(selectedCompanyId, id);
      await cancelInboxIssueQueries(queryClient, selectedCompanyId);
      const previousData = snapshotInboxIssueCaches(queryClient, selectedCompanyId);
      removeIssueFromInboxCaches(queryClient, selectedCompanyId, id);
      return { companyId: selectedCompanyId, previousData };
    },
    onSuccess: (_data, id) => {
      if (selectedCompanyId) {
        removeIssueFromInboxCaches(queryClient, selectedCompanyId, id);
      }
      invalidateIssueCollections();
      navigate(sourceBreadcrumb.href.startsWith("/inbox") ? sourceBreadcrumb.href : "/inbox", { replace: true });
      pushToast({ title: "Task archived from inbox", tone: "success" });
    },
    onError: (err, id, context) => {
      if (context?.companyId) clearLocalInboxArchive(context.companyId, id);
      if (context?.previousData) {
        restoreIssueToInboxCaches(queryClient, context.previousData, id);
      }
      pushToast({
        title: "Archive failed",
        body: err instanceof Error ? err.message : "Unable to archive this task from the inbox",
        tone: "error",
      });
    },
    onSettled: async (_data, error, id, context) => {
      if (!context?.companyId) return;
      if (!error) boundLocalInboxArchive(context.companyId, id);
      await invalidateInboxIssueQueries(queryClient, context.companyId);
      if (!error) {
        const presence = getIssuePresenceInActiveInboxCaches(queryClient, context.companyId, id);
        if (presence !== "unknown") confirmLocalInboxArchive(context.companyId, id);
      }
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      sourceBreadcrumb,
      {
        // The status glyph (leading) already conveys in-progress/live state;
        // no redundant 🔵 emoji prefix on the title.
        label: breadcrumbTitle,
        leading: breadcrumbStatusLeading,
        leadingKey: breadcrumbStatusKey,
      },
    ]);
  }, [
    breadcrumbTitle,
    hasLiveRuns,
    setBreadcrumbs,
    sourceBreadcrumb.href,
    sourceBreadcrumb.label,
    breadcrumbStatusLeading,
    breadcrumbStatusKey,
  ]);

  const isFromInbox = resolvedIssueDetailState?.issueDetailSource === "inbox";

  // Scroll to top on forward navigation (PUSH/REPLACE) so issue doesn't
  // inherit the inbox/issues-list scroll position on mobile.
  useEffect(() => {
    const previousIssueId = lastScrollIssueIdRef.current;
    lastScrollIssueIdRef.current = issueId;
    if (!shouldScrollIssueDetailToTopOnNavigation({ previousIssueId, nextIssueId: issueId, navigationType })) return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const main = document.getElementById("main-content");
    if (main) main.scrollTop = 0;
  }, [issueId, navigationType]);

  // Redirect to identifier-based URL if navigated via UUID
  useEffect(() => {
    const nextState = resolvedIssueDetailState ?? location.state;
    if (issue?.identifier && issueId !== issue.identifier) {
      rememberIssueDetailLocationState(issue.identifier, nextState, location.search);
      navigate(createIssueDetailPath(issue.identifier), {
        replace: true,
        state: nextState,
      });
      return;
    }
  }, [issue, issueId, navigate, location.state, location.search, resolvedIssueDetailState]);

  useEffect(() => {
    if (!issue?.id) return;
    if (lastMarkedReadIssueIdRef.current === issue.id) return;
    lastMarkedReadIssueIdRef.current = issue.id;
    markIssueRead.mutate(issue.id);
  }, [issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!panelIssue) {
      closePanel();
      return;
    }
    openPanel(
      <IssueProperties
        issue={panelIssue}
        childIssues={panelChildIssues}
        onAddSubIssue={openNewSubIssue}
        onUpdate={handleIssuePropertiesUpdate}
        hasActiveRun={resolvedHasActiveRun}
        externalObjects={externalObjectsState.isEnabled ? externalObjectsState.groups : undefined}
        externalObjectsLoading={externalObjectsState.isEnabled ? externalObjectsState.isLoading : undefined}
        externalObjectsError={externalObjectsState.isEnabled ? externalObjectsState.isError : undefined}
        onRetryExternalObjects={externalObjectsState.isEnabled ? externalObjectsState.refetch : undefined}
        onCheckMonitorNow={() => checkIssueMonitorNow.mutate()}
        checkingMonitorNow={checkIssueMonitorNow.isPending}
      />
    );
    return () => closePanel();
  }, [
    closePanel,
    handleIssuePropertiesUpdate,
    issuePanelKey,
    openNewSubIssue,
    openPanel,
    panelChildIssues,
    panelIssue,
    resolvedHasActiveRun,
    checkIssueMonitorNow.isPending,
    checkIssueMonitorNow.mutate,
    externalObjectsState.isEnabled,
    externalObjectsState.groups,
    externalObjectsState.isLoading,
    externalObjectsState.isError,
    externalObjectsState.refetch,
  ]);

  const goToInboxShortcutArmedRef = useRef(false);
  const goToInboxShortcutTimeoutRef = useRef<number | null>(null);
  const canQuickArchiveFromInbox =
    keyboardShortcutsEnabled &&
    !issue?.hiddenAt;

  useEffect(() => {
    if (!issue?.id || !canQuickArchiveFromInbox) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveInboxQuickArchiveKeyAction({
        armed: canQuickArchiveFromInbox,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });

      if (action !== "archive") return;

      event.preventDefault();
      if (!archiveFromInbox.isPending) {
        archiveFromInbox.mutate(issue.id);
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [archiveFromInbox, canQuickArchiveFromInbox, issue?.id]);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) {
      goToInboxShortcutArmedRef.current = false;
      if (goToInboxShortcutTimeoutRef.current !== null) {
        window.clearTimeout(goToInboxShortcutTimeoutRef.current);
        goToInboxShortcutTimeoutRef.current = null;
      }
      return;
    }

    const clearArmTimeout = () => {
      if (goToInboxShortcutTimeoutRef.current !== null) {
        window.clearTimeout(goToInboxShortcutTimeoutRef.current);
        goToInboxShortcutTimeoutRef.current = null;
      }
    };

    const disarm = () => {
      goToInboxShortcutArmedRef.current = false;
      clearArmTimeout();
    };

    const arm = () => {
      goToInboxShortcutArmedRef.current = true;
      clearArmTimeout();
      goToInboxShortcutTimeoutRef.current = window.setTimeout(() => {
        goToInboxShortcutArmedRef.current = false;
        goToInboxShortcutTimeoutRef.current = null;
      }, 1200);
    };

    const handlePointerDown = () => {
      disarm();
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== document.body) {
        disarm();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveIssueDetailGoKeyAction({
        armed: goToInboxShortcutArmedRef.current,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });

      if (action === "ignore") return;
      if (action === "arm") {
        arm();
        return;
      }

      disarm();
      if (action === "navigate_inbox") {
        event.preventDefault();
        event.stopPropagation();
        navigate(sourceBreadcrumb.href.startsWith("/inbox") ? sourceBreadcrumb.href : "/inbox");
        return;
      }
      if (action === "focus_comment") {
        event.preventDefault();
        event.stopPropagation();
        setDetailTab("chat");
        setPendingCommentComposerFocusKey((current) => current + 1);
      }
      if (action === "open_file_viewer") {
        if (!fileViewerEnabled) return;
        event.preventDefault();
        event.stopPropagation();
        setFileViewerPromptOpen(true);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      disarm();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [fileViewerEnabled, keyboardShortcutsEnabled, navigate, sourceBreadcrumb.href]);

  // Scroll + briefly highlight work-product / direct-attachment anchors so the
  // company Artifacts page (PAP-10359) can deep-link to a specific artifact in
  // its issue context. Retries while the section data loads in.
  useEffect(() => {
    const match = location.hash.match(/^#(work-product|attachment)-(.+)$/);
    if (!match) return;
    const targetId = `${match[1]}-${decodeURIComponent(match[2]!)}`;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryScroll = () => {
      if (cancelled) return;
      const element = document.getElementById(targetId);
      if (!element) {
        if (attempts < 30) {
          attempts += 1;
          timer = setTimeout(tryScroll, 100);
        }
        return;
      }
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.add("ring-2", "ring-primary/50", "transition-shadow");
      timer = setTimeout(() => element.classList.remove("ring-2", "ring-primary/50", "transition-shadow"), 3000);
    };
    tryScroll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [location.hash, workProducts, attachments]);

  useEffect(() => {
    if (pendingCommentComposerFocusKey === 0) return;
    if (detailTab !== "chat") return;
    commentComposerRef.current?.focus();
  }, [detailTab, pendingCommentComposerFocusKey]);

  useEffect(() => {
    if (!fileViewerEnabled) return;
    const handleOpenFileViewer = () => {
      setFileViewerPromptOpen(true);
    };
    window.addEventListener("paperclip:open-file-viewer", handleOpenFileViewer as EventListener);
    return () => {
      window.removeEventListener(
        "paperclip:open-file-viewer",
        handleOpenFileViewer as EventListener,
      );
    };
  }, [fileViewerEnabled]);

  const promotedOutputAttachmentIds = useMemo(() => getPromotedOutputAttachmentIds(workProducts), [workProducts]);
  const attachmentList = useMemo(
    () => (attachments ?? []).filter((attachment) => !promotedOutputAttachmentIds.has(attachment.id)),
    [attachments, promotedOutputAttachmentIds],
  );
  const mediaGalleryItems = useMemo<GalleryMediaItem[]>(() => {
    const items: GalleryMediaItem[] = [];
    const seen = new Set<string>();

    const mark = (attachmentId: string | null | undefined, contentPath: string) => {
      if (attachmentId) seen.add(`attachment:${attachmentId}`);
      seen.add(`content:${contentPath}`);
    };

    const hasSeen = (attachmentId: string | null | undefined, contentPath: string) => (
      Boolean(attachmentId && seen.has(`attachment:${attachmentId}`)) ||
      seen.has(`content:${contentPath}`)
    );

    for (const attachment of attachments ?? []) {
      if (!isImageAttachment(attachment) && !isVideoAttachment(attachment)) continue;
      items.push(attachment);
      mark(attachment.id, attachment.contentPath);
    }

    for (const item of getIssueOutputs(workProducts).items) {
      const meta = item.metadata;
      if (!meta) continue;
      const isMedia = isImageContentType(meta.contentType) ||
        isVideoLikeOutput(meta.contentType, meta.originalFilename);
      if (!isMedia || hasSeen(meta.attachmentId, meta.contentPath)) continue;
      items.push({
        id: `work-product-${item.id}`,
        contentPath: meta.contentPath,
        openPath: meta.openPath,
        downloadPath: meta.downloadPath,
        contentType: meta.contentType,
        originalFilename: meta.originalFilename ?? item.title,
      });
      mark(meta.attachmentId, meta.contentPath);
    }

    return items;
  }, [attachments, workProducts]);

  const handleChatImageClick = useCallback(
    (src: string) => {
      // Try exact contentPath match first
      let idx = mediaGalleryItems.findIndex((a) => a.contentPath === src);
      if (idx < 0) {
        // Try matching by asset ID extracted from /api/assets/{assetId}/content URLs
        const assetMatch = src.match(/\/api\/assets\/([^/]+)\/content/);
        if (assetMatch) {
          idx = mediaGalleryItems.findIndex((a) => "assetId" in a && a.assetId === assetMatch[1]);
        }
      }
      if (idx >= 0) {
        setGalleryIndex(idx);
        setGalleryOpen(true);
      } else {
        // Image not in attachment list — open in new tab
        window.open(src, "_blank");
      }
    },
    [mediaGalleryItems],
  );

  const copyIssueToClipboard = async () => {
    if (!issue) return;
    const decodeEntities = (text: string) => {
      const el = document.createElement("textarea");
      el.innerHTML = text;
      return el.value;
    };
    const title = decodeEntities(issueDisplayTitle(issue));
    const body = decodeEntities(issue.request ?? "");
    const md = `# ${issue.identifier}: ${title}\n\n${body}`.trimEnd();
    try {
      await copyTextToClipboard(md);
      setCopied(true);
      pushToast({ title: "Copied to clipboard", tone: "success" });
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      pushToast({
        title: "Copy failed",
        body: error instanceof Error ? error.message : "Unable to copy task markdown",
        tone: "error",
      });
    }
  };

  // Gmail-style mobile toolbar when viewing an issue from inbox.
  // Callbacks are stored in a ref so the effect deps stay stable and
  // don't trigger an infinite render loop (useMutation results and
  // non-memoized functions change identity every render).
  const inboxToolbarCallbacksRef = useRef({
    onArchive: () => {
      if (!archiveFromInbox.isPending && issue?.id) archiveFromInbox.mutate(issue.id);
    },
    onCopy: () => copyIssueToClipboard(),
    onProperties: () => setMobilePropsOpen(true),
  });
  inboxToolbarCallbacksRef.current = {
    onArchive: () => {
      if (!archiveFromInbox.isPending && issue?.id) archiveFromInbox.mutate(issue.id);
    },
    onCopy: () => copyIssueToClipboard(),
    onProperties: () => setMobilePropsOpen(true),
  };

  const backHref = sourceBreadcrumb.href ?? "/inbox";
  const showInboxToolbar = isMobile && isFromInbox;
  const archivePending = archiveFromInbox.isPending;
  const issueHidden = !!issue?.hiddenAt;
  const canArchiveFromInbox = isFromInbox && !!issue?.id && !issueHidden;

  useEffect(() => {
    if (!showInboxToolbar) {
      setMobileToolbar(null);
      return;
    }

    setMobileToolbar(
      <InboxMobileToolbar
        backHref={backHref}
        issueId={issue?.id}
        issueHidden={issueHidden}
        archivePending={archivePending}
        onArchive={() => inboxToolbarCallbacksRef.current.onArchive()}
        onCopy={() => inboxToolbarCallbacksRef.current.onCopy()}
        onProperties={() => inboxToolbarCallbacksRef.current.onProperties()}
      />,
    );

    return () => setMobileToolbar(null);
  }, [showInboxToolbar, backHref, issue?.id, issueHidden, archivePending, setMobileToolbar]);

  const attachmentsInitialLoading = attachmentsLoading && attachments === undefined;
  const loadOlderComments = useCallback(() => {
    void fetchOlderComments();
  }, [fetchOlderComments]);
  const refetchLatestComments = useCallback(async () => {
    // Refetch page 0 first so comments that arrived after initial load are
    // visible, then load every remaining older page. The chat thread is
    // paginated and virtualized, so "latest" must be resolved against the
    // complete comment set rather than the current loaded window.
    const refreshed = await refetchComments();
    const pages = [...(refreshed.data?.pages ?? [])];
    const pageParams = [
      ...((refreshed.data?.pageParams as Array<string | null> | undefined) ?? []),
    ];
    let cursor = pages.at(-1)?.nextCursor ?? null;
    const seen = new Set<string>();
    while (
      cursor &&
      !seen.has(cursor) &&
      seen.size < JUMP_TO_LATEST_MAX_COMMENT_PAGES
    ) {
      seen.add(cursor);
      const page = await issuesApi.listComments(issueId!, {
        cursor,
        limit: ISSUE_COMMENT_PAGE_SIZE,
        entryLimit: ISSUE_COMMENT_PAGE_SIZE,
      });
      pages.push(page);
      pageParams.push(cursor);
      cursor = page.nextCursor;
    }
    queryClient.setQueryData<InfiniteData<BoardIssueCommentGroupPage, string | null>>(
      queryKeys.issues.comments(issueId!),
      { pages, pageParams },
    );
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => resolve());
    });
  }, [issueId, queryClient, refetchComments]);
  useEffect(() => {
    if (!shouldPrefetchOlderComments) return;
    void fetchOlderComments();
  }, [fetchOlderComments, shouldPrefetchOlderComments]);
  const handleCommentVote = useCallback(async (commentId: string, vote: "up" | "down", options?: { allowSharing?: boolean; reason?: string }) => {
    await feedbackVoteMutation.mutateAsync({
      targetType: "issue_comment",
      targetId: commentId,
      vote,
      reason: options?.reason,
      allowSharing: options?.allowSharing,
      sharingPreferenceAtSubmit: feedbackDataSharingPreference,
    });
  }, [feedbackDataSharingPreference, feedbackVoteMutation]);
  const handleChatAdd = useCallback(async (
    body: string,
    ownerChange?: CommentOwnerChange,
    mentionAgentId?: string,
    replyToCommentId?: string,
  ) => {
    let commentTarget = issue;
    if (ownerChange) {
      const result = await reassignIssue.mutateAsync(ownerChange.ownerAgentId);
      commentTarget = result.issue;
    }
    if (isUserCreatorWithdrawalOwner) {
      throw new Error(
        "A withdrawn task accepts only the creator's cancellation",
      );
    }
    if (isNamedUserCreator && !replyToCommentId) {
      const result = await issuesApi.commitCreatorFormUpdate({
        issueId: issueId!,
        message: body,
      });
      upsertCommentInCache(result.comment);
      invalidateIssueDetail();
      invalidateIssueRunState();
      invalidateIssueCollections();
      return;
    }
    if (isSystemEscalationHumanOwner && !replyToCommentId) {
      const result = await issuesApi.commitOwnerFormUpdate({
        issueId: issueId!,
        message: body,
      });
      upsertCommentInCache(result.comment);
      invalidateIssueDetail();
      invalidateIssueCollections();
      return;
    }
    const mention =
      mentionAgentId &&
      commentTarget?.ownerAgentId === mentionAgentId &&
      typeof commentTarget.ownershipEpoch === "number" &&
      Number.isInteger(commentTarget.ownershipEpoch) &&
      commentTarget.ownershipEpoch > 0
        ? {
            targetAgentId: mentionAgentId,
            ownershipEpoch: commentTarget.ownershipEpoch,
          }
        : null;
    await addComment.mutateAsync({
      message: body,
      idempotencyKey: crypto.randomUUID(),
      mention: replyToCommentId ? null : mention,
      replyToCommentId: replyToCommentId ?? null,
    });
  }, [
    addComment,
    invalidateIssueCollections,
    invalidateIssueDetail,
    invalidateIssueRunState,
    isNamedUserCreator,
    isSystemEscalationHumanOwner,
    isUserCreatorWithdrawalOwner,
    issue,
    issueId,
    reassignIssue,
    upsertCommentInCache,
  ]);
  const handleCommentImageUpload = useCallback(async (file: File) => {
    const attachment = await uploadAttachment.mutateAsync(file);
    return attachment.contentPath;
  }, [uploadAttachment]);
  const handleCommentAttachImage = useCallback(async (file: File) => {
    return uploadAttachment.mutateAsync(file);
  }, [uploadAttachment]);
  const treePreviewAffectedIssues = useMemo(
    () => (treeControlPreview?.issues ?? []).filter((candidate) => !candidate.skipped),
    [treeControlPreview],
  );
  // "What this affects" buckets for the pause/hold dialog (design surface 4).
  const pauseAffectsSummary = useMemo(
    () => computePauseAffectsSummary(treeControlPreview?.issues ?? []),
    [treeControlPreview],
  );
  const treePreviewDisplayIssues = useMemo(
    () => {
      const previewIssues = treeControlPreview?.issues ?? [];
      if (treeControlMode !== "pause") {
        return previewIssues.filter((candidate) => !candidate.skipped);
      }
      return previewIssues.filter((candidate) => !candidate.skipped || candidate.skipReason === "terminal_status");
    },
    [treeControlMode, treeControlPreview],
  );
  const activePauseHold = treeControlState?.activePauseHold ?? null;
  const activeRootPauseHoldsForDisplay = useMemo(
    () => activePauseHold?.isRoot === true ? activeRootPauseHolds : [],
    [activePauseHold?.isRoot, activeRootPauseHolds],
  );
  const heldIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const hold of activeRootPauseHoldsForDisplay) {
      for (const member of hold.members ?? []) {
        if (member.skipped) continue;
        ids.add(member.issueId);
      }
    }
    return ids;
  }, [activeRootPauseHoldsForDisplay]);
  const mutedChildIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const child of childIssues) {
      if (heldIssueIds.has(child.id)) ids.add(child.id);
    }
    return ids;
  }, [childIssues, heldIssueIds]);
  const childPauseBadgeById = useMemo(() => {
    const badges = new Map<string, string>();
    for (const child of childIssues) {
      if (!heldIssueIds.has(child.id)) continue;
      badges.set(child.id, "Paused");
    }
    return badges;
  }, [childIssues, heldIssueIds]);
  const activePauseHoldRoot = useMemo(() => {
    if (!activePauseHold) return null;
    if (activePauseHold.rootIssueId === issue?.id) return issue ?? null;
    return issue?.ancestors?.find((ancestor) => ancestor.id === activePauseHold.rootIssueId) ?? null;
  }, [activePauseHold, issue]);
  const activeRootPauseHold = useMemo(
    () => activeRootPauseHoldsForDisplay.find((hold) => hold.id === activePauseHold?.holdId) ?? null,
    [activePauseHold?.holdId, activeRootPauseHoldsForDisplay],
  );

  if (isLoading) return <IssueDetailLoadingState headerSeed={issueHeaderSeed} />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!issue) return null;

  // Ancestors are returned oldest-first from the server (root at end, immediate parent at start)
  const ancestors = issue.ancestors ?? [];
  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const files = evt.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleAttachmentDrop = async (evt: DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    setAttachmentDragActive(false);
    const files = evt.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
  };

  const hasAttachments = attachmentList.length > 0;
  const treePreviewWarnings = treeControlPreview?.warnings ?? [];
  const heldDescendantCount = activeRootPauseHold?.members?.filter((member) => member.depth > 0 && !member.skipped).length
    ?? Math.max(heldIssueIds.size - 1, 0);
  const canShowSubtreeControls = canManageTreeControl && childIssues.length > 0;
  const canResumeSubtree = canShowSubtreeControls && activePauseHold?.isRoot === true;
  const canRestoreSubtree = canShowSubtreeControls && activeCancelHolds.length > 0;
  const isTerminalIssue = issue.lifecycleStatus === "done" || issue.lifecycleStatus === "cancelled";
  const canPauseLeafWork = canManageTreeControl && childIssues.length === 0 && !activePauseHold && !isTerminalIssue;
  const canResumeLeafWork = canManageTreeControl && childIssues.length === 0 && activePauseHold?.isRoot === true;
  const treeControlScope: "leaf" | "subtree" = childIssues.length === 0 ? "leaf" : "subtree";
  const previewAffectedIssueCount = treePreviewAffectedIssues.length;
  const treeControlPrimaryButtonLabel =
    treeControlMode === "pause"
      ? treeControlScope === "leaf"
        ? "Pause work"
        : "Pause and stop work"
      : treeControlMode === "cancel"
        ? `Cancel ${previewAffectedIssueCount} tasks`
      : treeControlMode === "restore"
          ? `Restore ${previewAffectedIssueCount} tasks`
          : treeControlScope === "leaf"
            ? "Resume work"
            : "Resume subtree";
  const pausedComposerHint = activePauseHold
    ? (
      issue.ownerAgentId
        ? `Use @ to mention ${agentMap.get(issue.ownerAgentId)?.name ?? "the owner"} if you want to queue triage while the subtree remains paused. Ordinary comments do not dispatch.`
        : "Choose an agent owner or use @ to mention an eligible agent. Ordinary comments do not dispatch."
    )
    : null;
  const composerHint = pausedComposerHint;
  const humanLifecycleFormControls =
    !isTerminalIssue &&
    ((isNamedUserCreator &&
      (issue.ownerKind === "agent" ||
        isUserCreatorWithdrawalOwner)) ||
      isSystemEscalationHumanOwner) ? (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
        <span className="mr-auto text-xs text-muted-foreground">
          {isSystemEscalationHumanOwner
            ? "Human escalation owner controls"
            : isUserCreatorWithdrawalOwner
              ? "Creator withdrawal is awaiting cancellation"
              : "Named creator withdrawal control"}
        </span>
        {isSystemEscalationHumanOwner ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={commitHumanOwnerStatus.isPending}
              onClick={() =>
                commitHumanOwnerStatus.mutate(
                  issue.lifecycleStatus === "blocked"
                    ? {
                        status: "open",
                        message: "Reopened by the human escalation owner.",
                      }
                    : {
                        status: "blocked",
                        message: "Blocked by the human escalation owner.",
                      },
                )
              }
            >
              {issue.lifecycleStatus === "blocked" ? "Reopen" : "Block"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={commitHumanOwnerStatus.isPending}
              onClick={() =>
                commitHumanOwnerStatus.mutate({
                  status: "done",
                  message: "Resolved by the human escalation owner.",
                })
              }
            >
              Resolve
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={commitHumanOwnerStatus.isPending}
              onClick={() =>
                commitHumanOwnerStatus.mutate({
                  status: "cancelled",
                  message: "Cancelled by the human escalation owner.",
                })
              }
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={withdrawAndCancelIssue.isPending}
            onClick={() => withdrawAndCancelIssue.mutate()}
          >
            {isUserCreatorWithdrawalOwner
              ? "Finish cancellation"
              : "Withdraw and cancel"}
          </Button>
        )}
      </div>
    ) : null;
  const canApplyTreeControl =
    Boolean(treeControlPreview)
    && !treeControlPreviewLoading
    && (treeControlMode !== "cancel" || treeControlCancelConfirmed);
  const attachmentUploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        aria-label="Upload issue attachments"
        className="hidden"
        onChange={handleFilePicked}
        multiple
      />
      {uploadAttachment.isPending || importMarkdownDocument.isPending ? (
        <span className="sr-only" role="status">
          Uploading attachment.
        </span>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadAttachment.isPending || importMarkdownDocument.isPending}
        className={cn(
          "shadow-none",
          attachmentDragActive && "border-primary bg-primary/5",
        )}
      >
        <Paperclip className="h-3.5 w-3.5 mr-1.5" />
        {uploadAttachment.isPending || importMarkdownDocument.isPending ? "Uploading..." : (
          <>
            <span className="hidden sm:inline">Upload attachment</span>
            <span className="sm:hidden">Upload</span>
          </>
        )}
      </Button>
    </>
  );

  return (
    <FileViewerProvider issueId={issue.id} enabled={fileViewerEnabled}>
    <div className="max-w-3xl space-y-6">
      {/* Parent chain breadcrumb */}
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <Link
                to={createIssueDetailPath(ancestor.identifier ?? ancestor.id)}
                state={resolvedIssueDetailState ?? location.state}
                onClickCapture={() =>
                  rememberIssueDetailLocationState(
                    ancestor.identifier ?? ancestor.id,
                    resolvedIssueDetailState ?? location.state,
                    location.search,
                  )}
                className="hover:text-foreground transition-colors truncate max-w-(--sz-200px)"
                title={issueDisplayTitle(ancestor)}
              >
                {issueDisplayTitle(ancestor)}
              </Link>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="text-foreground/60 truncate max-w-(--sz-200px)">{issueDisplayTitle(issue)}</span>
        </nav>
      )}

      {issue.hiddenAt && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <EyeOff className="h-4 w-4 shrink-0" />
          This task is hidden
        </div>
      )}
      {activePauseHold && (
        <div className="rounded-md border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          {activePauseHold.isRoot ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {childIssues.length === 0 ? "Paused by board." : "Subtree pause is active."}
                </span>
                <span className="text-xs text-amber-900/80 dark:text-amber-100/80">
                  {childIssues.length === 0
                    ? "Task execution is held until resume. Only an explicit @mention can queue owner triage."
                    : "Root and descendant execution is held until resume. Only explicit @mentions can queue owner triage."}
                </span>
              </div>
              <div className="text-xs text-amber-900/80 dark:text-amber-100/80">
                {childIssues.length === 0
                  ? "1 task held"
                  : `${heldDescendantCount} descendant${heldDescendantCount === 1 ? "" : "s"} held`}
                {activeRootPauseHold?.createdAt ? ` · started ${relativeTime(activeRootPauseHold.createdAt)}` : ""}
              </div>
              {canShowSubtreeControls || canResumeLeafWork ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setTreeControlMode("resume");
                      setTreeControlOpen(true);
                    }}
                  >
                    {childIssues.length === 0 ? "Resume work" : "Resume subtree"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setTreeControlMode("resume");
                      setTreeControlOpen(true);
                    }}
                  >
                    View affected ({childIssues.length === 0 ? 1 : heldDescendantCount})
                  </Button>
                  {canShowSubtreeControls ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        setTreeControlMode("cancel");
                        setTreeControlCancelConfirmed(false);
                        setTreeControlOpen(true);
                      }}
                    >
                      Cancel subtree...
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-xs">
              This task is paused by ancestor{" "}
              {activePauseHoldRoot?.identifier ? (
                <Link to={createIssueDetailPath(activePauseHoldRoot.identifier)} className="underline">
                  {activePauseHoldRoot.identifier}
                </Link>
              ) : (
                activePauseHold.rootIssueId.slice(0, 8)
              )}
              . Resume from the root task to deliver deferred work.
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <StatusIcon
            status={issue.boardPresentationStatus}
            size="lg"
            blockerAttention={issue.blockerAttention}
          />
          <PriorityIcon priority={issue.priority} />
          <span className="text-sm font-mono text-muted-foreground shrink-0">{issue.identifier ?? issue.id.slice(0, 8)}</span>
          {(issue.lifecycleStatus === "done" || issue.lifecycleStatus === "cancelled") ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReopenDialogOpen(true)}
            >
              Reopen
            </Button>
          ) : null}

          {hasLiveRuns && (
            <Badge variant="outline" className={cn("gap-1.5 text-(length:--text-nano)", liveBlueBadge)}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
              </span>
              Live
            </Badge>
          )}

          {issue.originKind === "routine_execution" && issue.originId && (
            <Link
              to={`/routines/${issue.originId}`}
              className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-(length:--text-nano) font-medium text-violet-600 dark:text-violet-400 shrink-0 hover:bg-violet-500/20 transition-colors"
              title={`Routine execution from routine ${issue.originId}`}
            >
              <Repeat className="h-3 w-3" />
              Routine
            </Link>
          )}

          {issue.workMode === "ask" || issue.workMode === "planning" ? (() => {
            const workModeMeta = workModeMetaFor(issue.workMode);
            const WorkModeIcon = workModeMeta.icon;
            return (
              <Badge variant="outline"
                className={cn("text-(length:--text-nano)", workModeMeta.classes.badge)}
                title={`This task is in ${workModeMeta.label.toLowerCase()}.`}
              >
                <WorkModeIcon className="h-3 w-3" aria-hidden />
                {workModeMeta.label}
              </Badge>
            );
          })() : null}

          {hasAssignedBacklogBlocker(issue.blockedBy) ? (
            <Badge variant="outline"
              data-testid="issue-detail-parked-blocker"
              className="border-amber-500/60 bg-amber-500/15 text-(length:--text-nano) text-amber-700 dark:text-amber-300"
              title="Blocked by parked work — at least one owned blocker is in backlog and will not dispatch its owner."
            >
              <Flag className="h-3 w-3" />
              Blocked by parked work
            </Badge>
          ) : null}

          {issue.projectId ? (
            <Link
              to={`/projects/${issue.projectId}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
            >
              <Hexagon className="h-3 w-3 shrink-0" />
              <span className="truncate">{resolvedProject?.name ?? issue.project?.name ?? issue.projectId.slice(0, 8)}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
              <Hexagon className="h-3 w-3 shrink-0" />
              No project
            </span>
          )}

          <IssueAttributionByline
            issue={issue}
            agentMap={agentMap}
            userProfileMap={userProfileMap}
            userLabelMap={userLabelMap}
          />

          {(issue.labels ?? []).length > 0 && (
            <div className="hidden sm:flex items-center gap-1">
              {(issue.labels ?? []).slice(0, 4).map((label) => (
                <Badge variant="outline"
                  key={label.id}
                  className="text-(length:--text-nano)"
                  style={{
                    borderColor: label.color,
                    color: pickTextColorForPillBg(label.color, 0.12),
                    backgroundColor: `${label.color}1f`,
                  }}
                >
                  {label.name}
                </Badge>
              ))}
              {(issue.labels ?? []).length > 4 && (
                <span className="text-(length:--text-nano) text-muted-foreground">+{(issue.labels ?? []).length - 4}</span>
              )}
            </div>
          )}

          {!(isMobile && isFromInbox) && (
            <div className="ml-auto flex items-center gap-0.5 md:hidden shrink-0">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={copyIssueToClipboard}
                title="Copy task as markdown"
              >
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setMobilePropsOpen(true)}
                title="Properties"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </Button>
            </div>
          )}

          <div className="hidden md:flex items-center md:ml-auto shrink-0">
            {canArchiveFromInbox && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  if (!archivePending && issue?.id) archiveFromInbox.mutate(issue.id);
                }}
                disabled={archivePending}
                title="Archive from inbox"
                aria-label="Archive from inbox"
              >
                <Archive className="h-4 w-4" />
              </Button>
            )}
            {fileViewerEnabled ? (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setFileViewerPromptOpen(true)}
                title="Open file... (g f)"
                aria-label="Open file in this issue"
              >
                <FileCode2 className="h-4 w-4" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy task as markdown"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "shrink-0 transition-opacity duration-200",
                panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
              )}
              onClick={() => setPanelVisible(true)}
              title="Show properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>

            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  aria-label="More task actions"
                  title="More task actions"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setMoreOpen(true);
                    }
                  }}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
            <PopoverContent className="w-52 p-1" align="end">
              {canPauseLeafWork ? (
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                  onClick={() => {
                    setTreeControlMode("pause");
                    setTreeControlCancelConfirmed(false);
                    setTreeControlOpen(true);
                    setMoreOpen(false);
                  }}
                >
                  <PauseCircle className="h-3 w-3" />
                  Pause work...
                </button>
              ) : null}
              {canResumeLeafWork ? (
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                  onClick={() => {
                    setTreeControlMode("resume");
                    setTreeControlOpen(true);
                    setMoreOpen(false);
                  }}
                >
                  <PlayCircle className="h-3 w-3" />
                  Resume work
                </button>
              ) : null}
              {canShowSubtreeControls ? (
                <>
                  <button
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                    onClick={() => {
                      setTreeControlMode("pause");
                      setTreeControlCancelConfirmed(false);
                      setTreeControlOpen(true);
                      setMoreOpen(false);
                    }}
                  >
                    <PauseCircle className="h-3 w-3" />
                    Pause subtree...
                  </button>
                  {canResumeSubtree ? (
                    <button
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                      onClick={() => {
                        setTreeControlMode("resume");
                        setTreeControlOpen(true);
                        setMoreOpen(false);
                      }}
                    >
                      <PlayCircle className="h-3 w-3" />
                      Resume subtree
                    </button>
                  ) : null}
                  <button
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                    onClick={() => {
                      setTreeControlMode("cancel");
                      setTreeControlCancelConfirmed(false);
                      setTreeControlOpen(true);
                      setMoreOpen(false);
                    }}
                  >
                    <XCircle className="h-3 w-3" />
                    Cancel subtree...
                  </button>
                  {canRestoreSubtree ? (
                    <button
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                      onClick={() => {
                        setTreeControlMode("restore");
                        setTreeControlCancelConfirmed(false);
                        setTreeControlOpen(true);
                        setMoreOpen(false);
                      }}
                    >
                      <Repeat className="h-3 w-3" />
                      Restore subtree...
                    </button>
                  ) : null}
                </>
              ) : null}
            </PopoverContent>
            </Popover>
          </div>
        </div>

        <InlineEditor
          value={issue.title ?? ""}
          onSave={(title) => updateIssueTitle.mutateAsync(title || null)}
          as="h2"
          className="text-xl font-bold"
          placeholder="Add a title..."
          nullable
        />

        <IssueMonitorBanner
          issue={issue}
          onCheckNow={() => checkIssueMonitorNow.mutate()}
          checkingNow={checkIssueMonitorNow.isPending}
        />

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Immutable request
          </h3>
          {issue.request ? (
            <MarkdownBody
              className="text-sm leading-7 text-foreground"
              externalReferences={
                externalObjectsState.isEnabled
                  ? externalObjectsState.markdownReferences
                  : undefined
              }
            >
              {issue.request}
            </MarkdownBody>
          ) : (
            <p className="text-sm text-muted-foreground">
              Canonical request unavailable for this historical task.
            </p>
          )}
        </section>
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Issue context access
          </h3>
          <IssueContextAccessMaskMatrix
            value={issue.contextAccessMask ?? null}
            readOnly
          />
        </section>
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <PluginSlotOutlet
        slotTypes={["issueDetailView"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="space-y-3"
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />

      {showRichSubIssuesSection ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">Sub-tasks</h3>
          </div>
          <IssuesList
            issues={childIssues}
            isLoading={childIssuesLoading}
            agents={agents}
            projects={projects}
            liveIssueIds={liveIssueIds}
            mutedIssueIds={mutedChildIssueIds}
            issueBadgeById={childPauseBadgeById}
            projectId={issue.projectId ?? undefined}
            viewStateKey={`paperclip:issue-detail:${issue.id}:subissues-view`}
            issueLinkState={resolvedIssueDetailState ?? location.state}
            searchFilters={{ descendantOf: issue.id, includeBlockedBy: true }}
            searchWithinLoadedIssues
            baseCreateIssueDefaults={buildSubIssueDefaultsForViewer(issue)}
            createIssueLabel="Sub-task"
            defaultSortField="workflow"
            showProgressSummary
            parentIssueIdForCostSummary={issue.id}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
          <Button variant="outline" size="sm" onClick={openNewSubIssue} className="shrink-0 shadow-none">
            <Plus data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
            New Sub-task
          </Button>
        </div>
      )}

      <IssueDocumentsSection
        issue={issue}
        canDeleteDocuments={Boolean(session?.user?.id)}
        canManageDocumentLocks={Boolean(session?.user?.id)}
        feedbackVotes={feedbackVotes}
        feedbackDataSharingPreference={feedbackDataSharingPreference}
        feedbackTermsUrl={FEEDBACK_TERMS_URL}
        mentions={mentionOptions}
        externalReferences={externalObjectsState.isEnabled ? externalObjectsState.markdownReferences : undefined}
        imageUploadHandler={async (file) => {
          const attachment = await uploadAttachment.mutateAsync(file);
          return attachment.contentPath;
        }}
        onVote={async (revisionId, vote, options) => {
          await feedbackVoteMutation.mutateAsync({
            targetType: "issue_document_revision",
            targetId: revisionId,
            vote,
            reason: options?.reason,
            allowSharing: options?.allowSharing,
            sharingPreferenceAtSubmit: feedbackDataSharingPreference,
          });
        }}
        extraActions={!hasAttachments ? attachmentUploadButton : null}
        agentMap={agentMap}
        userProfileMap={userProfileMap}
      />

      <IssueOutputSection
        workProducts={workProducts}
        onMediaClick={(item) => {
          const meta = item.metadata;
          if (!meta) return;
          const idx = mediaGalleryItems.findIndex((galleryItem) => (
            galleryItem.contentPath === meta.contentPath ||
            galleryItem.id === `work-product-${item.id}` ||
            galleryItem.id === meta.attachmentId
          ));
          setGalleryIndex(idx >= 0 ? idx : 0);
          setGalleryOpen(true);
        }}
      />

      {attachmentsInitialLoading ? (
        <IssueSectionSkeleton titleWidth="w-24" rows={2} />
      ) : hasAttachments ? (
        <IssueAttachmentsSection
          attachments={attachmentList}
          uploadButton={attachmentUploadButton}
          error={attachmentError}
          dragActive={attachmentDragActive}
          deletePending={deleteAttachment.isPending}
          onDelete={(attachmentId) => deleteAttachment.mutate(attachmentId)}
          onImageClick={(attachment) => {
            const idx = mediaGalleryItems.findIndex((a) => a.id === attachment.id);
            setGalleryIndex(idx >= 0 ? idx : 0);
            setGalleryOpen(true);
          }}
          onDragEnter={(evt) => {
            evt.preventDefault();
            setAttachmentDragActive(true);
          }}
          onDragOver={(evt) => {
            evt.preventDefault();
            setAttachmentDragActive(true);
          }}
          onDragLeave={(evt) => {
            if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
            setAttachmentDragActive(false);
          }}
          onDrop={(evt) => void handleAttachmentDrop(evt)}
        />
      ) : null}

      <ImageGalleryModal
        items={mediaGalleryItems}
        initialIndex={galleryIndex}
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
      />

      <IssueWorkspaceCard
        issue={issue}
        project={resolvedProject}
        onUpdate={handleIssuePropertiesUpdate}
        onBrowseFiles={fileViewerEnabled ? () => setFileViewerPromptOpen(true) : undefined}
        onOpenFileByPath={fileViewerEnabled ? () => setFileViewerPromptOpen(true) : undefined}
      />

      {fileViewerEnabled && issue.workProducts && issue.workProducts.length > 0 && (() => {
        const workProductsWithFileRefs = issue.workProducts
          .map((product) => ({ product, fileRef: extractWorkspaceFileRefFromWorkProduct(product) }))
          .filter(({ fileRef }) => fileRef !== null);

        if (workProductsWithFileRefs.length === 0) return null;

        return (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-muted-foreground">Artifacts</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {workProductsWithFileRefs.map(({ product, fileRef }) => (
                <ArtifactFileChip
                  key={product.id}
                  workspaceFileRef={fileRef!}
                  title={product.title}
                />
              ))}
            </div>
          </div>
        );
      })()}

      <Separator />

      <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="chat" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
          <TabsTrigger value="related-work" className="gap-1.5">
            <ListTree className="h-3.5 w-3.5" />
            Related work
          </TabsTrigger>
          {issuePluginTabItems.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="chat">
          {detailTab === "chat" ? (
            <IssueDetailChatTab
              issueId={issue.id}
              companyId={issue.companyId}
              projectId={issue.projectId ?? null}
              issueStatus={issue.boardPresentationStatus}
              issueLifecycleStatus={issue.lifecycleStatus}
              issueWorkMode={issue.workMode ?? "standard"}
              blockedBy={issue.blockedBy ?? []}
              liveIssueIds={liveIssueIds}
              blockerAttention={issue.blockerAttention ?? null}
              comments={threadComments}
              locallyQueuedCommentRunIds={locallyQueuedCommentRunIds}
              hasOlderComments={hasOlderComments}
              commentsLoadingOlder={commentsLoadingOlder}
              onLoadOlderComments={loadOlderComments}
              onRefreshLatestComments={refetchLatestComments}
              onLoadMoreCommentGroup={loadMoreCommentGroup}
              composerRef={commentComposerRef}
              composerAccessory={
                hasVisibleMonitorSurface(issue) ||
                humanLifecycleFormControls ? (
                  <div className="flex flex-col gap-2">
                    {hasVisibleMonitorSurface(issue) ? (
                      <IssueMonitorComposerStrip
                        issue={issue}
                        onCheckNow={() => checkIssueMonitorNow.mutate()}
                        checkingNow={checkIssueMonitorNow.isPending}
                      />
                    ) : null}
                    {humanLifecycleFormControls}
                  </div>
                ) : null
              }
              footer={
                siblingNavigation ? (
                  <IssueSiblingNavigation
                    navigation={siblingNavigation}
                    linkState={resolvedIssueDetailState ?? location.state}
                  />
                ) : null
              }
              feedbackVotes={feedbackVotes}
              feedbackDataSharingPreference={feedbackDataSharingPreference}
              feedbackTermsUrl={FEEDBACK_TERMS_URL}
              agentMap={agentMap}
              currentUserId={currentUserId}
              userLabelMap={userLabelMap}
              userProfileMap={userProfileMap}
              draftKey={`paperclip:issue-comment-draft:${issue.id}`}
              ownerOptions={commentOwnerOptions}
              currentOwnerValue={currentOwnerValue}
              suggestedOwnerValue={suggestedOwnerValue}
              mentions={mentionOptions}
              composerDisabledReason={
                isUserCreatorWithdrawalOwner
                  ? "This task is withdrawn; finish its cancellation above."
                  : commentComposerDisabledReason
              }
              composerHint={composerHint}
              onVote={handleCommentVote}
              onAdd={handleChatAdd}
              onImageUpload={handleCommentImageUpload}
              onAttachImage={handleCommentAttachImage}
              onImageClick={handleChatImageClick}
              ownerUserId={issue.ownerUserId ?? null}
              externalReferences={externalObjectsState.isEnabled ? externalObjectsState.markdownReferences : undefined}
              linkCaseReferences={casesChipsEnabled}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="activity">
          {detailTab === "activity" ? (
            <IssueDetailActivityTab
              issue={issue}
              issueId={issue.id}
              companyId={issue.companyId}
              issueStatus={issue.boardPresentationStatus}
              childIssues={childIssues}
              agentMap={agentMap}
              hasLiveRuns={hasLiveRuns}
              currentUserId={currentUserId}
              userProfileMap={userProfileMap}
              pendingApprovalAction={pendingApprovalAction}
              onApprovalAction={(approvalId, action) => {
                approvalDecision.mutate({ approvalId, action });
              }}
              externalReferences={externalObjectsState.isEnabled ? externalObjectsState.markdownReferences : undefined}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="related-work">
          <IssueRelatedWorkPanel
            relatedWork={issue.relatedWork}
            externalObjectsEnabled={externalObjectsState.isEnabled}
            externalObjects={externalObjectsState.isEnabled ? externalObjectsState.groups : undefined}
            externalObjectsLoading={externalObjectsState.isEnabled ? externalObjectsState.isLoading : undefined}
            externalObjectsError={externalObjectsState.isEnabled ? externalObjectsState.isError : undefined}
            onRetryExternalObjects={externalObjectsState.isEnabled ? externalObjectsState.refetch : undefined}
          />
        </TabsContent>

        {activePluginTab && (
          <TabsContent value={activePluginTab.value}>
            <PluginSlotMount
              slot={activePluginTab.slot}
              context={{
                companyId: issue.companyId,
                projectId: issue.projectId ?? null,
                entityId: issue.id,
                entityType: "issue",
              }}
              missingBehavior="placeholder"
            />
          </TabsContent>
        )}
      </Tabs>

      <Dialog open={treeControlOpen} onOpenChange={setTreeControlOpen}>
        <DialogContent className="flex max-h-(--sz-calc-18) flex-col gap-0 overflow-hidden p-0 sm:max-w-(--sz-560px)">
          <DialogHeader className="border-b border-border/60 px-6 pb-4 pr-12 pt-6">
            <DialogTitle>{issueTreeControlLabel(treeControlMode, treeControlScope)}</DialogTitle>
            <DialogDescription>
              {issueTreeControlHelpText(treeControlMode, treeControlScope)}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4">
            {treeControlMode === "cancel" ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                Cancelling a subtree is destructive. Non-terminal tasks will be marked cancelled, and running or queued work will be interrupted where possible.
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="tree-control-reason">
                Reason (optional)
              </label>
              <Textarea
                id="tree-control-reason"
                value={treeControlReason}
                onChange={(event) => setTreeControlReason(event.target.value)}
                placeholder="Explain why this subtree control is being applied..."
                className="min-h-(--sz-88px)"
              />
            </div>

            {treeControlMode === "cancel" ? (
              <label className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={treeControlCancelConfirmed}
                  onChange={(event) => setTreeControlCancelConfirmed(event.target.checked)}
                />
                <span>I understand this will cancel {previewAffectedIssueCount} tasks.</span>
              </label>
            ) : null}

            <div className="space-y-2">
              {treeControlPreviewLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ) : treeControlPreviewError ? (
                <div className="space-y-2">
                  <p className="text-xs text-destructive">{treeControlPreviewErrorCopy(treeControlPreviewError)}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void refetchTreeControlPreview();
                    }}
                  >
                    Retry preview
                  </Button>
                </div>
              ) : treeControlPreview ? (
                <div className="space-y-2">
                  {treeControlMode === "pause" ? (
                    <PauseAffectsSummaryView summary={pauseAffectsSummary} />
                  ) : null}
                  {treePreviewWarnings.length > 0 ? (
                    <div className="space-y-1">
                      {treePreviewWarnings.map((warning) => (
                        <p key={warning.code} className="text-xs text-amber-700 dark:text-amber-300">
                          {warning.message}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  {treePreviewDisplayIssues.length > 0 ? (
                    <div className="max-h-56 overflow-y-auto overscroll-contain">
                      {treePreviewDisplayIssues.map((candidate) => (
                        <div key={candidate.id} style={candidate.depth > 0 ? { paddingLeft: `${Math.min(candidate.depth, 6) * 14}px` } : undefined}>
                          <Link
                            to={createIssueDetailPath(candidate.identifier ?? candidate.id)}
                            className={cn(
                              "group flex items-start gap-2 border-b border-border py-2 pl-1 pr-2 text-sm no-underline text-inherit transition-colors last:border-b-0 hover:bg-accent/50 sm:items-center",
                              candidate.skipped && "opacity-60",
                            )}
                          >
                            <StatusIcon status={candidate.boardPresentationStatus} />
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              {candidate.identifier ?? candidate.id.slice(0, 8)}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                            {candidate.skipped && candidate.skipReason === "terminal_status" ? (
                              <span className="shrink-0 text-xs text-muted-foreground">Complete</span>
                            ) : null}
                          </Link>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Preview unavailable.</p>
              )}
            </div>
          </div>
          <DialogFooter className="border-t border-border/60 bg-background px-6 py-4">
            <Button variant="outline" onClick={() => setTreeControlOpen(false)} disabled={executeTreeControl.isPending}>
              Close
            </Button>
            <Button
              onClick={() => executeTreeControl.mutate()}
              disabled={executeTreeControl.isPending || !canApplyTreeControl}
              variant={treeControlMode === "cancel" ? "destructive" : "default"}
            >
              {executeTreeControl.isPending ? "Applying..." : treeControlPrimaryButtonLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reopenDialogOpen}
        onOpenChange={(open) => {
          setReopenDialogOpen(open);
          if (!open) setReopenReason("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen this task</DialogTitle>
            <DialogDescription>
              This audited command preserves the owner and execution session, clears the
              terminal disposition, and invokes the owner with the stored immutable request.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            <span className="font-medium">Reason</span>
            <textarea
              value={reopenReason}
              onChange={(event) => setReopenReason(event.target.value)}
              rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="Why should this task be reopened?"
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReopenDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!reopenReason.trim() || reopenIssue.isPending}
              onClick={() => reopenIssue.mutate(reopenReason)}
            >
              {reopenIssue.isPending ? "Reopening..." : "Reopen task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mobile properties drawer */}
      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-(--sz-85dvh) pb-(--sz-safe-bottom)">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <IssueProperties
                issue={issue}
                childIssues={childIssues}
                onAddSubIssue={openNewSubIssue}
                onUpdate={handleIssuePropertiesUpdate}
                inline
                hasActiveRun={resolvedHasActiveRun}
                externalObjects={externalObjectsState.isEnabled ? externalObjectsState.groups : undefined}
                externalObjectsLoading={externalObjectsState.isEnabled ? externalObjectsState.isLoading : undefined}
                externalObjectsError={externalObjectsState.isEnabled ? externalObjectsState.isError : undefined}
                onRetryExternalObjects={externalObjectsState.isEnabled ? externalObjectsState.refetch : undefined}
                onCheckMonitorNow={() => checkIssueMonitorNow.mutate()}
                checkingMonitorNow={checkIssueMonitorNow.isPending}
              />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      {fileViewerEnabled ? (
        <IssueFileViewer
          issueId={issue.id}
          companyId={issue.companyId}
          promptOpen={fileViewerPromptOpen}
          onPromptOpenChange={setFileViewerPromptOpen}
        />
      ) : null}
      <ScrollToBottom />
    </div>
    </FileViewerProvider>
  );
}

function IssueFileViewer({
  issueId,
  companyId,
  promptOpen,
  onPromptOpenChange,
}: {
  issueId: string;
  companyId: string;
  promptOpen: boolean;
  onPromptOpenChange: (next: boolean) => void;
}) {
  const viewer = useRequiredFileViewer();
  const open = viewer.state !== null || viewer.browse || promptOpen;
  const showPromptWhenEmpty = (promptOpen || viewer.browse) && viewer.state === null;

  useEffect(() => {
    if (!promptOpen) return;
    if (viewer.state === null && !viewer.browse) return;
    onPromptOpenChange(false);
  }, [onPromptOpenChange, promptOpen, viewer.browse, viewer.state]);

  return (
    <FileViewerSheet
      issueId={issueId}
      companyId={companyId}
      open={open}
      showPromptWhenEmpty={showPromptWhenEmpty}
      onOpenChange={(next) => {
        if (!next) {
          onPromptOpenChange(false);
          // Clears any file view and browse state from the URL.
          viewer.close();
        }
      }}
    />
  );
}
