// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GanttColumns,
  type GanttFeature,
  GanttFeatureItem,
  GanttHeader,
  GanttMarker,
  GanttProvider,
  GanttSidebar,
  GanttSidebarGroup,
  GanttSidebarItem,
  GanttTimeline,
  GanttToday,
} from ".";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR_MS = 60 * 60 * 1000;
const status = { id: "succeeded", name: "Succeeded", color: "var(--chart-2)" };

function buildFeature(overrides: Partial<GanttFeature> = {}): GanttFeature {
  return {
    id: "run-1",
    name: "Precise run",
    startAt: new Date(2026, 3, 24, 9, 30),
    endAt: new Date(2026, 3, 24, 10, 30),
    status,
    ...overrides,
  };
}

function readTranslateX(element: Element | null): number {
  const match = element?.getAttribute("style")?.match(/translateX\(([-\d.]+)px\)/);
  if (!match?.[1]) throw new Error("Expected a pixel translateX style");
  return Number.parseFloat(match[1]);
}

describe("Kibo Gantt compatibility corrections", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalTimeZone: string | undefined;

  beforeEach(() => {
    originalTimeZone = process.env.TZ;
    process.env.TZ = "America/New_York";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T14:00:00-04:00"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  });

  it("uses one fractional daily coordinate for features, markers, and today", async () => {
    const feature = buildFeature();
    const afternoonFeature = buildFeature({
      id: "run-2",
      name: "Afternoon run",
      startAt: new Date(2026, 3, 24, 14, 0),
      endAt: new Date(2026, 3, 24, 16, 0),
    });

    await act(async () => {
      root.render(
        <GanttProvider initialExtent={{ from: feature.startAt, to: feature.endAt }} range="daily" zoom={480}>
          <GanttTimeline>
            <GanttFeatureItem {...feature} draggable={false} />
            <GanttFeatureItem {...afternoonFeature} draggable={false} />
            <GanttMarker date={feature.startAt} id="feature-start" label="Feature start" />
            <GanttToday />
          </GanttTimeline>
        </GanttProvider>,
      );
    });

    const card = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="card"]')).find((element) =>
      element.textContent?.includes(feature.name),
    );
    const positionedFeature = card?.parentElement;
    const afternoonCard = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="card"]')).find(
      (element) => element.textContent?.includes(afternoonFeature.name),
    );
    const positionedAfternoonFeature = afternoonCard?.parentElement;
    const marker = container.querySelector('[data-roadmap-ui="gantt-marker"]');
    const today = container.querySelector('[data-roadmap-ui="gantt-today"]');

    expect(positionedFeature).not.toBeNull();
    expect(Number.parseFloat(positionedFeature?.style.width ?? "NaN")).toBeCloseTo(10, 6);
    expect(Number.parseFloat(positionedFeature?.style.left ?? "NaN")).toBeCloseTo(readTranslateX(marker), 6);
    expect(
      Number.parseFloat(positionedAfternoonFeature?.style.left ?? "NaN") -
        Number.parseFloat(positionedFeature?.style.left ?? "NaN"),
    ).toBeCloseTo(45, 6);
    expect(Number.parseFloat(positionedAfternoonFeature?.style.width ?? "NaN")).toBeCloseTo(20, 6);
    expect(readTranslateX(today) - readTranslateX(marker)).toBeCloseTo(45, 6);
  });

  it("normalizes a DST transition into one calendar-day column", async () => {
    const dayStart = new Date(2026, 2, 8, 0, 0);
    const nextDayStart = new Date(2026, 2, 9, 0, 0);
    const feature = buildFeature({
      startAt: new Date(2026, 2, 8, 1, 30),
      endAt: new Date(2026, 2, 8, 3, 30),
    });

    expect((nextDayStart.getTime() - dayStart.getTime()) / HOUR_MS).toBe(23);
    expect(((feature.endAt?.getTime() ?? 0) - feature.startAt.getTime()) / HOUR_MS).toBe(1);

    await act(async () => {
      root.render(
        <GanttProvider initialExtent={{ from: dayStart, to: nextDayStart }} range="daily" zoom={460}>
          <GanttTimeline>
            <GanttFeatureItem {...feature} draggable={false} />
            <GanttMarker date={dayStart} id="day-start" label="Day start" />
          </GanttTimeline>
        </GanttProvider>,
      );
    });

    const card = container.querySelector<HTMLElement>('[data-slot="card"]');
    const positionedFeature = card?.parentElement;
    const dayStartMarker = container.querySelector('[data-roadmap-ui="gantt-marker"]');

    expect(
      Number.parseFloat(positionedFeature?.style.left ?? "NaN") - readTranslateX(dayStartMarker),
    ).toBeCloseTo(15, 6);
    expect(Number.parseFloat(positionedFeature?.style.width ?? "NaN")).toBeCloseTo(10, 6);
  });

  it("keeps hour guides opt-in and hides them until daily columns are readable", async () => {
    const date = new Date(2026, 3, 24);

    await act(async () => {
      root.render(
        <GanttProvider range="daily" zoom={800}>
          <GanttColumns columns={1} startDate={date} />
        </GanttProvider>,
      );
    });

    const gantt = container.querySelector<HTMLElement>(".gantt");
    expect(container.querySelector('[data-roadmap-ui="gantt-hour-ticks"]')).toBeNull();
    expect(gantt?.style.getPropertyValue("--gantt-header-height")).toBe("60px");

    await act(async () => {
      root.render(
        <GanttProvider range="daily" showDailyHourTicks zoom={384}>
          <GanttColumns columns={1} startDate={date} />
        </GanttProvider>,
      );
    });

    const hourTicks = container.querySelector<SVGElement>('[data-roadmap-ui="gantt-hour-ticks"]');
    expect(hourTicks).not.toBeNull();
    expect(hourTicks?.tagName.toLowerCase()).toBe("svg");
    expect(hourTicks?.querySelector("path")?.getAttribute("d")).toContain("M0.250000 0V1");
    expect(gantt?.style.getPropertyValue("--gantt-header-height")).toBe("72px");

    await act(async () => {
      root.render(
        <GanttProvider range="daily" showDailyHourTicks zoom={300}>
          <GanttColumns columns={1} startDate={date} />
        </GanttProvider>,
      );
    });

    expect(container.querySelector('[data-roadmap-ui="gantt-hour-ticks"]')).toBeNull();
    expect(gantt?.style.getPropertyValue("--gantt-header-height")).toBe("60px");
  });

  it("syncs refreshed feature dates without remounting the feature", async () => {
    const feature = buildFeature();

    await act(async () => {
      root.render(
        <GanttProvider initialExtent={{ from: feature.startAt, to: feature.endAt }} range="daily" zoom={480}>
          <GanttTimeline>
            <GanttFeatureItem {...feature} draggable={false} />
          </GanttTimeline>
        </GanttProvider>,
      );
    });

    const getPositionedFeature = () =>
      container.querySelector<HTMLElement>('[data-slot="card"]')?.parentElement;
    expect(Number.parseFloat(getPositionedFeature()?.style.width ?? "NaN")).toBeCloseTo(10, 6);

    const refreshedFeature = { ...feature, endAt: new Date(2026, 3, 24, 11, 30) };
    await act(async () => {
      root.render(
        <GanttProvider
          initialExtent={{ from: refreshedFeature.startAt, to: refreshedFeature.endAt }}
          range="daily"
          zoom={480}
        >
          <GanttTimeline>
            <GanttFeatureItem {...refreshedFeature} draggable={false} />
          </GanttTimeline>
        </GanttProvider>,
      );
    });

    expect(Number.parseFloat(getPositionedFeature()?.style.width ?? "NaN")).toBeCloseTo(20, 6);
  });

  it("uses one 44px row metric for sidebar and chart rows on coarse pointers", async () => {
    let coarsePointer = true;
    let notifyChange: (() => void) | undefined;
    const media = {
      get matches() {
        return coarsePointer;
      },
      media: "(pointer: coarse)",
      onchange: null,
      addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
        notifyChange = () => listener({ matches: coarsePointer } as MediaQueryListEvent);
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as MediaQueryList;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media),
    );
    const feature = buildFeature();

    await act(async () => {
      root.render(
        <GanttProvider initialExtent={{ from: feature.startAt, to: feature.endAt }} range="daily">
          <GanttSidebar>
            <GanttSidebarGroup name="Agents">
              <GanttSidebarItem feature={feature} />
            </GanttSidebarGroup>
          </GanttSidebar>
          <GanttTimeline>
            <GanttFeatureItem {...feature} draggable={false} />
          </GanttTimeline>
        </GanttProvider>,
      );
    });

    const gantt = container.querySelector<HTMLElement>(".gantt");
    const sidebarRow = container.querySelector<HTMLElement>('[role="button"]');
    const featureCard = container.querySelector<HTMLElement>('[data-slot="card"]');
    const chartRow = featureCard?.parentElement?.parentElement;

    expect(gantt?.style.getPropertyValue("--gantt-row-height")).toBe("44px");
    expect(sidebarRow?.style.height).toBe("var(--gantt-row-height)");
    expect(sidebarRow?.style.minHeight).toBe("var(--gantt-row-height)");
    expect(chartRow?.style.height).toBe("var(--gantt-row-height)");

    coarsePointer = false;
    await act(async () => notifyChange?.());
    expect(gantt?.style.getPropertyValue("--gantt-row-height")).toBe("36px");
  });

  it("seeds exact extent years while preserving the default three-year window", async () => {
    const extent = {
      from: new Date(2026, 3, 24),
      to: new Date(2026, 3, 25),
    };

    await act(async () => {
      root.render(
        <GanttProvider initialExtent={extent} range="monthly">
          <GanttHeader />
        </GanttProvider>,
      );
    });

    expect(container.textContent).toContain("2026");
    expect(container.textContent).not.toContain("2025");
    expect(container.textContent).not.toContain("2027");

    await act(async () => {
      root.render(
        <GanttProvider key="default-window" range="monthly">
          <GanttHeader />
        </GanttProvider>,
      );
    });

    expect(container.textContent).toContain("2025");
    expect(container.textContent).toContain("2026");
    expect(container.textContent).toContain("2027");
  });

  it("extends consecutive years across repeated timeline-edge scrolls", async () => {
    await act(async () => {
      root.render(
        <GanttProvider range="monthly">
          <GanttHeader />
        </GanttProvider>,
      );
    });

    const gantt = container.querySelector<HTMLElement>(".gantt");
    expect(gantt).not.toBeNull();

    await act(async () => {
      gantt?.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.textContent).toContain("2024");

    await act(async () => {
      gantt?.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.textContent).toContain("2023");
  });

  it("shows exact sidebar durations with configurable labels", async () => {
    const endedFeature = buildFeature({
      id: "ended",
      name: "Ended run",
      startAt: new Date(2026, 3, 24, 9, 30),
      endAt: new Date(2026, 3, 24, 10, 0),
    });
    await act(async () => {
      root.render(
        <GanttProvider>
          <GanttSidebar durationLabel="Elapsed" itemLabel="Runs">
            <GanttSidebarGroup name="Agents">
              <GanttSidebarItem feature={endedFeature} />
            </GanttSidebarGroup>
          </GanttSidebar>
        </GanttProvider>,
      );
    });

    const sidebar = container.querySelector('[data-roadmap-ui="gantt-sidebar"]');
    const sidebarHeader = sidebar?.firstElementChild as HTMLElement | null;

    expect(container.textContent).toContain("Runs");
    expect(container.textContent).toContain("Elapsed");
    expect(container.textContent).toContain("30m");
    expect(sidebarHeader?.className).toContain("bg-background/90");
  });

  it("uses an initial focus date and preserves its focal point across zoom changes", async () => {
    const focusDate = new Date(2026, 3, 24, 9, 30);

    await act(async () => {
      root.render(
        <GanttProvider
          initialExtent={{ from: focusDate, to: focusDate }}
          initialFocusDate={focusDate}
          range="daily"
        >
          <GanttMarker date={focusDate} id="focus" label="Focus" />
        </GanttProvider>,
      );
    });

    const gantt = container.querySelector<HTMLElement>(".gantt");
    const marker = container.querySelector('[data-roadmap-ui="gantt-marker"]');

    expect(gantt?.scrollLeft).toBeCloseTo(readTranslateX(marker), 6);

    await act(async () => {
      root.render(
        <GanttProvider
          initialExtent={{ from: focusDate, to: focusDate }}
          initialFocusDate={focusDate}
          range="daily"
          zoom={200}
        >
          <GanttMarker date={focusDate} id="focus" label="Focus" />
        </GanttProvider>,
      );
    });

    const scaledMarker = container.querySelector('[data-roadmap-ui="gantt-marker"]');
    expect(gantt?.scrollLeft).toBeCloseTo(readTranslateX(scaledMarker), 6);
  });

  it("adds only the neighboring year needed to center a boundary focus", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);

    const renderBoundary = async (focusDate: Date) => {
      await act(async () => {
        root.render(
          <GanttProvider
            initialExtent={{ from: focusDate, to: focusDate }}
            initialFocusDate={focusDate}
            key={focusDate.getTime()}
            range="daily"
            zoom={384}
          >
            <GanttHeader />
            <GanttMarker date={focusDate} id="focus" label="Focus" />
          </GanttProvider>,
        );
      });

      const gantt = container.querySelector<HTMLElement>(".gantt");
      const marker = container.querySelector('[data-roadmap-ui="gantt-marker"]');
      expect((gantt?.scrollLeft ?? 0) + 500).toBeCloseTo(readTranslateX(marker), 6);
    };

    await renderBoundary(new Date(2026, 0, 1));
    expect(container.textContent).toContain("2025");
    expect(container.textContent).not.toContain("2027");

    await renderBoundary(new Date(2026, 11, 31));
    expect(container.textContent).not.toContain("2025");
    expect(container.textContent).toContain("2027");
  });
});
