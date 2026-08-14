import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { FolderListItem, FolderListResult } from "@paperclipai/shared";
import { Check, Folder as FolderIcon, Plus } from "lucide-react";
import { useMemo } from "react";
import { FolderSwatch, type FolderSelection } from "./folder-primitives";

interface FolderTreeNode {
  folder: FolderListItem;
  children: FolderTreeNode[];
}

function treeFromResult(result: FolderListResult | null | undefined) {
  const nodeById = new Map<string, FolderTreeNode>();
  for (const folder of result?.folders ?? []) {
    nodeById.set(folder.id, { folder, children: [] });
  }
  const roots: FolderTreeNode[] = [];
  for (const node of nodeById.values()) {
    const parent = node.folder.parentId ? nodeById.get(node.folder.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (nodes: FolderTreeNode[]) => {
    nodes.sort(
      (left, right) =>
        left.folder.position - right.folder.position || left.folder.name.localeCompare(right.folder.name),
    );
    nodes.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}

export function MobileFolderSheet({
  open,
  onOpenChange,
  result,
  selection,
  allLabel,
  itemLabelPlural,
  onSelect,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: FolderListResult | null | undefined;
  selection: FolderSelection;
  allLabel: string;
  itemLabelPlural: string;
  onSelect: (selection: FolderSelection) => void;
  onCreate: () => void;
}) {
  function select(next: FolderSelection) {
    onSelect(next);
    onOpenChange(false);
  }

  const roots = useMemo(() => treeFromResult(result), [result]);

  function renderBranch(node: FolderTreeNode, rootLabel?: string) {
    return (
      <div key={node.folder.id} data-folder-id={node.folder.id}>
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
          onClick={() => select(node.folder.id)}
        >
          <FolderSwatch color={node.folder.color} />
          <span className="min-w-0 flex-1 truncate">{rootLabel ?? node.folder.name}</span>
          <span className="text-xs text-muted-foreground">{node.folder.itemCount}</span>
          {selection === node.folder.id ? <Check /> : null}
        </Button>
        {node.children.length > 0 ? (
          <div className="pl-3">{node.children.map((child) => renderBranch(child))}</div>
        ) : null}
      </div>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-(--sz-folder-sheet-max) rounded-t-lg pb-4">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle>{itemLabelPlural} folders</SheetTitle>
        </SheetHeader>
        <div className="overflow-y-auto px-3">
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
            onClick={() => select("all")}
          >
            <FolderIcon />
            <span className="min-w-0 flex-1 truncate">{allLabel}</span>
            <span className="text-xs text-muted-foreground">{result?.allCount ?? 0}</span>
            {selection === "all" ? <Check /> : null}
          </Button>
          {roots.map((node) => renderBranch(node, node.folder.name))}
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
            onClick={() => select("unfiled")}
          >
            <FolderSwatch color={null} />
            <span className="min-w-0 flex-1 truncate">Unfiled</span>
            <span className="text-xs text-muted-foreground">{result?.unfiledCount ?? 0}</span>
            {selection === "unfiled" ? <Check /> : null}
          </Button>
        </div>
        <div className="border-t border-border px-4 pt-3">
          <Button size="sm" variant="outline" className="w-full" onClick={onCreate}>
            <Plus data-icon="inline-start" className="mr-2 h-3.5 w-3.5" />
            New folder
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
