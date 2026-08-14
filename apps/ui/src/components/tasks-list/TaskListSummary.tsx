import { startTransition, useEffect, useRef, useState } from "react";
import { TASK_STATUSES } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import type { SubTaskProgressSummary } from "@/lib/task-detail-subtasks";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";
import { formatDurationMs, formatMoneyAmount } from "@/lib/utils";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Card, CardContent } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { Search } from "lucide-react";
import { TaskLinkQuicklook } from "../TaskLinkQuicklook";
import { withTaskDetailHeaderSeed } from "@/lib/taskDetailBreadcrumb";
import { shouldBlurPageSearchOnEnter, shouldBlurPageSearchOnEscape } from "@/lib/keyboardShortcuts";
import { TASK_SEARCH_DEBOUNCE_MS, taskStatusLabels } from "./model";

export function TaskSearchInput({
  value,
  onDebouncedChange,
}: {
  value: string;
  onDebouncedChange?: (search: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const lastCommittedValueRef = useRef(value);

  useEffect(() => {
    setDraftValue(value);
    lastCommittedValueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!onDebouncedChange || draftValue === lastCommittedValueRef.current) return;

    const timeoutId = window.setTimeout(() => {
      lastCommittedValueRef.current = draftValue;
      startTransition(() => {
        onDebouncedChange(draftValue);
      });
    }, TASK_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [draftValue, onDebouncedChange]);

  return (
    <InputGroup className="w-48 sm:w-64 md:w-80">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        value={draftValue}
        onChange={(e) => {
          setDraftValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (
            shouldBlurPageSearchOnEnter({
              key: e.key,
              isComposing: e.nativeEvent.isComposing,
            })
          ) {
            e.currentTarget.blur();
            return;
          }

          if (
            shouldBlurPageSearchOnEscape({
              key: e.key,
              isComposing: e.nativeEvent.isComposing,
              currentValue: e.currentTarget.value,
            })
          ) {
            e.currentTarget.blur();
          }
        }}
        placeholder="Search tasks..."
        className="text-xs sm:text-sm"
        aria-label="Search tasks"
        data-page-search-target="true"
      />
    </InputGroup>
  );
}

export function SubTaskProgressSummaryStrip({
  summary,
  taskLinkState,
  parentTaskIdForCostSummary,
}: {
  summary: SubTaskProgressSummary;
  taskLinkState?: unknown;
  parentTaskIdForCostSummary?: string;
}) {
  const target = summary.target;
  const targetTask = target?.task ?? null;
  const targetState = targetTask ? withTaskDetailHeaderSeed(taskLinkState, targetTask) : undefined;
  const statusEntries = TASK_STATUSES.map((status) => ({
    status,
    count: summary.countsByStatus[status] ?? 0,
  })).filter((entry) => entry.count > 0);

  const { data: costSummary } = useQuery({
    queryKey: queryKeys.tasks.costSummary(parentTaskIdForCostSummary ?? "pending", { excludeRoot: true }),
    queryFn: () =>
      tasksApi.getCostSummary(parentTaskIdForCostSummary!, {
        excludeRoot: true,
      }),
    enabled: !!parentTaskIdForCostSummary,
  });

  const showCostSummary =
    !!costSummary &&
    (costSummary.runCount > 0 || costSummary.pricedPromptCount > 0 || costSummary.unpricedPromptCount > 0);

  return (
    <Card className="gap-3 py-3 shadow-none">
      <CardContent className="flex flex-col gap-3 px-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-medium text-foreground">
              {summary.doneCount}/{summary.totalCount} done
            </span>
            <span className="text-muted-foreground">{summary.inProgressCount} in progress</span>
            <span className="text-muted-foreground">{summary.blockedCount} blocked</span>
            {showCostSummary && (
              <>
                <span
                  className="text-muted-foreground tabular-nums"
                  title={`${costSummary.runCount.toLocaleString()} run${
                    costSummary.runCount === 1 ? "" : "s"
                  } across ${costSummary.taskCount} sub-task${costSummary.taskCount === 1 ? "" : "s"}`}
                >
                  {formatMoneyAmount(costSummary.knownCostAmount, costSummary.budgetCurrency)} known cost ·{" "}
                  {costSummary.unpricedPromptCount} unpriced
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {formatDurationMs(costSummary.runtimeMs)} runtime
                </span>
              </>
            )}
          </div>
          <Progress
            value={summary.totalCount > 0 ? (summary.doneCount / summary.totalCount) * 100 : 0}
            aria-label="Sub-tasks completion progress"
            aria-valuemin={0}
            aria-valuenow={summary.doneCount}
            aria-valuemax={summary.totalCount}
          />
          <div className="flex flex-wrap gap-1" aria-label="Sub-task status counts">
            {statusEntries.map(({ status, count }) => (
              <DomainStatus key={status} status={status}>
                {taskStatusLabels[status]}: {count}
              </DomainStatus>
            ))}
          </div>
        </div>

        <Item variant="outline" size="sm" className="min-w-0 lg:w-72">
          <ItemContent>
            {target && targetTask ? (
              <>
                <ItemDescription className="text-xs">
                  {target.kind === "next" ? "Next up" : "Waiting on blockers"}
                </ItemDescription>
                <TaskLinkQuicklook
                  taskId={targetTask.id}
                  taskNumber={targetTask.taskNumber}
                  state={targetState}
                  taskPrefetch={targetTask}
                  className="mt-1 block min-w-0 text-foreground underline-offset-2 hover:underline"
                >
                  <span className="font-mono text-xs text-muted-foreground">{targetTask.identifier}</span>{" "}
                  <span>{targetTask.title}</span>
                </TaskLinkQuicklook>
              </>
            ) : summary.totalCount === 0 ? (
              <ItemTitle>No active sub-tasks</ItemTitle>
            ) : summary.doneCount === summary.totalCount ? (
              <ItemTitle>All sub-tasks done</ItemTitle>
            ) : (
              <ItemTitle>No actionable sub-tasks</ItemTitle>
            )}
          </ItemContent>
        </Item>
      </CardContent>
    </Card>
  );
}
