import type { TaskRelatedWorkItem, TaskRelatedWorkSummary } from "@paperclipai/shared";
import { TaskLinkQuicklook } from "./TaskLinkQuicklook";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { taskDisplayTitle, taskReferenceLabel } from "@/lib/task-display";

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

export function TaskRelatedWorkPanel({ relatedWork }: { relatedWork?: TaskRelatedWorkSummary | null }) {
  const outbound = relatedWork?.outbound ?? [];
  const inbound = relatedWork?.inbound ?? [];
  const sections = [
    {
      title: "References",
      description:
        "Other tasks this task currently points at in its title, description, comments, or documents.",
      items: outbound,
      emptyLabel: "This task does not reference any other tasks yet.",
    },
    {
      title: "Referenced by",
      description: "Other tasks that currently point at this task.",
      items: inbound,
      emptyLabel: "No other tasks reference this task yet.",
    },
  ];

  return (
    <div className="space-y-3">
      {sections.map(({ title, description, items, emptyLabel }) => (
        <Card key={title}>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <Empty className="py-6">
                <EmptyDescription>{emptyLabel}</EmptyDescription>
              </Empty>
            ) : (
              <ItemGroup>
                {items.map((item) => {
                  const groupedSources = groupSourcesByLabel(item.sources);
                  const showTitle = item.task.identifier !== item.task.title;
                  const taskLabel = taskReferenceLabel(item.task);
                  const displayTitle = taskDisplayTitle(item.task);
                  return (
                    <Item key={item.task.id} size="sm">
                      <ItemContent>
                        <ItemTitle>
                          <Badge asChild variant="outline">
                            <TaskLinkQuicklook
                              taskId={item.task.id}
                              taskNumber={item.task.taskNumber}
                              title={displayTitle}
                              aria-label={`Task ${taskLabel}: ${displayTitle}`}
                            >
                              <span>{taskLabel}</span>
                            </TaskLinkQuicklook>
                          </Badge>
                        </ItemTitle>
                        {showTitle ? <ItemDescription>{item.task.title}</ItemDescription> : null}
                      </ItemContent>
                      <ItemActions className="flex-wrap">
                        {groupedSources.map((group) => (
                          <Badge
                            variant="outline"
                            key={`${item.task.id}:${group.label}`}
                            title={group.sampleMatchedText ?? undefined}
                          >
                            <span>{group.label}</span>
                            {group.count > 1 ? <span className="tabular-nums">×{group.count}</span> : null}
                          </Badge>
                        ))}
                      </ItemActions>
                    </Item>
                  );
                })}
              </ItemGroup>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
