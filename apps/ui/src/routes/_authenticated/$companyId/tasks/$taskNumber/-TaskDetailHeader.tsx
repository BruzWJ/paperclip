import type { ComponentProps, ReactNode } from "react";

import { InlineEditor } from "@/features/markdown/InlineEditor";
import { MarkdownBody } from "@/features/markdown/MarkdownBody";
import { TaskMonitorBanner } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-TaskMonitorBanner";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { hasAssignedBacklogBlocker, taskStatusAccessibleLabel, taskValueLabel } from "@/lib/task-blockers";
import { workModeMetaFor } from "@/lib/work-mode-meta";
import type { TaskTreeControlMode } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  Check,
  Copy,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Repeat,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";
import { TaskAttributionByline } from "./-TaskAttribution";
import { useTaskDetailPage } from "./-TaskDetailPageContext";

type HeaderIconActionProps = Omit<ComponentProps<typeof Button>, "aria-label" | "children"> & {
  label: string;
  children: ReactNode;
};

function HeaderIconAction({ label, children, ...props }: HeaderIconActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

interface TaskControlMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buttonSize: "icon" | "icon-sm";
  canPauseLeafWork: boolean;
  canResumeLeafWork: boolean;
  canShowSubtreeControls: boolean;
  canResumeSubtree: boolean;
  canRestoreSubtree: boolean;
  onAction: (mode: TaskTreeControlMode) => void;
}

