/**
 * Server-side SVG renderer for Paperclip org charts.
 *
 * Agent titles are display-only subtitles. The renderer deliberately applies
 * no title-, name-, hierarchy-, or creation-order-based semantic styling.
 */

export interface OrgNode {
  id: string;
  name: string;
  subtitle: string;
  status: string;
  reports: OrgNode[];
}

export type OrgChartStyle =
  | "monochrome"
  | "nebula"
  | "circuit"
  | "warmth"
  | "schematic";

export const ORG_CHART_STYLES: OrgChartStyle[] = [
  "monochrome",
  "nebula",
  "circuit",
  "warmth",
  "schematic",
];

export interface OrgChartOverlay {
  companyName?: string;
  stats?: string;
}

interface Theme {
  background: string;
  card: string;
  border: string;
  connector: string;
  name: string;
  subtitle: string;
  avatar: string;
  watermark: string;
  font: string;
}

const THEMES: Record<OrgChartStyle, Theme> = {
  monochrome: {
    background: "#18181b",
    card: "#18181b",
    border: "#3f3f46",
    connector: "#52525b",
    name: "#fafafa",
    subtitle: "#a1a1aa",
    avatar: "#27272a",
    watermark: "#71717a",
    font: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  nebula: {
    background: "#0d1117",
    card: "#161b22",
    border: "#30363d",
    connector: "#484f58",
    name: "#f0f6fc",
    subtitle: "#8b949e",
    avatar: "#21262d",
    watermark: "#6e7681",
    font: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  circuit: {
    background: "#f8fafc",
    card: "#ffffff",
    border: "#c7d2fe",
    connector: "#818cf8",
    name: "#1e1b4b",
    subtitle: "#6366f1",
    avatar: "#eef2ff",
    watermark: "#818cf8",
    font: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  warmth: {
    background: "#fafaf9",
    card: "#ffffff",
    border: "#e7e5e4",
    connector: "#d6d3d1",
    name: "#1c1917",
    subtitle: "#78716c",
    avatar: "#f5f5f4",
    watermark: "#a8a29e",
    font: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  schematic: {
    background: "#0d1117",
    card: "#111827",
    border: "#374151",
    connector: "#4b5563",
    name: "#e5e7eb",
    subtitle: "#9ca3af",
    avatar: "#1f2937",
    watermark: "#6b7280",
    font: "'JetBrains Mono', 'SF Mono', monospace",
  },
};

const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 640;
const CARD_WIDTH = 180;
const CARD_HEIGHT = 88;
const HORIZONTAL_GAP = 28;
const VERTICAL_GAP = 64;
const PADDING = 48;

interface LayoutNode {
  node: OrgNode;
  x: number;
  y: number;
  width: number;
  children: LayoutNode[];
}

function normalizedReports(node: OrgNode): OrgNode[] {
  return Array.isArray(node.reports) ? node.reports : [];
}

function subtreeWidth(node: OrgNode): number {
  const children = normalizedReports(node);
  if (children.length === 0) return CARD_WIDTH;
  const childrenWidth = children.reduce(
    (sum, child, index) =>
      sum + subtreeWidth(child) + (index === 0 ? 0 : HORIZONTAL_GAP),
    0,
  );
  return Math.max(CARD_WIDTH, childrenWidth);
}

function layoutNode(node: OrgNode, x: number, y: number): LayoutNode {
  const width = subtreeWidth(node);
  const children = normalizedReports(node);
  const layout: LayoutNode = {
    node,
    x: x + (width - CARD_WIDTH) / 2,
    y,
    width,
    children: [],
  };

  let childX = x;
  for (const child of children) {
    const childWidth = subtreeWidth(child);
    layout.children.push(
      layoutNode(child, childX, y + CARD_HEIGHT + VERTICAL_GAP),
    );
    childX += childWidth + HORIZONTAL_GAP;
  }
  return layout;
}

function layoutForest(nodes: OrgNode[]): LayoutNode[] {
  let x = PADDING;
  return nodes.map((node) => {
    const layout = layoutNode(node, x, PADDING + 36);
    x += layout.width + HORIZONTAL_GAP;
    return layout;
  });
}

function walkLayout(
  nodes: LayoutNode[],
  visit: (node: LayoutNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    walkLayout(node.children, visit);
  }
}

function layoutBounds(nodes: LayoutNode[]) {
  let maxX = PADDING;
  let maxY = PADDING;
  walkLayout(nodes, (entry) => {
    maxX = Math.max(maxX, entry.x + CARD_WIDTH + PADDING);
    maxY = Math.max(maxY, entry.y + CARD_HEIGHT + PADDING);
  });
  return { width: maxX, height: maxY };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] ?? "")
      .join("")
      .toUpperCase() || "A"
  );
}

function statusColor(status: string): string {
  if (status === "running") return "#3b82f6";
  if (status === "idle") return "#22c55e";
  if (status === "error") return "#ef4444";
  if (status === "paused") return "#f59e0b";
  return "#94a3b8";
}

function renderConnectors(nodes: LayoutNode[], theme: Theme): string {
  const lines: string[] = [];
  walkLayout(nodes, (parent) => {
    const parentX = parent.x + CARD_WIDTH / 2;
    const parentY = parent.y + CARD_HEIGHT;
    for (const child of parent.children) {
      const childX = child.x + CARD_WIDTH / 2;
      const childY = child.y;
      const midpoint = parentY + (childY - parentY) / 2;
      lines.push(
        `<path d="M ${parentX} ${parentY} V ${midpoint} H ${childX} V ${childY}" fill="none" stroke="${theme.connector}" stroke-width="1.5"/>`,
      );
    }
  });
  return lines.join("");
}

function renderCards(nodes: LayoutNode[], theme: Theme): string {
  const cards: string[] = [];
  walkLayout(nodes, (entry) => {
    const { node } = entry;
    const centerX = entry.x + CARD_WIDTH / 2;
    const avatarX = entry.x + 28;
    const avatarY = entry.y + CARD_HEIGHT / 2;
    const textX = entry.x + 52;
    const title = node.subtitle?.trim() ?? "";
    cards.push(`<g>
      <rect x="${entry.x}" y="${entry.y}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="8" fill="${theme.card}" stroke="${theme.border}"/>
      <circle cx="${avatarX}" cy="${avatarY}" r="16" fill="${theme.avatar}"/>
      <text x="${avatarX}" y="${avatarY + 4}" text-anchor="middle" font-family="${theme.font}" font-size="10" font-weight="700" fill="${theme.name}">${escapeXml(initials(node.name))}</text>
      <circle cx="${entry.x + CARD_WIDTH - 12}" cy="${entry.y + 12}" r="4" fill="${statusColor(node.status)}"/>
      <text x="${textX}" y="${entry.y + (title ? 38 : 48)}" font-family="${theme.font}" font-size="14" font-weight="600" fill="${theme.name}">${escapeXml(node.name)}</text>
      ${title ? `<text x="${textX}" y="${entry.y + 57}" font-family="${theme.font}" font-size="11" fill="${theme.subtitle}">${escapeXml(title)}</text>` : ""}
      <title>${escapeXml(`${node.name}${title ? ` — ${title}` : ""}`)}</title>
      <desc>Agent card centered at ${centerX}</desc>
    </g>`);
  });
  return cards.join("");
}

export function renderOrgChartSvg(
  orgTree: OrgNode[],
  style: OrgChartStyle = "warmth",
  overlay?: OrgChartOverlay,
): string {
  const theme = THEMES[style] ?? THEMES.warmth;
  const layouts = layoutForest(orgTree);
  const bounds = layoutBounds(layouts);
  const scale = Math.min(
    (TARGET_WIDTH - PADDING * 2) / Math.max(bounds.width, 1),
    (TARGET_HEIGHT - PADDING * 2) / Math.max(bounds.height, 1),
    1,
  );
  const contentWidth = bounds.width * scale;
  const contentHeight = bounds.height * scale;
  const translateX = Math.max(PADDING, (TARGET_WIDTH - contentWidth) / 2);
  const translateY = Math.max(PADDING, (TARGET_HEIGHT - contentHeight) / 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${TARGET_WIDTH}" height="${TARGET_HEIGHT}" viewBox="0 0 ${TARGET_WIDTH} ${TARGET_HEIGHT}">
    <rect width="100%" height="100%" fill="${theme.background}" rx="6"/>
    ${overlay?.companyName ? `<text x="${PADDING}" y="36" font-family="${theme.font}" font-size="22" font-weight="700" fill="${theme.name}">${escapeXml(overlay.companyName)}</text>` : ""}
    ${overlay?.stats ? `<text x="${TARGET_WIDTH - PADDING}" y="${TARGET_HEIGHT - 24}" text-anchor="end" font-family="${theme.font}" font-size="13" fill="${theme.subtitle}">${escapeXml(overlay.stats)}</text>` : ""}
    <text x="${TARGET_WIDTH - PADDING}" y="32" text-anchor="end" font-family="${theme.font}" font-size="13" font-weight="600" fill="${theme.watermark}">Paperclip</text>
    <g transform="translate(${translateX}, ${translateY}) scale(${scale})">
      ${renderConnectors(layouts, theme)}
      ${renderCards(layouts, theme)}
    </g>
  </svg>`;
}

export async function renderOrgChartPng(
  orgTree: OrgNode[],
  style: OrgChartStyle = "warmth",
  overlay?: OrgChartOverlay,
): Promise<Buffer> {
  const svg = renderOrgChartSvg(orgTree, style, overlay);
  const sharpModule = await import("sharp");
  return sharpModule.default(Buffer.from(svg), { density: 144 })
    .resize(TARGET_WIDTH, TARGET_HEIGHT)
    .png()
    .toBuffer();
}
