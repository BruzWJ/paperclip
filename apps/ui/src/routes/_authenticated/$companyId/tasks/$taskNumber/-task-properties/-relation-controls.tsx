import type { TaskRelationTaskSummary, TaskStatus } from "@paperclipai/shared";
import { GitFork } from "lucide-react";

import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { taskDisplayTitle, taskReferenceLabel } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import { TaskLinkQuicklook } from "@/routes/_authenticated/$companyId/-TaskLinkQuicklook";
import type { TaskPropertiesController } from "./-TaskProperties";
import { TaskPropertiesSection, TaskPropertyRow } from "./-TaskPropertyPrimitives";

const PREVIEW_COUNT = 5;

interface TaskReferenceShape {
  id: string;
  taskNumber: number;
  identifier: string;
  title: string | null;
  boardPresentationStatus: TaskStatus;
}

function TaskReference({ task, inline }: { task: TaskReferenceShape; inline: boolean }) {
  return (
    <Button
      asChild
      variant="outline"
      size={inline ? "default" : "xs"}
      className={cn("min-w-0", inline && "min-h-11")}
    >
      <TaskLinkQuicklook
        taskId={task.id}
        taskNumber={task.taskNumber}
        title={taskDisplayTitle(task)}
        aria-label={`Task ${taskReferenceLabel(task)}: ${taskDisplayTitle(task)}`}
      >
        <DomainStatus status={task.boardPresentationStatus} className="shrink-0" />
        <span className="truncate">{taskReferenceLabel(task)}</span>
      </TaskLinkQuicklook>
    </Button>
  );
}

function RelationList({
  tasks,
  expanded,
  onExpandedChange,
  inline,
}: {
  tasks: readonly TaskRelationTaskSummary[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  inline: boolean;
}) {
  const visible = expanded ? tasks : tasks.slice(0, PREVIEW_COUNT);
  const hiddenCount = tasks.length - visible.length;
  if (tasks.length === 0) return <span className="text-sm text-muted-foreground">None</span>;
  return (
    <>
      {visible.map((task) => (
        <TaskReference key={task.id} task={task} inline={inline} />
      ))}
      {expanded || hiddenCount > 0 ? (
        <Button
          type="button"
          variant="outline"
          size={inline ? "default" : "xs"}
          className={inline ? "min-h-11" : undefined}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? "Show less" : `Show ${hiddenCount} more`}
        </Button>
      ) : null}
    </>
  );
}

export function TaskPropertiesRelationships(props: TaskPropertiesController) {
  const { task, childTasks, inline = false, state } = props;
  const excludedIds = new Set([
    ...(task.blockedBy ?? []).map((item) => item.id),
    ...(task.blocks ?? []).map((item) => item.id),
    ...childTasks.map((item) => item.id),
  ]);
  const relatedTasks = (task.relatedWork?.outbound ?? [])
    .map((item) => item.task)
    .filter((item) => !excludedIds.has(item.id));
  const parent = task.ancestors?.[0] ?? null;

  return (
    <TaskPropertiesSection
      value="relationships"
      title="Relationships"
      description="Dependencies and task hierarchy"
      icon={GitFork}
    >
      <FieldGroup className="gap-0">
        <TaskPropertyRow label="Blocked by">
          <RelationList
            tasks={task.blockedBy ?? []}
            expanded={state.blockedByExpanded}
            onExpandedChange={state.setBlockedByExpanded}
            inline={inline}
          />
        </TaskPropertyRow>

        <TaskPropertyRow label="Parent">
          {parent ? (
            <TaskReference task={parent} inline={inline} />
          ) : (
            <span className="px-2 text-sm text-muted-foreground">None</span>
          )}
        </TaskPropertyRow>

        <TaskPropertyRow label="Blocking">
          <RelationList
            tasks={task.blocks ?? []}
            expanded={state.blockingExpanded}
            onExpandedChange={state.setBlockingExpanded}
            inline={inline}
          />
        </TaskPropertyRow>

        {relatedTasks.length > 0 ? (
          <TaskPropertyRow label="Related">
            <RelationList
              tasks={relatedTasks}
              expanded={state.relatedTasksExpanded}
              onExpandedChange={state.setRelatedTasksExpanded}
              inline={inline}
            />
          </TaskPropertyRow>
        ) : null}
      </FieldGroup>
    </TaskPropertiesSection>
  );
}
