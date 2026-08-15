import type { Task } from "@paperclipai/shared";
import { ChevronRight } from "lucide-react";

import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { InboxTaskMetaLeading, InboxTaskTrailingColumns, taskActivityText } from "@/routes/_authenticated/$companyId/-tasks-list/-TaskColumns";
import { TaskRow } from "@/routes/_authenticated/$companyId/-tasks-list/-TaskRow";
import {
  resolveInboxTaskBlockerAttention,
  resolveTaskLiveDescendantCount,
} from "@/lib/inbox-live-descendants";
import { formatOwnerUserLabel, taskOriginatorIds } from "@/lib/task-owners";
import { taskStatusAccessibleLabel, taskValueLabel } from "@/lib/task-blockers";
import { cn } from "@/lib/utils";

import { useInboxPage } from "./-InboxPageContext";

export interface InboxTaskItemProps {
  task: Task;
  depth: number;
  selected: boolean;
  hasChildren?: boolean;
  isExpanded?: boolean;
  childCount?: number;
  collapseParentId?: string | null;
  allowArchive?: boolean;
}

/** One task row, including nesting, ownership, live state, and archive actions. */
export function InboxTaskItem({
  task,
  depth,
  selected,
  hasChildren = false,
  isExpanded = false,
  childCount = 0,
  collapseParentId = null,
  allowArchive,
}: InboxTaskItemProps) {
  const {
    canArchiveFromTab,
    fadingOutTasks,
    archivingTaskIds,
    projectById,
    companyUserProfileMap,
    liveTaskIds,
    subtreeLiveCounts,
    visibleTaskColumnSet,
    availableTaskColumnSet,
    nestingEnabled,
    toggleInboxParentCollapse,
    taskLinkState,
    markReadMutation,
    archiveTaskMutation,
    visibleTrailingTaskColumns,
    agentName,
    currentUserId,
    companyUserLabelMap,
    taskById,
  } = useInboxPage();
  const archiveAllowed = allowArchive ?? canArchiveFromTab;
  const isUnread = task.isUnreadForMe && !fadingOutTasks.has(task.id);
  const isFading = fadingOutTasks.has(task.id);
  const isArchiving = archivingTaskIds.has(task.id);
  const project = task.projectId ? (projectById.get(task.projectId) ?? null) : null;
  const ownerUserProfile = task.ownerUserId ? (companyUserProfileMap.get(task.ownerUserId) ?? null) : null;
  const { originatingAgentId, originatingUserId, originatingViaAgentId } = taskOriginatorIds(task);
  const isLive = liveTaskIds.has(task.id);
  const loadedSubtreeLiveCount = subtreeLiveCounts.get(task.id) ?? 0;
  const liveDescendantCount = resolveTaskLiveDescendantCount(task, loadedSubtreeLiveCount);
  const blockerAttention = resolveInboxTaskBlockerAttention(task, {
    isLive,
    loadedSubtreeLiveCount,
  });
  const showStatus = visibleTaskColumnSet.has("status") && availableTaskColumnSet.has("status");
  const showSubtreeLiveChip = !(
    showStatus &&
    task.boardPresentationStatus === "blocked" &&
    blockerAttention?.state === "covered"
  );
  const statusIcon = (
    <DomainStatus
      status={task.boardPresentationStatus}
      aria-label={taskStatusAccessibleLabel(task.boardPresentationStatus, blockerAttention)}
    >
      {taskValueLabel(task.boardPresentationStatus)}
    </DomainStatus>
  );

  return (
    <TaskRow
      key={`task:${task.id}`}
      task={task}
      taskLinkState={taskLinkState}
      treeGuides={depth}
      hideDivider={hasChildren && isExpanded}
      selected={selected}
      className={
        isArchiving
          ? "pointer-events-none -translate-x-4 scale-(--s-0_98) opacity-0 transition-all duration-200 ease-out"
          : "transition-all duration-200 ease-out"
      }
      desktopMetaLeading={
        <>
          {nestingEnabled ? (
            depth === 0 && hasChildren && collapseParentId ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="hidden shrink-0 sm:inline-flex"
                aria-label="Toggle subtasks"
                aria-expanded={isExpanded}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleInboxParentCollapse(collapseParentId);
                }}
              >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")}  data-icon="inline-start"/>
              </Button>
            ) : (
              <span className="hidden w-4 shrink-0 sm:block" />
            )
          ) : null}
          <InboxTaskMetaLeading
            task={task}
            isLive={isLive}
            subtreeLiveCount={liveDescendantCount}
            showSubtreeLiveChip={showSubtreeLiveChip}
            showStatus={showStatus}
            showIdentifier={visibleTaskColumnSet.has("id") && availableTaskColumnSet.has("id")}
            statusSlot={statusIcon}
          />
        </>
      }
      titleSuffix={
        hasChildren && !isExpanded && depth === 0 ? (
          <span className="ml-1.5 text-xs text-muted-foreground">
            ({childCount} sub-task{childCount !== 1 ? "s" : ""})
          </span>
        ) : undefined
      }
      mobileMeta={taskActivityText(task).toLowerCase()}
      mobileLeading={
        depth === 0 && hasChildren && collapseParentId ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Toggle subtasks"
            aria-expanded={isExpanded}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleInboxParentCollapse(collapseParentId);
            }}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")}  data-icon="inline-start"/>
          </Button>
        ) : (
          statusIcon
        )
      }
      unreadState={isUnread ? "visible" : isFading ? "fading" : "hidden"}
      onMarkRead={() => markReadMutation.mutate(task.id)}
      onArchive={archiveAllowed ? () => archiveTaskMutation.mutate(task.id) : undefined}
      archiveDisabled={isArchiving}
      desktopTrailing={
        visibleTrailingTaskColumns.length > 0 ? (
          <InboxTaskTrailingColumns
            task={task}
            columns={visibleTrailingTaskColumns}
            projectName={project?.name ?? null}
            projectColor={project?.color ?? null}
            ownerName={agentName(task.ownerAgentId)}
            ownerUserName={
              formatOwnerUserLabel(task.ownerUserId, currentUserId, companyUserLabelMap) ??
              ownerUserProfile?.label ??
              null
            }
            ownerUserAvatarUrl={ownerUserProfile?.image ?? null}
            originatingAgentName={agentName(originatingAgentId)}
            creatorUserName={
              originatingUserId ? (companyUserProfileMap.get(originatingUserId)?.label ?? null) : null
            }
            creatorUserAvatarUrl={
              originatingUserId ? (companyUserProfileMap.get(originatingUserId)?.image ?? null) : null
            }
            viaAgentName={originatingViaAgentId ? agentName(originatingViaAgentId) : null}
            currentUserId={currentUserId}
            parentIdentifier={task.parentId ? (taskById.get(task.parentId)?.identifier ?? null) : null}
            parentTitle={task.parentId ? (taskById.get(task.parentId)?.title ?? null) : null}
          />
        ) : undefined
      }
    />
  );
}
