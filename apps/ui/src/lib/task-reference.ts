type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const BARE_TASK_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/i;
const TASK_SCHEME_RE = /^task:\/\/:?([^?#\s]+)(?:[?#].*)?$/i;
const TASK_REFERENCE_TOKEN_RE = /task:\/\/:?[^\s<>()]+|https?:\/\/[^\s<>()]+|\/(?:[^\s<>()/]+\/)*tasks\/[A-Z][A-Z0-9]*-\d+(?=$|[\s<>)\],.;!?:])|\b[A-Z][A-Z0-9]*-\d+\b/gi;

export function parseTaskPathIdFromPath(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  const pathname = pathOrUrl.trim();
  if (!pathname) return null;
  if (/^https?:\/\//i.test(pathname)) return null;

  const segments = pathname.split("/").filter(Boolean);
  const taskIndex = segments.findIndex((segment) => segment === "tasks");
  if (taskIndex === -1 || taskIndex === segments.length - 1) return null;
  const taskPathId = decodeURIComponent(segments[taskIndex + 1] ?? "");
  if (!taskPathId || taskPathId.startsWith(":")) return null;
  return BARE_TASK_IDENTIFIER_RE.test(taskPathId) ? taskPathId.toUpperCase() : taskPathId;
}

export function parseTaskReferenceFromHref(
  href: string | null | undefined,
  knownPrefixes?: Set<string>,
) {
  if (!href) return null;
  const trimmed = href.trim();
  const taskSchemeMatch = trimmed.match(TASK_SCHEME_RE);
  if (taskSchemeMatch?.[1]) {
    const taskPathId = decodeURIComponent(taskSchemeMatch[1]);
    return {
      taskPathId,
      href: `/tasks/${encodeURIComponent(taskPathId)}`,
    };
  }

  const pathId = parseTaskPathIdFromPath(href);
  if (pathId) {
    return {
      taskPathId: pathId,
      href: `/tasks/${encodeURIComponent(pathId)}`,
    };
  }

  if (!BARE_TASK_IDENTIFIER_RE.test(trimmed)) return null;
  const normalized = trimmed.toUpperCase();
  // Bare tokens require an exact company prefix. The explicit task:// and
  // /tasks/ forms above remain deliberate references in provider-less views.
  const prefix = normalized.split("-")[0];
  if (!prefix || !knownPrefixes?.has(prefix)) return null;
  return {
    taskPathId: normalized,
    href: `/tasks/${encodeURIComponent(normalized)}`,
  };
}

function splitTrailingPunctuation(token: string) {
  let core = token;
  let trailing = "";

  while (core.length > 0) {
    const lastChar = core.at(-1);
    if (!lastChar || !/[),.;!?:\]]/.test(lastChar)) break;
    if (lastChar === ")") {
      const openCount = (core.match(/\(/g) ?? []).length;
      const closeCount = (core.match(/\)/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    if (lastChar === "]") {
      const openCount = (core.match(/\[/g) ?? []).length;
      const closeCount = (core.match(/\]/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    trailing = `${lastChar}${trailing}`;
    core = core.slice(0, -1);
  }

  return { core, trailing };
}

function createTaskLinkNode(value: string, href: string, childType: "text" | "inlineCode" = "text"): MarkdownNode {
  return {
    type: "link",
    url: href,
    children: [{ type: childType, value }],
  };
}

function linkifyTaskReferencesInText(value: string, knownPrefixes?: Set<string>): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  let matched = false;

  for (const match of value.matchAll(TASK_REFERENCE_TOKEN_RE)) {
    const raw = match[0];
    if (!raw) continue;

    const start = match.index ?? 0;
    const end = start + raw.length;
    const { core, trailing } = splitTrailingPunctuation(raw);
    const taskRef = parseTaskReferenceFromHref(core, knownPrefixes);
    if (!taskRef) continue;

    matched = true;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    nodes.push(createTaskLinkNode(core, taskRef.href));
    if (trailing) {
      nodes.push({ type: "text", value: trailing });
    }
    cursor = end;
  }

  if (!matched) return null;
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

function rewriteMarkdownTree(node: MarkdownNode, knownPrefixes?: Set<string>) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  if (node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "definition" || node.type === "html") {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const taskRef = parseTaskReferenceFromHref(child.value, knownPrefixes);
      if (taskRef) {
        nextChildren.push(createTaskLinkNode(child.value, taskRef.href, "inlineCode"));
        continue;
      }
    }

    if (child.type === "text" && typeof child.value === "string") {
      const linked = linkifyTaskReferencesInText(child.value, knownPrefixes);
      if (linked) {
        nextChildren.push(...linked);
        continue;
      }
    }

    rewriteMarkdownTree(child, knownPrefixes);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export interface RemarkLinkTaskReferencesOptions {
  /**
   * Company task prefixes that are eligible for auto-linking. When provided
   * and non-empty, a bare IDENT-123 token only becomes a task link if its
   * prefix is in this set -- this keeps foreign tracker keys (e.g. a Jira
   * "TREE-604") from linking to non-existent Paperclip tasks.
   */
  knownPrefixes?: string[];
}

export function remarkLinkTaskReferences(options?: RemarkLinkTaskReferencesOptions) {
  const knownPrefixes = new Set(
    (options?.knownPrefixes ?? []).map((prefix) => prefix.toUpperCase()),
  );
  return (tree: MarkdownNode) => {
    rewriteMarkdownTree(tree, knownPrefixes);
  };
}
