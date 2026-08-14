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
import { getAgentIcon } from "@/lib/agent-icons";
import { AXIS_H, computeLayout, shortLabel } from "@/lib/timeline/layout";
import type { WorkTimelineActor } from "@paperclipai/shared";

import { AVATAR_R, GEOM, svgFragmentId, truncate } from "./TimelineChartUtils";

/** An SVG avatar glyph: agents use their configured sidebar icon, humans use their avatar image. */
export function ActorGlyph({
  actor,
  cx,
  cy,
  r,
  clipId,
}: {
  actor: WorkTimelineActor;
  cx: number;
  cy: number;
  r: number;
  clipId: string;
}) {
  if (actor.type === "agent") {
    const Icon = getAgentIcon(actor.avatar);
    const size = r > 10 ? 16 : 13;
    return (
      <Icon
        data-testid="timeline-agent-icon"
        x={cx - size / 2}
        y={cy - size / 2}
        width={size}
        height={size}
        strokeWidth={2.2}
        color="var(--color-muted-foreground)"
      />
    );
  }

  const stroke = "var(--color-foreground)";
  const fill = actor.type === "system" ? "var(--color-muted)" : "var(--color-card)";
  const label = shortLabel(actor.name);

  if (actor.type === "user" && actor.avatar) {
    return (
      <g>
        <defs>
          <clipPath id={clipId}>
            <circle cx={cx} cy={cy} r={r} />
          </clipPath>
        </defs>
        <image
          data-testid="timeline-user-avatar-image"
          href={actor.avatar}
          x={cx - r}
          y={cy - r}
          width={2 * r}
          height={2 * r}
          preserveAspectRatio="xMidYMid slice"
          clipPath={`url(#${clipId})`}
        />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={stroke} strokeWidth={1.2} opacity={0.5} />
      </g>
    );
  }

  return (
    <g>
      {actor.type === "user" ? (
        <rect
          x={cx - r}
          y={cy - r}
          width={2 * r}
          height={2 * r}
          rx={3}
          fill={fill}
          stroke={stroke}
          strokeWidth={1.5}
        />
      ) : (
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill={fill}
          stroke={stroke}
          strokeWidth={1.5}
          strokeDasharray={actor.type === "system" ? "3 2" : undefined}
        />
      )}
      <text x={cx} y={cy + 3.4} fontSize={r > 10 ? 9 : 8} textAnchor="middle" fill={stroke}>
        {label}
      </text>
    </g>
  );
}

export function ActorGutter({
  rows,
  height,
}: {
  rows: ReturnType<typeof computeLayout>["rows"];
  height: number;
}) {
  return (
    <svg
      aria-hidden="true"
      data-testid="work-timeline-actor-gutter"
      width={GEOM.gutter}
      height={height}
      viewBox={`0 0 ${GEOM.gutter} ${height}`}
      className="sticky left-0 z-20 block bg-card"
    >
      <rect x={0} y={0} width={GEOM.gutter} height={height} fill="var(--color-card)" />
      {rows.map((row, i) => {
        const cy = row.y + AXIS_H + row.h / 2;
        const actorGlyphId = svgFragmentId(`gutter-${row.actor.id}`);
        return (
          <g key={`gutter-${row.actor.id}`}>
            <rect
              x={0}
              y={row.y + AXIS_H}
              width={GEOM.gutter}
              height={row.h}
              fill={i % 2 ? "var(--color-muted)" : "var(--color-card)"}
              opacity={i % 2 ? 0.35 : 1}
            />
            <ActorGlyph actor={row.actor} cx={26} cy={cy} r={AVATAR_R} clipId={actorGlyphId} />
            <text x={26 + AVATAR_R + 10} y={cy + 4} fontSize={13} fill="var(--color-foreground)">
              {truncate(row.actor.name, 16)}
            </text>
          </g>
        );
      })}
      <line
        x1={GEOM.gutter}
        y1={0}
        x2={GEOM.gutter}
        y2={height}
        stroke="var(--color-foreground)"
        strokeWidth={1.5}
      />
      <line
        x1={0}
        y1={AXIS_H}
        x2={GEOM.gutter}
        y2={AXIS_H}
        stroke="var(--color-foreground)"
        strokeWidth={1.5}
      />
    </svg>
  );
}
