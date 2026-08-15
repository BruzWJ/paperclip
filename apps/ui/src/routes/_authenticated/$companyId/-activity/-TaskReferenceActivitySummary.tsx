import type { ActivityEvent } from "@paperclipai/shared";
import { Plus, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { taskDisplayTitle, taskReferenceLabel } from "@/lib/task-display";
import { TaskLinkQuicklook } from "../-TaskLinkQuicklook";

type ActivityTaskReference = {
  id: string;
  taskNumber: number;
  identifier: string;
  title?: string | null;
};

function readTaskReferences(
  details: Record<string, unknown> | null | undefined,
  key: string,
): ActivityTaskReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ActivityTaskReference =>
      !!item &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { identifier?: unknown }).identifier === "string" &&
      typeof (item as { taskNumber?: unknown }).taskNumber === "number" &&
      Number.isInteger((item as { taskNumber: number }).taskNumber) &&
      (item as { taskNumber: number }).taskNumber > 0,
  );
}

export function TaskReferenceActivitySummary({ event }: { event: Pick<ActivityEvent, "details"> }) {
  const added = readTaskReferences(event.details, "addedReferencedTasks");
  const removed = readTaskReferences(event.details, "removedReferencedTasks");
  if (added.length === 0 && removed.length === 0) return null;
  const sections = [
    {
      label: "Added references",
      icon: Plus,
      items: added,
      strikethrough: false,
    },
    {
      label: "Removed references",
      icon: Minus,
      items: removed,
      strikethrough: true,
    },
  ].filter((section) => section.items.length > 0);

  return (
    <div className="mt-2 space-y-1">
      {sections.map(({ label, icon: Icon, items, strikethrough }) => (
        <div key={label} className="flex flex-wrap items-center gap-1.5">
          <span aria-label={label} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Icon className="size-3" aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </span>
          {items.map((task) => {
            const taskLabel = taskReferenceLabel(task);
            const displayTitle = taskDisplayTitle(task);
            return (
              <Badge
                key={`${label}:${task.id}`}
                asChild
                variant="outline"
                className={cn(strikethrough && "line-through")}
              >
                <TaskLinkQuicklook
                  taskId={task.id}
                  taskNumber={task.taskNumber}
                  title={displayTitle}
                  aria-label={`Task ${taskLabel}: ${displayTitle}`}
                >
                  <span>{taskLabel}</span>
                </TaskLinkQuicklook>
              </Badge>
            );
          })}
        </div>
      ))}
    </div>
  );
}
