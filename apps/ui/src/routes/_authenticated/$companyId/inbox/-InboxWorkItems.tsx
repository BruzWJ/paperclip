import { SwipeToArchive } from "@/routes/_authenticated/$companyId/inbox/-SwipeToArchive";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Item } from "@/components/ui/item";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Separator } from "@/components/ui/separator";
import { getInboxWorkItemKey } from "@/lib/inbox";
import { cn } from "@/lib/utils";
import type { Task } from "@paperclipai/shared";
import { ChevronRight, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { ApprovalInboxRow } from "./-ApprovalInboxRow";
import { FailedRunInboxRow } from "./-FailedRunInboxRow";
import { useInboxPage } from "./-InboxPageContext";
import { InboxTaskItem } from "./-InboxTaskItem";
import { JoinRequestInboxRow } from "./-JoinRequestInboxRow";

const ARCHIVING_ROW_CLASS =
  "pointer-events-none -translate-x-4 scale-(--s-0_98) opacity-0 transition-all duration-200 ease-out";
const ACTIVE_ROW_CLASS = "transition-all duration-200 ease-out";

function InboxArchiveSurface({
  enabled,
  selected,
  disabled,
  onArchive,
  children,
}: {
  enabled: boolean;
  selected: boolean;
  disabled: boolean;
  onArchive: () => void;
  children: ReactNode;
}) {
  return enabled ? (
    <SwipeToArchive selected={selected} disabled={disabled} onArchive={onArchive}>
      {children}
    </SwipeToArchive>
  ) : (
    <Item className={cn("block border-0 p-0", selected && "bg-accent/50")}>{children}</Item>
  );
}

export function InboxWorkItems() {
  const {
    tab,
    groupBy,
    dismissInboxItem,
    canArchiveFromTab,
    archivingTaskIds,
    taskById,
    collapsedInboxParents,
    collapsedGroupKeys,
    toggleGroupCollapse,
    groupedSections,
    openCreateTaskForGroup,
    topFlatIndex,
    childFlatIndex,
    groupFlatIndex,
    agentName,
    approveMutation,
    rejectMutation,
    approveJoinMutation,
    rejectJoinMutation,
    archivingNonTaskIds,
    selectedIndex,
    setSelectedIndex,
    listRef,
    setSelectedIndexFromPointer,
    archiveTaskMutation,
    handleMarkNonTaskRead,
    handleArchiveNonTask,
    nonTaskUnreadState,
    showWorkItemsSection,
    showSeparatorBefore,
  } = useInboxPage();
  return (
    <>
      {tab !== "blocked" && showWorkItemsSection && (
        <>
          {showSeparatorBefore("work_items") && <Separator />}
          <div>
            <div ref={listRef} className="overflow-hidden">
              {(() => {
                let previousTimestamp = Number.POSITIVE_INFINITY;
                return groupedSections.flatMap((group, groupIndex) => {
                  const elements: ReactNode[] = [];
                  const isGroupCollapsed = collapsedGroupKeys.has(group.key);
                  if (
                    group.searchSection !== "none" &&
                    group.searchSection !== groupedSections[groupIndex - 1]?.searchSection
                  ) {
                    elements.push(
                      <Marker
                        key={`${group.searchSection}-search-divider`}
                        variant="separator"
                        className="px-4 py-2"
                      >
                        <MarkerContent>
                          {group.searchSection === "archived" ? "Archived" : "Other results"}
                        </MarkerContent>
                      </Marker>,
                    );
                  }
                  if (group.label) {
                    const groupNavIdx = groupFlatIndex.get(group.key) ?? -1;
                    const isGroupSelected = groupNavIdx >= 0 && selectedIndex === groupNavIdx;
                    const canCreateTaskInGroup = group.displayItems.some((item) => item.kind === "task");
                    elements.push(
                      <div
                        key={`group-${group.key}`}
                        data-inbox-item
                        className={cn(groupIndex > 0 && "pt-2")}
                        onFocusCapture={() => {
                          if (groupNavIdx >= 0) setSelectedIndex(groupNavIdx);
                        }}
                        onMouseEnter={() => {
                          if (groupNavIdx >= 0) setSelectedIndexFromPointer(groupNavIdx);
                        }}
                      >
                        <div
                          className={cn(
                            "rounded-lg px-3 sm:pl-0 sm:pr-4",
                            isGroupSelected ? "bg-accent/50" : "hover:bg-accent/50",
                          )}
                        >
                          <Collapsible
                            open={!isGroupCollapsed}
                            onOpenChange={() => toggleGroupCollapse(group.key)}
                          >
                            <div className="flex items-center py-1.5 pl-1 pr-3">
                              <CollapsibleTrigger asChild>
                                <Button
                                  variant="ghost"
                                  className="h-auto min-w-0 justify-start gap-2 p-0 text-left"
                                  aria-label={`${isGroupCollapsed ? "Expand" : "Collapse"} ${group.label}`}
                                >
                                  <span className="inline-flex w-4 shrink-0 items-center justify-center">
                                    <ChevronRight
                                      className={cn(
                                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                                        !isGroupCollapsed && "rotate-90",
                                      )}
                                     data-icon="inline-start"/>
                                  </span>
                                  <span className="truncate text-sm font-semibold uppercase tracking-wide">
                                    {group.label}
                                  </span>
                                </Button>
                              </CollapsibleTrigger>
                              {canCreateTaskInGroup ? (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  className="-mr-2 ml-auto text-muted-foreground"
                                  title={`New task in ${group.label}`}
                                  aria-label={`New task in ${group.label}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openCreateTaskForGroup(group);
                                  }}
                                >
                                  <Plus className="h-3 w-3"  data-icon="inline-start"/>
                                </Button>
                              ) : null}
                            </div>
                          </Collapsible>
                        </div>
                      </div>,
                    );
                  }
                  if (isGroupCollapsed) return elements;

                  for (let index = 0; index < group.displayItems.length; index += 1) {
                    const item = group.displayItems[index]!;
                    const navIdx = topFlatIndex.get(`${group.key}:${getInboxWorkItemKey(item)}`) ?? 0;
                    const wrapItem = (key: string, child: ReactNode) => (
                      <div
                        key={`sel-${key}`}
                        data-inbox-item
                        className="relative"
                        onFocusCapture={() => setSelectedIndex(navIdx)}
                        onMouseEnter={() => setSelectedIndexFromPointer(navIdx)}
                      >
                        {child}
                      </div>
                    );
                    const todayCutoff = Date.now() - 24 * 60 * 60 * 1000;
                    const showTodayDivider =
                      groupBy === "none" &&
                      item.timestamp > 0 &&
                      item.timestamp < todayCutoff &&
                      previousTimestamp >= todayCutoff;
                    previousTimestamp = item.timestamp > 0 ? item.timestamp : previousTimestamp;
                    if (showTodayDivider) {
                      elements.push(
                        <div
                          key={`today-divider-${group.key}-${index}`}
                          className="my-2 flex items-center gap-3 px-4"
                        >
                          <Separator className="flex-1" />
                          <span className="shrink-0 text-(length:--text-micro) font-medium uppercase tracking-wider text-muted-foreground">
                            Earlier
                          </span>
                          <Separator className="flex-1" />
                        </div>,
                      );
                    }
                    const isSelected = selectedIndex === navIdx;

                    if (item.kind === "approval") {
                      const approvalKey = `approval:${item.approval.id}`;
                      const isArchiving = archivingNonTaskIds.has(approvalKey);
                      const row = (
                        <ApprovalInboxRow
                          key={approvalKey}
                          approval={item.approval}
                          selected={isSelected}
                          requesterName={agentName(item.approval.requestedByAgentId)}
                          onApprove={() => approveMutation.mutate(item.approval.id)}
                          onReject={() => rejectMutation.mutate(item.approval.id)}
                          isPending={approveMutation.isPending || rejectMutation.isPending}
                          unreadState={nonTaskUnreadState(approvalKey)}
                          onMarkRead={() => handleMarkNonTaskRead(approvalKey)}
                          onArchive={canArchiveFromTab ? () => handleArchiveNonTask(approvalKey) : undefined}
                          archiveDisabled={isArchiving}
                          className={isArchiving ? ARCHIVING_ROW_CLASS : ACTIVE_ROW_CLASS}
                        />
                      );
                      elements.push(
                        wrapItem(
                          approvalKey,
                          <InboxArchiveSurface
                            enabled={canArchiveFromTab}
                            selected={isSelected}
                            disabled={isArchiving}
                            onArchive={() => handleArchiveNonTask(approvalKey)}
                          >
                            {row}
                          </InboxArchiveSurface>,
                        ),
                      );
                      continue;
                    }

                    if (item.kind === "failed_run") {
                      const runKey = `run:${item.run.id}`;
                      const isArchiving = archivingNonTaskIds.has(runKey);
                      const row = (
                        <FailedRunInboxRow
                          key={runKey}
                          run={item.run}
                          selected={isSelected}
                          taskById={taskById}
                          agentName={agentName(item.run.targetAgentId)}
                          agentId={item.run.targetAgentId}
                          onDismiss={() => dismissInboxItem(runKey)}
                          unreadState={nonTaskUnreadState(runKey)}
                          onMarkRead={() => handleMarkNonTaskRead(runKey)}
                          onArchive={canArchiveFromTab ? () => handleArchiveNonTask(runKey) : undefined}
                          archiveDisabled={isArchiving}
                          className={isArchiving ? ARCHIVING_ROW_CLASS : ACTIVE_ROW_CLASS}
                        />
                      );
                      elements.push(
                        wrapItem(
                          runKey,
                          <InboxArchiveSurface
                            enabled={canArchiveFromTab}
                            selected={isSelected}
                            disabled={isArchiving}
                            onArchive={() => handleArchiveNonTask(runKey)}
                          >
                            {row}
                          </InboxArchiveSurface>,
                        ),
                      );
                      continue;
                    }

                    if (item.kind === "join_request") {
                      const joinKey = `join:${item.joinRequest.id}`;
                      const isArchiving = archivingNonTaskIds.has(joinKey);
                      const row = (
                        <JoinRequestInboxRow
                          key={joinKey}
                          joinRequest={item.joinRequest}
                          onApprove={() => approveJoinMutation.mutate(item.joinRequest)}
                          onReject={() => rejectJoinMutation.mutate(item.joinRequest)}
                          isPending={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                          unreadState={nonTaskUnreadState(joinKey)}
                          onMarkRead={() => handleMarkNonTaskRead(joinKey)}
                          onArchive={canArchiveFromTab ? () => handleArchiveNonTask(joinKey) : undefined}
                          archiveDisabled={isArchiving}
                          className={isArchiving ? ARCHIVING_ROW_CLASS : ACTIVE_ROW_CLASS}
                        />
                      );
                      elements.push(
                        wrapItem(
                          joinKey,
                          <InboxArchiveSurface
                            enabled={canArchiveFromTab}
                            selected={isSelected}
                            disabled={isArchiving}
                            onArchive={() => handleArchiveNonTask(joinKey)}
                          >
                            {row}
                          </InboxArchiveSurface>,
                        ),
                      );
                      continue;
                    }

                    const task = item.task;
                    const childTasks = group.childrenByTaskId.get(task.id) ?? [];
                    const hasChildren = childTasks.length > 0;
                    const isExpanded = hasChildren && !collapsedInboxParents.has(task.id);
                    const canArchiveTask = canArchiveFromTab && group.searchSection === "none";
                    const renderChildTaskRows = (
                      children: Task[],
                      depth: number,
                      seen: ReadonlySet<string>,
                    ): ReactNode[] =>
                      children.flatMap((child) => {
                        if (seen.has(child.id)) return [];
                        const nextSeen = new Set(seen);
                        nextSeen.add(child.id);
                        const childNavIdx = childFlatIndex.get(child.id) ?? -1;
                        const isChildSelected = selectedIndex === childNavIdx;
                        const grandchildTasks = group.childrenByTaskId.get(child.id) ?? [];
                        const childHasChildren = grandchildTasks.length > 0;
                        const childIsExpanded = childHasChildren && !collapsedInboxParents.has(child.id);
                        const childRow = (
                          <InboxTaskItem
                            task={child}
                            depth={depth}
                            selected={isChildSelected}
                            hasChildren={childHasChildren}
                            isExpanded={childIsExpanded}
                            childCount={grandchildTasks.length}
                            collapseParentId={child.id}
                            allowArchive={canArchiveTask}
                          />
                        );
                        const isChildArchiving = archivingTaskIds.has(child.id);
                        const row = (
                          <div
                            key={`sel-task:${child.id}`}
                            data-inbox-item
                            className="relative"
                            onFocusCapture={() => {
                              if (childNavIdx >= 0) setSelectedIndex(childNavIdx);
                            }}
                            onMouseEnter={() => {
                              if (childNavIdx >= 0) setSelectedIndexFromPointer(childNavIdx);
                            }}
                          >
                            <InboxArchiveSurface
                              enabled={canArchiveTask}
                              selected={isChildSelected}
                              disabled={isChildArchiving}
                              onArchive={() => archiveTaskMutation.mutate(child.id)}
                            >
                              {childRow}
                            </InboxArchiveSurface>
                          </div>
                        );

                        return childIsExpanded
                          ? [row, ...renderChildTaskRows(grandchildTasks, depth + 1, nextSeen)]
                          : [row];
                      });
                    const parentRow = (
                      <InboxTaskItem
                        task={task}
                        depth={0}
                        selected={isSelected}
                        hasChildren={hasChildren}
                        isExpanded={isExpanded}
                        childCount={childTasks.length}
                        collapseParentId={task.id}
                        allowArchive={canArchiveTask}
                      />
                    );

                    elements.push(
                      wrapItem(
                        `task:${task.id}`,
                        <InboxArchiveSurface
                          enabled={canArchiveTask}
                          selected={isSelected}
                          disabled={archivingTaskIds.has(task.id)}
                          onArchive={() => archiveTaskMutation.mutate(task.id)}
                        >
                          {parentRow}
                        </InboxArchiveSurface>,
                      ),
                    );

                    if (isExpanded) {
                      elements.push(...renderChildTaskRows(childTasks, 1, new Set([task.id])));
                    }
                  }

                  return elements;
                });
              })()}
            </div>
          </div>
        </>
      )}
    </>
  );
}
