import { TaskLinkQuicklook } from "@/features/tasks/shared/TaskLinkQuicklook";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { taskDisplayTitle } from "@/lib/task-display";
import { relativeTime } from "@/lib/utils";
import { ChevronRight, CirclePause, EyeOff } from "lucide-react";
import { useTaskDetailPage } from "./-TaskDetailPageContext";

export function TaskDetailStatusPanels() {
  const {
    activePauseHold,
    activePauseHoldRoot,
    activeRootPauseHold,
    ancestors,
    canResumeLeafWork,
    canShowSubtreeControls,
    childTasks,
    heldDescendantCount,
    location,
    resolvedTaskDetailState,
    setTreeControlCancelConfirmed,
    setTreeControlMode,
    setTreeControlOpen,
    task,
  } = useTaskDetailPage();
  return (
    <>
      {/* Parent chain breadcrumb */}
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0"  data-icon="inline-start"/>}
              <TaskLinkQuicklook
                taskId={ancestor.id}
                taskNumber={ancestor.taskNumber}
                state={(resolvedTaskDetailState ?? location.state) as never}
                className="hover:text-foreground transition-colors truncate max-w-(--sz-200px)"
                title={taskDisplayTitle(ancestor)}
              >
                {taskDisplayTitle(ancestor)}
              </TaskLinkQuicklook>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0"  data-icon="inline-start"/>
          <span className="text-foreground/60 truncate max-w-(--sz-200px)">{taskDisplayTitle(task)}</span>
        </nav>
      )}
      {task.hiddenAt && (
        <Alert variant="destructive">
          <EyeOff  data-icon="inline-start"/>
          <AlertDescription>This task is hidden</AlertDescription>
        </Alert>
      )}
      {activePauseHold && (
        <Alert>
          <CirclePause  data-icon="inline-start"/>
          {activePauseHold.isRoot ? (
            <>
              <AlertTitle>
                {childTasks.length === 0 ? "Paused by board." : "Subtree pause is active."}
              </AlertTitle>
              <AlertDescription>
                <p>
                  {childTasks.length === 0
                    ? "Task execution is held until resume. Only an explicit @mention can queue owner triage."
                    : "Root and descendant execution is held until resume. Only explicit @mentions can queue owner triage."}
                </p>
                <p>
                  {childTasks.length === 0
                    ? "1 task held"
                    : `${heldDescendantCount} descendant${heldDescendantCount === 1 ? "" : "s"} held`}
                  {activeRootPauseHold?.createdAt
                    ? ` · started ${relativeTime(activeRootPauseHold.createdAt)}`
                    : ""}
                </p>
                {canShowSubtreeControls || canResumeLeafWork ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setTreeControlMode("resume");
                        setTreeControlOpen(true);
                      }}
                    >
                      {childTasks.length === 0 ? "Resume work" : "Resume subtree"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setTreeControlMode("resume");
                        setTreeControlOpen(true);
                      }}
                    >
                      View affected ({childTasks.length === 0 ? 1 : heldDescendantCount})
                    </Button>
                    {canShowSubtreeControls ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setTreeControlMode("cancel");
                          setTreeControlCancelConfirmed(false);
                          setTreeControlOpen(true);
                        }}
                      >
                        Cancel subtree...
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </AlertDescription>
            </>
          ) : (
            <AlertDescription>
              This task is paused by ancestor{" "}
              {activePauseHoldRoot ? (
                <TaskLinkQuicklook
                  taskId={activePauseHoldRoot.id}
                  taskNumber={activePauseHoldRoot.taskNumber}
                  className="underline"
                >
                  {activePauseHoldRoot.identifier}
                </TaskLinkQuicklook>
              ) : (
                "the unavailable root task"
              )}
              . Resume from the root task to deliver deferred work.
            </AlertDescription>
          )}
        </Alert>
      )}
    </>
  );
}
