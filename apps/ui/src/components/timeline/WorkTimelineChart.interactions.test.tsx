// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import "./WorkTimelineChart.test-support";
import {
  container,
  flushTimelineEffects,
  renderChart,
  replaceRoot,
  root,
  timelineSample,
} from "./WorkTimelineChart.test-support";
describe("WorkTimelineChart", () => {
  it("reserves normal wheel input for panning and uses modifier-wheel for continuous zoom", () => {
    const onZoomScaleChange = vi.fn();
    renderChart(timelineSample(), { onZoomScaleChange });
    const scroller = container.querySelector<HTMLElement>("[data-testid='work-timeline-scroll']")!;
    flushSync(() => {
      scroller.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 80,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onZoomScaleChange).not.toHaveBeenCalled();
    flushSync(() => {
      scroller.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 80,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onZoomScaleChange).toHaveBeenCalledTimes(1);
  });
  it("renders task bars as native company-scoped links", () => {
    renderChart(timelineSample());
    const bar = container.querySelector<SVGGElement>("[data-run-id='run-1']")!;
    const link = bar.closest("a");
    expect(link?.getAttribute("href")).toBe("/11111111-1111-4111-8111-111111111111/tasks/12443");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("lets the minimap range slider resize the visible range and update zoom", async () => {
    const onZoomScaleChange = vi.fn();
    renderChart(timelineSample(), { onZoomScaleChange });
    await flushTimelineEffects();
    const thumbs = container.querySelectorAll<HTMLElement>("[data-slot='slider-thumb']");
    const rightThumb = thumbs.item(1);
    flushSync(() => {
      rightThumb.focus();
      rightThumb.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
        }),
      );
    });
    expect(onZoomScaleChange).toHaveBeenCalled();
  });
  it("exposes native range-slider semantics on both minimap edges", () => {
    renderChart(timelineSample(), { onZoomScaleChange: vi.fn() });
    const thumbs = container.querySelectorAll<HTMLElement>("[data-slot='slider-thumb']");
    expect(thumbs).toHaveLength(2);
    for (const thumb of thumbs) {
      expect(thumb.getAttribute("role")).toBe("slider");
      expect(thumb.getAttribute("aria-valuemin")).not.toBeNull();
      expect(thumb.getAttribute("aria-valuemax")).not.toBeNull();
      expect(thumb.getAttribute("aria-valuenow")).not.toBeNull();
    }
  });
  it("cleans up chart drag listeners when unmounted mid-drag", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    renderChart(timelineSample(), { onZoomScaleChange: vi.fn() });
    const chartSvg = container.querySelector<SVGSVGElement>("svg.absolute")!;
    vi.spyOn(chartSvg, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 400,
      width: 1000,
      height: 400,
      toJSON: () => ({}),
    });
    flushSync(() => {
      chartSvg.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: 260,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(add).toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(add).toHaveBeenCalledWith("mouseup", expect.any(Function));
    flushSync(() => root.unmount());
    replaceRoot(createRoot(container));
    expect(remove).toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("mouseup", expect.any(Function));
  });
  it("keeps minimap selection panning on pointer capture instead of document listeners", () => {
    const add = vi.spyOn(document, "addEventListener");
    renderChart(timelineSample(), { onZoomScaleChange: vi.fn() });
    const selection = container.querySelector<HTMLButtonElement>(
      "[data-testid='timeline-minimap-selection']",
    )!;
    selection.setPointerCapture = vi.fn();
    add.mockClear();
    flushSync(() => {
      selection.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(selection.setPointerCapture).toHaveBeenCalled();
    expect(add).not.toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(add).not.toHaveBeenCalledWith("mouseup", expect.any(Function));
  });
  it("keeps the default now timestamp stable across rerenders", () => {
    const now = new Date("2026-07-02T12:00:00.000Z").getTime();
    const later = new Date("2026-07-02T13:00:00.000Z").getTime();
    let currentNow = now;
    vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    const data = timelineSample();
    data.spans[0] = {
      ...data.spans[0],
      end: null,
      status: "running",
    };
    renderChart(data, { nowMs: undefined });
    const initialWidth = container
      .querySelector<SVGRectElement>("[data-run-id='run-1'] rect")
      ?.getAttribute("width");
    currentNow = later;
    renderChart(data, { nowMs: undefined });
    expect(container.querySelector<SVGRectElement>("[data-run-id='run-1'] rect")?.getAttribute("width")).toBe(
      initialWidth,
    );
  });
  it("lets dragging the chart grid select a time range to zoom into", () => {
    const onZoomScaleChange = vi.fn();
    renderChart(timelineSample(), { onZoomScaleChange });
    const chartSvg = container.querySelector<SVGSVGElement>("svg.absolute")!;
    const width = Number(chartSvg.getAttribute("width") ?? "1000");
    const height = Number(chartSvg.getAttribute("height") ?? "400");
    vi.spyOn(chartSvg, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    });
    flushSync(() => {
      chartSvg.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: 260,
          bubbles: true,
          cancelable: true,
        }),
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: 520,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(container.querySelector("[data-testid='timeline-drag-selection']")).not.toBeNull();
    flushSync(() => {
      document.dispatchEvent(
        new MouseEvent("mouseup", {
          clientX: 520,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onZoomScaleChange).toHaveBeenCalled();
    expect(container.querySelector("[data-testid='timeline-drag-selection']")).toBeNull();
  });
});
