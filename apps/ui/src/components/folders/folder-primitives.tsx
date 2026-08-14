import { cn } from "@/lib/utils";
import type { FolderListItem } from "@paperclipai/shared";

export type FolderSelection = "all" | "unfiled" | string;

export const FOLDER_COLORS = ["indigo", "violet", "emerald", "cyan", "amber", "slate"];

export function normalizeFolderSelection(value: string | null | undefined): FolderSelection {
  if (!value) return "all";
  if (value === "unfiled") return "unfiled";
  return value;
}

export function folderSearchValue(selection: FolderSelection): string {
  return selection === "all" ? "" : selection === "unfiled" ? "unfiled" : selection;
}

export function selectedFolderFromList(
  folders: FolderListItem[],
  selection: FolderSelection,
): FolderListItem | null {
  if (selection === "all" || selection === "unfiled") return null;
  return folders.find((folder) => folder.id === selection) ?? null;
}

const FOLDER_COLOR_VALUES: Record<(typeof FOLDER_COLORS)[number], string> = {
  indigo: "var(--folder-color-indigo)",
  violet: "var(--folder-color-violet)",
  emerald: "var(--folder-color-emerald)",
  cyan: "var(--folder-color-cyan)",
  amber: "var(--folder-color-amber)",
  slate: "var(--folder-color-slate)",
};

export function FolderSwatch({ color, className }: { color: string | null | undefined; className?: string }) {
  const backgroundColor = color ? (FOLDER_COLOR_VALUES[color] ?? color) : "var(--folder-color-slate)";
  return (
    <span
      aria-hidden="true"
      className={cn("h-2.5 w-2.5 shrink-0 rounded-sm border border-border/40", className)}
      style={{ backgroundColor }}
    />
  );
}
