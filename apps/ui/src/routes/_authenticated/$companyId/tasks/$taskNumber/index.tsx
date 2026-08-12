import { parseTaskNumber } from "@paperclipai/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ApiError } from "@/api/client";
import { tasksApi } from "@/api/tasks";
import { seedTaskDetailCache } from "@/lib/taskDetailCache";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  type Ref,
} from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import {
  getRouteApi,
  Link,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  useInfiniteQuery,
  useQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { approvalsApi } from "@/api/approvals";
import { activityApi } from "@/api/activity";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { projectsApi } from "@/api/projects";
import { useDialogActions } from "@/context/DialogContext";
import { usePanel } from "@/context/PanelContext";
import { useSidebar } from "@/context/SidebarContext";
import { useToastActions } from "@/context/ToastContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { formatUserLabel } from "@/lib/task-owners";
import {
  buildCompanyUserLabelMap,
  buildCompanyUserProfileMap,
  buildMarkdownMentionOptions,
} from "@/lib/company-members";
import { extractTaskTimelineEvents } from "@/lib/task-timeline-events";
import { queryKeys } from "@/lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "@/lib/query-placeholder-data";
import { collectLiveTaskIds } from "@/lib/liveTaskIds";
import {
  readTaskDetailLocationState,
  readTaskDetailHeaderSeed,
  type TaskDetailSource,
} from "@/lib/taskDetailBreadcrumb";
import { taskDisplayTitle } from "@/lib/task-display";
import { getTaskDetailQueryOptions } from "@/lib/taskDetailCache";
import {
  beginLocalInboxArchive,
  boundLocalInboxArchive,
  cancelInboxTaskQueries,
  clearLocalInboxArchive,
  confirmLocalInboxArchive,
  invalidateInboxTaskQueries,
  getTaskPresenceInActiveInboxCaches,
  removeTaskFromInboxCaches,
  restoreTaskToInboxCaches,
  snapshotInboxTaskCaches,
} from "@/lib/inboxArchiveCache";
import {
  hasBlockingShortcutDialog,
  resolveTaskDetailGoKeyAction,
  resolveInboxQuickArchiveKeyAction,
} from "@/lib/keyboardShortcuts";
import {
  applyOptimisticTaskFieldUpdate,
  applyOptimisticTaskFieldUpdateToCollection,
  applyLocalQueuedTaskCommentState,
  createOptimisticTaskComment,
  flattenBoardTaskCommentGroupPages,
  matchesTaskId,
  mergeTaskComments,
  shouldAutoloadOlderTaskComments,
  type ClientTaskComment,
  type BoardTaskCommentGroupContinuation,
  type OptimisticTaskComment,
} from "@/lib/optimistic-task-comments";
import { useProjectOrder } from "@/hooks/useProjectOrder";
import {
  relativeTime,
  cn,
  formatDurationMs,
  formatMoneyAmount,
} from "@/lib/utils";
import { liveBlueBadge } from "@/lib/status-colors";
import { ApprovalCard } from "@/components/ApprovalCard";
import { InlineEditor } from "@/components/InlineEditor";
import {
  TaskChatThread,
  type TaskChatComposerHandle,
} from "@/components/TaskChatThread";
import { workModeMetaFor } from "@/lib/work-mode-meta";
import { TaskAttachmentsSection } from "@/components/TaskAttachmentsSection";
import { TaskDocumentsSection } from "@/components/TaskDocumentsSection";
import { TaskOutputSection } from "@/components/task-output/TaskOutputSection";
import { isImageAttachment, isVideoAttachment } from "@/lib/task-attachments";
import {
  getTaskOutputs,
  getPromotedOutputAttachmentIds,
  isImageContentType,
  isVideoLikeOutput,
} from "@/lib/task-output";
import { TaskSiblingNavigation } from "@/components/TaskSiblingNavigation";
import { TaskLinkQuicklook } from "@/components/TaskLinkQuicklook";
import { MarkdownBody } from "@/components/MarkdownBody";
import { TasksList } from "@/components/TasksList";
import { TaskReferenceActivitySummary } from "@/components/TaskReferenceActivitySummary";
import { TaskRelatedWorkPanel } from "@/components/TaskRelatedWorkPanel";
import {
  TaskMonitorBanner,
  TaskMonitorComposerStrip,
  hasVisibleMonitorSurface,
} from "@/components/TaskMonitorBanner";
import { TaskProperties } from "@/components/task-properties/TaskProperties";
import { PauseAffectsSummaryView } from "@/components/owner-transition/OwnerTransitionViews";
import { computePauseAffectsSummary } from "@/lib/owner-transition";
import { TaskRunLedger } from "@/components/TaskRunLedger";
import type { MentionOption } from "@/components/MarkdownEditor";
import {
  ImageGalleryModal,
  type GalleryMediaItem,
} from "@/components/ImageGalleryModal";
import { ScrollToBottom } from "@/components/ScrollToBottom";
import { StatusIcon } from "@/components/StatusIcon";
import { PriorityIcon } from "@/components/PriorityIcon";
import { Identity } from "@/components/Identity";
import {
  PluginSlotMount,
  PluginSlotOutlet,
  usePluginSlots,
} from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import {
  useNavigationAction,
  type NavigationAction,
} from "@/lib/navigation-action";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { formatTaskActivityAction } from "@/lib/activity-format";
import { copyTextToClipboard } from "@/lib/clipboard";
import { buildTaskPropertiesPanelKey } from "@/lib/task-properties-panel-key";
import { parseTaskArtifactFragment } from "@/lib/task-artifact-fragment";
import {
  buildTaskSiblingNavigation,
  shouldRenderRichSubTasksSection,
} from "@/lib/task-detail-subtasks";
import { filterTaskDescendants } from "@/lib/task-tree";
import { buildSubTaskDefaultsForViewer } from "@/lib/subTaskDefaults";
import { hasAssignedBacklogBlocker } from "@/lib/task-blockers";
import {
  Activity as ActivityIcon,
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  EyeOff,
  Flag,
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
  type ActivityEvent,
  type Agent,
  type BoardTaskCommentGroupPage,
  type BoardTaskThreadEntry,
  type Task,
  type TaskExecutionRunEnvelopeRecord,
  type TaskExecutionRunListPageRecord,
  type TaskAttachment,
  type TaskWorkProduct,
  type TaskWorkMode,
  type TaskTreeControlMode,
} from "@paperclipai/shared";

export const Route = createFileRoute(
  "/_authenticated/$companyId/tasks/$taskNumber/",
)({
  loader: async ({ abortController, context, params }) => {
    const taskNumber = parseTaskNumber(params.taskNumber);
    if (taskNumber === null) throw notFound();

    const task = await tasksApi
      .getByNumber(params.companyId, taskNumber, {
        signal: abortController.signal,
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) throw notFound();
        throw error;
      });
    if (task.companyId !== params.companyId || task.taskNumber !== taskNumber) {
      throw notFound();
    }

    return seedTaskDetailCache(context.queryClient, task);
  },
  component: TaskDetail,
});

type CommentOwnerChange = {
  ownerAgentId: string;
};

type TaskDetailComment = ClientTaskComment & {
  runId?: string | null;
  runAgentId?: string | null;
  interruptedRunId?: string | null;
  queueState?: "queued";
  queueTargetRunId?: string | null;
  queueReason?: "hold" | "active_run" | "other";
};

const TASK_COMMENT_PAGE_SIZE = 50;

const TASK_COMMENT_AUTOLOAD_LIMIT = TASK_COMMENT_PAGE_SIZE * 3;

const JUMP_TO_LATEST_MAX_COMMENT_PAGES = 10;

const TREE_CONTROL_MODE_LABEL: Record<TaskTreeControlMode, string> = {
  pause: "Pause subtree",
  resume: "Resume subtree",
  cancel: "Cancel subtree",
  restore: "Restore subtree",
};

const LEAF_WORK_CONTROL_MODE_LABEL: Partial<
  Record<TaskTreeControlMode, string>
> = {
  pause: "Pause work",
  resume: "Resume work",
};

const TREE_CONTROL_MODE_HELP_TEXT: Record<TaskTreeControlMode, string> = {
  pause:
    "Pause active execution in this task subtree until an explicit resume.",
  resume: "Release the active subtree pause hold so held work can continue.",
  cancel:
    "Cancel non-terminal tasks in this subtree and stop queued/running work where possible.",
  restore:
    "Restore tasks cancelled by this subtree operation so work can resume.",
};

const LEAF_WORK_CONTROL_MODE_HELP_TEXT: Partial<
  Record<TaskTreeControlMode, string>
> = {
  pause: "Pause active execution on this task until an explicit resume.",
  resume: "Release the active pause hold so this task can continue.",
};

function taskTreeControlLabel(
  mode: TaskTreeControlMode,
  scope: "leaf" | "subtree",
) {
  return scope === "leaf"
    ? (LEAF_WORK_CONTROL_MODE_LABEL[mode] ?? TREE_CONTROL_MODE_LABEL[mode])
    : TREE_CONTROL_MODE_LABEL[mode];
}

function taskTreeControlHelpText(
  mode: TaskTreeControlMode,
  scope: "leaf" | "subtree",
) {
  return scope === "leaf"
    ? (LEAF_WORK_CONTROL_MODE_HELP_TEXT[mode] ??
        TREE_CONTROL_MODE_HELP_TEXT[mode])
    : TREE_CONTROL_MODE_HELP_TEXT[mode];
}

function treeControlPreviewErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403)
      return "Only board users can preview subtree controls.";
    if (error.status === 409)
      return "Preview is stale because subtree hold state changed. Retry to refresh.";
    if (error.status === 422)
      return "This subtree action is currently invalid for the selected tasks.";
  }
  return error instanceof Error ? error.message : "Unable to load preview.";
}

export function shouldScrollTaskDetailToTopOnNavigation(input: {
  previousTaskId: string | undefined;
  nextTaskId: string | undefined;
  navigationType: NavigationAction;
}): boolean {
  if (input.navigationType === "POP") return false;
  return input.previousTaskId !== input.nextTaskId;
}

function resolveInterruptibleTaskRun(
  runs: readonly TaskExecutionRunEnvelopeRecord[] | undefined,
) {
  return (
    (runs ?? []).find((run) => run.status === "running") ??
    (runs ?? []).find((run) => run.status === "queued") ??
    (runs ?? []).find((run) => run.status === "scheduled_retry") ??
    null
  );
}

