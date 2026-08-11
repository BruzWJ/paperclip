import { useMemo } from "react";
import { Clock } from "lucide-react";
import type { Task } from "@paperclipai/shared";

import { InlineBanner } from "@/components/InlineBanner";
import { cn } from "@/lib/utils";
import {
  deriveMonitorState,
  formatMonitorAbsolute,
  formatMonitorEta,
  useMonitorCountdown,
  type DerivedMonitorState,
  type MonitorDisplayState,
} from "@/lib/task-monitor";

/** Matches the `Date | string` inputs accepted by the task-monitor helpers. */
type MonitorDate = Date | string;

/**
 * States in which the waiting-monitor surfaces (top banner + composer strip)
 * are shown. `cleared` and `none` hide both surfaces entirely — see
 * wireframe 04 (PAP-14557).
 */
const WAITING_STATES: readonly MonitorDisplayState[] = [
  "scheduled",
  "retrying",
  "due-now",
  "overdue",
];

export function isWaitingMonitorState(state: MonitorDisplayState): boolean {
  return WAITING_STATES.includes(state);
}

export function hasVisibleMonitorSurface(task: Task): boolean {
  const derived = deriveMonitorState(task);
  return isWaitingMonitorState(derived.state) && derived.nextCheckAt !== null;
}

export interface MonitorSurfaceCopy {
  /** Prominent lead for the top banner, e.g. "Monitor reminder — due in 2h 12m". */
  bannerTitle: string;
  /** Prominent lead for the composer strip, e.g. "Resumes in 2h 12m". */
  stripTitle: string;
  /** Muted detail line for the banner (absolute time carries a "(your time)" hint). */
  bannerMeta: string[];
  /** Muted detail line for the composer strip. */
  stripMeta: string[];
  /** `warning` (amber) once overdue, `info` (blue) while still on schedule. */
  tone: "info" | "warning";
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * Pure copy builder shared by the banner and the composer strip so both
 * surfaces render one consistent copy system (see wireframe 04). Kept free of
 * hooks/`Date.now()` so it is deterministic under test.
 */
export function buildMonitorSurfaceCopy(
  derived: DerivedMonitorState,
  now: MonitorDate,
): MonitorSurfaceCopy | null {
  if (!isWaitingMonitorState(derived.state) || !derived.nextCheckAt) return null;

  const eta = formatMonitorEta(derived.nextCheckAt, now); // "in 2h 12m" | "due now" | "overdue by 18m"
  const absolute = formatMonitorAbsolute(derived.nextCheckAt, {}, now); // local time, e.g. "Today, 4:08 PM"

  let bannerTitle: string;
  let stripTitle: string;
  let statusHint: string | null = null;
  switch (derived.state) {
    case "scheduled":
    case "retrying":
      bannerTitle = `Monitor reminder — due ${eta}`;
      stripTitle = `Due ${eta}`;
      break;
    case "due-now":
      bannerTitle = "Monitor reminder — due now";
      stripTitle = "Due now";
      break;
    case "overdue":
    default:
      bannerTitle = `Monitor reminder — ${eta}`;
      stripTitle = capitalize(eta);
      break;
  }

  const attemptLabel = derived.attemptCount >= 1 ? `Attempt ${derived.attemptCount}` : null;
  const serviceLabel = derived.serviceName ? `Watching: ${derived.serviceName}` : null;

  const bannerMeta = [statusHint, `${absolute} (your time)`, attemptLabel, serviceLabel].filter(
    (piece): piece is string => Boolean(piece),
  );
  const stripMeta = [statusHint, absolute, attemptLabel, serviceLabel].filter(
    (piece): piece is string => Boolean(piece),
  );

  return {
    bannerTitle,
    stripTitle,
    bannerMeta,
    stripMeta,
    tone: derived.state === "overdue" ? "warning" : "info",
  };
}

function useMonitorSurfaceCopy(task: Task): MonitorSurfaceCopy | null {
  // `nextCheckAt` is stable for a given task; derive once to seed the ticking
  // countdown cadence, then re-derive against the live clock so the surfaces
  // roll scheduled → due → overdue on their own.
  const nextCheckAt = useMemo(() => deriveMonitorState(task).nextCheckAt, [task]);
  const now = useMonitorCountdown(nextCheckAt);
  return useMemo(() => buildMonitorSurfaceCopy(deriveMonitorState(task, now), now), [task, now]);
}

export interface TaskMonitorSurfaceProps {
  task: Task;
}

/**
 * Pinned banner rendered between the task title and description while a
 * monitor reminder is active. Replaces the description-area "Monitor scheduled" card
 * for the waiting state (PAP-14557 decision 1) — the two never render at once.
 */
export function TaskMonitorBanner({ task }: TaskMonitorSurfaceProps) {
  const copy = useMonitorSurfaceCopy(task);
  if (!copy) return null;

  return (
    <InlineBanner
      tone={copy.tone}
      icon={Clock}
      title={copy.bannerTitle}
      className="my-3"
    >
      <span>{copy.bannerMeta.join("  ·  ")}</span>
    </InlineBanner>
  );
}

/**
 * Slim, inline (not sticky) strip anchored directly above the reply composer.
 * Mirrors the banner's monitor state and makes clear that only an explicit
 * agent mention queues execution (PAP-14557 decisions 2 +
 * wireframe 02).
 */
export function TaskMonitorComposerStrip({
  task,
  className,
}: TaskMonitorSurfaceProps & { className?: string }) {
  const copy = useMonitorSurfaceCopy(task);
  if (!copy) return null;

  return (
    <div
      role="note"
      data-testid="task-monitor-composer-strip"
      className={cn("rounded-lg border border-border bg-muted/30 px-3 py-2", className)}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{copy.stripTitle}</div>
            <div className="text-xs text-muted-foreground">{copy.stripMeta.join(" · ")}</div>
          </div>
        </div>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Use an explicit @mention to queue the agent; this reminder does not trigger a run.
      </p>
    </div>
  );
}
