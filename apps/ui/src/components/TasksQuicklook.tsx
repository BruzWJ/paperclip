import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createTaskDetailPath, withTaskDetailHeaderSeed } from "../lib/taskDetailBreadcrumb";
import { TaskQuicklookCard, type TaskQuicklookTask } from "./TaskLinkQuicklook";

interface TasksQuicklookProps {
  task: TaskQuicklookTask;
  children: React.ReactNode;
}

export function TasksQuicklook({ task, children }: TasksQuicklookProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        side="top"
        align="start"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <TaskQuicklookCard
          task={task}
          linkTo={createTaskDetailPath(task.identifier ?? task.id)}
          linkState={withTaskDetailHeaderSeed(null, task)}
        />
      </PopoverContent>
    </Popover>
  );
}