function TaskControlMenu({
  open,
  onOpenChange,
  buttonSize,
  canPauseLeafWork,
  canResumeLeafWork,
  canShowSubtreeControls,
  canResumeSubtree,
  canRestoreSubtree,
  onAction,
}: TaskControlMenuProps) {
  const hasControls = canPauseLeafWork || canResumeLeafWork || canShowSubtreeControls;
  if (!hasControls) return null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={buttonSize}
          aria-label="More task actions"
          title="More task actions"
        >
          <MoreHorizontal  data-icon="inline-start"/>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end">
        <DropdownMenuLabel>Work controls</DropdownMenuLabel>
        {canPauseLeafWork ? (
          <DropdownMenuItem onSelect={() => onAction("pause")}>
            <PauseCircle  data-icon="inline-end"/>
            Pause work...
          </DropdownMenuItem>
        ) : null}
        {canResumeLeafWork ? (
          <DropdownMenuItem onSelect={() => onAction("resume")}>
            <PlayCircle  data-icon="inline-end"/>
            Resume work
          </DropdownMenuItem>
        ) : null}
        {canShowSubtreeControls ? (
          <>
            <DropdownMenuItem onSelect={() => onAction("pause")}>
              <PauseCircle  data-icon="inline-end"/>
              Pause subtree...
            </DropdownMenuItem>
            {canResumeSubtree ? (
              <DropdownMenuItem onSelect={() => onAction("resume")}>
                <PlayCircle  data-icon="inline-end"/>
                Resume subtree
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem variant="destructive" onSelect={() => onAction("cancel")}>
              <XCircle  data-icon="inline-end"/>
              Cancel subtree...
            </DropdownMenuItem>
            {canRestoreSubtree ? (
              <DropdownMenuItem onSelect={() => onAction("restore")}>
                <Repeat  data-icon="inline-end"/>
                Restore subtree...
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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

  const actionButtonSize = isMobile ? "icon" : "icon-sm";
  const showLocalUtilities = !(isMobile && isFromInbox);
  const openTreeControl = (mode: TaskTreeControlMode) => {
    setTreeControlMode(mode);
    setTreeControlCancelConfirmed(false);
    setTreeControlOpen(true);
    setMoreOpen(false);
  };

  return (
    <div className="space-y-4">
      <header className="space-y-3" data-testid="task-detail-header">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <InlineEditor
              value={task.title ?? ""}
              onSave={(title) => updateTaskTitle.mutateAsync(title || null)}
              as="h1"
              className="text-xl font-semibold leading-tight sm:text-2xl [&>button]:text-xl [&>button]:font-semibold sm:[&>button]:text-2xl"
              placeholder="Add a title..."
              nullable
            />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1 pt-0.5" role="group" aria-label="Task utilities">
            {!isMobile && canArchiveFromInbox ? (
              <HeaderIconAction
                size={actionButtonSize}
                label="Archive from inbox"
                onClick={() => {
                  if (!archivePending && task.id) archiveFromInbox.mutate(task.id);
                }}
                disabled={archivePending}
              >
                <Archive  data-icon="inline-start"/>
              </HeaderIconAction>
            ) : null}

            {showLocalUtilities ? (
              <>
                <HeaderIconAction
                  size={actionButtonSize}
                  label={copied ? "Task copied" : "Copy task as markdown"}
                  onClick={copyTaskToClipboard}
                >
                  {copied ? <Check  data-icon="inline-start"/> : <Copy  data-icon="inline-start"/>}
                </HeaderIconAction>
                {(isMobile || !panelVisible) && (
                  <HeaderIconAction
                    size={actionButtonSize}
                    label="Show properties"
                    onClick={() => {
                      if (isMobile) setMobilePropsOpen(true);
                      else setPanelVisible(true);
                    }}
                  >
                    <SlidersHorizontal  data-icon="inline-start"/>
                  </HeaderIconAction>
                )}
              </>
            ) : null}

            <TaskControlMenu
              open={moreOpen}
              onOpenChange={setMoreOpen}
              buttonSize={actionButtonSize}
              canPauseLeafWork={canPauseLeafWork}
              canResumeLeafWork={canResumeLeafWork}
              canShowSubtreeControls={canShowSubtreeControls}
              canResumeSubtree={canResumeSubtree}
              canRestoreSubtree={canRestoreSubtree}
              onAction={openTreeControl}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Task state">
            <DomainStatus
              status={task.boardPresentationStatus}
              aria-label={taskStatusAccessibleLabel(task.boardPresentationStatus, task.blockerAttention)}
            >
              {taskValueLabel(task.boardPresentationStatus)}
            </DomainStatus>
            <Badge variant="secondary" aria-label={`${taskValueLabel(task.priority)} priority`}>
              {taskValueLabel(task.priority)} priority
            </Badge>
            {task.originKind === "routine_execution" && task.originId ? (
              <Badge asChild variant="secondary">
                <Link
                  to="/$companyId/routines/$routineId"
                  params={{ companyId, routineId: task.originId }}
                  title={`Routine execution from routine ${task.originId}`}
                >
                  <Repeat  data-icon="inline-start"/> Routine
                </Link>
              </Badge>
            ) : null}
            {task.workMode === "ask" || task.workMode === "planning"
              ? (() => {
                  const workModeMeta = workModeMetaFor(task.workMode);
                  const WorkModeIcon = workModeMeta.icon;
                  return (
                    <Badge variant="outline" title={`This task is in ${workModeMeta.label.toLowerCase()}.`}>
                      <WorkModeIcon aria-hidden="true" />
                      {workModeMeta.label}
                    </Badge>
                  );
                })()
              : null}
            {hasLiveRuns ? <DomainStatus status="running">Live run</DomainStatus> : null}
            {hasAssignedBacklogBlocker(task.blockedBy) ? (
              <DomainStatus
                status="blocked"
                data-testid="task-detail-parked-blocker"
                title="Blocked by parked work — at least one owned blocker is in backlog and will not dispatch its owner."
              >
                Blocked by parked work
              </DomainStatus>
            ) : null}
            {task.lifecycleStatus === "done" || task.lifecycleStatus === "cancelled" ? (
              <Button type="button" variant="outline" size="xs" onClick={() => setReopenDialogOpen(true)}>
                Reopen
              </Button>
            ) : null}
          </div>

          <TaskAttributionByline
            task={task}
            agentMap={agentMap}
            userProfileMap={userProfileMap}
            userLabelMap={userLabelMap}
            className="sm:justify-end"
          />
        </div>

        {(task.labels ?? []).length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Task labels">
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
            {(task.labels ?? []).length > 4 ? (
              <span className="text-(length:--text-nano) text-muted-foreground">
                +{(task.labels ?? []).length - 4} more
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      <TaskMonitorBanner task={task} />

      <section className="space-y-2 border-t border-border pt-4">
        <h2 className="text-xs font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
          Immutable request
        </h2>
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
