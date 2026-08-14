import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Task } from "@paperclipai/shared";
import type { TaskSiblingNavigation as TaskSiblingNavigationState } from "@/lib/task-detail-subtasks";
import { withTaskDetailHeaderSeed } from "@/lib/taskDetailBreadcrumb";
import { taskStatusAccessibleLabel, taskValueLabel } from "@/lib/task-blockers";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { TaskLinkQuicklook } from "./TaskLinkQuicklook";

type TaskSiblingNavigationProps = {
  navigation: TaskSiblingNavigationState | null;
  linkState?: unknown;
};

export function TaskSiblingNavigation({ navigation, linkState }: TaskSiblingNavigationProps) {
  if (!navigation) return null;

  return (
    <nav aria-label="Sub-task navigation" className="mt-4 flex flex-col gap-3 sm:mt-6 sm:grid sm:grid-cols-2">
      {navigation.previous ? (
        <SiblingLink direction="previous" task={navigation.previous} linkState={linkState} />
      ) : null}
      {navigation.next ? (
        <SiblingLink
          direction="next"
          task={navigation.next}
          linkState={linkState}
          className={!navigation.previous ? "sm:col-start-2" : undefined}
        />
      ) : null}
    </nav>
  );
}

function SiblingLink({
  direction,
  task,
  linkState,
  className,
}: {
  direction: "previous" | "next";
  task: Task;
  linkState?: unknown;
  className?: string;
}) {
  const label = direction === "previous" ? "Previous" : "Next";
  const ariaDirection = direction === "previous" ? "Previous sub-task" : "Next sub-task";
  const identifier = task.identifier;
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  const cardClassName = cn(
    "group min-w-0 rounded-lg text-left no-underline transition-colors hover:bg-accent/50 focus-visible:ring-(length:--rad-3) focus-visible:ring-ring focus-visible:outline-none",
    direction === "next" && "sm:text-right",
    className,
  );
  const content = (
    <Item variant="outline" size="sm" className="h-full">
      <ItemContent className="min-w-0">
        <ItemDescription
          className={cn(
            "flex items-center gap-1.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground",
            direction === "next" && "sm:justify-end",
          )}
        >
          {direction === "previous" ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
          <span>{label}</span>
          {direction === "next" ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
        </ItemDescription>
        <ItemDescription
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs font-mono text-muted-foreground transition-colors group-hover:text-foreground",
            direction === "next" && "sm:justify-end",
          )}
        >
          <Badge
            variant="secondary"
            aria-label={taskStatusAccessibleLabel(task.boardPresentationStatus, task.blockerAttention)}
          >
            {taskValueLabel(task.boardPresentationStatus)}
          </Badge>
          <span className="shrink-0">{identifier}</span>
        </ItemDescription>
        <ItemTitle className={cn("truncate", direction === "next" && "sm:ml-auto")}>{task.title}</ItemTitle>
      </ItemContent>
    </Item>
  );

  return (
    <TaskLinkQuicklook
      // design-allow(card-pattern): navigation <Link> card; Card renders a div and would break anchor semantics (C5a Run 3)
      taskId={task.id}
      taskNumber={task.taskNumber}
      state={withTaskDetailHeaderSeed(linkState, task)}
      taskPrefetch={task}
      taskQuicklookSide="top"
      taskQuicklookAlign={direction === "previous" ? "start" : "end"}
      aria-label={`${ariaDirection}: ${identifier} - ${task.title}`}
      className={cardClassName}
    >
      {content}
    </TaskLinkQuicklook>
  );
}
