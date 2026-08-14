import { Spinner } from "@/components/ui/spinner";
import { Kbd } from "@/components/ui/kbd";
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { DirtyFieldDescriptor } from "./RoutineHistoryTab";

/**
 * Per-section sticky save bar (§1.4–§1.5). Hidden when clean; reveals on dirty.
 * On a 409 it swaps to the conflict-recovery surface ("Reload latest" /
 * "Overwrite anyway"). Wires ⌘/Ctrl+S → save and Esc → discard-with-confirm.
 */
export function RoutineSaveBar({
  dirtyFields,
  isSaving,
  saveConflict,
  onSave,
  onDiscard,
  onReload,
  disabled,
}: {
  dirtyFields: DirtyFieldDescriptor[];
  isSaving: boolean;
  saveConflict: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
  disabled?: boolean;
}) {
  const dirtyCount = dirtyFields.length;
  const isDirty = dirtyCount > 0;
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  useEffect(() => {
    if (!isDirty && !saveConflict) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!isSaving && !disabled) onSave();
      } else if (event.key === "Escape" && isDirty) {
        event.preventDefault();
        setConfirmDiscardOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDirty, saveConflict, isSaving, disabled, onSave]);

  if (!isDirty && !saveConflict) return null;

  return (
    <>
      <Card className="sticky bottom-0 z-10 -mx-8 mt-6 rounded-none py-0">
        <CardContent className="flex min-h-14 items-center justify-between px-8 py-2">
          {saveConflict ? (
            <Alert variant="destructive" className="w-auto border-0 p-0 shadow-none">
              <AlertTriangle />
              <AlertTitle>Routine changed elsewhere. Reload to merge.</AlertTitle>
            </Alert>
          ) : (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm">
                  <span>
                    {dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64">
                <ItemGroup aria-label="Pending changes">
                  {dirtyFields.map((field) => (
                    <Item key={field.key} size="sm">
                      <ItemContent>
                        <ItemTitle className="capitalize">{field.label}</ItemTitle>
                      </ItemContent>
                    </Item>
                  ))}
                </ItemGroup>
              </PopoverContent>
            </Popover>
          )}

          <div className="flex items-center gap-2">
            {saveConflict ? (
              <>
                <Button variant="outline" size="sm" onClick={onReload}>
                  Reload latest
                </Button>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={isSaving || disabled}
                        onClick={onSave}
                      >
                        {isSaving ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
                        Overwrite anyway
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Replaces the newer revision with your local edits.</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isSaving || disabled}
                  onClick={() => setConfirmDiscardOpen(true)}
                >
                  Discard
                </Button>
                <Button size="sm" disabled={isSaving || disabled} onClick={onSave}>
                  {isSaving ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
                  Save changes
                  <Kbd className="ml-2 hidden sm:inline-flex">⌘S</Kbd>
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This will revert {dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"} in this section.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDiscard}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
