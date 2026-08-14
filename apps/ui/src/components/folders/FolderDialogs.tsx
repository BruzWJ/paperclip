import { Button } from "@/components/ui/button";
import { HexColorPicker } from "@/components/patterns/BrandColorPicker";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";
import { Input } from "@/components/ui/input";
import type { FolderListItem } from "@paperclipai/shared";
import { useEffect, useState } from "react";
import type { NamedColor } from "@/lib/presentation-contracts";

import { resolveFolderColor } from "./folder-primitives";

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
  onSubmit: (payload: NamedColor) => void;
  pending?: boolean;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(() => resolveFolderColor(null));
  const isEdit = Boolean(folder);

  useEffect(() => {
    if (!open) return;
    setName(folder?.name ?? "");
    setColor(folder?.color ?? resolveFolderColor(null));
  }, [folder, open]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="sm:max-w-md"
      title={isEdit ? "Edit folder" : "Create folder"}
      description="Organize routines in this company."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit({ name: name.trim(), color })} disabled={pending || !name.trim()}>
            {pending ? "Saving..." : isEdit ? "Save" : "Create folder"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <LabeledFormField className="gap-2" label="Name" labelFor="folder-name">
          <Input
            id="folder-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter" && name.trim()) onSubmit({ name: name.trim(), color });
            }}
          />
        </LabeledFormField>
        <LabeledFormField className="gap-2" label="Color">
          <HexColorPicker value={resolveFolderColor(color)} onChange={setColor} ariaLabel="Folder color" />
          <Button type="button" size="sm" variant="ghost" onClick={() => setColor(null)}>
            Use default
          </Button>
        </LabeledFormField>
      </div>
    </FormDialog>
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
  onConfirm: () => void | Promise<void>;
  pending?: boolean;
}) {
  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete folder"
      description={
        <>
          The {folder?.itemCount ?? 0} {itemLabelPlural} in this folder won&apos;t be deleted. They&apos;ll
          move to Unfiled.
        </>
      }
      confirmLabel="Delete folder"
      pendingLabel="Deleting..."
      variant="destructive"
      disabled={!folder}
      pending={pending}
      onConfirm={onConfirm}
    />
  );
}
