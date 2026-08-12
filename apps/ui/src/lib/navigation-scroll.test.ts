// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  applyMainContentScrollTop,
  NavigationScrollMemory,
  resetNavigationScroll,
  SIDEBAR_SCROLL_RESET_STATE,
  shouldResetScrollOnNavigation,
  type NavigationScrollRoute,
} from "./navigation-scroll";

const dashboardRoute: NavigationScrollRoute = {
  matchId: "dashboard",
  kind: "other",
};
const taskIndexRoute: NavigationScrollRoute = {
  matchId: "task-index",
  kind: "task-index",
};
const taskDetailRoute = (taskRef: string): NavigationScrollRoute => ({
  matchId: `task-detail:${taskRef}`,
  kind: "task-detail",
  taskRef,
});

describe("navigation-scroll", () => {
  it("resets scroll only for flagged sidebar navigation", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousRoute: taskIndexRoute,
        route: dashboardRoute,
        navigationType: "PUSH",
        state: SIDEBAR_SCROLL_RESET_STATE,
      }),
    ).toBe(true);

    expect(
      shouldResetScrollOnNavigation({
        previousRoute: taskIndexRoute,
        route: dashboardRoute,
        navigationType: "PUSH",
        state: null,
      }),
    ).toBe(false);
  });

  it("preserves scroll restoration for browser history navigation even for sidebar entries", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousRoute: taskIndexRoute,
        route: dashboardRoute,
        navigationType: "POP",
        state: SIDEBAR_SCROLL_RESET_STATE,
      }),
    ).toBe(false);
  });

  it("resets scroll when navigating into the top-level tasks page", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousRoute: taskDetailRoute("PAP-1389"),
        route: taskIndexRoute,
        navigationType: "REPLACE",
        state: null,
      }),
    ).toBe(true);
  });

  it("does not reset tasks page scroll on browser history restoration", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousRoute: taskDetailRoute("PAP-1389"),
        route: taskIndexRoute,
        navigationType: "POP",
        state: null,
      }),
    ).toBe(false);
  });

  it("resets scroll when navigating directly between task detail routes", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousRoute: taskDetailRoute("PAP-1389"),
        route: taskDetailRoute("PAP-1346"),
        navigationType: "REPLACE",
        state: null,
      }),
    ).toBe(true);
  });

  it("does not treat other routes as task-to-task navigation", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousRoute: { matchId: "project-tasks", kind: "other" },
        route: taskDetailRoute("PAP-1346"),
        navigationType: "PUSH",
        state: null,
      }),
    ).toBe(false);

    expect(
      shouldResetScrollOnNavigation({
        previousRoute: taskDetailRoute("PAP-1389"),
        route: { matchId: "project-tasks", kind: "other" },
        navigationType: "PUSH",
        state: null,
      }),
    ).toBe(false);
  });

  it("does not reset scroll on the initial render or when the route match is unchanged", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousRoute: null,
        route: dashboardRoute,
        navigationType: "PUSH",
        state: SIDEBAR_SCROLL_RESET_STATE,
      }),
    ).toBe(false);

    expect(
      shouldResetScrollOnNavigation({
        previousRoute: dashboardRoute,
        route: dashboardRoute,
        navigationType: "REPLACE",
        state: SIDEBAR_SCROLL_RESET_STATE,
      }),
    ).toBe(false);
  });

  it("resets both the main content container and page scroll state", () => {
    const main = document.createElement("main");
    main.scrollTop = 180;
    main.scrollLeft = 14;
    main.scrollTo = vi.fn();
    document.body.appendChild(main);

    document.documentElement.scrollTop = 240;
    document.documentElement.scrollLeft = 9;
    document.body.scrollTop = 120;
    document.body.scrollLeft = 7;
    const windowScrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    resetNavigationScroll(main);

    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
    expect(main.scrollTop).toBe(0);
    expect(main.scrollLeft).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.documentElement.scrollLeft).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    expect(document.body.scrollLeft).toBe(0);
    expect(windowScrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
  });

  it("remembers and recalls scroll offsets per history key", () => {
    const memory = new NavigationScrollMemory();
    expect(memory.recall("missing")).toBe(0);

    memory.remember("inbox", 640);
    memory.remember("task", 1820);
    expect(memory.recall("inbox")).toBe(640);
    expect(memory.recall("task")).toBe(1820);

    memory.remember("inbox", 700);
    expect(memory.recall("inbox")).toBe(700);

    memory.remember("inbox", -50);
    expect(memory.recall("inbox")).toBe(0);
  });

  it("restores a remembered scroll offset onto the main content element", () => {
    const main = document.createElement("main");
    main.scrollTo = vi.fn();

    applyMainContentScrollTop(main, 540);

    expect(main.scrollTo).toHaveBeenCalledWith({ top: 540, left: 0, behavior: "auto" });
    expect(main.scrollTop).toBe(540);
    expect(main.scrollLeft).toBe(0);

    expect(() => applyMainContentScrollTop(null, 540)).not.toThrow();
  });
});
