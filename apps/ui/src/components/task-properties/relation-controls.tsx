import type { Task } from "@paperclipai/shared";
import { GitFork, Plus, X } from "lucide-react";

import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { TaskLinkQuicklook } from "@/components/TaskLinkQuicklook";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FieldGroup } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { taskDisplayTitle, taskReferenceLabel } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import type { TaskPropertiesController } from "./TaskProperties";
import { TaskPropertiesSection, TaskPropertyPicker, TaskPropertyRow } from "./TaskPropertyPrimitives";

export function RemovableTaskReferencePill({
  task,
  onRemove,
  inline = false,
}: {
  task: NonNullable<Task["blockedBy"]>[number];
  onRemove: (taskId: string) => void;
  inline?: boolean;
}) {
  const taskLabel = taskReferenceLabel(task);
  const displayTitle = taskDisplayTitle(task);
  const confirmLabel =
    task.identifier && task.identifier !== displayTitle
      ? `${task.identifier}: ${displayTitle}`
      : displayTitle;
  const removeLabel = `Remove ${taskLabel} as blocker`;

  return (
    <ButtonGroup className="max-w-full">
      <Button
        asChild
        variant="outline"
        size={inline ? "default" : "xs"}
        className={cn("min-w-0", inline && "min-h-11")}
      >
        <TaskLinkQuicklook
          taskId={task.id}
          taskNumber={task.taskNumber}
          data-mention-kind="task"
          title={displayTitle}
          aria-label={`Task ${taskLabel}: ${displayTitle}`}
        >
          <DomainStatus status={task.boardPresentationStatus} className="shrink-0" />
          <span className="truncate">{taskLabel}</span>
        </TaskLinkQuicklook>
      </Button>
      <ConfirmActionDialog
        triggerAsChild
        trigger={
          <Button
            type="button"
            variant="outline"
            size={inline ? "icon-lg" : "icon-xs"}
            className={inline ? "size-11!" : undefined}
            aria-label={removeLabel}
            title={removeLabel}
          >
            <X />
          </Button>
        }
        title="Remove blocker?"
        description={<>Remove {confirmLabel} as a blocker for this task.</>}
        confirmLabel="Remove blocker"
        variant="destructive"
        onConfirm={() => onRemove(task.id)}
      />
    </ButtonGroup>
  );
}

