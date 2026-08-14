/** Synthetic thread id used to render the in-progress (pending) comment highlight. */
export const PENDING_HIGHLIGHT_THREAD_ID = "__paperclip-pending-annotation__";

export type NativeHighlightKind = "open" | "focused" | "stale" | "resolved";

export type NativeHighlightRanges = Record<NativeHighlightKind, Range[]>;

export type CssHighlight = object;

export type HighlightConstructor = new (...ranges: Range[]) => CssHighlight;

export type HighlightRegistry = {
  set: (name: string, highlight: CssHighlight) => void;
  delete: (name: string) => void;
};

export const NATIVE_HIGHLIGHT_NAMES: Record<NativeHighlightKind, string> = {
  open: "paperclip-doc-annotation-open",
  focused: "paperclip-doc-annotation-focused",
  stale: "paperclip-doc-annotation-stale",
  resolved: "paperclip-doc-annotation-resolved",
};

const nativeHighlightInstances = new Map<string, NativeHighlightRanges>();

export function getNativeHighlightApi(): {
  registry: HighlightRegistry;
  HighlightCtor: HighlightConstructor;
} | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const HighlightCtor = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  if (!css?.highlights || typeof HighlightCtor !== "function") return null;
  return { registry: css.highlights, HighlightCtor };
}

export function emptyNativeHighlightRanges(): NativeHighlightRanges {
  return {
    open: [],
    focused: [],
    stale: [],
    resolved: [],
  };
}

function syncNativeHighlights(api = getNativeHighlightApi()) {
  if (!api) return;
  for (const kind of Object.keys(NATIVE_HIGHLIGHT_NAMES) as NativeHighlightKind[]) {
    const ranges = Array.from(nativeHighlightInstances.values()).flatMap((entry) => entry[kind]);
    const name = NATIVE_HIGHLIGHT_NAMES[kind];
    if (ranges.length === 0) {
      api.registry.delete(name);
    } else {
      api.registry.set(name, new api.HighlightCtor(...ranges));
    }
  }
}

export function setNativeHighlightRanges(instanceId: string, ranges: NativeHighlightRanges) {
  if (!getNativeHighlightApi()) return;
  nativeHighlightInstances.set(instanceId, ranges);
  syncNativeHighlights();
}

export function clearNativeHighlightRanges(instanceId: string) {
  if (!nativeHighlightInstances.delete(instanceId)) return;
  syncNativeHighlights();
}

export function elementFromNode(node: Node | null | undefined): HTMLElement | null {
  if (!node) return null;
  if (node instanceof HTMLElement) return node;
  const parent = node.parentElement;
  return parent instanceof HTMLElement ? parent : null;
}

export function selectionTouchesEditableElement(container: HTMLElement, range: Range) {
  for (const node of [range.startContainer, range.endContainer, range.commonAncestorContainer]) {
    const element = elementFromNode(node);
    if (!element || !container.contains(element)) continue;
    const editableElement = element.closest("input, textarea, select, [contenteditable]");
    if (!(editableElement instanceof HTMLElement)) continue;
    if (editableElement.matches("input, textarea, select")) return true;
    const contentEditableValue = editableElement.getAttribute("contenteditable");
    if (
      editableElement.isContentEditable ||
      (contentEditableValue !== null && contentEditableValue.toLowerCase() !== "false")
    ) {
      return true;
    }
  }
  return false;
}

export function intersectRects(a: DOMRect, b: DOMRect): DOMRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

export function clipsOverflow(element: HTMLElement) {
  if (element.classList.contains("fold-curtain__content")) return true;
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return false;
  const style = window.getComputedStyle(element);
  return [style.overflow, style.overflowX, style.overflowY].some(
    (value) => value === "hidden" || value === "clip" || value === "auto" || value === "scroll",
  );
}

export function visibleClipRectForRange(range: Range, container: HTMLElement): DOMRect | null {
  let clipRect = container.getBoundingClientRect();
  let element = elementFromNode(range.commonAncestorContainer);
  while (element) {
    if (clipsOverflow(element)) {
      const nextClipRect = intersectRects(clipRect, element.getBoundingClientRect());
      if (!nextClipRect) return null;
      clipRect = nextClipRect;
    }
    if (element === container) break;
    element = element.parentElement;
  }
  return clipRect;
}

export function nativeHighlightKind(input: {
  focused: boolean;
  stale: boolean;
  resolved: boolean;
}): NativeHighlightKind {
  if (input.resolved) return "resolved";
  if (input.stale) return "stale";
  if (input.focused) return "focused";
  return "open";
}
