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
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import {
  AXIS_H,
  chooseTickStepMs,
  computeLayout,
  TIMELINE_COLORS,
  type PositionedBar,
} from "@/lib/timeline/layout";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  clampZoomScale,
  formatVisibleDurationMinutes,
  GEOM,
  nearestZoomForScale,
  plotViewportWidth,
  visibleWindowForScroll,
  zoomScaleForLevel,
  type VisibleTimelineWindow,
  type ZoomLevel,
} from "./TimelineChartUtils";

import { ActorGutter } from "./TimelineActors";

import { TimeAxisOverlay, Tooltip } from "./TimelineOverlays";

import { MiniMap } from "./TimelineMiniMap";
import { TimelineWorkRows } from "./TimelineWorkRows";

const DEFAULT_VIEWPORT_W = 960;

const MIN_MINIMAP_SELECTION_MS = 15 * 60 * 1000;

interface TooltipState {
  x: number;
  y: number;
  bar: PositionedBar;
  connectorHint: string | null;
}

interface DragSelectionState {
  anchorX: number;
  currentX: number;
}

export interface WorkTimelineChartProps {
  data: WorkTimelineResult;
  zoom: ZoomLevel;
  zoomScale?: number;
  onZoomScaleChange?: (nextScale: number, nextZoom: ZoomLevel) => void;
  onVisibleRangeLabelChange?: (label: string) => void;
  onVisibleWindowChange?: (window: VisibleTimelineWindow) => void;
  /** override "now" (tests / stories); defaults to Date.now(). */
  nowMs?: number;
}

