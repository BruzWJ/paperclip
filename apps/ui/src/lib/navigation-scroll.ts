export type NavigationType = "POP" | "PUSH" | "REPLACE";

export const SIDEBAR_SCROLL_RESET_STATE = {
  paperclipSidebarScrollReset: true,
} as const;

export type NavigationScrollRoute =
  | { matchId: string; kind: "other" | "task-index" }
  | { matchId: string; kind: "task-detail"; taskRef: string };

export function shouldResetScrollOnNavigation(params: {
  previousRoute: NavigationScrollRoute | null;
  route: NavigationScrollRoute;
  navigationType: NavigationType;
  state: unknown;
}): boolean {
  const { previousRoute, route, navigationType, state } = params;
  if (previousRoute === null) return false;
  if (previousRoute.matchId === route.matchId) return false;
  if (navigationType === "POP") return false;
  if (route.kind === "task-index") return true;
  if (
    previousRoute.kind === "task-detail" &&
    route.kind === "task-detail" &&
    previousRoute.taskRef !== route.taskRef
  ) {
    return true;
  }
  return hasSidebarScrollResetState(state);
}

// Remembers the `#main-content` scroll offset per browser-history entry so a
// back/forward (POP) navigation can be restored to where the user left off.
// `#main-content` is a single element that survives route changes, so without
// this the offset from the page we navigated away from (e.g. a deep
// task-detail scroll) bleeds into the page we return to (e.g. the inbox).
export class NavigationScrollMemory {
  private positions = new Map<string, number>();

  remember(key: string, scrollTop: number): void {
    this.positions.set(key, Math.max(0, scrollTop));
  }

  recall(key: string): number {
    return this.positions.get(key) ?? 0;
  }
}

export function applyMainContentScrollTop(mainElement: HTMLElement | null, scrollTop: number): void {
  if (!mainElement) return;
  mainElement.scrollTo?.({ top: scrollTop, left: 0, behavior: "auto" });
  mainElement.scrollTop = scrollTop;
  mainElement.scrollLeft = 0;
}

export function resetNavigationScroll(mainElement: HTMLElement | null): void {
  mainElement?.scrollTo?.({ top: 0, left: 0, behavior: "auto" });

  if (mainElement) {
    mainElement.scrollTop = 0;
    mainElement.scrollLeft = 0;
  }

  const scrollingElement = document.scrollingElement ?? document.documentElement;
  if (scrollingElement) {
    scrollingElement.scrollTop = 0;
    scrollingElement.scrollLeft = 0;
  }

  if (document.body) {
    document.body.scrollTop = 0;
    document.body.scrollLeft = 0;
  }

  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function hasSidebarScrollResetState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  return Reflect.get(state, "paperclipSidebarScrollReset") === true;
}