function readTaskRunStateFromCache(queryClient: QueryClient, taskId: string) {
  const page = queryClient.getQueryData<TaskExecutionRunListPageRecord>(
    queryKeys.tasks.runs(taskId, ACTIVE_TASK_EXECUTION_RUN_STATUSES),
  );
  const activeRuns = page?.items ?? [];
  return {
    activeRuns,
    interruptibleTaskRun: resolveInterruptibleTaskRun(activeRuns),
  };
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

function ActorIdentity({
  evt,
  agentMap,
  userProfileMap,
}: {
  evt: ActivityEvent;
  agentMap: Map<string, Agent>;
  userProfileMap?: Map<
    string,
    import("@/lib/company-members").CompanyUserProfile
  >;
}) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") {
    const profile = userProfileMap?.get(id);
    return (
      <Identity
        name={profile?.label ?? "Board"}
        avatarUrl={profile?.image}
        size="sm"
      />
    );
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
  if (parts.length >= 2)
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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
  const accessibleLabel = via
    ? `${label}: ${actor.name} · via ${via}`
    : `${label}: ${actor.name}`;
  const testIdLabel = label.toLowerCase();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar
          size="sm"
          className={cn(
            "ring-2 ring-background",
            actor.kind === "agent" && "rounded-md",
          )}
          aria-label={accessibleLabel}
          data-testid={`task-${testIdLabel}-avatar`}
        >
          {actor.avatarUrl ? (
            <AvatarImage src={actor.avatarUrl} alt="" />
          ) : null}
          <AvatarFallback>{attributionInitials(actor.name)}</AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="px-2 py-1.5">
        <div
          className="flex items-center gap-2"
          data-testid={`task-${testIdLabel}-tooltip`}
        >
          <Avatar
            size="sm"
            className={cn(
              "ring-1 ring-background/30",
              actor.kind === "agent" && "rounded-md",
            )}
          >
            {actor.avatarUrl ? (
              <AvatarImage src={actor.avatarUrl} alt="" />
            ) : null}
            <AvatarFallback className="bg-background/20 text-background">
              {attributionInitials(actor.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="text-(length:--text-nano) font-medium uppercase leading-none text-background/70">
              {label}
            </div>
            <div className="max-w-48 truncate text-xs font-medium leading-4 text-background">
              {actor.name}
            </div>
            {via ? (
              <div className="max-w-48 truncate text-(length:--text-nano) leading-3 text-background/60">
                via {via}
              </div>
            ) : null}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function TaskAttributionByline({
  task,
  agentMap,
  userProfileMap,
  userLabelMap,
}: {
  task: Task;
  agentMap: Map<string, Agent>;
  userProfileMap: ReadonlyMap<
    string,
    import("@/lib/company-members").CompanyUserProfile
  >;
  userLabelMap: ReadonlyMap<string, string>;
}) {
  const owner: AttributionActor | null = task.ownerAgentId
    ? {
        kind: "agent",
        id: task.ownerAgentId,
        name:
          agentMap.get(task.ownerAgentId)?.name ??
          task.ownerAgentId.slice(0, 8),
      }
    : task.ownerUserId
      ? {
          kind: "user",
          id: task.ownerUserId,
          name:
            formatUserLabel(task.ownerUserId, userLabelMap) ??
            userProfileMap.get(task.ownerUserId)?.label ??
            "User",
          avatarUrl: userProfileMap.get(task.ownerUserId)?.image ?? null,
        }
      : null;
  const originatingActor = deriveOriginatingActor(task);
  const originator: AttributionActor | null = originatingActor
    ? originatingActor.kind === "agent"
      ? {
          kind: "agent",
          id: originatingActor.id,
          name:
            agentMap.get(originatingActor.id)?.name ??
            originatingActor.id.slice(0, 8),
        }
      : {
          kind: "user",
          id: originatingActor.id,
          name:
            formatUserLabel(originatingActor.id, userLabelMap) ??
            userProfileMap.get(originatingActor.id)?.label ??
            "User",
          avatarUrl: userProfileMap.get(originatingActor.id)?.image ?? null,
        }
    : null;
  const originatorVia =
    originatingActor?.kind === "user" && originatingActor.viaAgentId
      ? (agentMap.get(originatingActor.viaAgentId)?.name ??
        originatingActor.viaAgentId.slice(0, 8))
      : null;
  if (!owner && !originator) return null;

  return (
    <AvatarGroup
      className="-space-x-1.5"
      aria-label="Task people"
      data-testid="task-attribution-avatar-stack"
    >
      {owner ? <AttributionAvatar label="Owner" actor={owner} /> : null}
      {originator ? (
        <AttributionAvatar
          label="Originating"
          actor={originator}
          via={originatorVia}
        />
      ) : null}
    </AvatarGroup>
  );
}

function TaskSectionSkeleton({
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

function TaskChatSkeleton() {
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

function TaskDetailLoadingState({
  headerSeed,
}: {
  headerSeed: ReturnType<typeof readTaskDetailHeaderSeed>;
}) {
  const identifier = headerSeed?.identifier ?? null;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-3 w-40" />

        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {headerSeed ? (
            <>
              <StatusIcon
                status={headerSeed.boardPresentationStatus}
                blockerAttention={headerSeed.blockerAttention}
              />
              <PriorityIcon priority={headerSeed.priority} />
              {identifier ? (
                <span className="text-sm font-mono text-muted-foreground shrink-0">
                  {identifier}
                </span>
              ) : null}
              {headerSeed.originKind === "routine_execution" &&
              headerSeed.originId ? (
                <Badge
                  variant="outline"
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
            <h2 className="text-xl font-bold leading-tight">
              {headerSeed.title}
            </h2>
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
        <TaskChatSkeleton />
      </div>

      <TaskSectionSkeleton titleWidth="w-24" rows={3} />
    </div>
  );
}

interface InboxMobileToolbarProps {
  companyId: string;
  taskId: string | undefined;
  taskHidden: boolean;
  onArchive: () => void;
  archivePending: boolean;
  onCopy: () => void;
  onProperties: () => void;
}

function InboxMobileToolbar({
  companyId,
  taskId: taskIdProp,
  taskHidden,
  onArchive,
  archivePending,
  onCopy,
  onProperties,
}: InboxMobileToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex items-center w-full">
      <Button variant="ghost" size="icon-sm" asChild>
        <Link
          to="/$companyId/inbox"
          params={{ companyId }}
          aria-label="Back to inbox"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
      </Button>

      <div className="ml-auto flex items-center gap-0.5">
        {taskIdProp && !taskHidden && (
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
              onClick={() => {
                onCopy();
                setMenuOpen(false);
              }}
            >
              <Copy className="h-3 w-3" />
              Copy as markdown
            </button>
            <button
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
              onClick={() => {
                onProperties();
                setMenuOpen(false);
              }}
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

type TaskDetailChatTabProps = {
  taskId: string;
  companyId: string;
  projectId: string | null;
  taskStatus: Task["boardPresentationStatus"];
  taskLifecycleStatus: Task["lifecycleStatus"];
  taskWorkMode: TaskWorkMode;
  blockedBy: Task["blockedBy"];
  liveTaskIds: ReadonlySet<string>;
  blockerAttention: Task["blockerAttention"] | null;
  comments: TaskDetailComment[];
  locallyQueuedCommentRunIds: ReadonlyMap<string, string>;
  hasOlderComments: boolean;
  commentsLoadingOlder: boolean;
  onLoadOlderComments: () => void;
  onRefreshLatestComments: () => Promise<unknown> | void;
  onLoadMoreCommentGroup: (rootCommentId: string) => Promise<void> | void;
  composerRef: Ref<TaskChatComposerHandle>;
  /** Optional node rendered inline directly above the reply composer. */
  composerAccessory?: ReactNode;
  footer?: ReactNode;
  agentMap: Map<string, Agent>;
  currentUserId: string | null;
  userLabelMap: ReadonlyMap<string, string> | null;
  userProfileMap: ReadonlyMap<
    string,
    import("@/lib/company-members").CompanyUserProfile
  > | null;
  draftKey: string;
  ownerOptions: Array<{ id: string; label: string; searchText?: string }>;
  currentOwnerValue: string;
  suggestedOwnerValue: string;
  mentions: MentionOption[];
  composerDisabledReason: string | null;
  composerHint: string | null;
  onAdd: (
    body: string,
    ownerChange?: CommentOwnerChange,
    mentionAgentId?: string,
    replyToCommentId?: string,
  ) => Promise<void>;
  onImageUpload: (file: File) => Promise<string>;
  onAttachImage: (file: File) => Promise<TaskAttachment | void>;
  onCancelQueued?: (commentId: string) => void;
  onImageClick: (src: string) => void;
  ownerUserId: string | null;
  onResumeFromBacklog?: () => Promise<void> | void;
  resumeFromBacklogPending?: boolean;
};

const TaskDetailChatTab = memo(function TaskDetailChatTab({
  taskId,
  companyId,
  projectId,
  taskWorkMode,
  taskStatus,
  taskLifecycleStatus,
  blockedBy,
  liveTaskIds,
  blockerAttention,
  comments,
  locallyQueuedCommentRunIds,
  hasOlderComments,
  commentsLoadingOlder,
  onLoadOlderComments,
  onRefreshLatestComments,
  onLoadMoreCommentGroup,
  composerRef,
  composerAccessory,
  footer,
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
  onAdd,
  onImageUpload,
  onAttachImage,
  onCancelQueued,
  onImageClick,
  ownerUserId,
  onResumeFromBacklog,
  resumeFromBacklogPending,
}: TaskDetailChatTabProps) {
  const ThreadComponent = TaskChatThread;
  const { data: activity } = useQuery({
    queryKey: queryKeys.tasks.activity(taskId),
    queryFn: () => activityApi.forTask(taskId),
    placeholderData: keepPreviousDataForSameQueryTail<ActivityEvent[]>(taskId),
  });
  const { data: activeRunPage } = useQuery({
    queryKey: queryKeys.tasks.runs(taskId, ACTIVE_TASK_EXECUTION_RUN_STATUSES),
    queryFn: () =>
      runsApi.listForTask(taskId, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
    enabled: taskLifecycleStatus === "open",
    placeholderData:
      keepPreviousDataForSameQueryTail<TaskExecutionRunListPageRecord>(taskId),
  });
  const activeRuns = activeRunPage?.items ?? [];
  const resolvedActivity = activity ?? [];
  const interruptibleTaskRun = resolveInterruptibleTaskRun(activeRuns);
  const activeRunIds = useMemo(
    () => new Set(activeRuns.map((run) => run.id)),
    [activeRuns],
  );
  const commentsWithRunMeta = useMemo<TaskDetailComment[]>(() => {
    return comments.map((comment) => {
      const nextComment: TaskDetailComment = { ...comment };
      const queuedTargetRunId =
        locallyQueuedCommentRunIds.get(comment.id) ?? null;
      const locallyQueuedComment = applyLocalQueuedTaskCommentState(
        nextComment,
        {
          queuedTargetRunId,
          targetRunIsLive: queuedTargetRunId
            ? activeRunIds.has(queuedTargetRunId)
            : false,
          runningRunId: interruptibleTaskRun?.id ?? null,
        },
      );
      return locallyQueuedComment;
    });
  }, [
    activeRunIds,
    comments,
    locallyQueuedCommentRunIds,
    interruptibleTaskRun,
  ]);
  const timelineEvents = useMemo(
    () => extractTaskTimelineEvents(resolvedActivity),
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
            {commentsLoadingOlder
              ? "Loading earlier comments..."
              : "Load earlier comments"}
          </Button>
        </div>
      ) : null}
      <ThreadComponent
        composerRef={composerRef}
        composerAccessory={composerAccessory}
        comments={commentsWithRunMeta}
        timelineEvents={timelineEvents}
        hasActiveRun={activeRuns.length > 0}
        taskId={taskId}
        blockedBy={blockedBy ?? []}
        liveTaskIds={liveTaskIds}
        blockerAttention={blockerAttention}
        companyId={companyId}
        projectId={projectId}
        taskStatus={taskStatus}
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
        onAdd={onAdd}
        onLoadMoreCommentGroup={onLoadMoreCommentGroup}
        imageUploadHandler={onImageUpload}
        onAttachImage={onAttachImage}
        onCancelQueued={onCancelQueued}
        taskWorkMode={taskWorkMode}
        onImageClick={onImageClick}
        onRefreshLatestComments={onRefreshLatestComments}
        ownerUserId={ownerUserId}
        onResumeFromBacklog={onResumeFromBacklog}
        resumeFromBacklogPending={resumeFromBacklogPending}
        footer={footer}
      />
    </div>
  );
});

type TaskDetailActivityTabProps = {
  taskId: string;
  taskStatus: Task["boardPresentationStatus"];
  childTasks: Task[];
  agentMap: Map<string, Agent>;
  currentUserId: string | null;
  userProfileMap: Map<
    string,
    import("@/lib/company-members").CompanyUserProfile
  >;
  pendingApprovalAction: {
    approvalId: string;
    action: "approve" | "reject";
  } | null;
  onApprovalAction: (approvalId: string, action: "approve" | "reject") => void;
};

function TaskDetailActivityTab({
  taskId,
  taskStatus,
  childTasks,
  agentMap,
  currentUserId,
  userProfileMap,
  pendingApprovalAction,
  onApprovalAction,
}: TaskDetailActivityTabProps) {
  const { data: activity, isLoading: activityLoading } = useQuery({
    queryKey: queryKeys.tasks.activity(taskId),
    queryFn: () => activityApi.forTask(taskId),
    placeholderData: keepPreviousDataForSameQueryTail<ActivityEvent[]>(taskId),
  });
  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.tasks.approvals(taskId),
    queryFn: () => tasksApi.listApprovals(taskId),
    placeholderData:
      keepPreviousDataForSameQueryTail<
        Awaited<ReturnType<typeof tasksApi.listApprovals>>
      >(taskId),
  });
  const { data: taskTreeCostSummary } = useQuery({
    queryKey: queryKeys.tasks.costSummary(taskId),
    queryFn: () => tasksApi.getCostSummary(taskId),
    placeholderData:
      keepPreviousDataForSameQueryTail<
        Awaited<ReturnType<typeof tasksApi.getCostSummary>>
      >(taskId),
  });
  const initialLoading = activityLoading && activity === undefined;
  const hasTaskTreeCost =
    !!taskTreeCostSummary &&
    (taskTreeCostSummary.pricedPromptCount > 0 ||
      taskTreeCostSummary.unpricedPromptCount > 0 ||
      taskTreeCostSummary.runtimeMs > 0 ||
      taskTreeCostSummary.taskCount > 1);

  if (initialLoading) {
    return <TaskSectionSkeleton titleWidth="w-20" rows={4} />;
  }

  return (
    <>
      {hasTaskTreeCost && taskTreeCostSummary && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-border">
          <div className="text-sm font-medium text-muted-foreground mb-1">
            Cost Summary
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground">
              {taskTreeCostSummary.taskCount > 1
                ? "This task and sub-tasks"
                : "This task"}
            </span>
            <span className="font-medium text-foreground">
              {formatMoneyAmount(
                taskTreeCostSummary.knownCostAmount,
                taskTreeCostSummary.budgetCurrency,
              )}
            </span>
            <span>{taskTreeCostSummary.pricedPromptCount} priced prompts</span>
            <span>
              {taskTreeCostSummary.unpricedPromptCount} unpriced prompts
            </span>
            {taskTreeCostSummary.runCount > 0 ? (
              <span>
                Runtime {formatDurationMs(taskTreeCostSummary.runtimeMs)}
                {` (${taskTreeCostSummary.runCount} run${taskTreeCostSummary.runCount === 1 ? "" : "s"})`}
              </span>
            ) : null}
            <span>
              {taskTreeCostSummary.taskCount} task
              {taskTreeCostSummary.taskCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}
      <div className="mb-3">
        <TaskRunLedger
          taskId={taskId}
          taskStatus={taskStatus}
          childTasks={childTasks}
          agentMap={agentMap}
          activityEvents={activity ?? []}
          resolveUserLabel={(userId) =>
            userProfileMap.get(userId)?.label ?? null
          }
          renderActivityEvent={(evt) => {
            return (
              <div className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <ActorIdentity
                    evt={evt}
                    agentMap={agentMap}
                    userProfileMap={userProfileMap}
                  />
                  <span>
                    {formatTaskActivityAction(evt.action, evt.details, {
                      agentMap,
                      userProfileMap,
                      currentUserId,
                    })}
                  </span>
                  <span className="ml-auto shrink-0">
                    {relativeTime(evt.createdAt)}
                  </span>
                </div>
                <TaskReferenceActivitySummary event={evt} />
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
              requesterAgent={
                approval.requestedByAgentId
                  ? (agentMap.get(approval.requestedByAgentId) ?? null)
                  : null
              }
              onApprove={() => onApprovalAction(approval.id, "approve")}
              onReject={() => onApprovalAction(approval.id, "reject")}
              linkToDetails
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
    </>
  );
}

function taskDetailSourceLabel(source: TaskDetailSource | null): string {
  if (source === "inbox") return "Inbox";
  if (source === "routine_runs") return "Recent Runs";
  return "Tasks";
}

function taskDetailSourceRouteOptions(
  source: TaskDetailSource | null,
  companyId: string,
) {
  switch (source ?? "tasks") {
    case "inbox":
      return {
        to: "/$companyId/inbox" as const,
        params: { companyId },
      };
    case "routine_runs":
      return {
        to: "/$companyId/routines" as const,
        params: { companyId },
        search: { tab: "runs" as const },
      };
    case "tasks":
      return {
        to: "/$companyId/tasks" as const,
        params: { companyId },
      };
  }
}

function TaskDetailSourceLink({
  source,
  companyId,
  children,
}: {
  source: TaskDetailSource | null;
  companyId: string;
  children: ReactNode;
}) {
  return (
    <Link {...taskDetailSourceRouteOptions(source, companyId)}>{children}</Link>
  );
}

export function TaskDetail() {
  const taskDetailRoute = getRouteApi(
    "/_authenticated/$companyId/tasks/$taskNumber/",
  );
  const { companyId } = taskDetailRoute.useParams();
  const routeTask = taskDetailRoute.useLoaderData();
  const taskId = routeTask.id;
  const { openNewTask } = useDialogActions();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs, setMobileToolbar } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const navigationType = useNavigationAction();
  const location = useLocation();
  const { pushToast } = useToastActions();
  const { isMobile } = useSidebar();
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
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
  const [treeControlMode, setTreeControlMode] =
    useState<TaskTreeControlMode>("pause");
  const [treeControlReason, setTreeControlReason] = useState("");
  const [treeControlCancelConfirmed, setTreeControlCancelConfirmed] =
    useState(false);
  const [reopenDialogOpen, setReopenDialogOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [optimisticComments, setOptimisticComments] = useState<
    OptimisticTaskComment[]
  >([]);
  const [locallyQueuedCommentRunIds, setLocallyQueuedCommentRunIds] = useState<
    Map<string, string>
  >(() => new Map());
  const [pendingCommentComposerFocusKey, setPendingCommentComposerFocusKey] =
    useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastMarkedReadTaskIdRef = useRef<string | null>(null);
  const lastScrollTaskIdRef = useRef<string | undefined>(undefined);
  const commentComposerRef = useRef<TaskChatComposerHandle | null>(null);
  const resolvedTaskDetailState = useMemo(
    () => readTaskDetailLocationState(location.state),
    [location.state],
  );
  const taskHeaderSeed = useMemo(
    () =>
      readTaskDetailHeaderSeed(location.state) ??
      readTaskDetailHeaderSeed(resolvedTaskDetailState),
    [location.state, resolvedTaskDetailState],
  );

  const taskQuery = useQuery({
    ...getTaskDetailQueryOptions(queryClient, taskId),
  });
  const task = taskQuery.data;
  const isLoading = taskQuery.isLoading;
  const error = taskQuery.error;
  const [commentGroupContinuations, setCommentGroupContinuations] = useState<
    ReadonlyMap<string, BoardTaskCommentGroupContinuation>
  >(() => new Map());
  const loadingCommentGroupRootsRef = useRef(new Set<string>());
  const commentGroupTaskIdRef = useRef(taskId);
  commentGroupTaskIdRef.current = taskId;
  useEffect(() => {
    loadingCommentGroupRootsRef.current.clear();
    setCommentGroupContinuations(new Map());
  }, [taskId]);

  const {
    data: commentPages,
    isLoading: commentsLoading,
    isFetchingNextPage: commentsLoadingOlder,
    hasNextPage: hasOlderComments,
    fetchNextPage: fetchOlderComments,
    refetch: refetchComments,
  } = useInfiniteQuery({
    queryKey: queryKeys.tasks.comments(taskId!),
    queryFn: ({ pageParam }) =>
      tasksApi.listComments(taskId!, {
        limit: TASK_COMMENT_PAGE_SIZE,
        entryLimit: TASK_COMMENT_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    enabled: !!taskId,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousDataForSameQueryTail<
      InfiniteData<BoardTaskCommentGroupPage, string | null>
    >(taskId ?? "pending"),
  });
  const comments = useMemo(
    () =>
      flattenBoardTaskCommentGroupPages(
        commentPages?.pages,
        {
          companyId,
          taskId: taskId!,
        },
        commentGroupContinuations,
      ),
    [commentGroupContinuations, commentPages?.pages, taskId, companyId],
  );
  const loadMoreCommentGroup = useCallback(
    async (rootCommentId: string) => {
      if (!taskId || loadingCommentGroupRootsRef.current.has(rootCommentId))
        return;
      const initialGroup = commentPages?.pages
        .flatMap((page) => page.groups)
        .find((group) => group.root.id === rootCommentId);
      const current = commentGroupContinuations.get(rootCommentId);
      const cursor =
        current?.nextCursor ?? initialGroup?.entriesNextCursor ?? null;
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
          const page = await tasksApi.getCommentThread(taskId, rootCommentId, {
            cursor: nextCursor,
            limit: TASK_COMMENT_PAGE_SIZE,
          });
          const entriesByIdentity = new Map<string, BoardTaskThreadEntry>();
          for (const entry of accumulatedEntries) {
            entriesByIdentity.set(`${entry.kind}:${entry.id}`, entry);
          }
          for (const entry of page.entries) {
            entriesByIdentity.set(`${entry.kind}:${entry.id}`, entry);
          }
          accumulatedEntries = [...entriesByIdentity.values()];
          nextCursor = page.nextCursor;
        }
        if (commentGroupTaskIdRef.current !== taskId) return;
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
        if (commentGroupTaskIdRef.current !== taskId) return;
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
    },
    [commentGroupContinuations, commentPages?.pages, taskId],
  );
  const shouldPrefetchOlderComments = useMemo(
    () =>
      shouldAutoloadOlderTaskComments({
        activeDetailTab: detailTab,
        hasOlderComments: hasOlderComments ?? false,
        loadedCommentCount: comments.length,
        initialPageLoading: commentsLoading,
        olderPageLoading: commentsLoadingOlder,
        autoLoadLimit: TASK_COMMENT_AUTOLOAD_LIMIT,
      }),
    [
      comments.length,
      commentsLoading,
      commentsLoadingOlder,
      detailTab,
      hasOlderComments,
    ],
  );
  const { data: attachments, isLoading: attachmentsLoading } = useQuery({
    queryKey: queryKeys.tasks.attachments(taskId!),
    queryFn: () => tasksApi.listAttachments(taskId!),
    enabled: !!taskId,
    placeholderData: keepPreviousDataForSameQueryTail<TaskAttachment[]>(
      taskId ?? "pending",
    ),
  });

  const { data: workProducts } = useQuery({
    queryKey: queryKeys.tasks.workProducts(taskId!),
    queryFn: () => tasksApi.listWorkProducts(taskId!),
    enabled: !!taskId,
    placeholderData: keepPreviousDataForSameQueryTail<TaskWorkProduct[]>(
      taskId ?? "pending",
    ),
  });

  const { data: activeTaskRunPage } = useQuery({
    queryKey: queryKeys.tasks.runs(taskId!, ACTIVE_TASK_EXECUTION_RUN_STATUSES),
    queryFn: () =>
      runsApi.listForTask(taskId!, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
    enabled: !!taskId,
    placeholderData:
      keepPreviousDataForSameQueryTail<TaskExecutionRunListPageRecord>(
        taskId ?? "pending",
      ),
  });
  const activeTaskRuns = activeTaskRunPage?.items ?? [];
  const resolvedHasActiveRun =
    task?.lifecycleStatus === "open" && activeTaskRuns.length > 0;
  const hasLiveRuns = activeTaskRuns.length > 0;
  useEffect(() => {
    if (!hasLiveRuns && locallyQueuedCommentRunIds.size > 0) {
      setLocallyQueuedCommentRunIds(new Map());
    }
  }, [hasLiveRuns, locallyQueuedCommentRunIds.size]);
  const taskDetailSource = resolvedTaskDetailState?.taskDetailSource ?? null;
  const navigateToTaskSource = useCallback(
    (replace = false) => {
      return navigate({
        ...taskDetailSourceRouteOptions(taskDetailSource, companyId),
        replace,
      });
    },
    [companyId, navigate, taskDetailSource],
  );

  const { data: rawChildTasks = [], isLoading: childTasksLoading } = useQuery({
    queryKey: task?.id
      ? queryKeys.tasks.listByDescendantRoot(companyId, task.id)
      : ["tasks", "parent", "pending"],
    queryFn: () =>
      tasksApi.list(companyId, {
        descendantOf: task!.id,
        includeBlockedBy: true,
      }),
    enabled: !!task?.id,
    placeholderData: keepPreviousDataForSameQueryTail<Task[]>(
      task?.id ?? "pending",
    ),
  });
  const {
    data: rawSiblingTasks = [],
    isLoading: siblingTasksLoading,
    isError: siblingTasksError,
  } = useQuery({
    queryKey: task?.parentId
      ? queryKeys.tasks.listByParent(companyId, task.parentId)
      : ["tasks", "siblings", "pending"],
    queryFn: () =>
      tasksApi.list(companyId, {
        parentId: task!.parentId!,
        includeBlockedBy: true,
      }),
    enabled: !!task?.parentId,
  });
  const companyRunsQueryKey = queryKeys.runs(companyId, {
    status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
  });
  const { data: companyRunPage } = useQuery({
    queryKey: companyRunsQueryKey,
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
    placeholderData:
      keepPreviousDataForSameQueryTail<TaskExecutionRunListPageRecord>(
        companyId,
      ),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const { data: taskOwnerCatalog } = useQuery({
    queryKey: queryKeys.agents.taskOwnerCatalog(companyId),
    queryFn: () => agentsApi.listInvokableTaskOwners(companyId),
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });
  // Bounded pool of recently-updated tasks to back the `@task` reference picker.
  // The picker filters this list client-side by identifier/title.
  const { data: mentionTasks = [] } = useQuery({
    queryKey: queryKeys.tasks.mentionPool(companyId),
    queryFn: () =>
      tasksApi.list(companyId, {
        limit: 100,
        sortField: "updated",
        sortDir: "desc",
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousDataForSameQueryTail<Task[]>(companyId),
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const currentUserId = session?.user.id ?? null;
  const { data: boardAccess } = useQuery({
    queryKey: currentUserId
      ? queryKeys.access.currentBoardAccess(currentUserId)
      : (["access", "current-board-access", null] as const),
    queryFn: () => accessApi.getCurrentBoardAccess(currentUserId!),
    enabled: !!session?.user?.id,
    retry: false,
  });
  const canManageTreeControl = Boolean(
    boardAccess?.companyIds?.includes(companyId),
  );
  const { data: instanceGeneralSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    enabled: !!taskId,
    retry: false,
  });
  const keyboardShortcutsEnabled =
    instanceGeneralSettings?.keyboardShortcuts === true;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: companyId,
    userId: currentUserId,
  });
  const { slots: taskPluginDetailSlots } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "task",
  });
  const taskPluginTabItems = useMemo(
    () =>
      taskPluginDetailSlots.map((slot) => ({
        value: `plugin:${slot.pluginKey}:${slot.id}`,
        label: slot.displayName,
        slot,
      })),
    [taskPluginDetailSlots],
  );
  const activePluginTab =
    taskPluginTabItems.find((item) => item.value === detailTab) ?? null;
  const {
    data: treeControlPreview,
    isFetching: treeControlPreviewLoading,
    error: treeControlPreviewError,
    refetch: refetchTreeControlPreview,
  } = useQuery({
    queryKey: [
      "tasks",
      "tree-control-preview",
      taskId ?? "pending",
      treeControlMode,
    ],
    queryFn: () =>
      tasksApi.previewTreeControl(taskId!, {
        mode: treeControlMode,
        releasePolicy: {
          strategy: "manual",
        },
      }),
    enabled: treeControlOpen && !!taskId && canManageTreeControl,
    staleTime: 0,
    retry: false,
  });
  const { data: treeControlState } = useQuery({
    queryKey: ["tasks", "tree-control-state", taskId ?? "pending"],
    queryFn: () => tasksApi.getTreeControlState(taskId!),
    enabled: !!taskId && canManageTreeControl,
    retry: false,
  });
  const { data: activeRootPauseHolds = [] } = useQuery({
    queryKey: [
      "tasks",
      "tree-holds",
      taskId ?? "pending",
      "active-pause-with-members",
    ],
    queryFn: () =>
      tasksApi.listTreeHolds(taskId!, {
        status: "active",
        mode: "pause",
        includeMembers: true,
      }),
    enabled: !!taskId && treeControlState?.activePauseHold?.isRoot === true,
  });
  const { data: activeCancelHolds = [] } = useQuery({
    queryKey: ["tasks", "tree-holds", taskId ?? "pending", "active-cancel"],
    queryFn: () =>
      tasksApi.listTreeHolds(taskId!, {
        status: "active",
        mode: "cancel",
      }),
    enabled: !!taskId && canManageTreeControl,
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
      tasks: mentionTasks,
    });
  }, [agents, companyMembers?.users, orderedProjects, mentionTasks]);

  const resolvedProject = useMemo(
    () =>
      task?.projectId
        ? (orderedProjects.find((project) => project.id === task.projectId) ??
          task.project ??
          null)
        : null,
    [task?.project, task?.projectId, orderedProjects],
  );
  const projectRouteId = resolvedProject?.id ?? null;
  const childTasks = useMemo(() => {
    const descendants = task?.id
      ? filterTaskDescendants(task.id, rawChildTasks)
      : rawChildTasks;
    return [...descendants].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [task?.id, rawChildTasks]);
  const liveTaskIds = useMemo(
    () => collectLiveTaskIds(companyRunPage?.items),
    [companyRunPage?.items],
  );
  const taskPanelKey = useMemo(
    () => buildTaskPropertiesPanelKey(task ?? null, childTasks),
    [childTasks, task],
  );
  const panelTask = useMemo(() => task ?? null, [task?.id, taskPanelKey]);
  const panelChildTasks = useMemo(() => childTasks, [taskPanelKey]);
  const showRichSubTasksSection = shouldRenderRichSubTasksSection(
    childTasksLoading,
    childTasks.length,
  );
  const siblingNavigation = useMemo(
    () =>
      task && !childTasksLoading && !siblingTasksLoading && !siblingTasksError
        ? buildTaskSiblingNavigation(task, rawSiblingTasks, childTasks)
        : null,
    [
      childTasks,
      childTasksLoading,
      task,
      rawSiblingTasks,
      siblingTasksError,
      siblingTasksLoading,
    ],
  );
  const openNewSubTask = useCallback(() => {
    if (!task) return;
    openNewTask(buildSubTaskDefaultsForViewer(task));
  }, [task, openNewTask]);

  const isNamedUserCreator =
    task?.creatorKind === "user/board" &&
    Boolean(currentUserId) &&
    task.creatorUserId === currentUserId;
  const isSystemEscalationHumanOwner =
    task?.creatorKind === "system" &&
    Boolean(task.escalatedFromAffectedTaskId) &&
    (task.ownerKind === "board" ||
      (task.ownerKind === "user" &&
        Boolean(currentUserId) &&
        task.ownerUserId === currentUserId));
  const isUserCreatorWithdrawalOwner =
    isNamedUserCreator &&
    task?.ownerKind === "user" &&
    task.ownerUserId === currentUserId &&
    task.ownerAssignmentSource === "user_creator_withdrawal";

  const commentOwnerOptions = useMemo(() => {
    if (!isNamedUserCreator || task?.ownerKind !== "agent") return [];

    const options: Array<{ id: string; label: string; searchText?: string }> =
      [];
    const activeAgents = [...(taskOwnerCatalog ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    return options;
  }, [isNamedUserCreator, task?.ownerKind, taskOwnerCatalog]);

  const currentOwnerValue = useMemo(
    () => (task?.ownerAgentId ? `agent:${task.ownerAgentId}` : ""),
    [task?.ownerAgentId],
  );

  const suggestedOwnerValue = useMemo(
    () => currentOwnerValue,
    [currentOwnerValue],
  );

  const threadComments = useMemo(
    () => mergeTaskComments(comments ?? [], optimisticComments),
    [comments, optimisticComments],
  );
  const breadcrumbTitle = task?.title ?? taskId;
  const breadcrumbStatus = task?.boardPresentationStatus;
  const breadcrumbBlockerAttention = task?.blockerAttention;
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
        <StatusIcon
          status={breadcrumbStatus}
          size="lg"
          blockerAttention={breadcrumbBlockerAttention}
        />
      ) : undefined,
    // `breadcrumbStatusKey` is a complete signature of the inputs below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [breadcrumbStatusKey],
  );
  const invalidateTaskDetail = useCallback(() => {
    if (!taskId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.activity(taskId),
    });
  }, [taskId, queryClient]);
  const invalidateTaskThreadLazily = useCallback(() => {
    if (!taskId) return;
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.detail(taskId),
      refetchType: "inactive",
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.activity(taskId),
      refetchType: "inactive",
    });
  }, [taskId, queryClient]);

  const invalidateTaskRunState = useCallback(() => {
    if (!taskId) return;
    queryClient.invalidateQueries({ queryKey: ["tasks", "runs", taskId] });
  }, [taskId, queryClient]);

  const upsertCommentInCache = useCallback(
    (_comment: unknown) => {
      if (!taskId) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.comments(taskId),
      });
    },
    [taskId, queryClient],
  );

  const invalidateTaskCollections = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.list(companyId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.listMineByMe(companyId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.listTouchedByMe(companyId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.listUnreadTouchedByMe(companyId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.sidebarBadges(companyId),
    });
  }, [queryClient, companyId]);
  const applyOptimisticTaskCacheUpdate = useCallback(
    (canonicalTaskId: string, data: Record<string, unknown>) => {
      queryClient.setQueryData<Task>(
        queryKeys.tasks.detail(canonicalTaskId),
        (cached) =>
          cached ? applyOptimisticTaskFieldUpdate(cached, data) : cached,
      );

      queryClient.setQueryData<Task[] | undefined>(
        queryKeys.tasks.list(companyId),
        (cached) =>
          applyOptimisticTaskFieldUpdateToCollection(
            cached,
            canonicalTaskId,
            data,
          ),
      );
    },
    [queryClient, companyId],
  );

  const mergeTaskResponseIntoCaches = useCallback(
    (nextTask: Task) => {
      queryClient.setQueryData<Task>(
        queryKeys.tasks.detail(nextTask.id),
        (cached) => (cached ? { ...cached, ...nextTask } : nextTask),
      );

      queryClient.setQueryData<Task[] | undefined>(
        queryKeys.tasks.list(companyId),
        (cached) =>
          cached?.map((item) =>
            matchesTaskId(item, nextTask.id) ? { ...item, ...nextTask } : item,
          ),
      );
    },
    [queryClient, companyId],
  );

  const markTaskRead = useMutation({
    mutationFn: (id: string) => tasksApi.markRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.listMineByMe(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.listTouchedByMe(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.listUnreadTouchedByMe(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(companyId),
      });
    },
  });

  const updateTaskTitle = useMutation({
    mutationFn: (title: string | null) =>
      tasksApi.updateTitle(taskId!, { title }),
    onMutate: async (title) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.tasks.detail(taskId!),
      });
      await queryClient.cancelQueries({
        queryKey: queryKeys.tasks.list(companyId),
      });

      const previousTask = queryClient.getQueryData<Task>(
        queryKeys.tasks.detail(taskId!),
      );
      const previousList = queryClient.getQueryData<Task[]>(
        queryKeys.tasks.list(companyId),
      );

      applyOptimisticTaskCacheUpdate(taskId!, { title });
      return { previousTask, previousList, companyId };
    },
    onSuccess: (nextTask) => {
      mergeTaskResponseIntoCaches(nextTask);
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.activity(taskId!),
      });
      invalidateTaskCollections();
    },
    onError: (err, _variables, context) => {
      queryClient.setQueryData(
        queryKeys.tasks.detail(taskId!),
        context?.previousTask,
      );
      if (context?.companyId) {
        queryClient.setQueryData(
          queryKeys.tasks.list(context.companyId),
          context.previousList,
        );
      }
      pushToast({
        title: "Title update failed",
        body:
          err instanceof Error ? err.message : "Unable to save the task title",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(taskId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.list(companyId),
      });
    },
  });

  const updateTaskExecutionPolicy = useMutation({
    mutationFn: (
      executionPolicy: NonNullable<Task["executionPolicy"]> | null,
    ) => tasksApi.updateExecutionPolicy(taskId!, { executionPolicy }),
    onSuccess: (nextTask) => {
      mergeTaskResponseIntoCaches(nextTask);
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.activity(taskId!),
      });
      invalidateTaskCollections();
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
        queryKey: queryKeys.tasks.detail(taskId!),
      });
    },
  });

  const reassignTask = useMutation({
    mutationFn: (ownerAgentId: string) =>
      tasksApi.creatorReassign(taskId!, {
        ownerAgentId,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: ({ task: nextTask }) => {
      mergeTaskResponseIntoCaches(nextTask);
      invalidateTaskDetail();
      invalidateTaskRunState();
      invalidateTaskCollections();
    },
    onError: (err) => {
      pushToast({
        title: "Reassignment failed",
        body:
          err instanceof Error ? err.message : "Unable to reassign this task",
        tone: "error",
      });
    },
  });

  const commitHumanOwnerStatus = useMutation({
    mutationFn: async (input: {
      status: "open" | "blocked" | "done" | "cancelled";
      message: string;
    }) =>
      tasksApi.commitOwnerFormUpdate({
        taskId: taskId!,
        message: input.message,
        status: input.status,
      }),
    onSuccess: (result) => {
      upsertCommentInCache(result.comment);
      invalidateTaskDetail();
      invalidateTaskRunState();
      invalidateTaskCollections();
    },
    onError: (err) => {
      pushToast({
        title: "Owner update failed",
        body: err instanceof Error ? err.message : "Unable to update this task",
        tone: "error",
      });
    },
  });

  const withdrawAndCancelTask = useMutation({
    mutationFn: async () => {
      if (!task) throw new Error("Task is still loading");
      let withdrawalTask = task;
      if (task.ownerKind === "agent" && task.ownerAgentId) {
        const assigned = await tasksApi.selfAssignForWithdrawal(task.id, {
          idempotencyKey: crypto.randomUUID(),
        });
        withdrawalTask = assigned.task;
        mergeTaskResponseIntoCaches(assigned.task);
      }
      if (
        withdrawalTask.ownerKind !== "user" ||
        withdrawalTask.ownerUserId !== currentUserId ||
        withdrawalTask.ownerAssignmentSource !== "user_creator_withdrawal"
      ) {
        throw new Error(
          "Only the named creator can withdraw an agent-owned task",
        );
      }
      return tasksApi.commitOwnerFormUpdate({
        taskId: task.id,
        message: "Cancelled by the named creator after withdrawal.",
        status: "cancelled",
      });
    },
    onSuccess: (result) => {
      upsertCommentInCache(result.comment);
      invalidateTaskDetail();
      invalidateTaskRunState();
      invalidateTaskCollections();
      pushToast({ title: "Task withdrawn and cancelled", tone: "success" });
    },
    onError: (err) => {
      invalidateTaskDetail();
      pushToast({
        title: "Withdrawal failed",
        body:
          err instanceof Error ? err.message : "Unable to withdraw this task",
        tone: "error",
      });
    },
  });

  const reopenTask = useMutation({
    mutationFn: (reason: string) =>
      tasksApi.reopen(taskId!, {
        reason,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: ({ task: nextTask }) => {
      mergeTaskResponseIntoCaches(nextTask);
      setReopenDialogOpen(false);
      setReopenReason("");
      invalidateTaskDetail();
      invalidateTaskThreadLazily();
      invalidateTaskRunState();
      invalidateTaskCollections();
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
          throw new Error(
            "No active subtree pause hold is available to resume.",
          );
        }
        const releasedHold = await tasksApi.releaseTreeHold(
          taskId!,
          pauseHoldId,
          {
            reason: treeControlReason.trim() || null,
          },
        );
        return { kind: "release" as const, hold: releasedHold };
      }
      const created = await tasksApi.createTreeHold(taskId!, {
        mode: treeControlMode,
        reason: treeControlReason.trim() || null,
        releasePolicy: {
          strategy: "manual",
          ...(treeControlMode === "pause"
            ? {
                note: treeControlScope === "leaf" ? "leaf_pause" : "full_pause",
              }
            : {}),
        },
      });
      return {
        kind: "create" as const,
        hold: created.hold,
        preview: created.preview,
      };
    },
    onSuccess: async (result) => {
      const modeLabel = taskTreeControlLabel(
        result.hold.mode,
        treeControlScope,
      );
      const cancelCount = result.preview?.totals.activeRuns ?? 0;
      pushToast({
        title:
          result.kind === "release"
            ? treeControlScope === "leaf"
              ? "Work resumed"
              : "Subtree resumed"
            : result.hold.mode === "pause"
              ? treeControlScope === "leaf"
                ? "Work paused"
                : "Subtree paused"
              : `${modeLabel} applied`,
        body:
          result.kind === "release"
            ? result.hold.releaseReason?.trim() ||
              (treeControlScope === "leaf"
                ? "Active task pause released."
                : "Active subtree pause released.")
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
        queryClient.invalidateQueries({
          queryKey: queryKeys.tasks.detail(taskId!),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.tasks.activity(taskId!),
        }),
        queryClient.invalidateQueries({ queryKey: ["tasks", "runs", taskId!] }),
        queryClient.invalidateQueries({
          queryKey: ["tasks", "tree-control-state", taskId ?? "pending"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["tasks", "tree-holds", taskId ?? "pending"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["tasks", "tree-control-preview", taskId ?? "pending"],
        }),
      ]);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.tasks.list(companyId),
        }),
        ...(task?.id
          ? [
              queryClient.invalidateQueries({
                queryKey: queryKeys.tasks.listByParent(companyId, task.id),
              }),
              queryClient.invalidateQueries({
                queryKey: queryKeys.tasks.listByDescendantRoot(
                  companyId,
                  task.id,
                ),
              }),
            ]
          : []),
      ]);
    },
    onError: (err) => {
      pushToast({
        title: "Unable to apply subtree control",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      });
    },
  });
  const handleTaskPropertiesUpdate = useCallback(
    (data: Record<string, unknown>) => {
      const keys = Object.keys(data);
      if (
        keys.length === 1 &&
        keys[0] === "title" &&
        (typeof data.title === "string" || data.title === null)
      ) {
        updateTaskTitle.mutate(data.title);
        return;
      }
      if (
        keys.length === 1 &&
        keys[0] === "executionPolicy" &&
        (data.executionPolicy === null ||
          (typeof data.executionPolicy === "object" &&
            !Array.isArray(data.executionPolicy)))
      ) {
        updateTaskExecutionPolicy.mutate(
          data.executionPolicy as NonNullable<Task["executionPolicy"]> | null,
        );
        return;
      }
      pushToast({
        title: "Property is read-only",
        body: "The board can edit title and execution-policy controls. Lifecycle changes belong to the owner runtime.",
        tone: "error",
      });
    },
    [pushToast, updateTaskExecutionPolicy, updateTaskTitle],
  );

  const approvalDecision = useMutation({
    mutationFn: async ({
      approvalId,
      action,
    }: {
      approvalId: string;
      action: "approve" | "reject";
    }) => {
      if (action === "approve") {
        return approvalsApi.approve(approvalId);
      }
      return approvalsApi.reject(approvalId);
    },
    onMutate: ({ approvalId, action }) => {
      setPendingApprovalAction({ approvalId, action });
    },
    onSuccess: (_approval, variables) => {
      invalidateTaskDetail();
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.approvals(taskId!),
      });
      invalidateTaskCollections();
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.detail(variables.approvalId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(companyId),
      });
      pushToast({
        title:
          variables.action === "approve"
            ? "Approval approved"
            : "Approval rejected",
        tone: "success",
      });
    },
    onError: (err, variables) => {
      pushToast({
        title:
          variables.action === "approve"
            ? "Approval failed"
            : "Rejection failed",
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
    }) => tasksApi.addComment(taskId!, input),
    onMutate: async ({ message, mention }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.tasks.comments(taskId!),
      });
      const queuedComment = mention
        ? readTaskRunStateFromCache(queryClient, taskId!).interruptibleTaskRun
        : null;
      const optimisticComment = task
        ? createOptimisticTaskComment({
            companyId: task.companyId,
            taskId: task.id,
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
          current.filter(
            (entry) => entry.clientId !== context.optimisticCommentId,
          ),
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
        queryKey: queryKeys.tasks.comments(taskId!),
      });
    },
    onError: (err, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter(
            (entry) => entry.clientId !== context.optimisticCommentId,
          ),
        );
      }
      pushToast({
        title: "Comment failed",
        body: err instanceof Error ? err.message : "Unable to post comment",
        tone: "error",
      });
    },
    onSettled: (_result, _error, variables) => {
      invalidateTaskThreadLazily();
      if (variables.mention || variables.replyToCommentId) {
        invalidateTaskRunState();
      }
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) =>
      tasksApi.uploadAttachment(companyId, taskId!, file),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.attachments(taskId!),
      });
      invalidateTaskDetail();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const importMarkdownDocument = useMutation({
    mutationFn: async (file: File) => {
      const baseName = fileBaseName(file.name);
      const key = slugifyDocumentKey(baseName);
      const existing =
        (task?.documentSummaries ?? []).find((doc) => doc.key === key) ?? null;
      const body = await file.text();
      const inferredTitle = titleizeFilename(baseName);
      const nextTitle = existing?.title ?? inferredTitle ?? null;
      return tasksApi.upsertDocument(taskId!, key, {
        title: key === "plan" ? null : nextTitle,
        format: "markdown",
        body,
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
    },
    onSuccess: () => {
      setAttachmentError(null);
      invalidateTaskDetail();
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.documents(taskId!),
      });
    },
    onError: (err) => {
      setAttachmentError(
        err instanceof Error ? err.message : "Document import failed",
      );
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) =>
      tasksApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.attachments(taskId!),
      });
      invalidateTaskDetail();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const archiveFromInbox = useMutation({
    mutationFn: (id: string) => tasksApi.archiveFromInbox(id),
    onMutate: async (id) => {
      beginLocalInboxArchive(companyId, id);
      await cancelInboxTaskQueries(queryClient, companyId);
      const previousData = snapshotInboxTaskCaches(queryClient, companyId);
      removeTaskFromInboxCaches(queryClient, companyId, id);
      return { companyId, previousData };
    },
    onSuccess: (_data, id) => {
      removeTaskFromInboxCaches(queryClient, companyId, id);
      invalidateTaskCollections();
      void navigateToTaskSource(true);
      pushToast({ title: "Task archived from inbox", tone: "success" });
    },
    onError: (err, id, context) => {
      if (context?.companyId) clearLocalInboxArchive(context.companyId, id);
      if (context?.previousData) {
        restoreTaskToInboxCaches(queryClient, context.previousData, id);
      }
      pushToast({
        title: "Archive failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to archive this task from the inbox",
        tone: "error",
      });
    },
    onSettled: async (_data, error, id, context) => {
      if (!context?.companyId) return;
      if (!error) boundLocalInboxArchive(context.companyId, id);
      await invalidateInboxTaskQueries(queryClient, context.companyId);
      if (!error) {
        const presence = getTaskPresenceInActiveInboxCaches(
          queryClient,
          context.companyId,
          id,
        );
        if (presence !== "unknown")
          confirmLocalInboxArchive(context.companyId, id);
      }
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      {
        label: taskDetailSourceLabel(taskDetailSource),
        renderLink: (content) => (
          <TaskDetailSourceLink source={taskDetailSource} companyId={companyId}>
            {content}
          </TaskDetailSourceLink>
        ),
      },
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
    companyId,
    hasLiveRuns,
    setBreadcrumbs,
    taskDetailSource,
    breadcrumbStatusLeading,
    breadcrumbStatusKey,
  ]);

  const isFromInbox = resolvedTaskDetailState?.taskDetailSource === "inbox";

  // Scroll to top on forward navigation (PUSH/REPLACE) so task doesn't
  // inherit the inbox/tasks-list scroll position on mobile.
  useEffect(() => {
    const previousTaskId = lastScrollTaskIdRef.current;
    const nextTaskId = taskId ?? undefined;
    lastScrollTaskIdRef.current = nextTaskId;
    if (
      !shouldScrollTaskDetailToTopOnNavigation({
        previousTaskId,
        nextTaskId,
        navigationType,
      })
    )
      return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const main = document.getElementById("main-content");
    if (main) main.scrollTop = 0;
  }, [taskId, navigationType]);

  useEffect(() => {
    if (!task?.id) return;
    if (lastMarkedReadTaskIdRef.current === task.id) return;
    lastMarkedReadTaskIdRef.current = task.id;
    markTaskRead.mutate(task.id);
  }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!panelTask) {
      closePanel();
      return;
    }
    openPanel(
      <TaskProperties
        task={panelTask}
        childTasks={panelChildTasks}
        onAddSubTask={openNewSubTask}
        onUpdate={handleTaskPropertiesUpdate}
        hasActiveRun={resolvedHasActiveRun}
      />,
    );
  }, [
    closePanel,
    handleTaskPropertiesUpdate,
    taskPanelKey,
    openNewSubTask,
    openPanel,
    panelChildTasks,
    panelTask,
    resolvedHasActiveRun,
  ]);

  useEffect(() => {
    return () => closePanel();
  }, [closePanel]);

  const goToInboxShortcutArmedRef = useRef(false);
  const goToInboxShortcutTimeoutRef = useRef<number | null>(null);
  const canQuickArchiveFromInbox = keyboardShortcutsEnabled && !task?.hiddenAt;

  useEffect(() => {
    if (!task?.id || !canQuickArchiveFromInbox) return;
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
        archiveFromInbox.mutate(task.id);
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [archiveFromInbox, canQuickArchiveFromInbox, task?.id]);

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
      if (
        event.target instanceof HTMLElement &&
        event.target !== document.body
      ) {
        disarm();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveTaskDetailGoKeyAction({
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
        void navigateToTaskSource();
        return;
      }
      if (action === "focus_comment") {
        event.preventDefault();
        event.stopPropagation();
        setDetailTab("chat");
        setPendingCommentComposerFocusKey((current) => current + 1);
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
  }, [keyboardShortcutsEnabled, navigateToTaskSource]);

  // Scroll + briefly highlight work-product / direct-attachment anchors so the
  // company Artifacts page (PAP-10359) can deep-link to a specific artifact in
  // its task context. Retries while the section data loads in.
  useEffect(() => {
    const target = parseTaskArtifactFragment(location.hash);
    if (!target) return;
    const targetId = `${target.kind}-${target.id}`;
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
      timer = setTimeout(
        () =>
          element.classList.remove(
            "ring-2",
            "ring-primary/50",
            "transition-shadow",
          ),
        3000,
      );
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

  const promotedOutputAttachmentIds = useMemo(
    () => getPromotedOutputAttachmentIds(workProducts),
    [workProducts],
  );
  const attachmentList = useMemo(
    () =>
      (attachments ?? []).filter(
        (attachment) => !promotedOutputAttachmentIds.has(attachment.id),
      ),
    [attachments, promotedOutputAttachmentIds],
  );
  const mediaGalleryItems = useMemo<GalleryMediaItem[]>(() => {
    const items: GalleryMediaItem[] = [];
    const seen = new Set<string>();

    const mark = (
      attachmentId: string | null | undefined,
      contentPath: string,
    ) => {
      if (attachmentId) seen.add(`attachment:${attachmentId}`);
      seen.add(`content:${contentPath}`);
    };

    const hasSeen = (
      attachmentId: string | null | undefined,
      contentPath: string,
    ) =>
      Boolean(attachmentId && seen.has(`attachment:${attachmentId}`)) ||
      seen.has(`content:${contentPath}`);

    for (const attachment of attachments ?? []) {
      if (!isImageAttachment(attachment) && !isVideoAttachment(attachment))
        continue;
      items.push(attachment);
      mark(attachment.id, attachment.contentPath);
    }

    for (const item of getTaskOutputs(workProducts).items) {
      const meta = item.metadata;
      if (!meta) continue;
      const isMedia =
        isImageContentType(meta.contentType) ||
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
          idx = mediaGalleryItems.findIndex(
            (a) => "assetId" in a && a.assetId === assetMatch[1],
          );
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

  const copyTaskToClipboard = async () => {
    if (!task) return;
    const decodeEntities = (text: string) => {
      const el = document.createElement("textarea");
      el.innerHTML = text;
      return el.value;
    };
    const title = decodeEntities(taskDisplayTitle(task));
    const body = decodeEntities(task.request ?? "");
    const md = `# ${task.identifier}: ${title}\n\n${body}`.trimEnd();
    try {
      await copyTextToClipboard(md);
      setCopied(true);
      pushToast({ title: "Copied to clipboard", tone: "success" });
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      pushToast({
        title: "Copy failed",
        body:
          error instanceof Error
            ? error.message
            : "Unable to copy task markdown",
        tone: "error",
      });
    }
  };

  // Gmail-style mobile toolbar when viewing a task from inbox.
  // Callbacks are stored in a ref so the effect deps stay stable and
  // don't trigger an infinite render loop (useMutation results and
  // non-memoized functions change identity every render).
  const inboxToolbarCallbacksRef = useRef({
    onArchive: () => {
      if (!archiveFromInbox.isPending && task?.id)
        archiveFromInbox.mutate(task.id);
    },
    onCopy: () => copyTaskToClipboard(),
    onProperties: () => setMobilePropsOpen(true),
  });
  inboxToolbarCallbacksRef.current = {
    onArchive: () => {
      if (!archiveFromInbox.isPending && task?.id)
        archiveFromInbox.mutate(task.id);
    },
    onCopy: () => copyTaskToClipboard(),
    onProperties: () => setMobilePropsOpen(true),
  };

  const showInboxToolbar = isMobile && isFromInbox;
  const archivePending = archiveFromInbox.isPending;
  const taskHidden = !!task?.hiddenAt;
  const canArchiveFromInbox = isFromInbox && !!task?.id && !taskHidden;

  useEffect(() => {
    if (!showInboxToolbar) {
      setMobileToolbar(null);
      return;
    }

    setMobileToolbar(
      <InboxMobileToolbar
        companyId={companyId}
        taskId={task?.id}
        taskHidden={taskHidden}
        archivePending={archivePending}
        onArchive={() => inboxToolbarCallbacksRef.current.onArchive()}
        onCopy={() => inboxToolbarCallbacksRef.current.onCopy()}
        onProperties={() => inboxToolbarCallbacksRef.current.onProperties()}
      />,
    );

    return () => setMobileToolbar(null);
  }, [
    showInboxToolbar,
    companyId,
    task?.id,
    taskHidden,
    archivePending,
    setMobileToolbar,
  ]);

  const attachmentsInitialLoading =
    attachmentsLoading && attachments === undefined;
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
      ...((refreshed.data?.pageParams as Array<string | null> | undefined) ??
        []),
    ];
    let cursor = pages.at(-1)?.nextCursor ?? null;
    const seen = new Set<string>();
    while (
      cursor &&
      !seen.has(cursor) &&
      seen.size < JUMP_TO_LATEST_MAX_COMMENT_PAGES
    ) {
      seen.add(cursor);
      const page = await tasksApi.listComments(taskId!, {
        cursor,
        limit: TASK_COMMENT_PAGE_SIZE,
        entryLimit: TASK_COMMENT_PAGE_SIZE,
      });
      pages.push(page);
      pageParams.push(cursor);
      cursor = page.nextCursor;
    }
    queryClient.setQueryData<
      InfiniteData<BoardTaskCommentGroupPage, string | null>
    >(queryKeys.tasks.comments(taskId!), { pages, pageParams });
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => resolve());
    });
  }, [taskId, queryClient, refetchComments]);
  useEffect(() => {
    if (!shouldPrefetchOlderComments) return;
    void fetchOlderComments();
  }, [fetchOlderComments, shouldPrefetchOlderComments]);
  const handleChatAdd = useCallback(
    async (
      body: string,
      ownerChange?: CommentOwnerChange,
      mentionAgentId?: string,
      replyToCommentId?: string,
    ) => {
      let commentTarget = task;
      if (ownerChange) {
        const result = await reassignTask.mutateAsync(ownerChange.ownerAgentId);
        commentTarget = result.task;
      }
      if (isUserCreatorWithdrawalOwner) {
        throw new Error(
          "A withdrawn task accepts only the creator's cancellation",
        );
      }
      if (isNamedUserCreator && !replyToCommentId) {
        const result = await tasksApi.commitCreatorFormUpdate({
          taskId: taskId!,
          message: body,
        });
        upsertCommentInCache(result.comment);
        invalidateTaskDetail();
        invalidateTaskRunState();
        invalidateTaskCollections();
        return;
      }
      if (isSystemEscalationHumanOwner && !replyToCommentId) {
        const result = await tasksApi.commitOwnerFormUpdate({
          taskId: taskId!,
          message: body,
        });
        upsertCommentInCache(result.comment);
        invalidateTaskDetail();
        invalidateTaskCollections();
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
    },
    [
      addComment,
      invalidateTaskCollections,
      invalidateTaskDetail,
      invalidateTaskRunState,
      isNamedUserCreator,
      isSystemEscalationHumanOwner,
      isUserCreatorWithdrawalOwner,
      task,
      taskId,
      reassignTask,
      upsertCommentInCache,
    ],
  );
  const handleCommentImageUpload = useCallback(
    async (file: File) => {
      const attachment = await uploadAttachment.mutateAsync(file);
      return attachment.contentPath;
    },
    [uploadAttachment],
  );
  const handleCommentAttachImage = useCallback(
    async (file: File) => {
      return uploadAttachment.mutateAsync(file);
    },
    [uploadAttachment],
  );
  const treePreviewAffectedTasks = useMemo(
    () =>
      (treeControlPreview?.tasks ?? []).filter(
        (candidate) => !candidate.skipped,
      ),
    [treeControlPreview],
  );
  // "What this affects" buckets for the pause/hold dialog (design surface 4).
  const pauseAffectsSummary = useMemo(
    () => computePauseAffectsSummary(treeControlPreview?.tasks ?? []),
    [treeControlPreview],
  );
  const treePreviewDisplayTasks = useMemo(() => {
    const previewTasks = treeControlPreview?.tasks ?? [];
    if (treeControlMode !== "pause") {
      return previewTasks.filter((candidate) => !candidate.skipped);
    }
    return previewTasks.filter(
      (candidate) =>
        !candidate.skipped || candidate.skipReason === "terminal_status",
    );
  }, [treeControlMode, treeControlPreview]);
  const activePauseHold = treeControlState?.activePauseHold ?? null;
  const activeRootPauseHoldsForDisplay = useMemo(
    () => (activePauseHold?.isRoot === true ? activeRootPauseHolds : []),
    [activePauseHold?.isRoot, activeRootPauseHolds],
  );
  const heldTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const hold of activeRootPauseHoldsForDisplay) {
      for (const member of hold.members ?? []) {
        if (member.skipped) continue;
        ids.add(member.taskId);
      }
    }
    return ids;
  }, [activeRootPauseHoldsForDisplay]);
  const mutedChildTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const child of childTasks) {
      if (heldTaskIds.has(child.id)) ids.add(child.id);
    }
    return ids;
  }, [childTasks, heldTaskIds]);
  const childPauseBadgeById = useMemo(() => {
    const badges = new Map<string, string>();
    for (const child of childTasks) {
      if (!heldTaskIds.has(child.id)) continue;
      badges.set(child.id, "Paused");
    }
    return badges;
  }, [childTasks, heldTaskIds]);
  const activePauseHoldRoot = useMemo(() => {
    if (!activePauseHold) return null;
    if (activePauseHold.rootTaskId === task?.id) return task ?? null;
    return (
      task?.ancestors?.find(
        (ancestor) => ancestor.id === activePauseHold.rootTaskId,
      ) ?? null
    );
  }, [activePauseHold, task]);
  const activeRootPauseHold = useMemo(
    () =>
      activeRootPauseHoldsForDisplay.find(
        (hold) => hold.id === activePauseHold?.holdId,
      ) ?? null,
    [activePauseHold?.holdId, activeRootPauseHoldsForDisplay],
  );

  if (isLoading) return <TaskDetailLoadingState headerSeed={taskHeaderSeed} />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!task) return null;

  // Ancestors are returned oldest-first from the server (root at end, immediate parent at start)
  const ancestors = task.ancestors ?? [];
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
  const heldDescendantCount =
    activeRootPauseHold?.members?.filter(
      (member) => member.depth > 0 && !member.skipped,
    ).length ?? Math.max(heldTaskIds.size - 1, 0);
  const canShowSubtreeControls = canManageTreeControl && childTasks.length > 0;
  const canResumeSubtree =
    canShowSubtreeControls && activePauseHold?.isRoot === true;
  const canRestoreSubtree =
    canShowSubtreeControls && activeCancelHolds.length > 0;
  const isTerminalTask =
    task.lifecycleStatus === "done" || task.lifecycleStatus === "cancelled";
  const canPauseLeafWork =
    canManageTreeControl &&
    childTasks.length === 0 &&
    !activePauseHold &&
    !isTerminalTask;
  const canResumeLeafWork =
    canManageTreeControl &&
    childTasks.length === 0 &&
    activePauseHold?.isRoot === true;
  const treeControlScope: "leaf" | "subtree" =
    childTasks.length === 0 ? "leaf" : "subtree";
  const previewAffectedTaskCount = treePreviewAffectedTasks.length;
  const treeControlPrimaryButtonLabel =
    treeControlMode === "pause"
      ? treeControlScope === "leaf"
        ? "Pause work"
        : "Pause and stop work"
      : treeControlMode === "cancel"
        ? `Cancel ${previewAffectedTaskCount} tasks`
        : treeControlMode === "restore"
          ? `Restore ${previewAffectedTaskCount} tasks`
          : treeControlScope === "leaf"
            ? "Resume work"
            : "Resume subtree";
  const pausedComposerHint = activePauseHold
    ? task.ownerAgentId
      ? `Use @ to mention ${agentMap.get(task.ownerAgentId)?.name ?? "the owner"} if you want to queue triage while the subtree remains paused. Ordinary comments do not dispatch.`
      : "Choose an agent owner or use @ to mention an eligible agent. Ordinary comments do not dispatch."
    : null;
  const composerHint = pausedComposerHint;
  const humanLifecycleFormControls =
    !isTerminalTask &&
    ((isNamedUserCreator &&
      (task.ownerKind === "agent" || isUserCreatorWithdrawalOwner)) ||
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
                  task.lifecycleStatus === "blocked"
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
              {task.lifecycleStatus === "blocked" ? "Reopen" : "Block"}
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
            disabled={withdrawAndCancelTask.isPending}
            onClick={() => withdrawAndCancelTask.mutate()}
          >
            {isUserCreatorWithdrawalOwner
              ? "Finish cancellation"
              : "Withdraw and cancel"}
          </Button>
        )}
      </div>
    ) : null;
  const canApplyTreeControl =
    Boolean(treeControlPreview) &&
    !treeControlPreviewLoading &&
    (treeControlMode !== "cancel" || treeControlCancelConfirmed);
  const attachmentUploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        aria-label="Upload task attachments"
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
        disabled={
          uploadAttachment.isPending || importMarkdownDocument.isPending
        }
        className={cn(
          "shadow-none",
          attachmentDragActive && "border-primary bg-primary/5",
        )}
      >
        <Paperclip className="h-3.5 w-3.5 mr-1.5" />
        {uploadAttachment.isPending || importMarkdownDocument.isPending ? (
          "Uploading..."
        ) : (
          <>
            <span className="hidden sm:inline">Upload attachment</span>
            <span className="sm:hidden">Upload</span>
          </>
        )}
      </Button>
    </>
  );

  return (
    <div className="max-w-3xl space-y-6">
      {/* Parent chain breadcrumb */}
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <TaskLinkQuicklook
                taskId={ancestor.id}
                taskNumber={ancestor.taskNumber}
                state={resolvedTaskDetailState ?? location.state}
                className="hover:text-foreground transition-colors truncate max-w-(--sz-200px)"
                title={taskDisplayTitle(ancestor)}
              >
                {taskDisplayTitle(ancestor)}
              </TaskLinkQuicklook>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="text-foreground/60 truncate max-w-(--sz-200px)">
            {taskDisplayTitle(task)}
          </span>
        </nav>
      )}

      {task.hiddenAt && (
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
                  {childTasks.length === 0
                    ? "Paused by board."
                    : "Subtree pause is active."}
                </span>
                <span className="text-xs text-amber-900/80 dark:text-amber-100/80">
                  {childTasks.length === 0
                    ? "Task execution is held until resume. Only an explicit @mention can queue owner triage."
                    : "Root and descendant execution is held until resume. Only explicit @mentions can queue owner triage."}
                </span>
              </div>
              <div className="text-xs text-amber-900/80 dark:text-amber-100/80">
                {childTasks.length === 0
                  ? "1 task held"
                  : `${heldDescendantCount} descendant${heldDescendantCount === 1 ? "" : "s"} held`}
                {activeRootPauseHold?.createdAt
                  ? ` · started ${relativeTime(activeRootPauseHold.createdAt)}`
                  : ""}
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
                    {childTasks.length === 0 ? "Resume work" : "Resume subtree"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setTreeControlMode("resume");
                      setTreeControlOpen(true);
                    }}
                  >
                    View affected (
                    {childTasks.length === 0 ? 1 : heldDescendantCount})
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
              {activePauseHoldRoot ? (
                <TaskLinkQuicklook
                  taskId={activePauseHoldRoot.id}
                  taskNumber={activePauseHoldRoot.taskNumber}
                  className="underline"
                >
                  {activePauseHoldRoot.identifier}
                </TaskLinkQuicklook>
              ) : (
                "the unavailable root task"
              )}
              . Resume from the root task to deliver deferred work.
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <StatusIcon
            status={task.boardPresentationStatus}
            size="lg"
            blockerAttention={task.blockerAttention}
          />
          <PriorityIcon priority={task.priority} />
          <span className="text-sm font-mono text-muted-foreground shrink-0">
            {task.identifier}
          </span>
          {task.lifecycleStatus === "done" ||
          task.lifecycleStatus === "cancelled" ? (
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
            <Badge
              variant="outline"
              className={cn("gap-1.5 text-(length:--text-nano)", liveBlueBadge)}
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
              </span>
              Live
            </Badge>
          )}

          {task.originKind === "routine_execution" && task.originId && (
            <Link
              to="/$companyId/routines/$routineId"
              params={{ companyId, routineId: task.originId }}
              className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-(length:--text-nano) font-medium text-violet-600 dark:text-violet-400 shrink-0 hover:bg-violet-500/20 transition-colors"
              title={`Routine execution from routine ${task.originId}`}
            >
              <Repeat className="h-3 w-3" />
              Routine
            </Link>
          )}

          {task.workMode === "ask" || task.workMode === "planning"
            ? (() => {
                const workModeMeta = workModeMetaFor(task.workMode);
                const WorkModeIcon = workModeMeta.icon;
                return (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-(length:--text-nano)",
                      workModeMeta.classes.badge,
                    )}
                    title={`This task is in ${workModeMeta.label.toLowerCase()}.`}
                  >
                    <WorkModeIcon className="h-3 w-3" aria-hidden />
                    {workModeMeta.label}
                  </Badge>
                );
              })()
            : null}

          {hasAssignedBacklogBlocker(task.blockedBy) ? (
            <Badge
              variant="outline"
              data-testid="task-detail-parked-blocker"
              className="border-amber-500/60 bg-amber-500/15 text-(length:--text-nano) text-amber-700 dark:text-amber-300"
              title="Blocked by parked work — at least one owned blocker is in backlog and will not dispatch its owner."
            >
              <Flag className="h-3 w-3" />
              Blocked by parked work
            </Badge>
          ) : null}

          {task.projectId && projectRouteId ? (
            <Link
              to="/$companyId/projects/$projectId"
              params={{ companyId, projectId: projectRouteId }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
            >
              <Hexagon className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {resolvedProject?.name ??
                  task.project?.name ??
                  task.projectId.slice(0, 8)}
              </span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
              <Hexagon className="h-3 w-3 shrink-0" />
              No project
            </span>
          )}

          <TaskAttributionByline
            task={task}
            agentMap={agentMap}
            userProfileMap={userProfileMap}
            userLabelMap={userLabelMap}
          />

          {(task.labels ?? []).length > 0 && (
            <div className="hidden sm:flex items-center gap-1">
              {(task.labels ?? []).slice(0, 4).map((label) => (
                <Badge
                  variant="outline"
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
              {(task.labels ?? []).length > 4 && (
                <span className="text-(length:--text-nano) text-muted-foreground">
                  +{(task.labels ?? []).length - 4}
                </span>
              )}
            </div>
          )}

          {!(isMobile && isFromInbox) && (
            <div className="ml-auto flex items-center gap-0.5 md:hidden shrink-0">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={copyTaskToClipboard}
                title="Copy task as markdown"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
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
                  if (!archivePending && task?.id)
                    archiveFromInbox.mutate(task.id);
                }}
                disabled={archivePending}
                title="Archive from inbox"
                aria-label="Archive from inbox"
              >
                <Archive className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyTaskToClipboard}
              title="Copy task as markdown"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "shrink-0 transition-opacity duration-200",
                panelVisible
                  ? "opacity-0 pointer-events-none w-0 overflow-hidden"
                  : "opacity-100",
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
          value={task.title ?? ""}
          onSave={(title) => updateTaskTitle.mutateAsync(title || null)}
          as="h2"
          className="text-xl font-bold"
          placeholder="Add a title..."
          nullable
        />

        <TaskMonitorBanner task={task} />

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Immutable request
          </h3>
          {task.request ? (
            <MarkdownBody className="text-sm leading-7 text-foreground">
              {task.request}
            </MarkdownBody>
          ) : (
            <p className="text-sm text-muted-foreground">
              Canonical request unavailable for this historical task.
            </p>
          )}
        </section>
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton"]}
        entityType="task"
        context={{
          companyId: task.companyId,
          projectId: task.projectId ?? null,
          entityId: task.id,
          entityType: "task",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="task"
        context={{
          companyId: task.companyId,
          projectId: task.projectId ?? null,
          entityId: task.id,
          entityType: "task",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <PluginSlotOutlet
        slotTypes={["taskDetailView"]}
        entityType="task"
        context={{
          companyId: task.companyId,
          projectId: task.projectId ?? null,
          entityId: task.id,
          entityType: "task",
        }}
        className="space-y-3"
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />

      {showRichSubTasksSection ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              Sub-tasks
            </h3>
          </div>
          <TasksList
            tasks={childTasks}
            isLoading={childTasksLoading}
            agents={agents}
            projects={projects}
            liveTaskIds={liveTaskIds}
            mutedTaskIds={mutedChildTaskIds}
            taskBadgeById={childPauseBadgeById}
            projectId={task.projectId ?? undefined}
            viewStateKey={`paperclip:task-detail:${task.id}:subtasks-view`}
            taskLinkState={resolvedTaskDetailState ?? location.state}
            searchFilters={{ descendantOf: task.id, includeBlockedBy: true }}
            searchWithinLoadedTasks
            baseCreateTaskDefaults={buildSubTaskDefaultsForViewer(task)}
            createTaskLabel="Sub-task"
            defaultSortField="workflow"
            showProgressSummary
            parentTaskIdForCostSummary={task.id}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
          <Button
            variant="outline"
            size="sm"
            onClick={openNewSubTask}
            className="shrink-0 shadow-none"
          >
            <Plus data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
            New Sub-task
          </Button>
        </div>
      )}

      <TaskDocumentsSection
        task={task}
        canDeleteDocuments={Boolean(session?.user?.id)}
        canManageDocumentLocks={Boolean(session?.user?.id)}
        mentions={mentionOptions}
        imageUploadHandler={async (file) => {
          const attachment = await uploadAttachment.mutateAsync(file);
          return attachment.contentPath;
        }}
        extraActions={!hasAttachments ? attachmentUploadButton : null}
        agentMap={agentMap}
        userProfileMap={userProfileMap}
      />

      <TaskOutputSection
        workProducts={workProducts}
        onMediaClick={(item) => {
          const meta = item.metadata;
          if (!meta) return;
          const idx = mediaGalleryItems.findIndex(
            (galleryItem) =>
              galleryItem.contentPath === meta.contentPath ||
              galleryItem.id === `work-product-${item.id}` ||
              galleryItem.id === meta.attachmentId,
          );
          setGalleryIndex(idx >= 0 ? idx : 0);
          setGalleryOpen(true);
        }}
      />

      {attachmentsInitialLoading ? (
        <TaskSectionSkeleton titleWidth="w-24" rows={2} />
      ) : hasAttachments ? (
        <TaskAttachmentsSection
          attachments={attachmentList}
          uploadButton={attachmentUploadButton}
          error={attachmentError}
          dragActive={attachmentDragActive}
          deletePending={deleteAttachment.isPending}
          onDelete={(attachmentId) => deleteAttachment.mutate(attachmentId)}
          onImageClick={(attachment) => {
            const idx = mediaGalleryItems.findIndex(
              (a) => a.id === attachment.id,
            );
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
            if (evt.currentTarget.contains(evt.relatedTarget as Node | null))
              return;
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

      <Tabs
        value={detailTab}
        onValueChange={setDetailTab}
        className="space-y-3"
      >
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
          {taskPluginTabItems.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="chat">
          {detailTab === "chat" ? (
            <TaskDetailChatTab
              taskId={task.id}
              companyId={task.companyId}
              projectId={task.projectId ?? null}
              taskStatus={task.boardPresentationStatus}
              taskLifecycleStatus={task.lifecycleStatus}
              taskWorkMode={task.workMode ?? "standard"}
              blockedBy={task.blockedBy ?? []}
              liveTaskIds={liveTaskIds}
              blockerAttention={task.blockerAttention ?? null}
              comments={threadComments}
              locallyQueuedCommentRunIds={locallyQueuedCommentRunIds}
              hasOlderComments={hasOlderComments}
              commentsLoadingOlder={commentsLoadingOlder}
              onLoadOlderComments={loadOlderComments}
              onRefreshLatestComments={refetchLatestComments}
              onLoadMoreCommentGroup={loadMoreCommentGroup}
              composerRef={commentComposerRef}
              composerAccessory={
                hasVisibleMonitorSurface(task) || humanLifecycleFormControls ? (
                  <div className="flex flex-col gap-2">
                    {hasVisibleMonitorSurface(task) ? (
                      <TaskMonitorComposerStrip task={task} />
                    ) : null}
                    {humanLifecycleFormControls}
                  </div>
                ) : null
              }
              footer={
                siblingNavigation ? (
                  <TaskSiblingNavigation
                    navigation={siblingNavigation}
                    linkState={resolvedTaskDetailState ?? location.state}
                  />
                ) : null
              }
              agentMap={agentMap}
              currentUserId={currentUserId}
              userLabelMap={userLabelMap}
              userProfileMap={userProfileMap}
              draftKey={`paperclip:task-comment-draft:${task.id}`}
              ownerOptions={commentOwnerOptions}
              currentOwnerValue={currentOwnerValue}
              suggestedOwnerValue={suggestedOwnerValue}
              mentions={mentionOptions}
              composerDisabledReason={
                isUserCreatorWithdrawalOwner
                  ? "This task is withdrawn; finish its cancellation above."
                  : null
              }
              composerHint={composerHint}
              onAdd={handleChatAdd}
              onImageUpload={handleCommentImageUpload}
              onAttachImage={handleCommentAttachImage}
              onImageClick={handleChatImageClick}
              ownerUserId={task.ownerUserId ?? null}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="activity">
          {detailTab === "activity" ? (
            <TaskDetailActivityTab
              taskId={task.id}
              taskStatus={task.boardPresentationStatus}
              childTasks={childTasks}
              agentMap={agentMap}
              currentUserId={currentUserId}
              userProfileMap={userProfileMap}
              pendingApprovalAction={pendingApprovalAction}
              onApprovalAction={(approvalId, action) => {
                approvalDecision.mutate({ approvalId, action });
              }}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="related-work">
          <TaskRelatedWorkPanel relatedWork={task.relatedWork} />
        </TabsContent>

        {activePluginTab && (
          <TabsContent value={activePluginTab.value}>
            <PluginSlotMount
              slot={activePluginTab.slot}
              context={{
                companyId: task.companyId,
                projectId: task.projectId ?? null,
                entityId: task.id,
                entityType: "task",
              }}
              missingBehavior="placeholder"
            />
          </TabsContent>
        )}
      </Tabs>

      <Dialog open={treeControlOpen} onOpenChange={setTreeControlOpen}>
        <DialogContent className="flex max-h-(--sz-calc-18) flex-col gap-0 overflow-hidden p-0 sm:max-w-(--sz-560px)">
          <DialogHeader className="border-b border-border/60 px-6 pb-4 pr-12 pt-6">
            <DialogTitle>
              {taskTreeControlLabel(treeControlMode, treeControlScope)}
            </DialogTitle>
            <DialogDescription>
              {taskTreeControlHelpText(treeControlMode, treeControlScope)}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4">
            {treeControlMode === "cancel" ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                Cancelling a subtree is destructive. Non-terminal tasks will be
                marked cancelled, and running or queued work will be interrupted
                where possible.
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="tree-control-reason"
              >
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
                  onChange={(event) =>
                    setTreeControlCancelConfirmed(event.target.checked)
                  }
                />
                <span>
                  I understand this will cancel {previewAffectedTaskCount}{" "}
                  tasks.
                </span>
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
                  <p className="text-xs text-destructive">
                    {treeControlPreviewErrorCopy(treeControlPreviewError)}
                  </p>
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
                        <p
                          key={warning.code}
                          className="text-xs text-amber-700 dark:text-amber-300"
                        >
                          {warning.message}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  {treePreviewDisplayTasks.length > 0 ? (
                    <div className="max-h-56 overflow-y-auto overscroll-contain">
                      {treePreviewDisplayTasks.map((candidate) => (
                        <div
                          key={candidate.id}
                          style={
                            candidate.depth > 0
                              ? {
                                  paddingLeft: `${Math.min(candidate.depth, 6) * 14}px`,
                                }
                              : undefined
                          }
                        >
                          <TaskLinkQuicklook
                            taskId={candidate.id}
                            taskNumber={candidate.taskNumber}
                            className={cn(
                              "group flex items-start gap-2 border-b border-border py-2 pl-1 pr-2 text-sm no-underline text-inherit transition-colors last:border-b-0 hover:bg-accent/50 sm:items-center",
                              candidate.skipped && "opacity-60",
                            )}
                          >
                            <StatusIcon
                              status={candidate.boardPresentationStatus}
                            />
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              {candidate.identifier}
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                              {candidate.title}
                            </span>
                            {candidate.skipped &&
                            candidate.skipReason === "terminal_status" ? (
                              <span className="shrink-0 text-xs text-muted-foreground">
                                Complete
                              </span>
                            ) : null}
                          </TaskLinkQuicklook>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Preview unavailable.
                </p>
              )}
            </div>
          </div>
          <DialogFooter className="border-t border-border/60 bg-background px-6 py-4">
            <Button
              variant="outline"
              onClick={() => setTreeControlOpen(false)}
              disabled={executeTreeControl.isPending}
            >
              Close
            </Button>
            <Button
              onClick={() => executeTreeControl.mutate()}
              disabled={executeTreeControl.isPending || !canApplyTreeControl}
              variant={treeControlMode === "cancel" ? "destructive" : "default"}
            >
              {executeTreeControl.isPending
                ? "Applying..."
                : treeControlPrimaryButtonLabel}
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
              This audited command preserves the owner and execution session,
              clears the terminal disposition, and invokes the owner with the
              stored immutable request.
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
              disabled={!reopenReason.trim() || reopenTask.isPending}
              onClick={() => reopenTask.mutate(reopenReason)}
            >
              {reopenTask.isPending ? "Reopening..." : "Reopen task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mobile properties drawer */}
      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent
          side="bottom"
          className="max-h-(--sz-85dvh) pb-(--sz-safe-bottom)"
        >
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <TaskProperties
                task={task}
                childTasks={childTasks}
                onAddSubTask={openNewSubTask}
                onUpdate={handleTaskPropertiesUpdate}
                inline
                hasActiveRun={resolvedHasActiveRun}
              />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <ScrollToBottom />
    </div>
  );
}
