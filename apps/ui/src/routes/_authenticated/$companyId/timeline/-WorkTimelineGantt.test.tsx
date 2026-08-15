// @vitest-environment jsdom

import type { WorkTimelineResult } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clusterTimelineActivity, WorkTimelineGantt } from "./-WorkTimelineGantt";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const historicalTimeline: WorkTimelineResult = {
  actors: [{ id: "agent:historian", type: "agent", name: "Historian", avatar: "book" }],
  spans: [
    {
      actorId: "agent:historian",
      runId: "run:historical",
      kind: "productive",
      taskId: "task:historical",
      taskNumber: 12,
      taskIdentifier: "PAP-12",
      taskTitle: "Index the archive",
      start: "2012-04-02T10:00:00.000Z",
      end: "2012-04-02T11:00:00.000Z",
      status: "succeeded",
      retryOfRunId: null,
    },
  ],
  events: [],
  edges: [],
  pagination: {
    limit: 100,
    offset: 0,
    totalTasks: 1,
    hasMore: false,
  },
  window: {
    from: "2012-04-01T00:00:00.000Z",
    to: "2012-04-08T00:00:00.000Z",
    capped: false,
  },
};

const intradayTimeline: WorkTimelineResult = {
  actors: [{ id: "agent:operator", type: "agent", name: "Operator", avatar: "terminal" }],
  spans: [
    {
      actorId: "agent:operator",
      runId: "run:morning",
      kind: "productive",
      taskId: "task:morning",
      taskNumber: 21,
      taskIdentifier: "PAP-21",
      taskTitle: "Morning run",
      start: "2026-07-02T09:00:00.000Z",
      end: "2026-07-02T10:00:00.000Z",
      status: "succeeded",
      retryOfRunId: null,
    },
    {
      actorId: "agent:operator",
      runId: "run:afternoon",
      kind: "productive",
      taskId: "task:afternoon",
      taskNumber: 22,
      taskIdentifier: "PAP-22",
      taskTitle: "Afternoon run",
      start: "2026-07-02T15:00:00.000Z",
      end: "2026-07-02T17:00:00.000Z",
      status: "failed",
      retryOfRunId: null,
    },
  ],
  events: [
    {
      actorId: "agent:operator",
      kind: "created",
      taskId: "task:morning",
      at: "2026-07-02T09:30:00.000Z",
    },
    {
      actorId: "agent:operator",
      kind: "commented",
      taskId: "task:afternoon",
      at: "2026-07-02T15:30:00.000Z",
    },
  ],
  edges: [],
  pagination: {
    limit: 100,
    offset: 0,
    totalTasks: 2,
    hasMore: false,
  },
  window: {
    from: "2026-07-02T00:00:00.000Z",
    to: "2026-07-02T23:59:59.999Z",
    capped: false,
  },
};

