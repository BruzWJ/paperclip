import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { barColor, computeLayout, isCancelledStatus, TIMELINE_COLORS } from "@/lib/timeline/layout";
import { useRef, type PointerEvent } from "react";
import { visibleWindowForScroll } from "./TimelineChartUtils";

const MIN_MINIMAP_SELECTION_MS = 15 * 60 * 1000;
const SLIDER_STEP_MS = 60 * 1000;
const KEYBOARD_PAN_MS = 5 * 60 * 1000;

export function MiniMap({
  layout,
  scrollRef,
  viewportW,
  scrollLeft,
  onVisibleRangeChange,
}: {
  layout: ReturnType<typeof computeLayout>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  viewportW: number;
  scrollLeft: number;
  onVisibleRangeChange: (fromMs: number, toMs: number) => void;
}) {
  const width = Math.max(320, viewportW || 900);
  const height = 54;
  const padding = 8;
  const spanMs = layout.toMs - layout.fromMs || 1;
  const drawableWidth = width - 2 * padding;
  const xForMs = (ms: number) => padding + ((ms - layout.fromMs) / spanMs) * drawableWidth;
  const rowIndex = new Map(layout.rows.map((row, index) => [row.actor.id, index]));
  const laneHeight = (height - 2 * padding) / Math.max(1, layout.rows.length);
  const effectiveViewportWidth = viewportW || width;
  const effectiveScrollLeft = Math.min(scrollLeft, Math.max(0, layout.width - effectiveViewportWidth));
  const visibleWindow = visibleWindowForScroll(layout, effectiveScrollLeft, effectiveViewportWidth);
  const selection: [number, number] = [
    Math.max(layout.fromMs, visibleWindow.fromMs),
    Math.min(layout.toMs, visibleWindow.toMs),
  ];
  const selectionDuration = Math.max(MIN_MINIMAP_SELECTION_MS, selection[1] - selection[0]);
  const selectionLeft = ((selection[0] - layout.fromMs) / spanMs) * 100;
  const selectionWidth = ((selection[1] - selection[0]) / spanMs) * 100;
  const panDragRef = useRef<{
    startClientX: number;
    fromMs: number;
    toMs: number;
  } | null>(null);

  const moveSelection = (deltaMs: number) => {
    const fromMs = Math.max(layout.fromMs, Math.min(layout.toMs - selectionDuration, selection[0] + deltaMs));
    onVisibleRangeChange(fromMs, fromMs + selectionDuration);
  };

  const seek = (clientX: number, track: HTMLElement) => {
    const rect = track.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    const centerMs = layout.fromMs + fraction * spanMs;
    if (!scrollRef.current) return;
    scrollRef.current.scrollLeft =
      layout.gutter +
      ((centerMs - layout.fromMs) / 60000) * layout.pxPerMinute -
      scrollRef.current.clientWidth / 2;
  };

  const handlePanMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!panDragRef.current) return;
    const track = event.currentTarget.parentElement;
    if (!track) return;
    const deltaMs =
      ((event.clientX - panDragRef.current.startClientX) / Math.max(1, track.getBoundingClientRect().width)) *
      spanMs;
    const duration = panDragRef.current.toMs - panDragRef.current.fromMs;
    const fromMs = Math.max(
      layout.fromMs,
      Math.min(layout.toMs - duration, panDragRef.current.fromMs + deltaMs),
    );
    onVisibleRangeChange(fromMs, fromMs + duration);
  };

  return (
    <div className="mt-2 border-t border-border bg-card px-3.5 py-2">
      <div className="relative" style={{ width, height }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="pointer-events-none block"
          aria-hidden="true"
        >
          <rect
            x={0}
            y={0}
            width={width}
            height={height}
            fill="var(--color-card)"
            stroke="var(--color-foreground)"
            strokeWidth={1.5}
          />
          {layout.rows.flatMap((row) =>
            row.bars.map((bar) => {
              const startMs = new Date(bar.span.start).getTime();
              const endMs = bar.span.end ? new Date(bar.span.end).getTime() : layout.toMs;
              const y = padding + (rowIndex.get(row.actor.id) ?? 0) * laneHeight;
              const cancelled = isCancelledStatus(bar.span.status);
              return (
                <rect
                  key={`mm-${bar.span.runId}`}
                  x={xForMs(startMs)}
                  y={y + 1}
                  width={Math.max(2, xForMs(endMs) - xForMs(startMs))}
                  height={Math.max(2, laneHeight - 2)}
                  fill={cancelled ? TIMELINE_COLORS.cancelled : barColor(bar)}
                  opacity={cancelled ? 0.5 : 1}
                />
              );
            }),
          )}
        </svg>

        <div
          data-minimap-track=""
          className="absolute inset-y-0"
          style={{ left: padding, width: drawableWidth }}
        >
          <Slider
            aria-label="Visible timeline range"
            min={layout.fromMs}
            max={layout.toMs}
            step={SLIDER_STEP_MS}
            minStepsBetweenThumbs={MIN_MINIMAP_SELECTION_MS / SLIDER_STEP_MS}
            value={selection}
            onValueChange={(value) => {
              const [fromMs, toMs] = value;
              if (fromMs !== undefined && toMs !== undefined) {
                onVisibleRangeChange(fromMs, toMs);
              }
            }}
            onPointerDownCapture={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest("[data-slot=slider-thumb]")) return;
              event.preventDefault();
              seek(event.clientX, event.currentTarget);
            }}
            className="absolute inset-0 h-full [&_[data-slot=slider-range]]:border-y [&_[data-slot=slider-range]]:border-foreground/50 [&_[data-slot=slider-range]]:bg-foreground/10 [&_[data-slot=slider-thumb]]:relative [&_[data-slot=slider-thumb]]:z-20 [&_[data-slot=slider-thumb]]:h-full [&_[data-slot=slider-thumb]]:w-3 [&_[data-slot=slider-thumb]]:cursor-col-resize [&_[data-slot=slider-thumb]]:rounded-sm [&_[data-slot=slider-thumb]]:border-foreground [&_[data-slot=slider-thumb]]:bg-background/80 [&_[data-slot=slider-track]]:h-full [&_[data-slot=slider-track]]:overflow-visible [&_[data-slot=slider-track]]:rounded-none [&_[data-slot=slider-track]]:bg-transparent"
          />
          <Button
            type="button"
            data-testid="timeline-minimap-selection"
            variant="ghost"
            aria-label="Move visible timeline range"
            className="absolute inset-y-0 z-10 h-full cursor-grab rounded-none bg-transparent p-0 active:cursor-grabbing"
            style={{ left: `${selectionLeft}%`, width: `${selectionWidth}%` }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              panDragRef.current = {
                startClientX: event.clientX,
                fromMs: selection[0],
                toMs: selection[1],
              };
            }}
            onPointerMove={handlePanMove}
            onPointerUp={() => {
              panDragRef.current = null;
            }}
            onPointerCancel={() => {
              panDragRef.current = null;
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              moveSelection(event.key === "ArrowLeft" ? -KEYBOARD_PAN_MS : KEYBOARD_PAN_MS);
            }}
          />
        </div>
      </div>
    </div>
  );
}
