import type { FolderListItem, FolderListResult } from "@paperclipai/shared";

export interface FolderTreeNode {
  folder: FolderListItem;
  children: FolderTreeNode[];
}

export interface FolderTreeModel {
  roots: FolderTreeNode[];
}

function sortNodes(nodes: FolderTreeNode[]): void {
  nodes.sort(
    (left, right) =>
      left.folder.position - right.folder.position ||
      left.folder.name.localeCompare(right.folder.name),
  );
  for (const node of nodes) sortNodes(node.children);
}

export function buildFolderTree(folders: FolderListItem[]): FolderTreeModel {
  const nodeById = new Map<string, FolderTreeNode>();
  for (const folder of folders) {
    nodeById.set(folder.id, { folder, children: [] });
  }

  const roots: FolderTreeNode[] = [];
  for (const folder of folders) {
    const node = nodeById.get(folder.id);
    if (!node) continue;
    const parent = folder.parentId ? nodeById.get(folder.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  sortNodes(roots);

  return { roots };
}

export function treeFromResult(
  result: FolderListResult | null | undefined,
): FolderTreeModel {
  return buildFolderTree(result?.folders ?? []);
}

export function folderRootLabel(
  folder: Pick<FolderListItem, "name">,
): string {
  return folder.name;
}
