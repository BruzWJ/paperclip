import type { ReactNode } from "react";
import type { TaskRelationTaskSummary } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";
import { taskDisplayTitle, taskReferenceLabel } from "../lib/task-display";

export function TaskReferencePill({
  task,
  strikethrough,
  className,
  children,
}: {
  task: Pick<TaskRelationTaskSummary, "id" | "identifier" | "title"> &
    Partial<Pick<TaskRelationTaskSummary, "boardPresentationStatus">>;
  strikethrough?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const taskLabel = taskReferenceLabel(task);
  const displayTitle = taskDisplayTitle(task);
  const classNames = cn(
    "paperclip-mention-chip paperclip-mention-chip--task",
    "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    task.identifier && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
    strikethrough && "opacity-60 line-through decoration-muted-foreground",
    className,
  );
  const content = (
    <>
      {task.boardPresentationStatus ? (
        <StatusIcon status={task.boardPresentationStatus} className="h-3 w-3 shrink-0" />
      ) : null}
      {children !== undefined ? children : <span>{task.identifier ?? displayTitle}</span>}
    </>
  );

  if (!task.identifier) {
    return (
      <span
        data-mention-kind="task"
        className={classNames}
        title={displayTitle}
        aria-label={`Task: ${displayTitle}`}
      >
        {content}
      </span>
    );
  }

  return (
    <Link
      to={`/tasks/${taskLabel}`}
      data-mention-kind="task"
      className={classNames}
      title={displayTitle}
      aria-label={`Task ${taskLabel}: ${displayTitle}`}
    >
      {content}
    </Link>
  );
}
