import {
  buildTaskReferenceHref,
  findTaskReferenceMatches,
  parseTaskReferenceHref,
} from "@paperclipai/shared";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

export function parseTaskReferenceFromHref(href: string | null | undefined) {
  if (!href) return null;
  const reference = parseTaskReferenceHref(href);
  return reference
    ? { taskId: reference.taskId, href: buildTaskReferenceHref(reference.taskId) }
    : null;
}

function createTaskLinkNode(value: string, href: string): MarkdownNode {
  return { type: "link", url: href, children: [{ type: "text", value }] };
}

function linkifyTaskReferencesInText(value: string): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  let matched = false;

  for (const match of findTaskReferenceMatches(value)) {
    const start = match.index;
    const end = start + match.length;
    matched = true;
    if (start > cursor) nodes.push({ type: "text", value: value.slice(cursor, start) });
    nodes.push(
      createTaskLinkNode(
        match.matchedText,
        buildTaskReferenceHref(match.taskId),
      ),
    );
    cursor = end;
  }

  if (!matched) return null;
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

function rewriteMarkdownTree(node: MarkdownNode) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  if (["link", "linkReference", "code", "definition", "html"].includes(node.type)) return;

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const linked = linkifyTaskReferencesInText(child.value);
      if (linked) {
        nextChildren.push(...linked);
        continue;
      }
    }
    rewriteMarkdownTree(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkLinkTaskReferences() {
  return (tree: MarkdownNode) => rewriteMarkdownTree(tree);
}
