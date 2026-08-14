import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import {
  TreeExpander,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeNodeContent,
  TreeNodeTrigger,
  TreeProvider,
  TreeView,
} from "@/components/kibo-ui/tree";
import { cn } from "@/lib/utils";
import type { ParentedEntity } from "@/lib/presentation-contracts";

export interface DomainTreeNode<T> {
  id: string;
  value: T;
  children?: DomainTreeNode<T>[];
}

export interface DomainTreeNodeState<T> {
  node: DomainTreeNode<T>;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  selected: boolean;
}

export interface DomainTreeProps<T> {
  nodes: DomainTreeNode<T>[];
  expandedIds?: ReadonlySet<string>;
  defaultExpandedIds?: ReadonlySet<string>;
  selectedIds?: readonly string[];
  onToggle?: (node: DomainTreeNode<T>) => void;
  onActivate?: (node: DomainTreeNode<T>) => void;
  onNodeKeyDown?: (event: KeyboardEvent<HTMLDivElement>, state: DomainTreeNodeState<T>) => boolean | void;
  renderLabel: (state: DomainTreeNodeState<T>) => ReactNode;
  renderBeforeLabel?: (state: DomainTreeNodeState<T>) => ReactNode;
  renderAfterLabel?: (state: DomainTreeNodeState<T>) => ReactNode;
  renderIcon?: (state: DomainTreeNodeState<T>) => ReactNode;
  rowClassName?: string | ((state: DomainTreeNodeState<T>) => string | undefined);
  rowData?: (state: DomainTreeNodeState<T>) => Record<`data-${string}`, string | undefined>;
  ariaChecked?: (state: DomainTreeNodeState<T>) => boolean | "mixed" | undefined;
  contentClassName?: string;
  className?: string;
  ariaLabel: string;
  showIcons?: boolean;
  showLines?: boolean;
  animateExpand?: boolean;
}

/**
 * Thin domain mapper for Kibo's official Tree composition.
 *
 * Domain surfaces provide data and row content; Kibo owns hierarchy,
 * disclosure, selection styling, lines, icons, and expand/collapse motion.
 */
