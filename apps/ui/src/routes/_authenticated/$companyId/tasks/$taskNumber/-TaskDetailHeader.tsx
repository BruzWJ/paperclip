import { InlineEditor } from "@/components/InlineEditor";
import { MarkdownBody } from "@/components/MarkdownBody";
import { TaskMonitorBanner } from "@/components/TaskMonitorBanner";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { hasAssignedBacklogBlocker, taskStatusAccessibleLabel, taskValueLabel } from "@/lib/task-blockers";
import { cn } from "@/lib/utils";
import { workModeMetaFor } from "@/lib/work-mode-meta";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  Check,
  Copy,
  Hexagon,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Repeat,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";
import { TaskAttributionByline } from "./-TaskAttribution";
import { useTaskDetailPage } from "./-TaskDetailPageContext";

export function TaskDetailHeader() {
  const {
    agentMap,
    archiveFromInbox,
    archivePending,
    canArchiveFromInbox,
    canPauseLeafWork,
    canRestoreSubtree,
    canResumeLeafWork,
    canResumeSubtree,
    canShowSubtreeControls,
    companyId,
    copied,
    copyTaskToClipboard,
    hasLiveRuns,
    isFromInbox,
    isMobile,
    moreOpen,
    panelVisible,
    projectRouteId,
    resolvedProject,
    setMobilePropsOpen,
    setMoreOpen,
    setPanelVisible,
    setReopenDialogOpen,
    setTreeControlCancelConfirmed,
    setTreeControlMode,
    setTreeControlOpen,
    task,
    updateTaskTitle,
    userLabelMap,
    userProfileMap,
  } = useTaskDetailPage();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        <DomainStatus
          status={task.boardPresentationStatus}
          aria-label={taskStatusAccessibleLabel(task.boardPresentationStatus, task.blockerAttention)}
        >
          {taskValueLabel(task.boardPresentationStatus)}
        </DomainStatus>
        <Badge variant="secondary">{taskValueLabel(task.priority)}</Badge>
        <span className="text-sm font-mono text-muted-foreground shrink-0">{task.identifier}</span>
        {task.lifecycleStatus === "done" || task.lifecycleStatus === "cancelled" ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setReopenDialogOpen(true)}>
            Reopen
          </Button>
        ) : null}

        {hasLiveRuns && <DomainStatus status="running">Live</DomainStatus>}

        {task.originKind === "routine_execution" && task.originId && (
          <Badge asChild variant="secondary">
            <Link
              to="/$companyId/routines/$routineId"
              params={{ companyId, routineId: task.originId }}
              title={`Routine execution from routine ${task.originId}`}
            >
              <Repeat /> Routine
            </Link>
          </Badge>
        )}

        {task.workMode === "ask" || task.workMode === "planning"
          ? (() => {
              const workModeMeta = workModeMetaFor(task.workMode);
              const WorkModeIcon = workModeMeta.icon;
              return (
                <Badge variant="outline" title={`This task is in ${workModeMeta.label.toLowerCase()}.`}>
                  <WorkModeIcon className="h-3 w-3" aria-hidden />
                  {workModeMeta.label}
                </Badge>
              );
            })()
          : null}

        {hasAssignedBacklogBlocker(task.blockedBy) ? (
          <DomainStatus
            status="blocked"
            data-testid="task-detail-parked-blocker"
            title="Blocked by parked work — at least one owned blocker is in backlog and will not dispatch its owner."
          >
            Blocked by parked work
          </DomainStatus>
        ) : null}

        {task.projectId && projectRouteId ? (
          <Link
            to="/$companyId/projects/$projectId"
            params={{ companyId, projectId: projectRouteId }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
          >
            <Hexagon className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {resolvedProject?.name ?? task.project?.name ?? task.projectId.slice(0, 8)}
            </span>
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
            <Hexagon className="h-3 w-3 shrink-0" />
            No project
          </span>
        )}

        <TaskAttributionByline
          task={task}
          agentMap={agentMap}
          userProfileMap={userProfileMap}
          userLabelMap={userLabelMap}
        />

        {(task.labels ?? []).length > 0 && (
          <div className="hidden sm:flex items-center gap-1">
            {(task.labels ?? []).slice(0, 4).map((label) => (
              <Badge
                variant="outline"
                key={label.id}
                className="text-(length:--text-nano)"
                style={{
                  borderColor: label.color,
                  color: pickTextColorForPillBg(label.color, 0.12),
                  backgroundColor: `${label.color}1f`,
                }}
              >
                {label.name}
              </Badge>
            ))}
            {(task.labels ?? []).length > 4 && (
              <span className="text-(length:--text-nano) text-muted-foreground">
                +{(task.labels ?? []).length - 4}
              </span>
            )}
          </div>
        )}

        {!(isMobile && isFromInbox) && (
          <div className="ml-auto flex items-center gap-0.5 md:hidden shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyTaskToClipboard}
              title="Copy task as markdown"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setMobilePropsOpen(true)}
              title="Properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>
        )}

        <div className="hidden md:flex items-center md:ml-auto shrink-0">
          {canArchiveFromInbox && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                if (!archivePending && task?.id) archiveFromInbox.mutate(task.id);
              }}
              disabled={archivePending}
              title="Archive from inbox"
              aria-label="Archive from inbox"
            >
              <Archive className="h-4 w-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" onClick={copyTaskToClipboard} title="Copy task as markdown">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "shrink-0 transition-opacity duration-200",
              panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
            )}
            onClick={() => setPanelVisible(true)}
            title="Show properties"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>

          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0"
                aria-label="More task actions"
                title="More task actions"
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setMoreOpen(true);
                  }
                }}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-1" align="end">
              {canPauseLeafWork ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => {
                    setTreeControlMode("pause");
                    setTreeControlCancelConfirmed(false);
                    setTreeControlOpen(true);
                    setMoreOpen(false);
                  }}
                >
                  <PauseCircle className="h-3 w-3" />
                  Pause work...
                </Button>
              ) : null}
              {canResumeLeafWork ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => {
                    setTreeControlMode("resume");
                    setTreeControlOpen(true);
                    setMoreOpen(false);
                  }}
                >
                  <PlayCircle className="h-3 w-3" />
                  Resume work
                </Button>
              ) : null}
              {canShowSubtreeControls ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => {
                      setTreeControlMode("pause");
                      setTreeControlCancelConfirmed(false);
                      setTreeControlOpen(true);
                      setMoreOpen(false);
                    }}
                  >
                    <PauseCircle className="h-3 w-3" />
                    Pause subtree...
                  </Button>
                  {canResumeSubtree ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => {
                        setTreeControlMode("resume");
                        setTreeControlOpen(true);
                        setMoreOpen(false);
                      }}
                    >
                      <PlayCircle className="h-3 w-3" />
                      Resume subtree
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-destructive"
                    onClick={() => {
                      setTreeControlMode("cancel");
                      setTreeControlCancelConfirmed(false);
                      setTreeControlOpen(true);
                      setMoreOpen(false);
                    }}
                  >
                    <XCircle className="h-3 w-3" />
                    Cancel subtree...
                  </Button>
                  {canRestoreSubtree ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => {
                        setTreeControlMode("restore");
                        setTreeControlCancelConfirmed(false);
                        setTreeControlOpen(true);
                        setMoreOpen(false);
                      }}
                    >
                      <Repeat className="h-3 w-3" />
                      Restore subtree...
                    </Button>
                  ) : null}
                </>
              ) : null}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <InlineEditor
        value={task.title ?? ""}
        onSave={(title) => updateTaskTitle.mutateAsync(title || null)}
        as="h2"
        className="text-xl font-bold"
        placeholder="Add a title..."
        nullable
      />

      <TaskMonitorBanner task={task} />

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Immutable request
        </h3>
        {task.request ? (
          <MarkdownBody className="text-sm leading-7 text-foreground">{task.request}</MarkdownBody>
        ) : (
          <p className="text-sm text-muted-foreground">
            Canonical request unavailable for this historical task.
          </p>
        )}
      </section>
    </div>
  );
}
