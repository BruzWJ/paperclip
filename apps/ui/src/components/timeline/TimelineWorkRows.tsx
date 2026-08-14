import {
  actorType,
  AXIS_H,
  barColor,
  isCancelledStatus,
  TIMELINE_COLORS,
  type Connector,
  type PositionedBar,
  type TimelineLayout,
} from "@/lib/timeline/layout";
import type { WorkTimelineActor } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import type { MouseEvent } from "react";
import { ActorGlyph } from "./TimelineActors";
import { AVATAR_R, CHIP_R, GEOM, svgFragmentId, truncate } from "./TimelineChartUtils";

interface TimelineWorkRowsProps {
  layout: TimelineLayout;
  connectors: Connector[];
  connectedRunIds: ReadonlySet<string> | null;
  companyId: string;
  onShowTooltip: (event: MouseEvent, bar: PositionedBar) => void;
  onClearTooltip: () => void;
}

export function TimelineWorkRows({
  layout,
  connectors,
  connectedRunIds,
  companyId,
  onShowTooltip,
  onClearTooltip,
}: TimelineWorkRowsProps) {
  return (
    <>
      {connectors.map((connector, index) => {
        const y1 = connector.y1 + AXIS_H;
        const y2 = connector.y2 + AXIS_H;
        const arrow =
          connector.x2 >= connector.x1
            ? `M${connector.x2},${y2} l-10,-5 l0,10 z`
            : `M${connector.x2},${y2} l10,-5 l0,10 z`;
        return (
          <g
            key={`edge-${connector.sourceRunId}-${connector.targetRunId}-${index}`}
            data-testid="timeline-connector"
            opacity={0.86}
          >
            <path
              d={`M${connector.x1},${y1} V${y2} H${connector.x2}`}
              fill="none"
              stroke="var(--color-foreground)"
              strokeWidth={2.2}
              strokeDasharray={connector.dashed ? "5 4" : undefined}
            />
            <circle cx={connector.x1} cy={y1} r={3.2} fill="var(--color-foreground)" />
            <path d={arrow} fill="var(--color-foreground)" />
          </g>
        );
      })}

      {layout.rows.map((row) => {
        const cy = row.y + AXIS_H + row.h / 2;
        const actorGlyphId = svgFragmentId(`plot-${row.actor.id}`);
        return (
          <g key={`row-${row.actor.id}`}>
            <ActorGlyph actor={row.actor} cx={26} cy={cy} r={AVATAR_R} clipId={actorGlyphId} />
            <text x={26 + AVATAR_R + 10} y={cy + 4} fontSize={13} fill="var(--color-foreground)">
              {truncate(row.actor.name, 18)}
            </text>

            {Array.from({ length: row.laneCount }).map((_, laneIndex) => {
              const laneY = row.y + AXIS_H + 6 + laneIndex * (GEOM.barH + GEOM.laneGap) + GEOM.barH / 2;
              return (
                <line
                  key={`lane-${row.actor.id}-${laneIndex}`}
                  x1={layout.gutter}
                  y1={laneY}
                  x2={layout.width - 8}
                  y2={laneY}
                  stroke="var(--color-border)"
                  strokeWidth={1}
                  strokeDasharray="2 4"
                  opacity={0.6}
                />
              );
            })}

            {row.bars.map((bar) => {
              const yTop = bar.yTop + AXIS_H;
              const width = bar.x2 - bar.x1;
              const cancelled = isCancelledStatus(bar.span.status);
              const color = barColor(bar);
              const connectedState =
                connectedRunIds == null
                  ? "idle"
                  : connectedRunIds.has(bar.span.runId)
                    ? "connected"
                    : "faded";
              const barOpacity = connectedState === "idle" ? 0.88 : connectedState === "connected" ? 1 : 0.22;
              const barGraphic = (
                <g
                  className={bar.span.taskId ? "cursor-pointer" : undefined}
                  data-run-id={bar.span.runId}
                  data-connected-state={connectedState}
                  onMouseEnter={(event) => onShowTooltip(event, bar)}
                  onMouseOver={(event) => onShowTooltip(event, bar)}
                  onMouseMove={(event) => onShowTooltip(event, bar)}
                  onMouseLeave={onClearTooltip}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <rect
                    x={bar.x1}
                    y={yTop}
                    width={width}
                    height={bar.height}
                    rx={3}
                    fill={cancelled ? "transparent" : color}
                    stroke={cancelled ? TIMELINE_COLORS.cancelled : "var(--color-foreground)"}
                    strokeWidth={1.5}
                    strokeDasharray={cancelled ? "4 3" : undefined}
                    opacity={barOpacity}
                  />
                  {bar.running && !cancelled && width > 8 && (
                    <rect
                      x={bar.x2 - Math.min(width - 2, 26)}
                      y={yTop + 1.5}
                      width={Math.min(width - 2, 26)}
                      height={bar.height - 3}
                      fill="url(#tl-fade)"
                    />
                  )}
                </g>
              );
              return (
                <g key={bar.span.runId} opacity={connectedState === "faded" ? 0.42 : 1}>
                  <Link
                    to="/$companyId/tasks/$taskNumber"
                    params={{
                      companyId,
                      taskNumber: String(bar.span.taskNumber),
                    }}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {barGraphic}
                  </Link>
                  {bar.kickoff && actorType(bar.kickoff) === "user" && (
                    <g className="pointer-events-none" data-testid="timeline-kickoff-chip">
                      <ActorGlyph
                        actor={bar.kickoff as WorkTimelineActor}
                        cx={bar.x1}
                        cy={yTop + bar.height / 2}
                        r={CHIP_R}
                        clipId={svgFragmentId(`kickoff-${bar.span.runId}-${bar.kickoff.id}`)}
                      />
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
    </>
  );
}
