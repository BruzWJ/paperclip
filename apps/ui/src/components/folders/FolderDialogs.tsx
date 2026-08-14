import { Button } from "@/components/ui/button";
import * as DialogUI from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldTitle } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { FolderListItem } from "@paperclipai/shared";
import { useEffect, useState } from "react";

import { FOLDER_COLORS } from "./folder-primitives";
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

export function FolderFormDialog({
  open,
  folder,
  onOpenChange,
  onSubmit,
  pending = false,
}: {
  open: boolean;
  folder: FolderListItem | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: { name: string; color: string | null }) => void;
  pending?: boolean;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(FOLDER_COLORS[0] ?? null);
  const isEdit = Boolean(folder);

  useEffect(() => {
    if (!open) return;
    setName(folder?.name ?? "");
    setColor(folder?.color ?? FOLDER_COLORS[0] ?? null);
  }, [folder, open]);

  return (
    <DialogUI.Dialog open={open} onOpenChange={onOpenChange}>
      <DialogUI.DialogContent className="sm:max-w-md">
        <DialogUI.DialogHeader>
          <DialogUI.DialogTitle>{isEdit ? "Edit folder" : "Create folder"}</DialogUI.DialogTitle>
          <DialogUI.DialogDescription>Organize routines in this company.</DialogUI.DialogDescription>
        </DialogUI.DialogHeader>
        <div className="space-y-4">
          <Field className="gap-2">
            <FieldLabel htmlFor="folder-name">Name</FieldLabel>
            <Input
              id="folder-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter" && name.trim()) onSubmit({ name: name.trim(), color });
              }}
            />
          </Field>
          <Field className="gap-2">
            <FieldTitle>Color</FieldTitle>
            <ToggleGroup
              type="single"
              value={color ?? "none"}
              variant="outline"
              size="sm"
              spacing={2}
              className="flex-wrap justify-start"
              onValueChange={(value) => setColor(value && value !== "none" ? value : null)}
            >
              {FOLDER_COLORS.map((swatch) => (
                <ToggleGroupItem
                  key={swatch}
                  value={swatch}
                  aria-label={`Use folder color ${swatch}`}
                  className="size-7 p-0"
                  style={{ backgroundColor: `var(--folder-color-${swatch})` }}
                />
              ))}
              <ToggleGroupItem value="none" className="h-7 text-xs text-muted-foreground">
                None
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </div>
        <DialogUI.DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit({ name: name.trim(), color })} disabled={pending || !name.trim()}>
            {pending ? "Saving..." : isEdit ? "Save" : "Create folder"}
          </Button>
        </DialogUI.DialogFooter>
      </DialogUI.DialogContent>
    </DialogUI.Dialog>
  );
}

export function DeleteFolderDialog({
  open,
  folder,
  itemLabelPlural,
  onOpenChange,
  onConfirm,
  pending = false,
}: {
  open: boolean;
  folder: FolderListItem | null;
  itemLabelPlural: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending?: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete folder</AlertDialogTitle>
          <AlertDialogDescription>
            The {folder?.itemCount ?? 0} {itemLabelPlural} in this folder won&apos;t be deleted. They&apos;ll
            move to Unfiled.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending || !folder}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending || !folder}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending ? "Deleting..." : "Delete folder"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
