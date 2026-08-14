import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { readTaskDetailHeaderSeed } from "@/lib/taskDetailBreadcrumb";
import { taskValueLabel } from "@/lib/task-blockers";
import { cn } from "@/lib/utils";
import { Hexagon, Repeat } from "lucide-react";

export function TaskSectionSkeleton({
  titleWidth = "w-28",
  rows = 3,
}: {
  titleWidth?: string;
  rows?: number;
}) {
  return (
    <Card className="gap-3 p-3">
      <Skeleton className={cn("h-4", titleWidth)} />
      <CardContent className="space-y-2 p-0">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-md" />
        ))}
      </CardContent>
    </Card>
  );
}

export function TaskChatSkeleton() {
  return (
    <Card className="gap-3 p-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-full" />
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
          <Skeleton className="h-8 w-8 rounded-full" />
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
  const identifier = headerSeed?.identifier ?? null;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-3">
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5">
            {headerSeed ? (
              <>
                {identifier ? (
                  <span className="shrink-0 font-mono text-xs font-medium text-muted-foreground">
                    {identifier}
                  </span>
                ) : null}
                {headerSeed.projectId ? (
                  <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <Hexagon className="size-3 shrink-0" />
                    <span className="truncate">
                      {headerSeed.projectName ?? headerSeed.projectId.slice(0, 8)}
                    </span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/60">
                    <Hexagon className="size-3 shrink-0" />
                    No project
                  </span>
                )}
                {headerSeed.originKind === "routine_execution" && headerSeed.originId ? (
                  <Badge variant="secondary" title={`Routine execution from routine ${headerSeed.originId}`}>
                    <Repeat />
                    Routine
                  </Badge>
                ) : null}
              </>
            ) : (
              <>
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-28" />
              </>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="size-8 rounded-md" />
          </div>
        </div>

        {headerSeed ? (
          <>
            <h1 className="text-xl font-semibold leading-tight sm:text-2xl">{headerSeed.title}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <DomainStatus status={headerSeed.boardPresentationStatus}>
                {taskValueLabel(headerSeed.boardPresentationStatus)}
              </DomainStatus>
              <Badge variant="secondary">{taskValueLabel(headerSeed.priority)} priority</Badge>
              <Skeleton className="h-6 w-28" />
            </div>
          </>
        ) : (
          <>
            <Skeleton className="h-8 w-(--sz-calc-37)" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-20" />
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-6 w-28" />
            </div>
          </>
        )}
      </div>

      <Skeleton className="h-28 w-full rounded-lg border border-border" />

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
        <TaskChatSkeleton />
      </div>

      <TaskSectionSkeleton titleWidth="w-24" rows={3} />
    </div>
  );
}
