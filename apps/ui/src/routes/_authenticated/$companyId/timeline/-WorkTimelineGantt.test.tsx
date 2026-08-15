// @vitest-environment jsdom

import type { WorkTimelineResult } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkTimelineGantt } from "./-WorkTimelineGantt";

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
    const positionedFeature = featureCard?.parentElement;
    const originalPosition = positionedFeature?.getAttribute("style");
    const featureSurface = featureCard?.firstElementChild;

    expect(featureCard).toBeDefined();
    expect(featureCard?.querySelector('[aria-roledescription="draggable"]')).toBeNull();
    expect(featureCard?.querySelector("[aria-pressed]")).toBeNull();
    expect(featureSurface).not.toBeNull();

    await act(async () => {
      featureSurface?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 20 }),
      );
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 20 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 300, clientY: 20 }));
    });

    expect(positionedFeature?.getAttribute("style")).toBe(originalPosition);
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
});
