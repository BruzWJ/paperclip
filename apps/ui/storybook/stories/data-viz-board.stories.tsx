import { useMemo, useState, useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Task } from "@paperclipai/shared";
import { ListFilter, Clock3, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KanbanBoard } from "@/features/tasks/list/KanbanBoard";
import { createTask, storybookAgents, storybookTasks, storybookTaskRuns } from "../fixtures/paperclipData";
import { StorySection as Section, StoryShell } from "./story-layout";
import { useQueryClient } from "@tanstack/react-query";
import { LiveRunWidget } from "@/routes/_authenticated/$companyId/routines/$routineId/-sections/-LiveRunWidget";
import { queryKeys } from "@/lib/queryKeys";

const kanbanTasks: Task[] = [
  ...storybookTasks,
  createTask({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd016",
    identifier: "PAP-1701",
    taskNumber: 1701,
    title: "Sketch company analytics dashboard",
    boardPresentationStatus: "backlog",
    priority: "low",
    owner: { kind: "agent", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3" },
  }),
  createTask({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd017",
    identifier: "PAP-1702",
    taskNumber: 1702,
    title: "Remove obsolete color token migration",
    boardPresentationStatus: "cancelled",
    priority: "medium",
    owner: { kind: "board" },
  }),
];

type FilterValue = { key: string; label: string; value: string };

function KanbanBoardDemo({ empty = false }: { empty?: boolean }) {
  const tasks: Task[] = empty ? [] : kanbanTasks;
  const liveTaskIds = useMemo(
    () => new Set(["dddddddd-dddd-4ddd-8ddd-ddddddddd001", "dddddddd-dddd-4ddd-8ddd-ddddddddd016"]),
    [],
  );

  return (
    <StoryShell>
      <Section
        eyebrow="KanbanBoard"
        title={empty ? "Collapsed empty workflow columns" : "Read-only task cards by status"}
      >
        <KanbanBoard tasks={tasks} agents={storybookAgents} liveTaskIds={liveTaskIds} />
      </Section>
    </StoryShell>
  );
}

function FilterBarDemo({ empty = false }: { empty?: boolean }) {
  const [filters, setFilters] = useState<FilterValue[]>(
    empty
      ? []
      : [
          { key: "status", label: "Status", value: "In progress" },
          { key: "assignee", label: "Assignee", value: "CodexCoder" },
          { key: "priority", label: "Priority", value: "High" },
          { key: "project", label: "Project", value: "Board UI" },
        ],
  );

  return (
    <StoryShell>
      <Section eyebrow="FilterBar" title={empty ? "No active filters" : "Active removable filter chips"}>
        <div className="rounded-lg border border-dashed border-border bg-background/70 p-4">
          {filters.length ? (
            <div className="flex flex-wrap items-center gap-2">
              {filters.map((filter) => (
                <Badge key={filter.key} variant="secondary">
                  {filter.label}: {filter.value}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${filter.label} filter`}
                    onClick={() => setFilters((current) => current.filter((item) => item.key !== filter.key))}
                  >
                    <X />
                  </Button>
                </Badge>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setFilters([])}>
                Clear all
              </Button>
            </div>
          ) : null}
          {filters.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ListFilter className="h-4 w-4" />
              No filters are active.
            </div>
          )}
        </div>
      </Section>
    </StoryShell>
  );
}

const meta = {
  title: "Product/Data Visualization & Misc",
  parameters: {
    docs: {
      description: {
        component:
          "Fixture-backed stories for charting, board, filtering, live run, onboarding, package preview, entity row, mobile gesture, generated icon, ASCII animation, and skeleton states.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const KanbanBoardPopulated: Story = {
  name: "KanbanBoard / Populated",
  render: () => <KanbanBoardDemo />,
};

export const KanbanBoardEmpty: Story = {
  name: "KanbanBoard / Empty",
  render: () => <KanbanBoardDemo empty />,
};

export const FilterBarPopulated: Story = {
  name: "FilterBar / Populated",
  render: () => <FilterBarDemo />,
};

export const FilterBarEmpty: Story = {
  name: "FilterBar / Empty",
  render: () => <FilterBarDemo empty />,
};

const primaryTaskId = "dddddddd-dddd-4ddd-8ddd-ddddddddd001";

function LiveRunWidgetStory({ empty = false, loading = false }: { empty?: boolean; loading?: boolean }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (loading) return;
    queryClient.setQueryData(queryKeys.tasks.runs(primaryTaskId, ["queued", "scheduled_retry", "running"]), {
      items: empty ? [] : storybookTaskRuns.filter((run) => run.status === "running"),
      nextCursor: null,
    });
  }, [empty, loading, queryClient]);

  if (loading) {
    return (
      <StoryShell>
        <Section eyebrow="LiveRunWidget" title="Loading live run status">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background/70 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Waiting for the first run poll.
          </div>
        </Section>
      </StoryShell>
    );
  }

  return (
    <StoryShell>
      <Section eyebrow="LiveRunWidget" title={empty ? "No active run" : "Streaming run indicator"}>
        <LiveRunWidget companyId="11111111-1111-4111-8111-111111111111" taskId={primaryTaskId} />
        {empty && (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background/70 p-4 text-sm text-muted-foreground">
            <Clock3 className="h-4 w-4" />
            The widget renders no panel when the task has no live runs.
          </div>
        )}
      </Section>
    </StoryShell>
  );
}

export const LiveRunWidgetPopulated: Story = {
  name: "LiveRunWidget / Populated",
  render: () => <LiveRunWidgetStory />,
};

export const LiveRunWidgetLoading: Story = {
  name: "LiveRunWidget / Loading",
  render: () => <LiveRunWidgetStory loading />,
};

export const LiveRunWidgetEmpty: Story = {
  name: "LiveRunWidget / Empty",
  render: () => <LiveRunWidgetStory empty />,
};