export function TaskPropertiesRelationships(props: TaskPropertiesController) {
  const { inline = false, childTasks, onAddSubTask } = props;
  const s = props.state;
  const hasVisibleBlockers = props.visibleBlockedByRelations.length > 0;

  return (
    <TaskPropertiesSection
      value="relationships"
      title="Relationships"
      description="Dependencies and task hierarchy"
      icon={GitFork}
    >
      <FieldGroup className="gap-0">
        {inline ? (
          <Collapsible
            className="contents"
            open={s.blockedByOpen}
            onOpenChange={(open) => {
              s.setBlockedByOpen(open);
              if (!open) s.setBlockedBySearch("");
            }}
          >
            <TaskPropertyRow label="Blocked by">
              {props.visibleBlockedByRelations.map((relation) => (
                <RemovableTaskReferencePill
                  key={relation.id}
                  task={relation}
                  onRemove={props.removeBlockedBy}
                  inline
                />
              ))}
              {!hasVisibleBlockers ? <span className="text-sm text-muted-foreground">None</span> : null}
              {s.blockedByExpanded || props.hiddenBlockedByCount > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  className="min-h-11"
                  onClick={() => s.setBlockedByExpanded((expanded) => !expanded)}
                  aria-label={
                    s.blockedByExpanded ? "Show fewer items" : `Show ${props.hiddenBlockedByCount} more items`
                  }
                >
                  {s.blockedByExpanded ? "Show less" : `Show ${props.hiddenBlockedByCount} more`}
                </Button>
              ) : null}
              <CollapsibleTrigger asChild>{props.renderAddBlockedByButton()}</CollapsibleTrigger>
              <CollapsibleContent className="basis-full">
                <Card className="mt-2 w-full gap-0 rounded-lg p-2 shadow-none">{props.blockedByContent}</Card>
              </CollapsibleContent>
            </TaskPropertyRow>
          </Collapsible>
        ) : (
          <TaskPropertyRow label="Blocked by">
            {props.visibleBlockedByRelations.map((relation) => (
              <RemovableTaskReferencePill
                key={relation.id}
                task={relation}
                onRemove={props.removeBlockedBy}
              />
            ))}
            {!hasVisibleBlockers ? <span className="text-sm text-muted-foreground">None</span> : null}
            {s.blockedByExpanded || props.hiddenBlockedByCount > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => s.setBlockedByExpanded((expanded) => !expanded)}
                aria-label={
                  s.blockedByExpanded ? "Show fewer items" : `Show ${props.hiddenBlockedByCount} more items`
                }
              >
                {s.blockedByExpanded ? "Show less" : `Show ${props.hiddenBlockedByCount} more`}
              </Button>
            ) : null}
            <Popover
              open={s.blockedByOpen}
              onOpenChange={(open) => {
                s.setBlockedByOpen(open);
                if (!open) s.setBlockedBySearch("");
              }}
            >
              <PopoverTrigger asChild>{props.renderAddBlockedByButton()}</PopoverTrigger>
              <PopoverContent className="w-72 p-1" align="end">
                {props.blockedByContent}
              </PopoverContent>
            </Popover>
          </TaskPropertyRow>
        )}

        <TaskPropertyRow label="Parent">
          <TaskPropertyPicker
            inline={inline}
            open={s.parentOpen}
            onOpenChange={(open) => {
              s.setParentOpen(open);
              if (!open) s.setParentSearch("");
            }}
            ariaLabel="Change parent task"
            trigger={props.parentTrigger}
            trailing={props.parentLink}
            popoverClassName="w-72"
          >
            {props.parentContent}
          </TaskPropertyPicker>
        </TaskPropertyRow>

        <TaskPropertyRow label="Blocking">
          {props.blockingTasks.length > 0 ? (
            <>
              {props.visibleBlockingTasks.map((relation) => (
                <Button
                  key={relation.id}
                  asChild
                  variant="outline"
                  size={inline ? "default" : "xs"}
                  className={inline ? "min-h-11" : undefined}
                >
                  <TaskLinkQuicklook
                    taskId={relation.id}
                    taskNumber={relation.taskNumber}
                    title={taskDisplayTitle(relation)}
                  >
                    <DomainStatus status={relation.boardPresentationStatus} />
                    {taskReferenceLabel(relation)}
                  </TaskLinkQuicklook>
                </Button>
              ))}
              {s.blockingExpanded || props.hiddenBlockingTaskCount > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size={inline ? "default" : "xs"}
                  className={inline ? "min-h-11" : undefined}
                  onClick={() => s.setBlockingExpanded((expanded) => !expanded)}
                  aria-label={
                    s.blockingExpanded
                      ? "Show fewer items"
                      : `Show ${props.hiddenBlockingTaskCount} more items`
                  }
                >
                  {s.blockingExpanded ? "Show less" : `Show ${props.hiddenBlockingTaskCount} more`}
                </Button>
              ) : null}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </TaskPropertyRow>

        <TaskPropertyRow label="Sub-tasks">
          {childTasks.length > 0 ? (
            props.visibleChildTasks.map((child) => (
              <Button
                key={child.id}
                asChild
                variant="outline"
                size={inline ? "default" : "xs"}
                className={inline ? "min-h-11" : undefined}
              >
                <TaskLinkQuicklook
                  taskId={child.id}
                  taskNumber={child.taskNumber}
                  title={taskDisplayTitle(child)}
                >
                  <DomainStatus status={child.boardPresentationStatus} />
                  {taskReferenceLabel(child)}
                </TaskLinkQuicklook>
              </Button>
            ))
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
          {s.subTasksExpanded || props.hiddenChildTaskCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              size={inline ? "default" : "xs"}
              className={inline ? "min-h-11" : undefined}
              onClick={() => s.setSubTasksExpanded((expanded) => !expanded)}
              aria-label={
                s.subTasksExpanded ? "Show fewer items" : `Show ${props.hiddenChildTaskCount} more items`
              }
            >
              {s.subTasksExpanded ? "Show less" : `Show ${props.hiddenChildTaskCount} more`}
            </Button>
          ) : null}
          {onAddSubTask ? (
            <Button
              type="button"
              variant="outline"
              size={inline ? "default" : "xs"}
              className={inline ? "min-h-11" : undefined}
              onClick={onAddSubTask}
            >
              <Plus />
              Add sub-task
            </Button>
          ) : null}
        </TaskPropertyRow>

        {props.relatedTasks.length > 0 ? (
          <TaskPropertyRow label="Related">
            {props.visibleRelatedTasks.map((related) => (
              <Button
                key={related.id}
                asChild
                variant="outline"
                size={inline ? "default" : "xs"}
                className={inline ? "min-h-11" : undefined}
              >
                <TaskLinkQuicklook
                  taskId={related.id}
                  taskNumber={related.taskNumber}
                  title={taskDisplayTitle(related)}
                >
                  <DomainStatus status={related.boardPresentationStatus} />
                  {taskReferenceLabel(related)}
                </TaskLinkQuicklook>
              </Button>
            ))}
            {s.relatedTasksExpanded || props.hiddenRelatedTaskCount > 0 ? (
              <Button
                type="button"
                variant="outline"
                size={inline ? "default" : "xs"}
                className={inline ? "min-h-11" : undefined}
                onClick={() => s.setRelatedTasksExpanded((expanded) => !expanded)}
                aria-label={
                  s.relatedTasksExpanded
                    ? "Show fewer items"
                    : `Show ${props.hiddenRelatedTaskCount} more items`
                }
              >
                {s.relatedTasksExpanded ? "Show less" : `Show ${props.hiddenRelatedTaskCount} more`}
              </Button>
            ) : null}
          </TaskPropertyRow>
        ) : null}
      </FieldGroup>
    </TaskPropertiesSection>
  );
}
