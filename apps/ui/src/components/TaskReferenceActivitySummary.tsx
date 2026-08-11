import type { ActivityEvent } from "@paperclipai/shared";
import { Plus, Minus } from "lucide-react";
import { TaskReferencePill } from "./TaskReferencePill";

type ActivityTaskReference = {
  id: string;
  identifier?: string | null;
  title?: string | null;
};

function readTaskReferences(details: Record<string, unknown> | null | undefined, key: string): ActivityTaskReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ActivityTaskReference => !!item && typeof item === "object");
}

function Section({
  label,
  icon,
  items,
  strikethrough,
}: {
  label: string;
  icon: React.ReactNode;
  items: ActivityTaskReference[];
  strikethrough?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        aria-label={label}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      >
        {icon}
        <span className="sr-only">{label}</span>
      </span>
      {items.map((task) => (
        <TaskReferencePill
          key={`${label}:${task.id}`}
          strikethrough={strikethrough}
          task={{
            id: task.id,
            identifier: task.identifier ?? null,
            title: task.title ?? task.identifier ?? task.id,
          }}
        />
      ))}
    </div>
  );
}

export function TaskReferenceActivitySummary({ event }: { event: Pick<ActivityEvent, "details"> }) {
  const added = readTaskReferences(event.details, "addedReferencedTasks");
  const removed = readTaskReferences(event.details, "removedReferencedTasks");
  if (added.length === 0 && removed.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      <Section
        label="Added references"
        icon={<Plus className="h-3 w-3 text-green-600 dark:text-green-400" aria-hidden="true" />}
        items={added}
      />
      <Section
        label="Removed references"
        icon={<Minus className="h-3 w-3 text-red-600 dark:text-red-400" aria-hidden="true" />}
        items={removed}
        strikethrough
      />
    </div>
  );
}