export function DomainTree<T>({
  nodes,
  expandedIds,
  defaultExpandedIds = new Set<string>(),
  selectedIds = [],
  onToggle,
  onActivate,
  onNodeKeyDown,
  renderLabel,
  renderBeforeLabel,
  renderAfterLabel,
  renderIcon,
  rowClassName,
  rowData,
  ariaChecked,
  contentClassName,
  className,
  ariaLabel,
  showIcons = true,
  showLines = true,
  animateExpand = true,
}: DomainTreeProps<T>) {
  const [localExpandedIds, setLocalExpandedIds] = useState(() => new Set(defaultExpandedIds));
  const resolvedExpandedIds = expandedIds ?? localExpandedIds;
  const expanded = [...resolvedExpandedIds];
  const selected = new Set(selectedIds);
  const triggerRefs = useRef(new Map<string, HTMLDivElement>());

  const visibleNodes: ParentedEntity[] = [];
  function collectVisibleNodes(items: DomainTreeNode<T>[], parentId: string | null) {
    for (const node of items) {
      visibleNodes.push({ id: node.id, parentId });
      if (resolvedExpandedIds.has(node.id)) collectVisibleNodes(node.children ?? [], node.id);
    }
  }
  collectVisibleNodes(nodes, null);

  const visibleIds = new Set(visibleNodes.map(({ id }) => id));
  const fallbackFocusedId =
    visibleNodes.find(({ id }) => selected.has(id))?.id ?? visibleNodes[0]?.id ?? null;
  const [focusedId, setFocusedId] = useState<string | null>(fallbackFocusedId);
  const effectiveFocusedId = focusedId && visibleIds.has(focusedId) ? focusedId : fallbackFocusedId;

  useEffect(() => {
    if (focusedId !== effectiveFocusedId) setFocusedId(effectiveFocusedId);
  }, [effectiveFocusedId, focusedId]);

  const focusNode = (nodeId: string | undefined) => {
    if (!nodeId) return;
    setFocusedId(nodeId);
    triggerRefs.current.get(nodeId)?.focus();
  };

  const handleToggle = (node: DomainTreeNode<T>) => {
    if (onToggle) {
      onToggle(node);
      return;
    }
    setLocalExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  };

  function renderNodes(items: DomainTreeNode<T>[], depth: number): ReactNode {
    return items.map((node, index) => {
      const children = node.children ?? [];
      const state: DomainTreeNodeState<T> = {
        node,
        depth,
        expanded: resolvedExpandedIds.has(node.id),
        hasChildren: children.length > 0,
        selected: selected.has(node.id),
      };
      const resolvedRowClassName = typeof rowClassName === "function" ? rowClassName(state) : rowClassName;
      const resolvedRowData = rowData?.(state);

      const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (onNodeKeyDown?.(event, state)) return;
        const visibleIndex = visibleNodes.findIndex(({ id }) => id === node.id);

        if (event.key === "ArrowDown") {
          event.preventDefault();
          focusNode(visibleNodes[visibleIndex + 1]?.id);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          focusNode(visibleNodes[visibleIndex - 1]?.id);
          return;
        }
        if (event.key === "Home") {
          event.preventDefault();
          focusNode(visibleNodes[0]?.id);
          return;
        }
        if (event.key === "End") {
          event.preventDefault();
          focusNode(visibleNodes.at(-1)?.id);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.currentTarget.click();
          return;
        }
        if (event.key === "ArrowRight" && state.hasChildren && !state.expanded) {
          event.preventDefault();
          handleToggle(node);
          return;
        }
        if (event.key === "ArrowRight" && state.hasChildren && state.expanded) {
          event.preventDefault();
          focusNode(children[0]?.id);
          return;
        }
        if (event.key === "ArrowLeft" && state.hasChildren && state.expanded) {
          event.preventDefault();
          handleToggle(node);
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          focusNode(visibleNodes[visibleIndex]?.parentId ?? undefined);
        }
      };

      return (
        <TreeNode key={node.id} nodeId={node.id} level={depth} isLast={index === items.length - 1}>
          <TreeNodeTrigger
            {...resolvedRowData}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={state.hasChildren ? state.expanded : undefined}
            aria-selected={state.selected || undefined}
            aria-checked={ariaChecked?.(state)}
            tabIndex={node.id === effectiveFocusedId ? 0 : -1}
            className={cn(state.selected && "bg-accent/80", resolvedRowClassName)}
            ref={(element) => {
              if (element) triggerRefs.current.set(node.id, element);
              else triggerRefs.current.delete(node.id);
            }}
            onFocus={() => setFocusedId(node.id)}
            onKeyDown={handleKeyDown}
            onClick={() => {
              if (state.hasChildren) handleToggle(node);
              else onActivate?.(node);
            }}
          >
            <TreeExpander hasChildren={state.hasChildren} onClick={() => handleToggle(node)} />
            {renderBeforeLabel ? (
              <span className="contents" onClick={(event) => event.stopPropagation()}>
                {renderBeforeLabel(state)}
              </span>
            ) : null}
            <TreeIcon hasChildren={state.hasChildren} icon={renderIcon?.(state)} />
            <TreeLabel>{renderLabel(state)}</TreeLabel>
            {renderAfterLabel ? (
              <span className="contents" onClick={(event) => event.stopPropagation()}>
                {renderAfterLabel(state)}
              </span>
            ) : null}
          </TreeNodeTrigger>
          <TreeNodeContent hasChildren={state.hasChildren} className={contentClassName}>
            {renderNodes(children, depth + 1)}
          </TreeNodeContent>
        </TreeNode>
      );
    });
  }

  return (
    <TreeProvider
      defaultExpandedIds={expanded}
      expandedIds={expanded}
      selectable={false}
      showIcons={showIcons}
      showLines={showLines}
      animateExpand={animateExpand}
      className={className}
    >
      <TreeView role="tree" aria-label={ariaLabel}>
        {renderNodes(nodes, 0)}
      </TreeView>
    </TreeProvider>
  );
}
