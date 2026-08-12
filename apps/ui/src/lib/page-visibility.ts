/**
 * Page-visibility helpers for request observability and foreground-aware UI.
 *
 * A tab can be in one of three practical states:
 *   - hidden:   `document.visibilityState !== "visible"` — the user is not looking at it.
 *   - visible:  on screen but not the focused window (e.g. split-screen, another window on top).
 *   - focused:  visible AND `document.hasFocus()` — the tab the user is actively using.
 *
 * The header value is a non-authoritative observability hint only — never a
 * security signal.
 */

export interface PageVisibility {
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /** Visible AND the document currently has focus. */
  focused: boolean;
}

const HIDDEN: PageVisibility = { visible: false, focused: false };

export function getPageVisibility(): PageVisibility {
  if (typeof document === "undefined") {
    // Non-browser test environments are treated as focused so queries load.
    return { visible: true, focused: true };
  }
  const visible = document.visibilityState === "visible";
  if (!visible) return HIDDEN;
  const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  return { visible: true, focused };
}

/** Stable header value for `X-Paperclip-Tab-Visible`: "focused" | "visible" | "hidden". */
export function getVisibilityHeaderValue(state: PageVisibility = getPageVisibility()): string {
  if (!state.visible) return "hidden";
  return state.focused ? "focused" : "visible";
}
