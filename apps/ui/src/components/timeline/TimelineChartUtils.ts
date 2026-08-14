/**
 * Work Timeline — custom-SVG Gantt (board-locked Direction C, PAP-12422).
 *
 * Renders actor rows with concurrency sub-lanes, run bars (no task IDs on the
 * bar — identity is the thin left colour tab; truncated title shows on hover),
 * human kickoff chips at the first matching run's leading edge, straight
 * hover-revealed agent→agent delegation connectors (dashed for retries), an
 * in-progress fade to "now", a hover tooltip, and a full-window mini-map with a
 * draggable brush.
 */
import { computeLayout, type LayoutOptions } from "@/lib/timeline/layout";

export type ZoomLevel = "hour" | "day" | "week";

export interface VisibleTimelineWindow {
  fromMs: number;
  toMs: number;
}

const ZOOM_DURATION_MIN: Record<ZoomLevel, number> = {
  hour: 60,
  day: 24 * 60,
  week: 7 * 24 * 60,
};

const MIN_PX_PER_MIN = 0.08;

const MAX_PX_PER_MIN = 12;

const DEFAULT_VIEWPORT_W = 960;

export function plotViewportWidth(viewportWidth: number): number {
  return Math.max(240, viewportWidth - GEOM.gutter - 24);
}

export function clampTime(ms: number, fromMs: number, toMs: number): number {
  return Math.max(fromMs, Math.min(toMs, ms));
}

export function visibleWindowForScroll(
  layout: Pick<ReturnType<typeof computeLayout>, "fromMs" | "toMs" | "pxPerMinute">,
  scrollLeft: number,
  viewportWidth: number,
): VisibleTimelineWindow {
  const plotWidth = plotViewportWidth(viewportWidth);
  const fromMs = clampTime(
    layout.fromMs + (scrollLeft / layout.pxPerMinute) * 60000,
    layout.fromMs,
    layout.toMs,
  );
  const toMs = clampTime(
    layout.fromMs + ((scrollLeft + plotWidth) / layout.pxPerMinute) * 60000,
    layout.fromMs,
    layout.toMs,
  );
  return { fromMs, toMs: Math.max(fromMs, toMs) };
}

export function zoomScaleForLevel(level: ZoomLevel, viewportWidth = DEFAULT_VIEWPORT_W): number {
  return clampZoomScale(plotViewportWidth(viewportWidth) / ZOOM_DURATION_MIN[level]);
}

export function nearestZoomForScale(pxPerMinute: number, viewportWidth = DEFAULT_VIEWPORT_W): ZoomLevel {
  return (Object.entries(ZOOM_DURATION_MIN) as [ZoomLevel, number][]).reduce<ZoomLevel>(
    (best, [level]) =>
      Math.abs(zoomScaleForLevel(level, viewportWidth) - pxPerMinute) <
      Math.abs(zoomScaleForLevel(best, viewportWidth) - pxPerMinute)
        ? level
        : best,
    "day",
  );
}

export function clampZoomScale(pxPerMinute: number): number {
  return Math.min(MAX_PX_PER_MIN, Math.max(MIN_PX_PER_MIN, pxPerMinute));
}

/** Pick an initial zoom whose plotted width comfortably fills a typical viewport. */
export function defaultZoomForWindow(fromMs: number, toMs: number): ZoomLevel {
  const hours = (toMs - fromMs) / 3_600_000;
  if (hours <= 4) return "hour";
  if (hours <= 48) return "day";
  return "week";
}

export const GEOM: Omit<LayoutOptions, "pxPerMinute" | "nowMs"> = {
  gutter: 176,
  rowH: 34,
  barH: 15,
  laneGap: 4,
};

export const AVATAR_R = 11;

export const CHIP_R = 9;

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const hasMinutes = d.getMinutes() !== 0;
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: hasMinutes ? "2-digit" : undefined,
    hour12: true,
  });
}

export function fmtTick(ms: number, stepMs: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  if (stepMs >= 24 * 60 * 60 * 1000) {
    return date;
  }
  return `${date}, ${fmtClock(ms)}`;
}

export function formatVisibleDurationMinutes(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded >= 7 * 24 * 60 && rounded % (7 * 24 * 60) === 0) {
    const weeks = rounded / (7 * 24 * 60);
    return `${weeks} week${weeks === 1 ? "" : "s"} visible`;
  }
  if (rounded >= 24 * 60 && rounded % (24 * 60) === 0) {
    const days = rounded / (24 * 60);
    return `${days} day${days === 1 ? "" : "s"} visible`;
  }
  if (rounded >= 24 * 60) {
    const days = Math.floor(rounded / (24 * 60));
    const hours = Math.round((rounded % (24 * 60)) / 60);
    return `${days}d${hours > 0 ? ` ${hours}h` : ""} visible`;
  }
  if (rounded >= 60 && rounded % 60 === 0) {
    const hours = rounded / 60;
    return `${hours} hour${hours === 1 ? "" : "s"} visible`;
  }
  if (rounded >= 60) return `${Math.floor(rounded / 60)}h ${rounded % 60}m visible`;
  return `${rounded} minutes visible`;
}

export function truncate(text: string, n = 42): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

export function svgFragmentId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
