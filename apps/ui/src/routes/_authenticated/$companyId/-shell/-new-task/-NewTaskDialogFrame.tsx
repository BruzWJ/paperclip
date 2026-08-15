import type { CSSProperties } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { nextWorkMode } from "@/lib/work-mode-meta";
import { isWorkModeEscapeShortcut, MOBILE_DIALOG_HEIGHT } from "./-model";
import { useNewTaskDialogViewModel } from "./-context";
import { NewTaskActions } from "./-NewTaskActions";
import { NewTaskEditorContent } from "./-NewTaskEditorContent";

export function NewTaskDialogFrame() {
  const model = useNewTaskDialogViewModel();
  const { newTaskOpen, closeNewTask } = model.dialog;
  const { expanded } = model.values;
  const { setWorkMode } = model.setters;
  const { createTask } = model.creation;
  const { handleKeyDown } = model.actions;
  return (
    <Dialog
      open={newTaskOpen}
      onOpenChange={(open) => {
        if (!open && !createTask.isPending) closeNewTask();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        style={{ "--new-task-dialog-height": MOBILE_DIALOG_HEIGHT } as CSSProperties}
        className={cn(
          "flex h-(--new-task-dialog-height) max-h-(--new-task-dialog-height) flex-col gap-0 overflow-hidden p-0 sm:h-auto",
          expanded ? "sm:max-w-2xl sm:h-(--new-task-dialog-height)" : "sm:max-w-lg",
        )}
        onKeyDown={handleKeyDown}
        onEscapeKeyDown={(event) => {
          if (event.defaultPrevented) return;
          if (isWorkModeEscapeShortcut(event)) {
            event.preventDefault();
            setWorkMode((current) => nextWorkMode(current));
            return;
          }
          if (createTask.isPending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (createTask.isPending) {
            event.preventDefault();
            return;
          }
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[data-radix-popper-content-wrapper], [data-paperclip-floating-ui]")) {
            event.preventDefault();
          }
        }}
      >
        <DialogTitle className="sr-only">Create a task</DialogTitle>
        <NewTaskEditorContent />
        <NewTaskActions />
      </DialogContent>
    </Dialog>
  );
}
