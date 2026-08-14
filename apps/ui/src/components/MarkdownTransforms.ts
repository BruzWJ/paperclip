import { isValidElement, type ReactNode } from "react";
import { defaultUrlTransform } from "react-markdown";
import { parseMentionChipHref } from "../lib/mention-chips";

const wrapAnywhereStyle: React.CSSProperties = {
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

const scrollableBlockStyle: React.CSSProperties = {
  maxWidth: "100%",
  overflowX: "auto",
};

const tableCellWrapStyle: React.CSSProperties = {
  overflowWrap: "anywhere",
  wordBreak: "normal",
};

export function isHtmlCommentNode(node: MarkdownAstNode) {
  return node.type === "html" && typeof node.value === "string" && /^<!--[\s\S]*-->$/.test(node.value.trim());
}

export function isEscapedHtmlCommentPlaceholder(node: MarkdownAstNode) {
  if (node.type !== "text" || typeof node.value !== "string") return false;
  const value = node.value.trim();
  return /^\\?<!--(?:\s*-{0,2}>?)?$/.test(value) || /^&lt;!--(?:\s*-{0,2}(?:&gt;)?)?$/.test(value);
}

export function remarkDropHtmlComments() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      const children = node.children;
      if (!children) return;
      node.children = children.filter(
        (child) => !isHtmlCommentNode(child) && !isEscapedHtmlCommentPlaceholder(child),
      );
      for (const child of node.children) {
        visit(child);
      }
    };
    visit(tree);
  };
}

export function mergeWrapStyle(style?: React.CSSProperties): React.CSSProperties {
  return {
    ...wrapAnywhereStyle,
    ...style,
  };
}

export function mergeTableCellStyle(style?: React.CSSProperties): React.CSSProperties {
  return {
    ...tableCellWrapStyle,
    ...style,
  };
}

export function mergeScrollableBlockStyle(style?: React.CSSProperties): React.CSSProperties {
  return {
    ...scrollableBlockStyle,
    ...style,
  };
}

export function flattenText(value: ReactNode): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).join("");
  return "";
}

export function extractMermaidSource(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const childProps = children.props as {
    className?: unknown;
    children?: ReactNode;
  };
  if (typeof childProps.className !== "string") return null;
  if (!/\blanguage-mermaid\b/i.test(childProps.className)) return null;
  return flattenText(childProps.children).replace(/\n$/, "");
}

export function safeMarkdownUrlTransform(url: string): string {
  return parseMentionChipHref(url) ? url : defaultUrlTransform(url);
}

type MarkdownAstNode = {
  type?: string;
  value?: string;
  children?: MarkdownAstNode[];
  url?: string;
  title?: string | null;
  data?: {
    hProperties?: Record<string, string>;
  };
};

type ParsedWikiLink = {
  target: string;
  label: string;
};

const WIKI_LINK_PATTERN = /\[\[([^\]\r\n]+)\]\]/g;

const WIKI_LINK_SKIP_PARENT_TYPES = new Set([
  "definition",
  "image",
  "imageReference",
  "link",
  "linkReference",
]);

export function parseWikiLinkBody(body: string): ParsedWikiLink | null {
  const [rawTarget, ...rawLabelParts] = body.split("|");
  const target = rawTarget?.trim() ?? "";
  const label = rawLabelParts.length > 0 ? rawLabelParts.join("|").trim() : target;
  if (!target || target.includes("[") || target.includes("]")) return null;
  return {
    target,
    label: label || target,
  };
}

export function encodeWikiLinkTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null;

  const hashIndex = trimmed.indexOf("#");
  const rawPath = (hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed).trim().replace(/^\/+/, "");
  if (
    !rawPath ||
    rawPath.includes("\\") ||
    rawPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }

  const encodedPath = rawPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const rawHash = hashIndex >= 0 ? trimmed.slice(hashIndex + 1).trim() : "";
  return rawHash ? `${encodedPath}#${encodeURIComponent(rawHash)}` : encodedPath;
}

export function defaultWikiLinkHref(target: string, wikiLinkRoot?: string): string | null {
  const encodedTarget = encodeWikiLinkTarget(target);
  if (!encodedTarget) return null;
  const root = wikiLinkRoot?.trim().replace(/\/+$/, "") ?? "";
  return root ? `${root}/${encodedTarget}` : encodedTarget;
}

export function createWikiLinkNode(href: string, wikiLink: ParsedWikiLink): MarkdownAstNode {
  return {
    type: "link",
    url: href,
    title: null,
    data: {
      hProperties: {
        "data-paperclip-wiki-link": "true",
        "data-paperclip-wiki-target": wikiLink.target,
      },
    },
    children: [{ type: "text", value: wikiLink.label }],
  };
}

export function splitTextByWikiLinks(
  value: string,
  options: {
    wikiLinkRoot?: string;
    resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
  },
): MarkdownAstNode[] {
  const nodes: MarkdownAstNode[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(WIKI_LINK_PATTERN)) {
    const raw = match[0] ?? "";
    const body = match[1] ?? "";
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push({ type: "text", value: value.slice(lastIndex, start) });
    }

    const wikiLink = parseWikiLinkBody(body);
    let resolvedHref: string | null = null;
    if (wikiLink) {
      if (options.resolveWikiLinkHref) {
        const customHref = options.resolveWikiLinkHref(wikiLink.target, wikiLink.label);
        resolvedHref =
          customHref === undefined ? defaultWikiLinkHref(wikiLink.target, options.wikiLinkRoot) : customHref;
      } else {
        resolvedHref = defaultWikiLinkHref(wikiLink.target, options.wikiLinkRoot);
      }
    }

    if (wikiLink && resolvedHref) {
      nodes.push(createWikiLinkNode(resolvedHref, wikiLink));
    } else {
      nodes.push({ type: "text", value: raw });
    }
    lastIndex = start + raw.length;
  }

  if (lastIndex < value.length) {
    nodes.push({ type: "text", value: value.slice(lastIndex) });
  }

  return nodes;
}

export function transformWikiLinkChildren(
  node: MarkdownAstNode,
  options: {
    wikiLinkRoot?: string;
    resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
  },
) {
  if (!node.children || WIKI_LINK_SKIP_PARENT_TYPES.has(node.type ?? "")) return;

  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("[[")) {
      return splitTextByWikiLinks(child.value, options);
    }
    transformWikiLinkChildren(child, options);
    return child;
  });
}

export function createRemarkWikiLinks(options: {
  wikiLinkRoot?: string;
  resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
}) {
  return function remarkWikiLinks() {
    return (tree: MarkdownAstNode) => {
      transformWikiLinkChildren(tree, options);
    };
  };
}

export function isGitHubUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    return url.protocol === "https:" && (url.hostname === "github.com" || url.hostname === "www.github.com");
  } catch {
    return false;
  }
}

export function isExternalHttpUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (typeof window === "undefined") return true;
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

export function isNonRouterAnchor(href: string | null | undefined, download: unknown): boolean {
  if (!href) return false;
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (download !== undefined) return true;
  if (trimmed.startsWith("#") || trimmed.startsWith("/api/")) return true;
  return /^(?:blob:|data:|mailto:|tel:)/i.test(trimmed);
}