describe("WorkTimelineGantt", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("seeds Kibo's calendar around the returned historical window", async () => {
    await act(async () => {
      root.render(<WorkTimelineGantt data={historicalTimeline} />);
    });

    expect(container.textContent).toContain("2012");

    const featureCard = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="card"]')).find(
      (card) => card.textContent?.includes("PAP-12 · Index the archive"),
    );
    const positionedFeature = featureCard?.parentElement;

    expect(positionedFeature).not.toBeNull();
    expect(Number.parseFloat(positionedFeature?.style.left ?? "-1")).toBeGreaterThanOrEqual(0);
  });

  it("keeps the Kibo feature bar read-only without drag semantics or date movement", async () => {
    await act(async () => {
      root.render(<WorkTimelineGantt data={historicalTimeline} />);
    });

    const featureCard = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="card"]')).find(
      (card) => card.textContent?.includes("PAP-12 · Index the archive"),
    );

    expect(featureCard).toBeDefined();
    expect(featureCard?.querySelector('[aria-roledescription="draggable"]')).toBeNull();
    expect(featureCard?.querySelector('button[aria-pressed="false"]')).not.toBeNull();
  });

  it("activates Kibo sidebar buttons with Enter and Space", async () => {
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    try {
      await act(async () => {
        root.render(<WorkTimelineGantt data={historicalTimeline} />);
      });

      const sidebarItem = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
        (item) => item.textContent?.includes("PAP-12 · Index the archive"),
      );
      expect(sidebarItem).toBeDefined();
      scrollTo.mockClear();

      const enter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      const space = new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      });

      await act(async () => {
        sidebarItem?.dispatchEvent(enter);
        sidebarItem?.dispatchEvent(space);
      });

      expect(enter.defaultPrevented).toBe(true);
      expect(space.defaultPrevented).toBe(true);
      expect(scrollTo).toHaveBeenCalledTimes(2);
    } finally {
      if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
      }
    }
  });

  it("preserves precise intraday geometry, markers, status labels, and selection", async () => {
    const onSelectRun = vi.fn();
    await act(async () => {
      root.render(<WorkTimelineGantt data={intradayTimeline} initialZoom={4800} onSelectRun={onSelectRun} />);
    });

    const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="card"]'));
    const morningCard = cards.find((card) => card.textContent?.includes("PAP-21 · Morning run"));
    const afternoonCard = cards.find((card) => card.textContent?.includes("PAP-22 · Afternoon run"));
    const morningPosition = morningCard?.parentElement;
    const afternoonPosition = afternoonCard?.parentElement;
    const morningLeft = Number.parseFloat(morningPosition?.style.left ?? "0");
    const afternoonLeft = Number.parseFloat(afternoonPosition?.style.left ?? "0");
    const morningWidth = Number.parseFloat(morningPosition?.style.width ?? "0");
    const afternoonWidth = Number.parseFloat(afternoonPosition?.style.width ?? "0");

    expect(afternoonLeft).toBeGreaterThan(morningLeft);
    expect(morningWidth).toBeGreaterThan(0);
    expect(afternoonWidth / morningWidth).toBeCloseTo(2, 2);
    expect(container.querySelector('[data-roadmap-ui="gantt-hour-ticks"]')).not.toBeNull();

    const markers = Array.from(container.querySelectorAll<HTMLElement>('[data-roadmap-ui="gantt-marker"]'));
    expect(markers).toHaveLength(2);
    expect(markers[0]?.style.transform).not.toBe(markers[1]?.style.transform);

    const failedBar = container.querySelector<HTMLButtonElement>(
      'button[aria-label*="PAP-22 · Afternoon run, Failed, 2h"]',
    );
    expect(failedBar).not.toBeNull();
    await act(async () => failedBar?.click());
    expect(onSelectRun).toHaveBeenCalledWith("run:afternoon");
  });

  it("uses a labelled, selectable run agenda instead of tiny Gantt bars on mobile", async () => {
    const originalWidth = window.innerWidth;
    const onSelectRun = vi.fn();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });

    try {
      await act(async () => {
        root.render(<WorkTimelineGantt data={intradayTimeline} onSelectRun={onSelectRun} />);
      });

      const agenda = container.querySelector('[aria-label="Timeline runs by actor"]');
      const afternoonRun = Array.from(agenda?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (button) => button.textContent?.includes("PAP-22 · Afternoon run"),
      );

      expect(agenda).not.toBeNull();
      expect(container.querySelector(".gantt")).toBeNull();
      expect(afternoonRun?.textContent).toContain("Failed");
      await act(async () => afternoonRun?.click());
      expect(onSelectRun).toHaveBeenCalledWith("run:afternoon");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("clusters dense event streams into a bounded set of readable markers", () => {
    const denseTimeline: WorkTimelineResult = {
      ...intradayTimeline,
      events: [
        {
          actorId: "agent:operator",
          kind: "created" as const,
          taskId: "task:morning",
          at: "2026-06-01T00:00:00.000Z",
        },
        ...Array.from({ length: 120 }, (_, index) => ({
          actorId: "agent:operator",
          kind: "commented" as const,
          taskId: "task:morning",
          at: new Date(Date.parse("2026-07-02T00:00:00.000Z") + index * 10 * 60_000).toISOString(),
        })),
        {
          actorId: "agent:operator",
          kind: "commented" as const,
          taskId: "task:morning",
          at: "2026-08-01T00:00:00.000Z",
        },
      ],
    };

    const clusters = clusterTimelineActivity(denseTimeline);
    expect(clusters.length).toBeLessThanOrEqual(8);
    expect(clusters.reduce((total, cluster) => total + cluster.count, 0)).toBe(120);
  });

  it("projects relationship-only activity into the marker timeline", () => {
    const relationshipTimeline: WorkTimelineResult = {
      ...intradayTimeline,
      spans: [],
      events: [],
      actors: [
        ...intradayTimeline.actors,
        { id: "user:reviewer", type: "user", name: "Reviewer", avatar: null },
      ],
      edges: [
        {
          fromActorId: "agent:operator",
          toActorId: "user:reviewer",
          taskId: "task:morning",
          at: "2026-07-02T12:00:00.000Z",
          kind: "delegation",
        },
      ],
    };

    expect(clusterTimelineActivity(relationshipTimeline)).toEqual([
      expect.objectContaining({
        count: 1,
        label: "Operator → Reviewer · delegation",
      }),
    ]);
  });
});
