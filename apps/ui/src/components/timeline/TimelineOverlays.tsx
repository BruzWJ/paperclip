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
import { AXIS_H, computeLayout, formatDuration, type PositionedBar } from "@/lib/timeline/layout";
import type { WorkTimelineActor } from "@paperclipai/shared";

import { fmtClock, fmtTick, truncate } from "./TimelineChartUtils";

interface TooltipState {
  x: number;
  y: number;
  bar: PositionedBar;
  connectorHint: string | null;
}

export function TimeAxisOverlay({
  layout,
  ticks,
  stepMs,
  scrollLeft,
}: {
  layout: ReturnType<typeof computeLayout>;
  ticks: number[];
  stepMs: number;
  scrollLeft: number;
}) {
  return (
    <div
      aria-hidden="true"
      data-testid="work-timeline-time-axis"
      className="pointer-events-none absolute left-0 right-0 top-0 z-30 overflow-hidden bg-card"
      style={{ height: AXIS_H }}
    >
      <svg
        width={layout.width}
        height={AXIS_H}
        viewBox={`0 0 ${layout.width} ${AXIS_H}`}
        className="block"
        style={{ transform: `translateX(${-scrollLeft}px)` }}
      >
        <rect x={0} y={0} width={layout.width} height={AXIS_H} fill="var(--color-card)" />
        {ticks.map((ms) => {
          const gx = layout.gutter + ((ms - layout.fromMs) / 60000) * layout.pxPerMinute;
          return (
            <g key={`axis-tick-${ms}`}>
              <line
                x1={gx}
                y1={AXIS_H - 7}
                x2={gx}
                y2={AXIS_H}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
              <text x={gx + 3} y={19} fontSize={11} fill="var(--color-muted-foreground)">
                {fmtTick(ms, stepMs)}
              </text>
            </g>
          );
        })}
        <line
          x1={0}
          y1={AXIS_H}
          x2={layout.width}
          y2={AXIS_H}
          stroke="var(--color-foreground)"
          strokeWidth={1.5}
        />
      </svg>
      <svg
        width={layout.gutter}
        height={AXIS_H}
        viewBox={`0 0 ${layout.gutter} ${AXIS_H}`}
        className="absolute left-0 top-0 block bg-card"
      >
        <rect x={0} y={0} width={layout.gutter} height={AXIS_H} fill="var(--color-card)" />
        <line
          x1={layout.gutter}
          y1={0}
          x2={layout.gutter}
          y2={AXIS_H}
          stroke="var(--color-foreground)"
          strokeWidth={1.5}
        />
        <line
          x1={0}
          y1={AXIS_H}
          x2={layout.gutter}
          y2={AXIS_H}
          stroke="var(--color-foreground)"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}

export function Tooltip({ tooltip, now }: { tooltip: TooltipState; now: number }) {
  const { bar } = tooltip;
  const startMs = new Date(bar.span.start).getTime();
  const endMs = bar.span.end ? new Date(bar.span.end).getTime() : now;
  const title = bar.span.taskTitle ?? bar.span.taskIdentifier;
  const left = Math.min(tooltip.x + 14, (typeof window !== "undefined" ? window.innerWidth : 1200) - 300);
  return (
    <div
      // design-allow(card-pattern): floating cursor-follow chart tooltip, not a content card (C5a Run 3)
      className="pointer-events-none fixed z-50 max-w-(--sz-280px) rounded-md border border-foreground bg-card px-2.5 py-2 text-xs shadow-md"
      style={{ left, top: tooltip.y + 14 }}
    >
      <div className="text-(length:--text-compact) font-medium text-foreground">{truncate(title)}</div>
      <div className="mt-0.5 text-muted-foreground">
        {fmtClock(startMs)}–{bar.span.end ? fmtClock(endMs) : "now"} · {formatDuration(startMs, endMs)} ·{" "}
        <span className="font-medium text-foreground">{bar.span.status}</span>
      </div>
      {bar.kickoff && (
        <div className="text-muted-foreground">
          kicked off by: {(bar.kickoff as WorkTimelineActor).name}
          {bar.span.retryOfRunId ? " · retry" : ""}
        </div>
      )}
      {tooltip.connectorHint && <div className="text-muted-foreground">{tooltip.connectorHint}</div>}
    </div>
  );
}
