import type { ReactNode } from "react";
import type { Task } from "@paperclipai/shared";
import { TaskLinkQuicklook } from "../shared/TaskLinkQuicklook";
import { Archive } from "lucide-react";
import { withTaskDetailHeaderSeed } from "@/lib/taskDetailBreadcrumb";
import { cn } from "@/lib/utils";
import { hasAssignedBacklogBlocker, taskStatusAccessibleLabel, taskValueLabel } from "@/lib/task-blockers";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Item } from "@/components/ui/item";

type UnreadState = "hidden" | "visible" | "fading";

interface TaskRowProps {
  task: Task;
  taskLinkState?: unknown;
  selected?: boolean;
  mobileLeading?: ReactNode;
  desktopMetaLeading?: ReactNode;
  desktopLeadingSpacer?: boolean;
  mobileMeta?: ReactNode;
  desktopTrailing?: ReactNode;
  trailingMeta?: ReactNode;
  titleSuffix?: ReactNode;
  titleClassName?: string;
  checklistStepNumber?: number | string | null;
  checklistCurrentStep?: boolean;
  checklistDependencyChips?: ReactNode;
  checklistRowId?: string;
  unreadState?: UnreadState | null;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  className?: string;
  /** Pointer entered the row (used by list keyboard nav to track hover). */
  onMouseEnter?: () => void;
  /** Ancestor levels; renders that many vertical tree-guide slots (desktop). */
  treeGuides?: number;
  /**
   * This row has its own collapse chevron sitting in the innermost guide
   * column (a nested parent). Breaks the guide line there so the chevron is
   * not crossed out by it.
   */
  chevronInGuide?: boolean;
  /** Suppress the row divider (parents with expanded children keep visual attachment to their subtree). */
  hideDivider?: boolean;
}

