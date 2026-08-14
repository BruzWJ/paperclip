import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { Task } from "@paperclipai/shared";
import { tasksApi } from "../api/tasks";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { applyTaskFilters, type TaskFilterState } from "../lib/task-filters";
import { resolveInboxTaskBlockerAttention } from "../lib/inbox-live-descendants";
import {
  blockedRowMatchesSearch,
  blockedVariantLabel,
  buildBlockedInboxRows,
  formatStoppedAge,
  groupBlockedInboxRows,
  sortBlockedInboxRows,
  type BlockedInboxGroupBy,
  type BlockedInboxTaskRow,
  type BlockedInboxSort,
} from "../lib/blockedInbox";
import { TaskRow } from "./TaskRow";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { deriveInitials } from "@/lib/identity";
import { taskStatusAccessibleLabel, taskValueLabel } from "@/lib/task-blockers";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";

interface BlockedInboxViewProps {
  companyId: string;
  searchQuery: string;
  agentNameById: ReadonlyMap<string, string>;
  userLabelById?: ReadonlyMap<string, string>;
  taskLinkState: unknown;
  groupBy: BlockedInboxGroupBy;
  sortBy: BlockedInboxSort;
  taskFilters: TaskFilterState;
  liveTaskIds: ReadonlySet<string>;
  subtreeLiveCounts: ReadonlyMap<string, number>;
  showStatusColumn: boolean;
  showIdentifierColumn: boolean;
  showUpdatedColumn: boolean;
}

const BLOCKED_LIST_LIMIT = 200;

