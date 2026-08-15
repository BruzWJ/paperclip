import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { readTaskDetailHeaderSeed } from "@/lib/taskDetailBreadcrumb";
import { taskValueLabel } from "@/lib/task-blockers";
import { Repeat } from "lucide-react";

function TaskChatSkeleton() {
  return (
    <Card className="gap-3 p-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-end gap-2">
          <div className="space-y-2 text-right">
            <Skeleton className="ml-auto h-3 w-20" />
            <Skeleton className="ml-auto h-3 w-14" />
          </div>
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
        <Skeleton className="ml-auto h-16 w-(--pct-85) rounded-xl" />
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </Card>
  );
}

export function TaskDetailLoadingState({
  headerSeed,
}: {
  headerSeed: ReturnType<typeof readTaskDetailHeaderSeed>;
}) {
  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-3">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            {headerSeed ? (
              <h1 className="text-xl font-semibold leading-tight sm:text-2xl">{headerSeed.title}</h1>
            ) : (
              <Skeleton className="h-8 w-(--sz-calc-37)" />
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1 pt-0.5">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="size-8 rounded-md" />
          </div>
        </div>

        {headerSeed ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <DomainStatus status={headerSeed.boardPresentationStatus}>
                {taskValueLabel(headerSeed.boardPresentationStatus)}
              </DomainStatus>
              <Badge variant="secondary">{taskValueLabel(headerSeed.priority)} priority</Badge>
              {headerSeed.originKind === "routine_execution" && headerSeed.originId ? (
                <Badge variant="secondary" title={`Routine execution from routine ${headerSeed.originId}`}>
                  <Repeat data-icon="inline-start" />
                  Routine
                </Badge>
              ) : null}
            </div>
            <Skeleton className="h-6 w-28" />
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-6 w-20" />
              <Skeleton className="h-6 w-24" />
            </div>
            <Skeleton className="h-6 w-28" />
          </div>
        )}
      </div>

      <Skeleton className="h-28 w-full rounded-lg border border-border" />

      <TaskChatSkeleton />
    </div>
  );
}
