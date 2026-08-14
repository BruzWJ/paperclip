import type { OrgNode } from "@/api/agents";

export const ORG_CARD_WIDTH = 200;
export const ORG_CARD_HEIGHT = 100;
export const ORG_PADDING = 60;

const HORIZONTAL_GAP = 32;
const VERTICAL_GAP = 80;

export interface OrgLayoutNode {
  id: string;
  name: string;
  subtitle: string;
  status: string;
  x: number;
  y: number;
  children: OrgLayoutNode[];
}

function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return ORG_CARD_WIDTH;
  const childrenWidth = node.reports.reduce((sum, child) => sum + subtreeWidth(child), 0);
  const gaps = (node.reports.length - 1) * HORIZONTAL_GAP;
  return Math.max(ORG_CARD_WIDTH, childrenWidth + gaps);
}

function layoutTree(node: OrgNode, x: number, y: number): OrgLayoutNode {
  const totalWidth = subtreeWidth(node);
  const children: OrgLayoutNode[] = [];

  if (node.reports.length > 0) {
    const childrenWidth = node.reports.reduce((sum, child) => sum + subtreeWidth(child), 0);
    const gaps = (node.reports.length - 1) * HORIZONTAL_GAP;
    let childX = x + (totalWidth - childrenWidth - gaps) / 2;
    for (const child of node.reports) {
      const childWidth = subtreeWidth(child);
      children.push(layoutTree(child, childX, y + ORG_CARD_HEIGHT + VERTICAL_GAP));
      childX += childWidth + HORIZONTAL_GAP;
    }
  }

  return {
    id: node.id,
    name: node.name,
    subtitle: node.subtitle,
    status: node.status,
    x: x + (totalWidth - ORG_CARD_WIDTH) / 2,
    y,
    children,
  };
}

export function layoutOrgForest(roots: OrgNode[]): OrgLayoutNode[] {
  let x = ORG_PADDING;
  return roots.map((root) => {
    const layout = layoutTree(root, x, ORG_PADDING);
    x += subtreeWidth(root) + HORIZONTAL_GAP;
    return layout;
  });
}

export function flattenOrgLayout(nodes: OrgLayoutNode[]): OrgLayoutNode[] {
  const result: OrgLayoutNode[] = [];
  const walk = (node: OrgLayoutNode) => {
    result.push(node);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return result;
}

export function collectOrgEdges(nodes: OrgLayoutNode[]) {
  const edges: Array<{ parent: OrgLayoutNode; child: OrgLayoutNode }> = [];
  const walk = (node: OrgLayoutNode) => {
    for (const child of node.children) {
      edges.push({ parent: node, child });
      walk(child);
    }
  };
  nodes.forEach(walk);
  return edges;
}
