import { cn } from "@/lib/utils";
import { PROJECT_COLORS, type FolderListItem } from "@paperclipai/shared";

export type FolderSelection = "all" | "unfiled" | string;

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

const LEGACY_FOLDER_COLOR_VALUES: Record<string, string> = {
  indigo: PROJECT_COLORS[0],
  violet: PROJECT_COLORS[1],
  emerald: PROJECT_COLORS[6],
  cyan: PROJECT_COLORS[8],
  amber: PROJECT_COLORS[5],
  slate: PROJECT_COLORS[9],
};

export function resolveFolderColor(color: string | null | undefined): string {
  return color ? (LEGACY_FOLDER_COLOR_VALUES[color] ?? color) : PROJECT_COLORS[0];
}

export function FolderSwatch({ color, className }: { color: string | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("h-2.5 w-2.5 shrink-0 rounded-sm border border-border/40", className)}
      style={{ backgroundColor: resolveFolderColor(color) }}
    />
  );
}
