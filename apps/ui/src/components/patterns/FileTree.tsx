import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { DomainTree, type DomainTreeNode, type DomainTreeNodeState } from "@/components/patterns/DomainTree";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { cn } from "@/lib/utils";
import { FileCode2, FileText } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import {
  type FileTreeBadge,
  type FileTreeEmptyState,
  type FileTreeErrorState,
  type FileTreeNode,
  type FileTreeTone,
  collectAllPaths,
} from "./FileTreeModel";

const fileTreeToneClass: Record<FileTreeTone, string | undefined> = {
  default: undefined,
  warning: "bg-muted text-foreground",
  error: "bg-destructive/5 text-destructive",
  muted: "opacity-50",
};

function fileIcon(name: string) {
  const Icon = name.endsWith(".yaml") || name.endsWith(".yml") ? FileCode2 : FileText;
  return <Icon className="size-4" />;
}

function checkboxState(node: FileTreeNode, checkedFiles: Set<string>) {
  if (node.kind === "file") {
    return {
      allChecked: checkedFiles.has(node.path),
      someChecked: false,
    };
  }

  const childFilePaths = [...collectAllPaths(node.children, "file")];
  const allChecked = childFilePaths.length > 0 && childFilePaths.every((path) => checkedFiles.has(path));
  const someChecked = childFilePaths.some((path) => checkedFiles.has(path));
  return { allChecked, someChecked: someChecked && !allChecked };
}

function toDomainNodes(nodes: FileTreeNode[]): DomainTreeNode<FileTreeNode>[] {
  return nodes.map((node) => ({
    id: node.path,
    value: node,
    children: toDomainNodes(node.children),
  }));
}

export type FileTreeProps = {
  nodes: FileTreeNode[];
  selectedFile: string | null;
  expandedDirs: Set<string>;
  checkedFiles?: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onToggleCheck?: (path: string, kind: "file" | "dir") => void;
  /** Serializable badge metadata keyed by path. This is safe to expose through plugin UI contracts. */
  fileBadges?: Record<string, FileTreeBadge | undefined>;
  /** Closed row tone metadata keyed by path. This avoids raw host class names in public contracts. */
  fileTones?: Record<string, FileTreeTone | undefined>;
  /** Internal-only escape hatch for current host call sites that need richer row content. */
  renderFileExtra?: (node: FileTreeNode, checked: boolean) => ReactNode;
  showCheckboxes?: boolean;
  /** Allow long file and directory names to wrap instead of forcing horizontal overflow. */
  wrapLabels?: boolean;
  loading?: boolean;
  error?: FileTreeErrorState | null;
  empty?: FileTreeEmptyState;
  ariaLabel?: string;
};

/** Paperclip file metadata mapped onto the official Kibo Tree composition. */
export function FileTree({
  nodes,
  selectedFile,
  expandedDirs,
  checkedFiles,
  onToggleDir,
  onSelectFile,
  onToggleCheck,
  fileBadges,
  fileTones,
  renderFileExtra,
  showCheckboxes = true,
  wrapLabels = true,
  loading = false,
  error,
  empty,
  ariaLabel = "Files",
}: FileTreeProps) {
  const effectiveCheckedFiles = checkedFiles ?? new Set<string>();
  const treeNodes = useMemo(() => toDomainNodes(nodes), [nodes]);

  if (loading) {
    return (
      <div aria-busy="true" aria-label={ariaLabel} role="tree" className="py-1">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex min-h-9 items-center gap-2 px-4">
            <Skeleton className="size-4 shrink-0 rounded-sm" />
            <Skeleton className={cn("h-3.5", row === 1 ? "w-3/5" : "w-4/5")} />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div aria-label={ariaLabel} role="tree" className="p-3">
        <Alert variant="destructive" role="treeitem" aria-level={1}>
          <AlertDescription>{error.message}</AlertDescription>
          {error.retry ? (
            <Button type="button" size="xs" variant="outline" onClick={error.retry}>
              Retry
            </Button>
          ) : null}
        </Alert>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div aria-label={ariaLabel} role="tree" className="p-3">
        <Empty className="p-6">
          <EmptyHeader>
            <EmptyTitle>{empty?.title ?? "No files"}</EmptyTitle>
            <EmptyDescription>
              {empty?.description ?? "Files will appear here when they are available."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const stateFor = (state: DomainTreeNodeState<FileTreeNode>) =>
    checkboxState(state.node.value, effectiveCheckedFiles);

  return (
    <DomainTree
      nodes={treeNodes}
      expandedIds={expandedDirs}
      selectedIds={selectedFile ? [selectedFile] : []}
      ariaLabel={ariaLabel}
      animateExpand={false}
      onToggle={({ value }) => {
        if (value.kind === "dir") onToggleDir(value.path);
      }}
      onActivate={({ value }) => {
        if (value.kind === "file") onSelectFile(value.path);
      }}
      onNodeKeyDown={(event, { node }) => {
        if (event.key !== " " || !showCheckboxes || !onToggleCheck) return false;
        event.preventDefault();
        onToggleCheck(node.value.path, node.value.kind);
        return true;
      }}
      rowData={({ node }) => ({ "data-file-tree-path": node.value.path })}
      ariaChecked={
        showCheckboxes
          ? (state) => {
              const { allChecked, someChecked } = stateFor(state);
              return someChecked ? "mixed" : allChecked;
            }
          : undefined
      }
      rowClassName={({ node, selected }) =>
        cn(
          "min-h-9",
          selected && "text-foreground",
          fileTreeToneClass[fileTones?.[node.value.path] ?? "default"],
        )
      }
      renderBeforeLabel={
        showCheckboxes
          ? (state) => {
              const node = state.node.value;
              const { allChecked, someChecked } = stateFor(state);
              return (
                <Checkbox
                  aria-label={`Select ${node.name}`}
                  data-file-tree-checkbox={node.path}
                  checked={someChecked ? "indeterminate" : allChecked}
                  onCheckedChange={() => onToggleCheck?.(node.path, node.kind)}
                />
              );
            }
          : undefined
      }
      renderIcon={({ node }) => (node.value.kind === "file" ? fileIcon(node.value.name) : undefined)}
      renderLabel={({ node }) => (
        <span className={cn("min-w-0", wrapLabels ? "break-all leading-4" : "truncate")}>
          {node.value.name}
        </span>
      )}
      renderAfterLabel={(state) => {
        const node = state.node.value;
        const badge = fileBadges?.[node.path];
        const { allChecked } = stateFor(state);
        return (
          <>
            {badge ? (
              <DomainStatus
                status={badge.status}
                className="ml-3 text-(length:--text-nano) uppercase tracking-wide"
                title={badge.tooltip}
              >
                {badge.label}
              </DomainStatus>
            ) : null}
            {node.kind === "file" ? renderFileExtra?.(node, allChecked) : null}
          </>
        );
      }}
    />
  );
}

export * from "./FileTreeModel";
