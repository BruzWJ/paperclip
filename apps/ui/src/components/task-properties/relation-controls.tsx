import type { MouseEvent } from "react";
import type { Task } from "@paperclipai/shared";
import { TaskLinkQuicklook } from "../TaskLinkQuicklook";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldGroup, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, X } from "lucide-react";
import { taskDisplayTitle, taskReferenceLabel } from "../../lib/task-display";
import type { TaskPropertiesController } from "./TaskProperties";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";

export function RemovableTaskReferencePill({
  task,
  onRemove,
}: {
  task: NonNullable<Task["blockedBy"]>[number];
  onRemove: (taskId: string) => void;
}) {
  const taskLabel = taskReferenceLabel(task);
  const displayTitle = taskDisplayTitle(task);
  const confirmLabel =
    task.identifier && task.identifier !== displayTitle
      ? `${task.identifier}: ${displayTitle}`
      : displayTitle;
  const content = (
    <>
      <DomainStatus status={task.boardPresentationStatus} className="shrink-0" />
      <span className="truncate">{taskLabel}</span>
    </>
  );
  const removeLabel = `Remove ${taskLabel} as blocker`;
  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  return (
    <>
      <span className="group relative inline-flex">
        <ConfirmActionDialog
          triggerAsChild
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute -right-1 -top-1 z-10 size-4 rounded-full opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={handleRemove}
            >
              <X className="h-3 w-3" />
            </Button>
          }
          title="Remove blocker?"
          description={<>Remove {confirmLabel} as a blocker for this task.</>}
          confirmLabel="Remove blocker"
          variant="destructive"
          onConfirm={() => onRemove(task.id)}
        />
        <Button asChild variant="outline" size="xs">
          <TaskLinkQuicklook
            taskId={task.id}
            taskNumber={task.taskNumber}
            data-mention-kind="task"
            title={displayTitle}
            aria-label={`Task ${taskLabel}: ${displayTitle}`}
          >
            {content}
          </TaskLinkQuicklook>
        </Button>
      </span>
    </>
  );
}

export function TaskPropertiesRelationships(props: TaskPropertiesController) {
  const { inline, childTasks, onAddSubTask } = props;
  const s = props.state;
  return (
    <FieldSet>
      <FieldLegend variant="label">Relationships</FieldLegend>
      <FieldGroup>
        <Field orientation="responsive" data-property-row="true">
          <FieldTitle data-property-label="Parent" title="Parent">
            Parent
          </FieldTitle>
          <FieldContent className="min-w-0 flex-row flex-wrap items-center">
            {inline ? (
              <Collapsible
                className="contents"
                open={s.parentOpen}
                onOpenChange={(open) => {
                  s.setParentOpen(open);
                  if (!open) s.setParentSearch("");
                }}
              >
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                    {props.parentTrigger}
                  </Button>
                </CollapsibleTrigger>
                {props.parentLink}
                <CollapsibleContent className="basis-full">
                  <Card className="mb-2 w-72 gap-0 p-1 shadow-none">{props.parentContent}</Card>
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <>
                <Popover
                  open={s.parentOpen}
                  onOpenChange={(open) => {
                    s.setParentOpen(open);
                    if (!open) s.setParentSearch("");
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                      {props.parentTrigger}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-1" align="end" collisionPadding={16}>
                    {props.parentContent}
                  </PopoverContent>
                </Popover>
                {props.parentLink}
              </>
            )}
          </FieldContent>
        </Field>

        {inline ? (
          <Collapsible open={s.blockedByOpen} onOpenChange={s.setBlockedByOpen}>
            <Field orientation="responsive" data-property-row="true">
              <FieldTitle data-property-label="Blocked by" title="Blocked by">
                Blocked by
              </FieldTitle>
              <FieldContent className="min-w-0 flex-row flex-wrap items-center">
                {props.visibleBlockedByRelations.map((relation) => (
                  <RemovableTaskReferencePill
                    key={relation.id}
                    task={relation}
                    onRemove={props.removeBlockedBy}
                  />
                ))}
                {s.blockedByExpanded || props.hiddenBlockedByCount > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => s.setBlockedByExpanded((expanded) => !expanded)}
                    aria-label={
                      s.blockedByExpanded
                        ? "Show fewer items"
                        : `Show ${props.hiddenBlockedByCount} more items`
                    }
                  >
                    {s.blockedByExpanded ? "Show less" : `Show ${props.hiddenBlockedByCount} more`}
                  </Button>
                ) : null}
                <CollapsibleTrigger asChild>{props.renderAddBlockedByButton()}</CollapsibleTrigger>
              </FieldContent>
            </Field>
            <CollapsibleContent>
              <Card className="mb-2 gap-0 p-1 shadow-none">{props.blockedByContent}</Card>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <Field orientation="responsive" data-property-row="true">
            <FieldTitle data-property-label="Blocked by" title="Blocked by">
              Blocked by
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row flex-wrap items-center">
              {props.visibleBlockedByRelations.map((relation) => (
                <RemovableTaskReferencePill
                  key={relation.id}
                  task={relation}
                  onRemove={props.removeBlockedBy}
                />
              ))}
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
                <PopoverContent className="w-72 p-1" align="end" collisionPadding={16}>
                  {props.blockedByContent}
                </PopoverContent>
              </Popover>
            </FieldContent>
          </Field>
        )}

        <Field orientation="responsive" data-property-row="true">
          <FieldTitle data-property-label="Blocking" title="Blocking">
            Blocking
          </FieldTitle>
          <FieldContent className="min-w-0 flex-row flex-wrap items-center">
            {props.blockingTasks.length > 0 ? (
              <>
                {props.visibleBlockingTasks.map((relation) => (
                  <Button key={relation.id} asChild variant="outline" size="xs">
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
                    size="xs"
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
          </FieldContent>
        </Field>

        <Field orientation="responsive" data-property-row="true">
          <FieldTitle data-property-label="Sub-tasks" title="Sub-tasks">
            Sub-tasks
          </FieldTitle>
          <FieldContent className="min-w-0 flex-row flex-wrap items-center">
            {childTasks.length > 0
              ? props.visibleChildTasks.map((child) => (
                  <Button key={child.id} asChild variant="outline" size="xs">
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
              : null}
            {s.subTasksExpanded || props.hiddenChildTaskCount > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => s.setSubTasksExpanded((expanded) => !expanded)}
                aria-label={
                  s.subTasksExpanded ? "Show fewer items" : `Show ${props.hiddenChildTaskCount} more items`
                }
              >
                {s.subTasksExpanded ? "Show less" : `Show ${props.hiddenChildTaskCount} more`}
              </Button>
            ) : null}
            {onAddSubTask ? (
              <Button type="button" variant="outline" size="xs" onClick={onAddSubTask}>
                <Plus />
                Add sub-task
              </Button>
            ) : null}
          </FieldContent>
        </Field>

        {props.relatedTasks.length > 0 ? (
          <Field orientation="responsive" data-property-row="true">
            <FieldTitle data-property-label="Related tasks" title="Related tasks">
              Related tasks
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row flex-wrap items-center">
              {props.visibleRelatedTasks.map((related) => (
                <Button key={related.id} asChild variant="outline" size="xs">
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
                  size="xs"
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
            </FieldContent>
          </Field>
        ) : null}
      </FieldGroup>
    </FieldSet>
  );
}
