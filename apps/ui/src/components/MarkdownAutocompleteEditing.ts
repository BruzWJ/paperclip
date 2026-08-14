import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildTaskReferenceHref,
  buildUserMentionHref,
} from "@paperclipai/shared";
import type { RoutineCommandOption } from "../context/EditorAutocompleteContext";
import { parseMentionChipHref } from "../lib/mention-chips";
import type { AutocompleteOption, MentionOption, MentionState } from "./MarkdownEditorTypes";

export function nodeInsideCodeLike(container: HTMLElement, node: Node | null): boolean {
  if (!node || !container.contains(node)) return false;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  return Boolean(el?.closest("pre, code"));
}

export function isSelectionInsideCodeLikeElement(container: HTMLElement | null) {
  if (!container) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  for (const node of [selection.anchorNode, selection.focusNode]) {
    if (nodeInsideCodeLike(container, node)) return true;
  }
  return false;
}

/** The human title of a task mention — `name` minus its leading identifier. */
export function taskMentionTitle(option: { name: string; taskIdentifier?: string }): string {
  const name = option.name.trim();
  const identifier = option.taskIdentifier?.trim();
  if (identifier && name.toLowerCase().startsWith(identifier.toLowerCase())) {
    return name.slice(identifier.length).trim();
  }
  return name;
}

export function mentionMarkdown(option: MentionOption): string {
  if (option.kind === "task") {
    return `[${option.taskIdentifier}](${buildTaskReferenceHref(option.taskId)}) `;
  }
  if (option.kind === "project") {
    return `[@${option.name}](${buildProjectMentionHref(option.projectId, option.projectColor ?? null)}) `;
  }
  if (option.kind === "user") {
    return `[@${option.name}](${buildUserMentionHref(option.userId)}) `;
  }
  return `[@${option.name}](${buildAgentMentionHref(option.agentId, option.agentIcon ?? null)}) `;
}

export function slashCommandLabel(option: RoutineCommandOption): string {
  return `/routine:${option.name}`;
}

export function slashCommandMarkdown(option: RoutineCommandOption): string {
  return `[${slashCommandLabel(option)}](${buildRoutineMentionHref(option.routineId)}) `;
}

export function autocompleteMarkdown(option: AutocompleteOption): string {
  return option.kind === "routine" ? slashCommandMarkdown(option) : mentionMarkdown(option);
}

export function shouldAcceptAutocompleteKey(
  key: string,
  trigger: MentionState["trigger"] | null,
  commandEnterArmed = false,
): boolean {
  if (key === "Tab") return true;
  if (key !== "Enter") return false;
  return trigger === "mention" || (trigger === "command" && commandEnterArmed);
}

export function isSameAutocompleteSession(
  left: Pick<MentionState, "trigger" | "marker" | "query" | "textNode" | "atPos" | "endPos"> | null,
  right: Pick<MentionState, "trigger" | "marker" | "query" | "textNode" | "atPos" | "endPos"> | null,
): boolean {
  if (!left || !right) return false;
  return (
    left.trigger === right.trigger &&
    left.marker === right.marker &&
    left.query === right.query &&
    left.textNode === right.textNode &&
    left.atPos === right.atPos &&
    left.endPos === right.endPos
  );
}

export function autocompleteOptionMatchesLink(option: AutocompleteOption, href: string): boolean {
  const parsed = parseMentionChipHref(href);
  if (!parsed) return false;

  if (option.kind === "routine") {
    return parsed.kind === "routine" && parsed.routineId === option.routineId;
  }

  if (option.kind === "task") {
    return parsed.kind === "task" && parsed.taskId === option.taskId;
  }
  if (option.kind === "project") {
    return parsed.kind === "project" && parsed.projectId === option.projectId;
  }
  if (option.kind === "user") {
    return parsed.kind === "user" && parsed.userId === option.userId;
  }
  return parsed.kind === "agent" && parsed.agentId === option.agentId;
}

export function findClosestAutocompleteAnchor(
  editable: HTMLElement,
  option: AutocompleteOption,
  origin?: Pick<MentionState, "left" | "top"> | null,
): HTMLAnchorElement | null {
  const matchingMentions = Array.from(editable.querySelectorAll("a"))
    .filter((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)
    .filter((link) => autocompleteOptionMatchesLink(option, link.getAttribute("href") ?? ""));

  if (matchingMentions.length === 0) return null;
  if (!origin) return matchingMentions[0] ?? null;

  const containerRect = editable.getBoundingClientRect();
  return (
    matchingMentions.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      const leftA = rectA.left - containerRect.left;
      const topA = rectA.top - containerRect.top;
      const leftB = rectB.left - containerRect.left;
      const topB = rectB.top - containerRect.top;
      const distA = Math.hypot(leftA - origin.left, topA - origin.top);
      const distB = Math.hypot(leftB - origin.left, topB - origin.top);
      return distA - distB;
    })[0] ?? null
  );
}

export function placeCaretAfterMentionAnchor(target: HTMLAnchorElement): boolean {
  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  const nextSibling = target.nextSibling;
  if (nextSibling?.nodeType === Node.TEXT_NODE) {
    const text = nextSibling.textContent ?? "";
    if (text.startsWith(" ")) {
      range.setStart(nextSibling, 1);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    if (text.length > 0) {
      range.setStart(nextSibling, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
  }

  range.setStartAfter(target);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** Replace the active autocomplete token in the markdown string with the selected token. */
export function applyMention(markdown: string, state: MentionState, option: AutocompleteOption): string {
  const search = `${state.marker}${state.query}`;
  const replacement = autocompleteMarkdown(option);
  const idx = markdown.lastIndexOf(search);
  if (idx === -1) return markdown;
  return markdown.slice(0, idx) + replacement + markdown.slice(idx + search.length);
}
