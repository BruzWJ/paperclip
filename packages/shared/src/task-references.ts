import { isCanonicalUuid } from "./canonical-uuid.js";

export interface TaskReferenceMatch {
  index: number;
  length: number;
  taskId: string;
  matchedText: string;
}

const TASK_REFERENCE_TOKEN_RE = /task:\/\/[^\s<>()]+/g;
const TASK_REFERENCE_HREF_RE = /^task:\/\/([^/?#\s]+)$/;

function preserveNewlinesAsWhitespace(value: string) {
  return value.replace(/[^\n]/g, " ");
}

function stripMarkdownCode(markdown: string): string {
  if (!markdown) return "";

  let output = "";
  let index = 0;

  while (index < markdown.length) {
    const remaining = markdown.slice(index);
    const fenceMatch = /^(?:```+|~~~+)/.exec(remaining);
    const atLineStart = index === 0 || markdown[index - 1] === "\n";

    if (atLineStart && fenceMatch) {
      const fence = fenceMatch[0]!;
      const blockStart = index;
      index += fence.length;
      while (index < markdown.length && markdown[index] !== "\n") index += 1;
      if (index < markdown.length) index += 1;

      while (index < markdown.length) {
        const lineStart = index === 0 || markdown[index - 1] === "\n";
        if (lineStart && markdown.startsWith(fence, index)) {
          index += fence.length;
          while (index < markdown.length && markdown[index] !== "\n") index += 1;
          if (index < markdown.length) index += 1;
          break;
        }
        index += 1;
      }

      output += preserveNewlinesAsWhitespace(markdown.slice(blockStart, index));
      continue;
    }

    if (markdown[index] === "`") {
      let tickCount = 1;
      while (index + tickCount < markdown.length && markdown[index + tickCount] === "`") {
        tickCount += 1;
      }
      const fence = "`".repeat(tickCount);
      const inlineStart = index;
      index += tickCount;
      const closeIndex = markdown.indexOf(fence, index);
      if (closeIndex === -1) {
        output += markdown.slice(inlineStart, inlineStart + tickCount);
        index = inlineStart + tickCount;
        continue;
      }
      index = closeIndex + tickCount;
      output += preserveNewlinesAsWhitespace(markdown.slice(inlineStart, index));
      continue;
    }

    output += markdown[index]!;
    index += 1;
  }

  return output;
}

function trimTrailingPunctuation(token: string): string {
  let trimmed = token;
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1]!;
    if (!".,!?;:".includes(last) && last !== ")" && last !== "]") break;

    if (
      (last === ")" && (trimmed.match(/\(/g)?.length ?? 0) >= (trimmed.match(/\)/g)?.length ?? 0))
      || (last === "]" && (trimmed.match(/\[/g)?.length ?? 0) >= (trimmed.match(/\]/g)?.length ?? 0))
    ) {
      break;
    }
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

export function buildTaskReferenceHref(taskId: string): string {
  if (!isCanonicalUuid(taskId)) {
    throw new Error("Cannot build a task reference href without a canonical task UUID");
  }
  return `task://${taskId}`;
}

export function parseTaskReferenceHref(href: string): { taskId: string } | null {
  if (!href) return null;

  const taskReference = href.match(TASK_REFERENCE_HREF_RE);
  if (taskReference?.[1]) {
    const taskId = taskReference[1];
    return isCanonicalUuid(taskId) ? { taskId } : null;
  }
  return null;
}

export function findTaskReferenceMatches(text: string): TaskReferenceMatch[] {
  if (!text) return [];

  const matches: TaskReferenceMatch[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(TASK_REFERENCE_TOKEN_RE);

  while ((match = re.exec(text)) !== null) {
    const rawToken = match[0];
    const cleanedToken = trimTrailingPunctuation(rawToken);
    if (!cleanedToken) continue;

    const taskId = parseTaskReferenceHref(cleanedToken)?.taskId ?? null;
    if (!taskId) continue;

    const cleanedIndex = match.index;
    matches.push({
      index: cleanedIndex,
      length: cleanedToken.length,
      taskId,
      matchedText: cleanedToken,
    });
  }

  return matches;
}

export function extractTaskReferenceIds(markdown: string): string[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const match of findTaskReferenceMatches(scrubbed)) {
    if (seen.has(match.taskId)) continue;
    seen.add(match.taskId);
    ordered.push(match.taskId);
  }

  return ordered;
}

export function extractTaskReferenceMatches(markdown: string): TaskReferenceMatch[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: TaskReferenceMatch[] = [];

  for (const match of findTaskReferenceMatches(scrubbed)) {
    if (seen.has(match.taskId)) continue;
    seen.add(match.taskId);
    ordered.push(match);
  }

  return ordered;
}
