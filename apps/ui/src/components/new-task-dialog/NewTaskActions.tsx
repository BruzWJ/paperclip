import type { TaskWorkMode } from "@paperclipai/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Calendar, CircleDot, Flag, Loader2, Minus, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { priorities } from "./model";
import { useNewTaskDialogViewModel } from "./context";

export function NewTaskActions() {
  const model = useNewTaskDialogViewModel();
  const { isSubTaskMode } = model.dialog;
  const { draftHasText, requestHasText, selectedOwnerAgentId, status, priority, ownerAgentId, workMode } =
    model.values;
  const { setStatus, setPriority, setWorkMode } = model.setters;
  const { statuses, workModeOptions } = model.options;
  const { currentStatus, currentPriority, currentWorkMode, canDiscardDraft, createTaskErrorMessage } =
    model.derived;
  const { createTask } = model.creation;
  const { discardDraft, handleSubmit } = model.actions;
  const CurrentWorkModeIcon = currentWorkMode.icon;
  return (
    <>
      <ButtonGroup className="w-full shrink-0 flex-wrap gap-1.5 px-4 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="xs">
              <CircleDot className="h-3 w-3" />
              {currentStatus.label}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="start">
            <DropdownMenuRadioGroup value={status} onValueChange={(v) => setStatus(v)}>
              {statuses.map((s) => (
                <DropdownMenuRadioItem key={s.value} value={s.value} className="text-xs">
                  <CircleDot className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="flex flex-col text-left leading-tight">
                    <span>{s.label}</span>
                    {s.description ? (
                      <span className="text-(length:--text-nano) text-muted-foreground">{s.description}</span>
                    ) : null}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="new-task-priority-chip"
              className="hidden sm:inline-flex"
            >
              {currentPriority ? (
                <>
                  <currentPriority.icon className="h-3 w-3" />
                  {currentPriority.label}
                </>
              ) : (
                <>
                  <Minus className="h-3 w-3 text-muted-foreground" />
                  Priority
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-36" align="start">
            <DropdownMenuRadioGroup value={priority} onValueChange={(v) => setPriority(v)}>
              {priorities.map((p) => (
                <DropdownMenuRadioItem key={p.value} value={p.value} className="text-xs">
                  <p.icon className="h-3 w-3" />
                  {p.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-task-work-mode-chip={workMode}
              aria-keyshortcuts="Meta+Period Control+Period"
            >
              <CurrentWorkModeIcon className="h-3 w-3" />
              {currentWorkMode.shortLabel}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-36" align="start">
            <DropdownMenuRadioGroup value={workMode} onValueChange={(v) => setWorkMode(v as TaskWorkMode)}>
              {workModeOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                    data-task-work-mode={option.value}
                    className="text-xs"
                  >
                    <Icon className="h-3 w-3" />
                    {option.label}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              data-testid="new-task-more-menu-trigger"
              aria-label="More task options"
            >
              <MoreHorizontal className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-44" align="start" data-testid="new-task-more-menu">
            <div className="sm:hidden">
              <DropdownMenuLabel className="text-(length:--text-nano)">Priority</DropdownMenuLabel>
              {priorities.map((p) => (
                <DropdownMenuItem
                  key={p.value}
                  data-testid={`new-task-more-priority-${p.value}`}
                  className={cn("text-xs", p.value === priority && "bg-accent")}
                  onClick={() => setPriority(p.value)}
                >
                  <p.icon className="h-3 w-3" />
                  {p.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </div>
            <DropdownMenuItem className="text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              Start date
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              Due date
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>

      {ownerAgentId && status === "backlog" ? (
        <Alert data-testid="new-task-assigned-backlog-note" className="mx-4 mb-2 w-auto">
          <Flag />
          <AlertDescription>
            Agent ownership implies executable intent - leave status as{" "}
            <span className="font-medium">Backlog</span> only to deliberately park this. The owner will not be
            dispatched until status moves to <span className="font-medium">Todo</span> or{" "}
            <span className="font-medium">In Progress</span>.
          </AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter className="shrink-0 flex-row items-center justify-between px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={discardDraft}
          disabled={createTask.isPending || !canDiscardDraft}
        >
          Discard Draft
        </Button>
        <div className="flex items-center gap-3">
          <div className="min-h-5 text-right">
            {createTask.isPending ? (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Creating task...
              </span>
            ) : createTask.isError ? (
              <span role="alert" className="text-xs text-destructive">
                {createTaskErrorMessage}
              </span>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            className="min-w-(--sz-8_5rem) disabled:opacity-100"
            disabled={!draftHasText || !requestHasText || !selectedOwnerAgentId || createTask.isPending}
            onClick={handleSubmit}
            aria-busy={createTask.isPending}
          >
            <span className="inline-flex items-center justify-center gap-1.5">
              {createTask.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              <span>
                {createTask.isPending ? "Creating..." : isSubTaskMode ? "Create Sub-Task" : "Create Task"}
              </span>
            </span>
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
