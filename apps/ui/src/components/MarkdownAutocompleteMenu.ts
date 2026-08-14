import { CodeMirrorEditor, type CodeBlockEditorDescriptor } from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import type { MentionState } from "./MarkdownEditorTypes";

interface MentionMenuViewport {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}

interface MentionMenuSize {
  width: number;
  height: number;
}

export const MENTION_MENU_WIDTH = 188;

export const MENTION_MENU_HEIGHT = 208;

export const MENTION_MENU_PADDING = 8;

export const MENTION_MENU_ROW_HEIGHT = 34;

export const MENTION_MENU_CHROME_HEIGHT = 8;

export const MAX_AUTOCOMPLETE_OPTIONS = 50;

/** Roughly one space-width of breathing room between the caret and the menu. */
export const MENTION_MENU_CARET_GAP = 10;

export const CODE_BLOCK_LANGUAGES: Record<string, string> = {
  txt: "Text",
  md: "Markdown",
  js: "JavaScript",
  jsx: "JavaScript (JSX)",
  ts: "TypeScript",
  tsx: "TypeScript (TSX)",
  json: "JSON",
  bash: "Bash",
  sh: "Shell",
  python: "Python",
  go: "Go",
  rust: "Rust",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  yaml: "YAML",
  yml: "YAML",
};

export const FALLBACK_CODE_BLOCK_DESCRIPTOR: CodeBlockEditorDescriptor = {
  // Keep this lower than codeMirrorPlugin's descriptor priority so known languages
  // still use the standard matching path; this catches malformed/unknown fences.
  priority: 0,
  match: () => true,
  Editor: CodeMirrorEditor,
};

export function findMentionMatch(
  text: string,
  offset: number,
): Pick<MentionState, "trigger" | "marker" | "query" | "atPos" | "endPos"> | null {
  let atPos = -1;
  let trigger: MentionState["trigger"] | null = null;
  let marker: MentionState["marker"] | null = null;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@" || ch === "/") {
      if (i === 0 || /\s/.test(text[i - 1])) {
        atPos = i;
        trigger = ch === "@" ? "mention" : "command";
        marker = ch;
      }
      break;
    }
    if (ch === "\n" || ch === "\r") break;
  }

  if (atPos === -1) return null;
  const query = text.slice(atPos + 1, offset);
  if (trigger === "command" && /\s/.test(query) && !query.toLowerCase().startsWith("routine:")) {
    return null;
  }

  return {
    trigger: trigger ?? "mention",
    marker: marker ?? "@",
    query,
    atPos,
    endPos: offset,
  };
}

interface CaretRect {
  top: number;
  bottom: number;
  /** Caret X — the right edge of the last typed character (or left edge of the next). */
  x: number;
}

export function measureCaretRect(textNode: Text, offset: number, atPos: number): CaretRect {
  const length = textNode.textContent?.length ?? 0;
  const rectFromRange = (start: number, end: number, side: "right" | "left"): CaretRect | null => {
    if (start < 0 || end > length || end <= start) return null;
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return {
      top: rect.top,
      bottom: rect.bottom,
      x: side === "right" ? rect.right : rect.left,
    };
  };

  // Prefer the character immediately before the caret — its right edge IS the caret X
  // and its top/bottom describe the active line. Falls back to the char after the caret
  // and finally the @ marker if nothing else gives us a valid rect.
  return (
    rectFromRange(Math.max(0, offset - 1), offset, "right") ??
    rectFromRange(offset, Math.min(length, offset + 1), "left") ??
    rectFromRange(atPos, atPos + 1, "right") ?? { top: 0, bottom: 0, x: 0 }
  );
}

export function detectMention(container: HTMLElement): MentionState | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return null;
  if (!container.contains(textNode)) return null;

  const text = textNode.textContent ?? "";
  const offset = range.startOffset;
  const match = findMentionMatch(text, offset);
  if (!match) return null;

  // Anchor the menu to the live caret so it tracks each typed character instead of
  // staying glued to the @ marker.
  const caret = measureCaretRect(textNode as Text, offset, match.atPos);
  const containerRect = container.getBoundingClientRect();

  return {
    trigger: match.trigger,
    marker: match.marker,
    query: match.query,
    top: caret.top - containerRect.top,
    left: caret.x - containerRect.left,
    viewportTop: caret.top,
    viewportBottom: caret.bottom,
    viewportLeft: caret.x,
    textNode: textNode as Text,
    atPos: match.atPos,
    endPos: match.endPos,
  };
}

export function getMentionMenuViewport(): MentionMenuViewport {
  const viewport = window.visualViewport;
  if (viewport) {
    return {
      offsetLeft: viewport.offsetLeft,
      offsetTop: viewport.offsetTop,
      width: viewport.width,
      height: viewport.height,
    };
  }

  return {
    offsetLeft: 0,
    offsetTop: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

export function computeMentionMenuPosition(
  anchor: Pick<MentionState, "viewportTop" | "viewportBottom" | "viewportLeft">,
  viewport: MentionMenuViewport,
  menuSize: MentionMenuSize = {
    width: MENTION_MENU_WIDTH,
    height: MENTION_MENU_HEIGHT,
  },
) {
  const minLeft = viewport.offsetLeft + MENTION_MENU_PADDING;
  const maxLeft = viewport.offsetLeft + viewport.width - menuSize.width;
  const minTop = viewport.offsetTop + MENTION_MENU_PADDING;
  const maxTop = viewport.offsetTop + viewport.height - menuSize.height;

  // Place the menu's top edge on the current line so it sits next to the caret.
  // If it would overflow below, flip above so the menu's bottom hugs the line.
  const desiredTop = viewport.offsetTop + anchor.viewportTop;
  let top: number;
  if (desiredTop > maxTop) {
    const flipped = viewport.offsetTop + anchor.viewportBottom - menuSize.height;
    top = Math.max(minTop, Math.min(flipped, maxTop));
  } else {
    top = Math.max(minTop, desiredTop);
  }

  // Place the menu's left edge a small gap to the right of the caret X so
  // there's roughly a space-width of breathing room between cursor and menu.
  const desiredLeft = viewport.offsetLeft + anchor.viewportLeft + MENTION_MENU_CARET_GAP;
  const left = Math.max(minLeft, Math.min(desiredLeft, maxLeft));

  return { top, left };
}

export function getMentionMenuSize(optionCount: number): MentionMenuSize {
  const visibleRows = Math.max(1, Math.min(optionCount, 8));
  return {
    width: MENTION_MENU_WIDTH,
    height: Math.min(MENTION_MENU_HEIGHT, visibleRows * MENTION_MENU_ROW_HEIGHT + MENTION_MENU_CHROME_HEIGHT),
  };
}
