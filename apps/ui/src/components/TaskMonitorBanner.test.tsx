// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Task } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TaskMonitorBanner,
  TaskMonitorComposerStrip,
  buildMonitorSurfaceCopy,
  hasVisibleMonitorSurface,
} from "./TaskMonitorBanner";
import type { DerivedMonitorState } from "@/lib/task-monitor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-07-17T20:00:00.000Z");

function derived(
  overrides: Partial<DerivedMonitorState> & {
    state: DerivedMonitorState["state"];
  },
): DerivedMonitorState {
  return {
    nextCheckAt: null,
    attemptCount: 0,
    serviceName: null,
    ...overrides,
  };
}

describe("buildMonitorSurfaceCopy", () => {
  it("leads with two-unit relative time while scheduled", () => {
    const copy = buildMonitorSurfaceCopy(
      derived({
        state: "scheduled",
        nextCheckAt: new Date(NOW.getTime() + (2 * 60 + 12) * 60_000).toISOString(),
        attemptCount: 1,
        serviceName: "vercel-deploy",
      }),
      NOW,
    );

    expect(copy).not.toBeNull();
    expect(copy!.bannerTitle).toBe("Monitor reminder — due in 2h 12m");
    expect(copy!.stripTitle).toBe("Due in 2h 12m");
    expect(copy!.tone).toBe("info");
    expect(copy!.bannerMeta).toContain("Attempt 1");
    expect(copy!.bannerMeta).toContain("Watching: vercel-deploy");
    // Absolute time carries the "(your time)" hint on the banner only.
    expect(copy!.bannerMeta.some((piece) => piece.includes("(your time)"))).toBe(true);
    expect(copy!.stripMeta.some((piece) => piece.includes("(your time)"))).toBe(false);
  });

  it("keeps the retrying attempt count visible", () => {
    const copy = buildMonitorSurfaceCopy(
      derived({
        state: "retrying",
        nextCheckAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
        attemptCount: 3,
      }),
      NOW,
    );
    expect(copy!.stripTitle).toBe("Due in 1h 30m");
    expect(copy!.stripMeta).toContain("Attempt 3");
  });

  it("switches copy for due-now and overdue states", () => {
    const dueNow = buildMonitorSurfaceCopy(
      derived({
        state: "due-now",
        nextCheckAt: NOW.toISOString(),
        attemptCount: 1,
      }),
      NOW,
    );
    expect(dueNow!.bannerTitle).toBe("Monitor reminder — due now");
    expect(dueNow!.stripTitle).toBe("Due now");
    expect(dueNow!.bannerMeta).not.toContain("Checking momentarily…");
    expect(dueNow!.tone).toBe("info");

    const overdue = buildMonitorSurfaceCopy(
      derived({
        state: "overdue",
        nextCheckAt: new Date(NOW.getTime() - 18 * 60_000).toISOString(),
        attemptCount: 2,
      }),
      NOW,
    );
    expect(overdue!.bannerTitle).toBe("Monitor reminder — overdue by 18m");
    expect(overdue!.stripTitle).toBe("Overdue by 18m");
    expect(overdue!.bannerMeta).not.toContain("Fires on next tick");
    expect(overdue!.tone).toBe("warning");
  });

  it("hides both surfaces when cleared, none, or without a next check", () => {
    expect(buildMonitorSurfaceCopy(derived({ state: "cleared", attemptCount: 2 }), NOW)).toBeNull();
    expect(buildMonitorSurfaceCopy(derived({ state: "none" }), NOW)).toBeNull();
    // A "scheduled" state with no timestamp cannot render an ETA — hide.
    expect(buildMonitorSurfaceCopy(derived({ state: "scheduled", nextCheckAt: null }), NOW)).toBeNull();
  });
});

describe("TaskMonitorBanner / TaskMonitorComposerStrip rendering", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  function taskWithMonitor(nextCheckAt: string | null): Task {
    return {
      executionState: nextCheckAt
        ? {
            monitor: {
              status: "scheduled",
              nextCheckAt,
              attemptCount: 1,
              serviceName: "vercel-deploy",
            },
          }
        : null,
    } as unknown as Task;
  }

  it("renders the waiting banner without an unsupported immediate-check action", () => {
    expect(
      hasVisibleMonitorSurface(taskWithMonitor(new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString())),
    ).toBe(true);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <TaskMonitorBanner task={taskWithMonitor(new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString())} />,
      );
    });

    expect(container.textContent).toContain("Monitor reminder — due in 2h");
    expect(container.textContent).toContain("Watching: vercel-deploy");

    expect(container.textContent).not.toContain("Check now");

    flushSync(() => root.unmount());
  });

  it("hides the banner and strip when there is no monitor", () => {
    expect(hasVisibleMonitorSurface(taskWithMonitor(null))).toBe(false);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <>
          <TaskMonitorBanner task={taskWithMonitor(null)} />
          <TaskMonitorComposerStrip task={taskWithMonitor(null)} />
        </>,
      );
    });
    expect(container.textContent).toBe("");
    flushSync(() => root.unmount());
  });

  it("renders the composer strip with the reply-wakes-agent hint", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <TaskMonitorComposerStrip
          task={taskWithMonitor(new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString())}
        />,
      );
    });

    expect(container.querySelector("[data-testid='task-monitor-composer-strip']")).toBeTruthy();
    expect(container.textContent).toContain("Due in 2h");
    expect(container.textContent).toContain("this reminder does not trigger a run");

    flushSync(() => root.unmount());
  });
});
