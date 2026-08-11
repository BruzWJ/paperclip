import type { TaskRelatedWorkItem, TaskRelatedWorkSummary } from "@paperclipai/shared";
import { TaskReferencePill } from "./TaskReferencePill";
import { Badge } from "@/components/ui/badge";

type GroupedSource = {
  label: string;
  count: number;
  sampleMatchedText: string | null;
};

function groupSourcesByLabel(sources: TaskRelatedWorkItem["sources"]): GroupedSource[] {
  const groups = new Map<string, GroupedSource>();
  for (const source of sources) {
    const existing = groups.get(source.label);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(source.label, {
        label: source.label,
        count: 1,
        sampleMatchedText: source.matchedText ?? null,
      });
    }
  }
  return Array.from(groups.values());
}

function Section({
  title,
  description,
  items,
  emptyLabel,
}: {
  title: string;
  description: string;
  items: TaskRelatedWorkItem[];
  emptyLabel: string;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="-mx-1 flex flex-col">
          {items.map((item) => {
            const groupedSources = groupSourcesByLabel(item.sources);
            const showTitle = item.task.identifier !== item.task.title;
            return (
              <li
                key={item.task.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md px-1 py-1.5 hover:bg-accent/40"
              >
                <TaskReferencePill task={item.task} />
                {showTitle ? (
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {item.task.title}
                  </span>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  {groupedSources.map((group) => (
                    <Badge variant="outline"
                      key={`${item.task.id}:${group.label}`}
                      className="border-border bg-muted/40 text-muted-foreground"
                      title={group.sampleMatchedText ?? undefined}
                    >
                      <span>{group.label}</span>
                      {group.count > 1 ? (
                        <span className="tabular-nums text-(length:--text-nano) font-medium opacity-80">×{group.count}</span>
                      ) : null}
                    </Badge>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function TaskRelatedWorkPanel({
  relatedWork,
}: {
  relatedWork?: TaskRelatedWorkSummary | null;
}) {
  const outbound = relatedWork?.outbound ?? [];
  const inbound = relatedWork?.inbound ?? [];

  return (
    <div className="space-y-3">
      <Section
        title="References"
        description="Other tasks this task currently points at in its title, description, comments, or documents."
        items={outbound}
        emptyLabel="This task does not reference any other tasks yet."
      />
      <Section
        title="Referenced by"
        description="Other tasks that currently point at this task."
        items={inbound}
        emptyLabel="No other tasks reference this task yet."
      />
    </div>
  );
}
