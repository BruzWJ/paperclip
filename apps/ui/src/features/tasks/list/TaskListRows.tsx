import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Item } from "@/components/ui/item";
import { ChevronRight, Plus } from "lucide-react";
import { deriveOriginatingActor, type Task } from "@paperclipai/shared";
import { buildTaskTree, countDescendants } from "@/lib/task-tree";
import { cn } from "@/lib/utils";
import { formatOwnerUserLabel } from "@/lib/task-owners";
import { deriveInitials } from "@/lib/identity";
import { taskStatusAccessibleLabel, taskValueLabel } from "@/lib/task-blockers";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { InboxTaskMetaLeading, InboxTaskTrailingColumns } from "./TaskColumns";
import { TaskRow } from "./TaskRow";
import { useTasksListViewModel } from "./context";

export function TaskListRows() {
  const model = useTasksListViewModel();
  const {
    groupedContent,
    viewState,
    selectedNavKey,
    workflowChecklistMeta,
    taskById,
    projectById,
    taskBadgeById,
    mutedTaskIds,
    companyUserProfileMap,
    currentUserId,
    companyUserLabelMap,
    visibleTaskColumnSet,
    availableTaskColumnSet,
    liveTaskIds,
    subtreeLiveCounts,
    taskLinkState,
    visibleTrailingTaskColumns,
    remainingTaskRowCount,
    hasMoreTasks,
    isLoadingMoreTasks,
    renderedTaskRowLimit,
    filtered,
  } = model.values;
  let remainingRowsToRender = model.values.remainingRowsToRender;
  const { updateView, setNavSelectionFromPointer, openCreateTaskDialog, agentName } = model.actions;
  return (
    <>
      {groupedContent.map((group: { key: string; label: string | null; items: Task[] }) => {
        if (remainingRowsToRender <= 0) return null;
        return (
          <Collapsible
            key={group.key}
            open={!viewState.collapsedGroups.includes(group.key)}
            onOpenChange={(open) =>
              updateView({
                collapsedGroups: open
                  ? viewState.collapsedGroups.filter((key: string) => key !== group.key)
                  : [...viewState.collapsedGroups, group.key],
              })
            }
          >
            {group.label ? (
              <Item
                data-tasks-group-key={group.key}
                variant={selectedNavKey === `group:${group.key}` ? "muted" : "default"}
                size="sm"
                className="flex-nowrap"
                onMouseEnter={() => setNavSelectionFromPointer(`group:${group.key}`)}
              >
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" className="min-w-0 flex-1 justify-start">
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 transition-transform",
                        !viewState.collapsedGroups.includes(group.key) && "rotate-90",
                      )}
                     data-icon="inline-start"/>
                    <span className="truncate text-sm font-semibold uppercase tracking-wide">
                      {group.label}
                    </span>
                  </Button>
                </CollapsibleTrigger>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-muted-foreground"
                  title={`New task in ${group.label}`}
                  aria-label={`New task in ${group.label}`}
                  onClick={() => openCreateTaskDialog(group)}
                >
                  <Plus className="h-3 w-3"  data-icon="inline-start"/>
                </Button>
              </Item>
            ) : null}
            <CollapsibleContent>
              {(() => {
                const { roots, childMap } = viewState.nestingEnabled
                  ? buildTaskTree(group.items)
                  : { roots: group.items, childMap: new Map<string, Task[]>() };
                const renderTaskRow = (task: Task, depth: number): React.ReactNode => {
                  if (remainingRowsToRender <= 0) return null;
                  remainingRowsToRender -= 1;
                  const children = childMap.get(task.id) ?? [];
                  const hasChildren = children.length > 0;
                  const totalDescendants = hasChildren ? countDescendants(task.id, childMap) : 0;
                  const isExpanded = !viewState.collapsedParents.includes(task.id);
                  const taskProject = task.projectId ? (projectById.get(task.projectId) ?? null) : null;
                  const parentTask = task.parentId ? (taskById.get(task.parentId) ?? null) : null;
                  const taskBadge = taskBadgeById?.get(task.id);
                  const isMutedTask = mutedTaskIds?.has(task.id) === true;
                  const ownerUserProfile = task.ownerUserId
                    ? (companyUserProfileMap.get(task.ownerUserId) ?? null)
                    : null;
                  const ownerUserLabel =
                    formatOwnerUserLabel(task.ownerUserId, currentUserId, companyUserLabelMap) ??
                    ownerUserProfile?.label ??
                    null;
                  const originatingActor = deriveOriginatingActor(task);
                  const originatingAgentId = originatingActor?.kind === "agent" ? originatingActor.id : null;
                  const originatingUserId = originatingActor?.kind === "user" ? originatingActor.id : null;
                  const originatingViaAgentId =
                    originatingActor?.kind === "user" ? (originatingActor.viaAgentId ?? null) : null;
                  const toggleCollapse = (event: { preventDefault(): void; stopPropagation(): void }) => {
                    event.preventDefault();
                    event.stopPropagation();
                    updateView({
                      collapsedParents: isExpanded
                        ? [...viewState.collapsedParents, task.id]
                        : viewState.collapsedParents.filter((id: string) => id !== task.id),
                    });
                  };
                  const checklistMeta = workflowChecklistMeta;
                  const checklistStepNumber = checklistMeta?.stepNumberByTaskId.get(task.id) ?? null;
                  const unresolvedVisibleBlockers =
                    checklistMeta?.unresolvedVisibleBlockersByTaskId.get(task.id) ?? [];
                  const visibleBlockerChips = unresolvedVisibleBlockers
                    .map((blockerId: string) => {
                      const blockerTask = taskById.get(blockerId);
                      if (!blockerTask) return null;
                      const step = checklistMeta?.stepNumberByTaskId.get(blockerId);
                      return {
                        blockerId,
                        chipLabel: `blocked by ${blockerTask.identifier}${step ? ` · step ${step}` : ""}`,
                      };
                    })
                    .filter(Boolean) as { blockerId: string; chipLabel: string }[];
                  const firstChip = visibleBlockerChips[0];
                  const extra = Math.max(visibleBlockerChips.length - 1, 0);
                  const displayLabel = firstChip
                    ? `${firstChip.chipLabel}${extra ? ` ... and ${extra} more` : ""}`
                    : "";
                  const firstVisibleBlockerTitle = extra
                    ? `${displayLabel}: ${visibleBlockerChips
                        .slice(1)
                        .map((chip) => chip.chipLabel)
                        .join(", ")}`
                    : displayLabel;
                  const checklistDependencyChips =
                    checklistMeta && firstChip ? (
                      <Button
                        key={firstChip.blockerId}
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const target = document.getElementById(`task-workflow-row-${firstChip.blockerId}`);
                          target?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                          target?.focus?.();
                        }}
                        className="text-(length:--text-nano)"
                        title={firstVisibleBlockerTitle}
                        aria-label={firstVisibleBlockerTitle}
                      >
                        {displayLabel}
                      </Button>
                    ) : null;
                  const status = (
                    <DomainStatus
                      status={task.boardPresentationStatus}
                      aria-label={taskStatusAccessibleLabel(
                        task.boardPresentationStatus,
                        task.blockerAttention,
                      )}
                    >
                      {taskValueLabel(task.boardPresentationStatus)}
                    </DomainStatus>
                  );
                  return (
                    <div
                      key={task.id}
                      data-task-row-id={task.id}
                      className={
                        depth > 0
                          ? ["", "pl-4 sm:pl-0", "pl-8 sm:pl-0", "pl-12 sm:pl-0", "pl-16 sm:pl-0"][
                              Math.min(depth, 4)
                            ]
                          : undefined
                      }
                      style={
                        !(hasChildren && isExpanded)
                          ? { contentVisibility: "auto", containIntrinsicSize: "44px" }
                          : undefined
                      }
                    >
                      <TaskRow
                        task={task}
                        taskLinkState={taskLinkState}
                        selected={selectedNavKey === `task:${task.id}`}
                        onMouseEnter={() => setNavSelectionFromPointer(`task:${task.id}`)}
                        treeGuides={depth}
                        chevronInGuide={depth > 0 && hasChildren}
                        hideDivider={hasChildren && isExpanded}
                        checklistStepNumber={checklistStepNumber}
                        checklistCurrentStep={checklistMeta?.currentStepTaskId === task.id}
                        checklistDependencyChips={checklistDependencyChips}
                        checklistRowId={checklistMeta ? `task-workflow-row-${task.id}` : undefined}
                        titleClassName={
                          checklistMeta && task.boardPresentationStatus === "done"
                            ? "text-muted-foreground"
                            : undefined
                        }
                        titleSuffix={
                          <>
                            {hasChildren && !isExpanded ? (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                ({totalDescendants} sub-task{totalDescendants !== 1 ? "s" : ""})
                              </span>
                            ) : null}
                            {taskBadge === "Paused" ? (
                              <DomainStatus
                                status="paused"
                                className="ml-1.5 px-1.5 text-(length:--text-nano)"
                                aria-label="Paused"
                                title="Paused"
                              >
                                Paused
                              </DomainStatus>
                            ) : taskBadge ? (
                              <Badge variant="outline" className="ml-1.5 px-1.5 text-(length:--text-nano)">
                                {taskBadge}
                              </Badge>
                            ) : null}
                          </>
                        }
                        className={cn(
                          isMutedTask && "opacity-70",
                          selectedNavKey === `task:${task.id}` && "bg-accent/50 hover:bg-accent/50",
                        )}
                        mobileLeading={
                          hasChildren ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`${isExpanded ? "Collapse" : "Expand"} sub-tasks for ${task.title}`}
                              aria-expanded={isExpanded}
                              onClick={toggleCollapse}
                            >
                              <ChevronRight
                                className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")}
                               data-icon="inline-start"/>
                            </Button>
                          ) : (
                            <span
                              className="inline-flex items-center"
                              onClickCapture={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                            >
                              {status}
                            </span>
                          )
                        }
                        desktopMetaLeading={
                          <>
                            {hasChildren ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                className="relative z-10 hidden shrink-0 sm:inline-flex"
                                aria-label={`${isExpanded ? "Collapse" : "Expand"} sub-tasks for ${task.title}`}
                                aria-expanded={isExpanded}
                                onClick={toggleCollapse}
                              >
                                <ChevronRight
                                  className={cn(
                                    "h-3.5 w-3.5 transition-transform",
                                    isExpanded && "rotate-90",
                                  )}
                                 data-icon="inline-start"/>
                              </Button>
                            ) : (
                              <span className="hidden w-4 shrink-0 sm:block" />
                            )}
                            <InboxTaskMetaLeading
                              task={task}
                              isLive={liveTaskIds?.has(task.id) === true}
                              subtreeLiveCount={subtreeLiveCounts.get(task.id) ?? 0}
                              showStatus={
                                visibleTaskColumnSet.has("status") && availableTaskColumnSet.has("status")
                              }
                              showIdentifier={
                                visibleTaskColumnSet.has("id") && availableTaskColumnSet.has("id")
                              }
                              checklistStepNumber={checklistStepNumber}
                              statusSlot={
                                <span
                                  className="inline-flex items-center"
                                  onClickCapture={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }}
                                >
                                  {status}
                                </span>
                              }
                            />
                          </>
                        }
                        mobileMeta={model.actions.taskActivityText(task).toLowerCase()}
                        desktopTrailing={
                          visibleTrailingTaskColumns.length ? (
                            <InboxTaskTrailingColumns
                              task={task}
                              columns={visibleTrailingTaskColumns}
                              projectName={taskProject?.name ?? null}
                              projectColor={taskProject?.color ?? null}
                              ownerName={agentName(task.ownerAgentId)}
                              ownerUserName={ownerUserLabel}
                              ownerUserAvatarUrl={ownerUserProfile?.image ?? null}
                              originatingAgentName={agentName(originatingAgentId)}
                              creatorUserName={
                                originatingUserId
                                  ? (companyUserProfileMap.get(originatingUserId)?.label ?? null)
                                  : null
                              }
                              creatorUserAvatarUrl={
                                originatingUserId
                                  ? (companyUserProfileMap.get(originatingUserId)?.image ?? null)
                                  : null
                              }
                              viaAgentName={originatingViaAgentId ? agentName(originatingViaAgentId) : null}
                              currentUserId={currentUserId}
                              parentIdentifier={parentTask?.identifier ?? null}
                              parentTitle={parentTask?.title ?? null}
                              ownerContent={
                                <div className="flex w-full shrink-0 items-center overflow-hidden px-2 py-1">
                                  {task.ownerAgentId && agentName(task.ownerAgentId) ? (
                                    <span
                                      className="inline-flex min-w-0 items-center gap-1.5"
                                      title={agentName(task.ownerAgentId)!}
                                    >
                                      <Avatar size="sm">
                                        <AvatarFallback>
                                          {deriveInitials(agentName(task.ownerAgentId)!)}
                                        </AvatarFallback>
                                      </Avatar>
                                      <span className="truncate text-xs">
                                        {agentName(task.ownerAgentId)!}
                                      </span>
                                    </span>
                                  ) : task.ownerUserId ? (
                                    <span
                                      className="inline-flex min-w-0 items-center gap-1.5"
                                      title={ownerUserLabel ?? "User"}
                                    >
                                      <Avatar size="sm">
                                        {ownerUserProfile?.image ? (
                                          <AvatarImage
                                            src={ownerUserProfile.image}
                                            alt={ownerUserLabel ?? "User"}
                                          />
                                        ) : null}
                                        <AvatarFallback>
                                          {deriveInitials(ownerUserLabel ?? "User")}
                                        </AvatarFallback>
                                      </Avatar>
                                      <span className="truncate text-xs">{ownerUserLabel ?? "User"}</span>
                                    </span>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">Board escalation</span>
                                  )}
                                </div>
                              }
                            />
                          ) : undefined
                        }
                      />
                      {hasChildren && isExpanded
                        ? children.map((child: Task) => renderTaskRow(child, depth + 1))
                        : null}
                    </div>
                  );
                };
                return roots.map((task: Task) => renderTaskRow(task, 0)).filter(Boolean);
              })()}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
      {remainingTaskRowCount > 0 || hasMoreTasks || isLoadingMoreTasks ? (
        <div className="py-2" data-testid="tasks-load-more-sentinel">
          <p className="text-xs text-muted-foreground" role="status">
            {isLoadingMoreTasks
              ? "Loading more tasks..."
              : remainingTaskRowCount > 0
                ? `Rendering ${Math.min(renderedTaskRowLimit, filtered.length)} of ${filtered.length} tasks`
                : "Scroll to load more tasks"}
          </p>
        </div>
      ) : null}
    </>
  );
}