export function TaskRow({
  task,
  taskLinkState,
  selected = false,
  mobileLeading,
  desktopMetaLeading,
  desktopLeadingSpacer = false,
  mobileMeta,
  desktopTrailing,
  trailingMeta,
  titleSuffix,
  titleClassName,
  checklistStepNumber = null,
  checklistCurrentStep = false,
  checklistDependencyChips,
  checklistRowId,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  className,
  onMouseEnter,
  treeGuides = 0,
  chevronInGuide = false,
  hideDivider = false,
}: TaskRowProps) {
  const identifier = task.identifier;
  // A row participates in the unread system whenever `unreadState` is supplied
  // (inbox rows). It then reserves a fixed leading dot slot on all rows — read
  // and unread alike — so the mark-read dot sits in the far-left gutter without
  // shifting content, matching the sibling non-task inbox rows.
  const showUnreadSlot = unreadState != null;
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";
  const unreadDotButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={() => {
        onMarkRead?.();
      }}
      className={cn(selected ? "hover:bg-muted/80" : "hover:bg-primary/10")}
      aria-label="Mark as read"
    >
      <span
        className={cn(
          "block h-2 w-2 rounded-full transition-opacity duration-300",
          selected ? "bg-muted-foreground/70" : "bg-primary",
          unreadState === "fading" ? "opacity-0" : "opacity-100",
        )}
      />
    </Button>
  );
  const detailState = withTaskDetailHeaderSeed(taskLinkState, task);
  const hasChecklistStep = checklistStepNumber !== null;
  const checklistStep = hasChecklistStep ? (
    <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">
      {checklistStepNumber}.
    </span>
  ) : null;
  const parkedBlockerIndicator = hasAssignedBacklogBlocker(task.blockedBy) ? (
    <DomainStatus
      status="blocked"
      data-testid="task-row-parked-blocker"
      title="Blocked by parked work — at least one owned blocker is in backlog and will not dispatch its owner."
    >
      Blocked by parked work
    </DomainStatus>
  ) : null;

  return (
    <Item
      size="sm"
      className={cn(
        // No color transition on the row band: hover/selection must snap
        // instantly. A fade (transition-colors) leaves a trail of fading bands
        // when scrubbing the mouse fast across the list.
        "group relative flex-nowrap items-start text-inherit sm:items-center",
        !hideDivider && "border-b border-border last:border-b-0",
        selected ? "hover:bg-transparent" : "hover:bg-accent/50",
        checklistCurrentStep ? "bg-primary/5" : null,
        className,
      )}
    >
      {/*
       * Keep navigation as a sibling overlay rather than a wrapper. Rows accept
       * caller-provided controls (collapse, mark-read, archive, and trailing
       * actions), so wrapping their slots in an anchor would create invalid
       * nested interactive controls.
       */}
      <TaskLinkQuicklook
        taskId={task.id}
        taskNumber={task.taskNumber}
        state={detailState}
        disableTaskQuicklook
        taskPrefetch={task}
        data-inbox-task-link
        id={checklistRowId}
        aria-label={`Open task ${identifier}: ${task.title}`}
        aria-current={checklistCurrentStep ? "step" : undefined}
        onMouseEnter={onMouseEnter}
        className="absolute inset-0 z-10 rounded-lg"
      />
      <span className="relative z-20 flex shrink-0 items-center gap-1 pt-px sm:hidden">
        {mobileLeading ?? (
          <DomainStatus
            status={task.boardPresentationStatus}
            aria-label={taskStatusAccessibleLabel(task.boardPresentationStatus, task.blockerAttention)}
          >
            {taskValueLabel(task.boardPresentationStatus)}
          </DomainStatus>
        )}
        {parkedBlockerIndicator}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
        <span
          className={cn(
            "line-clamp-2 text-sm sm:order-2 sm:min-w-0 sm:flex-1 sm:truncate sm:line-clamp-none",
            titleClassName,
          )}
        >
          {task.title}
          {titleSuffix ? <span className="relative z-20">{titleSuffix}</span> : null}
        </span>
        {checklistDependencyChips ? (
          <span className="relative z-20 flex flex-wrap gap-1 sm:order-3 sm:ml-(--sz-calc-13)">
            {checklistDependencyChips}
          </span>
        ) : null}
        <span className="relative z-20 flex items-center gap-2 self-stretch sm:order-1 sm:shrink-0">
          {showUnreadSlot ? (
            // Reserved leftmost dot gutter (desktop). Present on read and unread
            // rows so the mark-read dot lives to the LEFT of any leading control
            // (a parent's collapse caret, a tree guide) without indenting the row
            // relative to its siblings, and aligns with the non-task inbox rows
            // that reserve the same w-4 slot.
            <span
              data-testid="task-row-unread-slot"
              className="hidden h-4 w-4 shrink-0 items-center justify-center self-center sm:inline-flex"
            >
              {showUnreadDot ? unreadDotButton : null}
            </span>
          ) : null}
          {treeGuides > 0
            ? Array.from({ length: treeGuides }, (_, level) => {
                // The innermost guide lands on THIS row's own chevron column; if
                // the row has a chevron, break the line around it so it isn't
                // crossed out.
                const gapForChevron = chevronInGuide && level === treeGuides - 1;
                return (
                  // Tree guide: occupies the same flex slot as the parent's
                  // chevron column so the line lands under the parent's status
                  // column; stretched past the row padding so consecutive rows
                  // read as one continuous line.
                  <span
                    key={`guide-${level}`}
                    aria-hidden="true"
                    className="relative hidden w-4 shrink-0 self-stretch sm:block"
                  >
                    {/* The connector drops from under the ancestor's STATUS icon,
                    not its chevron: the status column sits one level (w-4 slot
                    + gap-2 = 2rem) right of this guide slot's left edge.
                    bg-background underlay: dark-mode --border is translucent,
                    so overlapping row segments would stack brighter without
                    an opaque base. */}
                    <span className="absolute -inset-y-3 left-8 w-px bg-background">
                      {gapForChevron ? (
                        // Two border segments centering a 14px (h-3.5) transparent
                        // gap for the row's own chevron.
                        <span className="absolute inset-0 flex flex-col">
                          <span className="flex-1 bg-border" />
                          <span className="h-3.5 shrink-0" />
                          <span className="flex-1 bg-border" />
                        </span>
                      ) : (
                        <span className="absolute inset-0 bg-border" />
                      )}
                    </span>
                  </span>
                );
              })
            : null}
          {desktopLeadingSpacer ? <span className="hidden w-3.5 shrink-0 sm:block" /> : null}
          {desktopMetaLeading ?? (
            <>
              <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
                <DomainStatus
                  status={task.boardPresentationStatus}
                  aria-label={taskStatusAccessibleLabel(task.boardPresentationStatus, task.blockerAttention)}
                >
                  {taskValueLabel(task.boardPresentationStatus)}
                </DomainStatus>
              </span>
              {checklistStep}
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{identifier}</span>
              {parkedBlockerIndicator}
            </>
          )}
          {mobileMeta ? (
            <>
              <span className="text-xs text-muted-foreground sm:hidden" aria-hidden="true">
                &middot;
              </span>
              <span className="text-xs text-muted-foreground sm:hidden">{mobileMeta}</span>
            </>
          ) : null}
        </span>
      </span>
      {onArchive || desktopTrailing || trailingMeta ? (
        <span className="relative z-20 ml-auto hidden shrink-0 items-center gap-2 sm:order-3 sm:flex sm:gap-3">
          {onArchive ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                onArchive();
              }}
              disabled={archiveDisabled}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label="Archive"
            >
              <Archive className="h-3.5 w-3.5" data-icon="inline-start" />
              Archive
            </Button>
          ) : null}
          {desktopTrailing}
          {trailingMeta ? <span className="text-xs text-muted-foreground">{trailingMeta}</span> : null}
        </span>
      ) : null}
      {showUnreadDot ? (
        // Mobile keeps the dot in flow as the leading item (mobile has no
        // reserved desktop dot gutter). Desktop renders the dot in the reserved
        // leading slot above instead, so this is mobile-only.
        <span className="relative z-20 order-first inline-flex h-4 w-4 shrink-0 items-center justify-center self-center sm:hidden">
          {unreadDotButton}
        </span>
      ) : null}
    </Item>
  );
}