export function BlockedInboxView({
  companyId,
  searchQuery,
  agentNameById,
  userLabelById,
  taskLinkState,
  groupBy,
  sortBy,
  taskFilters,
  liveTaskIds,
  subtreeLiveCounts,
  showStatusColumn,
  showIdentifierColumn,
  showUpdatedColumn,
}: BlockedInboxViewProps) {
  const [collapsedVariants, setCollapsedVariants] = useState<Set<string>>(() => new Set());

  const {
    data: tasks = [] as Task[],
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: [...queryKeys.tasks.listBlockedAttention(companyId), "live-descendant-summary"],
    queryFn: () =>
      tasksApi.list(companyId, {
        attention: "blocked",
        includeBlockedInboxAttention: true,
        includeBlockedBy: true,
        includeLiveDescendantSummary: true,
        limit: BLOCKED_LIST_LIMIT,
      }),
  });

  const allRows = useMemo(() => buildBlockedInboxRows(tasks), [tasks]);
  const filteredRows = useMemo(
    () => allRows.filter((row) => blockedRowMatchesSearch(row, searchQuery)),
    [allRows, searchQuery],
  );
  const taskFilteredRows = useMemo(() => {
    const visibleTaskIds = new Set(
      applyTaskFilters(
        filteredRows.map((row) => row.task),
        taskFilters,
        true,
        liveTaskIds,
      ).map((task) => task.id),
    );
    return filteredRows.filter((row) => visibleTaskIds.has(row.task.id));
  }, [filteredRows, taskFilters, liveTaskIds]);
  const sortedRows = useMemo(
    () => sortBlockedInboxRows(taskFilteredRows, sortBy),
    [taskFilteredRows, sortBy],
  );
  const groups = useMemo(() => groupBlockedInboxRows(taskFilteredRows, sortBy), [taskFilteredRows, sortBy]);

  const toggleVariant = (variant: string) => {
    setCollapsedVariants((prev) => {
      const next = new Set(prev);
      if (next.has(variant)) next.delete(variant);
      else next.add(variant);
      return next;
    });
  };
  const renderBlockedRow = (row: BlockedInboxTaskRow) => (
    <BlockedInboxRow
      key={row.task.id}
      row={row}
      taskLinkState={taskLinkState}
      agentNameById={agentNameById}
      userLabelById={userLabelById}
      liveTaskIds={liveTaskIds}
      subtreeLiveCounts={subtreeLiveCounts}
      showStatusColumn={showStatusColumn}
      showIdentifierColumn={showIdentifierColumn}
      showUpdatedColumn={showUpdatedColumn}
    />
  );

  if (isLoading) {
    return (
      <div data-testid="blocked-inbox-loading" className="space-y-3" aria-busy="true">
        {Array.from({ length: 3 }).map((_, groupIdx) => (
          <div key={groupIdx} className="space-y-1">
            <Skeleton className="h-4 w-40" />
            {Array.from({ length: 2 }).map((__, rowIdx) => (
              <div
                key={rowIdx}
                className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5 sm:px-4"
              >
                <Skeleton className="size-3.5 rounded-full" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="hidden h-3 w-24 sm:block" />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    const message = error instanceof Error ? error.message : "Couldn't load the Blocked tab.";
    return (
      <Alert data-testid="blocked-inbox-error">
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>Couldn&apos;t load the Blocked tab.</AlertTitle>
        <AlertDescription>
          <p>Other Inbox tabs still work. {message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Trying…" : "Try again"}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (allRows.length === 0) {
    return <BlockedInboxEmptyState />;
  }

  if (groups.length === 0) {
    return (
      <div className="space-y-3">
        <Empty data-testid="blocked-inbox-no-search-results">
          <EmptyHeader>
            <EmptyTitle>No matching stopped items</EmptyTitle>
            <EmptyDescription>No stopped items match your search.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div data-testid="blocked-inbox" className="space-y-3">
      <div className="overflow-hidden rounded-xl">
        {groupBy === "none"
          ? sortedRows.map(renderBlockedRow)
          : groups.map((group) => {
              const isCollapsed = collapsedVariants.has(group.variant);
              return (
                <Collapsible
                  key={group.variant}
                  open={!isCollapsed}
                  onOpenChange={() => toggleVariant(group.variant)}
                  asChild
                >
                  <div data-testid={`blocked-inbox-group-${group.variant}`}>
                    <div className="px-3 sm:px-4">
                      <div className="flex items-center py-1.5 pl-1 pr-3">
                        <CollapsibleTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-auto min-w-0 gap-2 p-0 text-left"
                            aria-expanded={!isCollapsed}
                          >
                            <ChevronRight
                              className={cn(
                                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                                !isCollapsed && "rotate-90",
                              )}
                            />
                            <span className="truncate text-sm font-semibold uppercase tracking-wide">
                              {group.label} · {group.rows.length}
                            </span>
                          </Button>
                        </CollapsibleTrigger>
                      </div>
                    </div>
                    <CollapsibleContent>{group.rows.map(renderBlockedRow)}</CollapsibleContent>
                  </div>
                </Collapsible>
              );
            })}
      </div>
    </div>
  );
}

function BlockedInboxEmptyState() {
  return (
    <Empty data-testid="blocked-inbox-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CheckCircle2 aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No work is stopped.</EmptyTitle>
        <EmptyDescription>
          Tasks that need a decision, recovery, or external action will appear here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

interface BlockedInboxRowProps {
  row: BlockedInboxTaskRow;
  taskLinkState: unknown;
  agentNameById: ReadonlyMap<string, string>;
  userLabelById?: ReadonlyMap<string, string>;
  liveTaskIds: ReadonlySet<string>;
  subtreeLiveCounts: ReadonlyMap<string, number>;
  showStatusColumn: boolean;
  showIdentifierColumn: boolean;
  showUpdatedColumn: boolean;
}

function resolveOwnerName(
  row: BlockedInboxTaskRow,
  agentNameById: ReadonlyMap<string, string>,
  userLabelById?: ReadonlyMap<string, string>,
): { label: string | null; isAgent: boolean } {
  const owner = row.attention.owner;
  if (owner.label) return { label: owner.label, isAgent: owner.type === "agent" };
  if (owner.agentId) {
    return { label: agentNameById.get(owner.agentId) ?? null, isAgent: true };
  }
  if (owner.userId) {
    return { label: userLabelById?.get(owner.userId) ?? null, isAgent: false };
  }
  return { label: null, isAgent: false };
}

function BlockedInboxRow({
  row,
  taskLinkState,
  agentNameById,
  userLabelById,
  liveTaskIds,
  subtreeLiveCounts,
  showStatusColumn,
  showIdentifierColumn,
  showUpdatedColumn,
}: BlockedInboxRowProps) {
  const { label: ownerName, isAgent } = resolveOwnerName(row, agentNameById, userLabelById);
  const stoppedAge = formatStoppedAge(row.attention.stoppedSinceAt);
  const blockerAttention = resolveInboxTaskBlockerAttention(row.task, {
    isLive: liveTaskIds.has(row.task.id),
    loadedSubtreeLiveCount: subtreeLiveCounts.get(row.task.id) ?? 0,
  });
  const reasonLabel = blockedVariantLabel(row.variant);
  const reasonBadgeVariant =
    row.variant === "stalled" || row.variant === "needs_attention"
      ? "destructive"
      : row.variant === "external_wait"
        ? "outline"
        : "secondary";

  const desktopTrailing = (
    <span className="flex shrink-0 items-center gap-3 text-xs">
      <span
        className="hidden w-(--sz-10_5rem) shrink-0 justify-start sm:inline-flex"
        data-testid="blocked-row-reason-column"
      >
        <Badge
          variant={reasonBadgeVariant}
          aria-label={`Reason: ${reasonLabel}, severity ${row.attention.severity}`}
          className="max-w-full"
        >
          {reasonLabel}
        </Badge>
      </span>
      {ownerName ? (
        <span
          className="hidden w-(--sz-150px) min-w-0 items-center gap-1 text-muted-foreground sm:inline-flex"
          title={ownerName}
        >
          <Avatar size="sm">
            <AvatarFallback>{deriveInitials(ownerName)}</AvatarFallback>
          </Avatar>
          <span className="truncate text-sm">{ownerName}</span>
        </span>
      ) : (
        <span className="hidden w-(--sz-150px) shrink-0 sm:inline-flex" aria-hidden="true" />
      )}
      {showUpdatedColumn ? (
        <span
          className="hidden w-(--sz-5_75rem) text-right text-muted-foreground sm:inline"
          data-testid="blocked-row-age"
        >
          {stoppedAge}
        </span>
      ) : null}
    </span>
  );

  const mobileMeta = (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <span data-testid="blocked-row-age-mobile">{stoppedAge}</span>
      {ownerName ? (
        <>
          <span aria-hidden="true">·</span>
          <span
            className={cn(isAgent ? "font-medium text-foreground/90" : null)}
            data-testid="blocked-row-owner-mobile"
          >
            {ownerName}
          </span>
        </>
      ) : null}
    </span>
  );

  return (
    <TaskRow
      task={row.task}
      taskLinkState={taskLinkState}
      desktopMetaLeading={
        <BlockedRowDesktopMeta
          row={row}
          blockerAttention={blockerAttention}
          showStatusColumn={showStatusColumn}
          showIdentifierColumn={showIdentifierColumn}
        />
      }
      mobileLeading={
        <span className="flex shrink-0 items-center gap-1.5 pt-px">
          <DomainStatus
            status={row.task.boardPresentationStatus}
            aria-label={taskStatusAccessibleLabel(row.task.boardPresentationStatus, blockerAttention)}
          >
            {taskValueLabel(row.task.boardPresentationStatus)}
          </DomainStatus>
        </span>
      }
      titleSuffix={
        <Badge
          variant={reasonBadgeVariant}
          aria-label={`Reason: ${reasonLabel}, severity ${row.attention.severity}`}
          className="ml-2 max-w-(--sz-12rem) align-middle sm:hidden"
        >
          {reasonLabel}
        </Badge>
      }
      mobileMeta={mobileMeta}
      desktopTrailing={desktopTrailing}
    />
  );
}

function BlockedRowDesktopMeta({
  row,
  blockerAttention,
  showStatusColumn,
  showIdentifierColumn,
}: {
  row: BlockedInboxTaskRow;
  blockerAttention: Task["blockerAttention"] | null;
  showStatusColumn: boolean;
  showIdentifierColumn: boolean;
}) {
  const identifier = row.task.identifier;
  return (
    <span className="hidden shrink-0 items-center gap-2 sm:inline-flex">
      {showStatusColumn ? (
        <DomainStatus
          status={row.task.boardPresentationStatus}
          aria-label={taskStatusAccessibleLabel(row.task.boardPresentationStatus, blockerAttention)}
        >
          {taskValueLabel(row.task.boardPresentationStatus)}
        </DomainStatus>
      ) : null}
      {showIdentifierColumn ? (
        <span className="font-mono text-xs text-muted-foreground">{identifier}</span>
      ) : null}
    </span>
  );
}
