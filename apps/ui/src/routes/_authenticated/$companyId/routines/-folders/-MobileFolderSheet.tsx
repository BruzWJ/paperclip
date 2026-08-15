import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DomainTree, type DomainTreeNode } from "@/components/patterns/DomainTree";
import type { FolderListItem, FolderListResult } from "@paperclipai/shared";
import { Check, Folder as FolderIcon, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { FolderSwatch, type FolderSelection } from "./-folder-primitives";

function treeFromResult(result: FolderListResult | null | undefined) {
  const nodeById = new Map<string, DomainTreeNode<FolderListItem>>();
  for (const folder of result?.folders ?? []) {
    nodeById.set(folder.id, { id: folder.id, value: folder, children: [] });
  }
  const roots: DomainTreeNode<FolderListItem>[] = [];
  for (const node of nodeById.values()) {
    const parent = node.value.parentId ? nodeById.get(node.value.parentId) : undefined;
    if (parent) parent.children?.push(node);
    else roots.push(node);
  }
  const sort = (nodes: DomainTreeNode<FolderListItem>[]) => {
    nodes.sort(
      (left, right) =>
        left.value.position - right.value.position || left.value.name.localeCompare(right.value.name),
    );
    nodes.forEach((node) => sort(node.children ?? []));
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
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const expandedIds = useMemo(
    () =>
      new Set(
        roots
          .flatMap(function collect(node): string[] {
            return node.children?.length ? [node.id, ...node.children.flatMap(collect)] : [];
          })
          .filter((id) => !collapsedIds.has(id)),
      ),
    [collapsedIds, roots],
  );

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
          <DomainTree
            nodes={roots}
            expandedIds={expandedIds}
            selectedIds={selection !== "all" && selection !== "unfiled" ? [selection] : []}
            onToggle={({ id }) => {
              setCollapsedIds((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            ariaLabel={`${itemLabelPlural} folders`}
            showLines={false}
            animateExpand={false}
            rowData={({ node }) => ({ "data-folder-id": node.id })}
            renderIcon={({ node }) => <FolderSwatch color={node.value.color} />}
            renderLabel={({ node }) => (
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start gap-2 p-0 text-left font-normal hover:bg-transparent"
                onClick={(event) => {
                  event.stopPropagation();
                  select(node.value.id);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{node.value.name}</span>
                <span className="text-xs text-muted-foreground">{node.value.itemCount}</span>
                {selection === node.value.id ? <Check /> : null}
              </Button>
            )}
          />
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