export function WorkTimelineChart({
  data,
  zoom,
  zoomScale,
  onZoomScaleChange,
  onVisibleRangeLabelChange,
  onVisibleWindowChange,
  nowMs,
}: WorkTimelineChartProps) {
  const companyId = useCompanyRouteId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialWindowKeyRef = useRef<string | null>(null);
  const centerMsRef = useRef<number | null>(null);
  const defaultNowRef = useRef<number | null>(null);
  const documentDragCleanupRef = useRef<(() => void) | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [hoveredRunId, setHoveredRunId] = useState<string | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  const [dragSelection, setDragSelection] = useState<DragSelectionState | null>(null);

  const clearDocumentDrag = () => {
    documentDragCleanupRef.current?.();
    documentDragCleanupRef.current = null;
  };

  const setDocumentDrag = (move: (event: MouseEvent) => void, up: (event: MouseEvent) => void) => {
    clearDocumentDrag();
    const handleUp = (event: MouseEvent) => {
      clearDocumentDrag();
      up(event);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", handleUp);
    documentDragCleanupRef.current = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", handleUp);
    };
  };

  useEffect(() => () => clearDocumentDrag(), []);

  if (defaultNowRef.current == null) defaultNowRef.current = Date.now();
  const now = nowMs ?? defaultNowRef.current;
  const pxPerMinute = zoomScale ?? zoomScaleForLevel(zoom, viewportW || DEFAULT_VIEWPORT_W);
  const layout = useMemo(
    () => computeLayout(data, { ...GEOM, pxPerMinute, nowMs: now }),
    [data, pxPerMinute, now],
  );
  const connectedRunIds = useMemo(() => {
    if (!hoveredRunId) return null;
    const connected = new Set([hoveredRunId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of layout.connectors) {
        if (connected.has(c.sourceRunId) && !connected.has(c.targetRunId)) {
          connected.add(c.targetRunId);
          changed = true;
        }
        if (connected.has(c.targetRunId) && !connected.has(c.sourceRunId)) {
          connected.add(c.sourceRunId);
          changed = true;
        }
      }
    }
    return connected;
  }, [hoveredRunId, layout.connectors]);
  const visibleConnectors = useMemo(
    () =>
      connectedRunIds
        ? layout.connectors.filter(
            (c) => connectedRunIds.has(c.sourceRunId) && connectedRunIds.has(c.targetRunId),
          )
        : [],
    [connectedRunIds, layout.connectors],
  );

  const timeToScrollLeft = (ms: number, viewportWidth: number) => {
    const x = layout.gutter + ((ms - layout.fromMs) / 60000) * layout.pxPerMinute;
    return Math.max(0, Math.min(layout.width - viewportWidth, x - viewportWidth / 2));
  };

  const scrollCenterMs = (el: HTMLDivElement) => {
    const centerX = el.scrollLeft + el.clientWidth / 2;
    return layout.fromMs + ((centerX - layout.gutter) / layout.pxPerMinute) * 60000;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nextViewportW = el.clientWidth;
    if (nextViewportW > 0 && nextViewportW !== viewportW) setViewportW(nextViewportW);

    const windowKey = `${data.window.from}:${data.window.to}`;
    if (initialWindowKeyRef.current !== windowKey) {
      initialWindowKeyRef.current = windowKey;
      const latest = Math.max(0, layout.width - nextViewportW);
      el.scrollLeft = latest;
      setScrollLeft(latest);
      centerMsRef.current = scrollCenterMs(el);
      return;
    }

    if (centerMsRef.current != null) {
      const next = timeToScrollLeft(centerMsRef.current, nextViewportW);
      el.scrollLeft = next;
      setScrollLeft(next);
    }
  }, [
    data.window.from,
    data.window.to,
    layout.fromMs,
    layout.gutter,
    layout.pxPerMinute,
    layout.toMs,
    layout.width,
    viewportW,
  ]);

  useEffect(() => {
    if (!onVisibleRangeLabelChange) return;
    const effectiveViewportW = viewportW || DEFAULT_VIEWPORT_W;
    const minutes = plotViewportWidth(effectiveViewportW) / layout.pxPerMinute;
    onVisibleRangeLabelChange(formatVisibleDurationMinutes(minutes));
  }, [layout.pxPerMinute, onVisibleRangeLabelChange, viewportW]);

  useEffect(() => {
    if (!onVisibleWindowChange || viewportW <= 0) return;
    onVisibleWindowChange(visibleWindowForScroll(layout, scrollLeft, viewportW));
  }, [layout.fromMs, layout.toMs, layout.pxPerMinute, onVisibleWindowChange, scrollLeft, viewportW]);

  const stepMs = chooseTickStepMs(layout.pxPerMinute);
  const ticks: number[] = [];
  const startTick = Math.ceil(layout.fromMs / stepMs) * stepMs;
  for (let ms = startTick; ms <= layout.toMs; ms += stepMs) ticks.push(ms);

  const updateVisibleRange = (fromMs: number, toMs: number) => {
    if (!onZoomScaleChange) return;
    const el = scrollRef.current;
    const boundedFrom = Math.max(layout.fromMs, Math.min(layout.toMs, fromMs));
    const boundedTo = Math.max(layout.fromMs, Math.min(layout.toMs, toMs));
    const startMs = Math.min(boundedFrom, boundedTo);
    const endMs = Math.max(boundedFrom, boundedTo);
    const durationMs = Math.max(MIN_MINIMAP_SELECTION_MS, endMs - startMs);
    const centerMs = startMs + durationMs / 2;
    const effectiveViewportW = el?.clientWidth || viewportW || DEFAULT_VIEWPORT_W;
    const nextScale = clampZoomScale(plotViewportWidth(effectiveViewportW) / (durationMs / 60000));
    centerMsRef.current = centerMs;
    onZoomScaleChange(nextScale, nearestZoomForScale(nextScale, effectiveViewportW));
  };

  const svgXFromClientX = (clientX: number, el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return layout.gutter;
    const x = ((clientX - rect.left) / rect.width) * layout.width;
    return Math.max(layout.gutter, Math.min(layout.width - 40, x));
  };

  const msFromSvgX = (x: number) => layout.fromMs + ((x - layout.gutter) / layout.pxPerMinute) * 60000;

  const handlePlotMouseDown = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!onZoomScaleChange || event.button !== 0) return;
    const el = event.currentTarget;
    const startX = svgXFromClientX(event.clientX, el);
    event.preventDefault();
    setTooltip(null);
    setHoveredRunId(null);
    setDragSelection({ anchorX: startX, currentX: startX });

    const move = (moveEvent: MouseEvent) => {
      setDragSelection(
        (prev) =>
          prev && {
            ...prev,
            currentX: svgXFromClientX(moveEvent.clientX, el),
          },
      );
    };
    const up = (upEvent: MouseEvent) => {
      const endX = svgXFromClientX(upEvent.clientX, el);
      setDragSelection(null);
      if (Math.abs(endX - startX) < 8) return;
      const fromMs = Math.min(msFromSvgX(startX), msFromSvgX(endX));
      const toMs = Math.max(msFromSvgX(startX), msFromSvgX(endX));
      updateVisibleRange(fromMs, toMs);
    };
    setDocumentDrag(move, up);
  };

  const connectorHintForBar = (bar: PositionedBar): string | null => {
    const related = layout.connectors.filter(
      (c) => c.sourceRunId === bar.span.runId || c.targetRunId === bar.span.runId,
    );
    if (related.length === 0) return null;
    return related.some((c) => c.dashed)
      ? "dashed transition: retry or changes requested"
      : "solid transition: delegation or assignment";
  };

  const showTooltip = (evt: React.MouseEvent, bar: PositionedBar) => {
    setHoveredRunId(bar.span.runId);
    setTooltip({
      x: evt.clientX,
      y: evt.clientY,
      bar,
      connectorHint: connectorHintForBar(bar),
    });
  };

  const handleWheel = (evt: React.WheelEvent<HTMLDivElement>) => {
    if (!onZoomScaleChange || !(evt.ctrlKey || evt.metaKey || evt.altKey)) return;
    evt.preventDefault();
    const el = scrollRef.current;
    if (el) {
      centerMsRef.current = scrollCenterMs(el);
    }
    const nextScale = clampZoomScale(layout.pxPerMinute * Math.exp(-evt.deltaY * 0.001));
    onZoomScaleChange(nextScale, nearestZoomForScale(nextScale, el?.clientWidth ?? viewportW));
  };

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="max-h-(--sz-70vh) overflow-auto"
        data-testid="work-timeline-scroll"
        onScroll={(e) => {
          setScrollLeft(e.currentTarget.scrollLeft);
          centerMsRef.current = scrollCenterMs(e.currentTarget);
        }}
        onWheel={handleWheel}
      >
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <ActorGutter rows={layout.rows} height={layout.height} />

          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="absolute inset-0 block select-none"
            onMouseDown={handlePlotMouseDown}
            ref={(el) => {
              if (el && viewportW === 0 && scrollRef.current) setViewportW(scrollRef.current.clientWidth);
            }}
          >
            <defs>
              <linearGradient id="tl-fade" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--color-foreground)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--color-foreground)" stopOpacity={0} />
              </linearGradient>
            </defs>

            {/* row backgrounds */}
            {layout.rows.map((row, i) => (
              <rect
                key={`bg-${row.actor.id}`}
                x={0}
                y={row.y + AXIS_H}
                width={layout.width}
                height={row.h}
                fill={i % 2 ? "var(--color-muted)" : "transparent"}
                opacity={i % 2 ? 0.35 : 1}
              />
            ))}

            {/* vertical gridlines */}
            {ticks.map((ms) => {
              const gx = layout.gutter + ((ms - layout.fromMs) / 60000) * layout.pxPerMinute;
              return (
                <g key={`tick-${ms}`}>
                  <line
                    x1={gx}
                    y1={AXIS_H}
                    x2={gx}
                    y2={layout.height}
                    stroke="var(--color-border)"
                    strokeWidth={1}
                  />
                </g>
              );
            })}

            {/* now line — status-blue "Signal" present marker (gallery r2; was teal) */}
            {now >= layout.fromMs && now <= layout.toMs && (
              <line
                x1={layout.gutter + ((now - layout.fromMs) / 60000) * layout.pxPerMinute}
                y1={AXIS_H}
                x2={layout.gutter + ((now - layout.fromMs) / 60000) * layout.pxPerMinute}
                y2={layout.height}
                stroke={TIMELINE_COLORS.now}
                strokeWidth={1.5}
                strokeDasharray="2 3"
                opacity={0.9}
              />
            )}

            {/* gutter divider + axis baseline */}
            <line
              x1={layout.gutter}
              y1={0}
              x2={layout.gutter}
              y2={layout.height}
              stroke="var(--color-foreground)"
              strokeWidth={1.5}
            />
            <line
              x1={0}
              y1={AXIS_H}
              x2={layout.width}
              y2={AXIS_H}
              stroke="var(--color-foreground)"
              strokeWidth={1.5}
            />

            <TimelineWorkRows
              layout={layout}
              connectors={visibleConnectors}
              connectedRunIds={connectedRunIds}
              companyId={companyId}
              onShowTooltip={showTooltip}
              onClearTooltip={() => {
                setTooltip(null);
                setHoveredRunId(null);
              }}
            />
            {dragSelection && (
              <rect
                data-testid="timeline-drag-selection"
                x={Math.min(dragSelection.anchorX, dragSelection.currentX)}
                y={AXIS_H}
                width={Math.abs(dragSelection.currentX - dragSelection.anchorX)}
                height={layout.height - AXIS_H}
                fill="var(--color-primary)"
                opacity={0.16}
                stroke="var(--color-primary)"
                strokeWidth={1.5}
                pointerEvents="none"
              />
            )}
          </svg>
        </div>
      </div>

      <TimeAxisOverlay layout={layout} ticks={ticks} stepMs={stepMs} scrollLeft={scrollLeft} />

      <MiniMap
        layout={layout}
        scrollRef={scrollRef}
        viewportW={viewportW}
        scrollLeft={scrollLeft}
        onVisibleRangeChange={updateVisibleRange}
      />

      {tooltip && <Tooltip tooltip={tooltip} now={now} />}
    </div>
  );
}

export * from "./TimelineActors";
export * from "./TimelineChartUtils";
export * from "./TimelineMiniMap";
export * from "./TimelineOverlays";
