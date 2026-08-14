import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { statusBadgeVariant } from "../lib/status-variant";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

import {
  FileTreeBadge,
  FileTreeEmptyState,
  FileTreeErrorState,
  FileTreeNode,
  FileTreeTone,
  collectAllPaths,
} from "./FileTreeModel";

type VisibleFileTreeNode = {
  node: FileTreeNode;
  depth: number;
};

const TREE_BASE_INDENT = 16;

const TREE_STEP_INDENT = 24;

const TREE_ROW_HEIGHT_CLASS = "min-h-9";

const fileTreeToneClass: Record<FileTreeTone, string | undefined> = {
  default: undefined,
  warning: "bg-muted text-foreground",
  error: "bg-destructive/5 text-destructive",
  muted: "opacity-50",
};

function fileIcon(name: string) {
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return FileCode2;
  return FileText;
}

function flattenVisibleNodes(
  nodes: FileTreeNode[],
  expandedDirs: Set<string>,
  depth = 0,
): VisibleFileTreeNode[] {
  const flattened: VisibleFileTreeNode[] = [];
  for (const node of nodes) {
    flattened.push({ node, depth });
    if (node.kind === "dir" && expandedDirs.has(node.path)) {
      flattened.push(...flattenVisibleNodes(node.children, expandedDirs, depth + 1));
    }
  }
  return flattened;
}

function checkboxState(node: FileTreeNode, checkedFiles: Set<string>) {
  if (node.kind === "file") {
    return {
      allChecked: checkedFiles.has(node.path),
      someChecked: false,
    };
  }

  const childFiles = collectAllPaths(node.children, "file");
  const childFilePaths = [...childFiles];
  const allChecked = childFilePaths.length > 0 && childFilePaths.every((p) => checkedFiles.has(p));
  const someChecked = childFilePaths.some((p) => checkedFiles.has(p));
  return { allChecked, someChecked: someChecked && !allChecked };
}

// -- File tree component -----------------------------------------------------

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
  const visibleNodes = useMemo(() => flattenVisibleNodes(nodes, expandedDirs), [expandedDirs, nodes]);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  function focusPath(path: string) {
    setFocusedPath(path);
    window.requestAnimationFrame(() => {
      rowRefs.current.get(path)?.focus();
    });
  }

  function toggleNode(node: FileTreeNode) {
    if (node.kind === "dir") onToggleDir(node.path);
    else onSelectFile(node.path);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number, node: FileTreeNode) {
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = visibleNodes[Math.min(index + 1, visibleNodes.length - 1)];
        if (next) focusPath(next.node.path);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const previous = visibleNodes[Math.max(index - 1, 0)];
        if (previous) focusPath(previous.node.path);
        break;
      }
      case "ArrowRight":
        if (node.kind === "dir" && !expandedDirs.has(node.path)) {
          event.preventDefault();
          onToggleDir(node.path);
        }
        break;
      case "ArrowLeft":
        if (node.kind === "dir" && expandedDirs.has(node.path)) {
          event.preventDefault();
          onToggleDir(node.path);
        }
        break;
      case "Enter":
        event.preventDefault();
        toggleNode(node);
        break;
      case " ":
        event.preventDefault();
        if (showCheckboxes && onToggleCheck) {
          onToggleCheck(node.path, node.kind);
        } else {
          toggleNode(node);
        }
        break;
    }
  }

  if (loading) {
    return (
      <div aria-busy="true" aria-label={ariaLabel} role="tree" className="py-1">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className={cn("flex items-center gap-2 px-4", TREE_ROW_HEIGHT_CLASS)}>
            <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
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
          {error.retry && (
            <Button type="button" size="xs" variant="outline" onClick={error.retry}>
              Retry
            </Button>
          )}
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

  return (
    <div aria-label={ariaLabel} role="tree">
      {visibleNodes.map(({ node, depth }, index) => {
        const expanded = node.kind === "dir" && expandedDirs.has(node.path);
        const { allChecked, someChecked } = checkboxState(node, effectiveCheckedFiles);
        const badge = fileBadges?.[node.path];
        const tone = fileTones?.[node.path] ?? "default";
        const FileIcon = node.kind === "file" ? fileIcon(node.name) : null;
        const isSelected = node.kind === "file" && node.path === selectedFile;

        return (
          <div
            key={node.path}
            role="none"
            className={cn(
              node.kind === "dir"
                ? showCheckboxes
                  ? "group grid w-full grid-cols-(--gtc-2) items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                  : "group grid w-full grid-cols-(--gtc-3) items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground max-[480px]:grid-cols-(--gtc-4)"
                : "group flex w-full items-center gap-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground cursor-pointer",
              TREE_ROW_HEIGHT_CLASS,
              isSelected && "text-foreground bg-accent/20",
              fileTreeToneClass[tone],
            )}
            style={{
              paddingInlineStart: `${TREE_BASE_INDENT + depth * TREE_STEP_INDENT - 8}px`,
            }}
          >
            {showCheckboxes && (
              <div className="flex items-center pl-2">
                <Checkbox
                  aria-label={`Select ${node.name}`}
                  data-file-tree-checkbox={node.path}
                  checked={someChecked ? "indeterminate" : allChecked}
                  onCheckedChange={() => onToggleCheck?.(node.path, node.kind)}
                  className="mr-2"
                />
              </div>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              ref={(element) => {
                if (element) rowRefs.current.set(node.path, element);
                else rowRefs.current.delete(node.path);
              }}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={node.kind === "dir" ? expanded : undefined}
              aria-selected={node.kind === "file" ? isSelected : undefined}
              aria-checked={showCheckboxes ? (someChecked ? "mixed" : allChecked) : undefined}
              tabIndex={(focusedPath ?? visibleNodes[0]?.node.path) === node.path ? 0 : -1}
              className="h-auto min-w-0 flex-1 justify-start py-1"
              onFocus={() => setFocusedPath(node.path)}
              onClick={() => toggleNode(node)}
              onKeyDown={(event) => handleRowKeyDown(event, index, node)}
              data-file-tree-path={node.path}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {node.kind === "dir" ? (
                  expanded ? (
                    <FolderOpen className="h-3.5 w-3.5" />
                  ) : (
                    <Folder className="h-3.5 w-3.5" />
                  )
                ) : FileIcon ? (
                  <FileIcon className="h-3.5 w-3.5" />
                ) : null}
              </span>
              <span className={cn("min-w-0", wrapLabels ? "break-all leading-4" : "truncate")}>
                {node.name}
              </span>
            </Button>
            {badge && (
              <Badge
                variant={statusBadgeVariant(badge.status)}
                className="ml-3 text-(length:--text-nano) uppercase tracking-wide"
                title={badge.tooltip}
              >
                {badge.label}
              </Badge>
            )}
            {node.kind === "file" && renderFileExtra?.(node, allChecked)}
            {node.kind === "dir" && (
              <span
                aria-hidden="true"
                className="flex h-9 w-9 items-center justify-center self-center rounded-sm text-muted-foreground opacity-70 max-[480px]:hidden"
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export * from "./FileTreeModel";
