import { useMemo } from "react";
import { Clock } from "lucide-react";
import type { Task } from "@paperclipai/shared";

import { Banner, BannerIcon, BannerTitle } from "@/components/kibo-ui/banner";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import {
  deriveMonitorState,
  formatMonitorAbsolute,
  formatMonitorEta,
  useMonitorCountdown,
  type DerivedMonitorState,
  type MonitorDate,
  type MonitorDisplayState,
} from "@/lib/task-monitor";

/**
 * States in which the waiting-monitor banner is shown.
 */
const WAITING_STATES: readonly MonitorDisplayState[] = ["scheduled", "retrying", "due-now", "overdue"];

function isWaitingMonitorState(state: MonitorDisplayState): boolean {
  return WAITING_STATES.includes(state);
}

interface MonitorSurfaceCopy {
  bannerTitle: string;
  bannerMeta: string[];
  tone: "info" | "warning";
}

/**
 * Pure copy builder kept free of hooks/`Date.now()` so it is deterministic under test.
 */
export function buildMonitorSurfaceCopy(
  derived: DerivedMonitorState,
  now: MonitorDate,
): MonitorSurfaceCopy | null {
  if (!isWaitingMonitorState(derived.state) || !derived.nextCheckAt) return null;

  const eta = formatMonitorEta(derived.nextCheckAt, now); // "in 2h 12m" | "due now" | "overdue by 18m"
  const absolute = formatMonitorAbsolute(derived.nextCheckAt, {}, now); // local time, e.g. "Today, 4:08 PM"

  let bannerTitle: string;
  switch (derived.state) {
    case "scheduled":
    case "retrying":
      bannerTitle = `Monitor reminder — due ${eta}`;
      break;
    case "due-now":
      bannerTitle = "Monitor reminder — due now";
      break;
    case "overdue":
    default:
      bannerTitle = `Monitor reminder — ${eta}`;
      break;
  }

  const attemptLabel = derived.attemptCount >= 1 ? `Attempt ${derived.attemptCount}` : null;
  const serviceLabel = derived.serviceName ? `Watching: ${derived.serviceName}` : null;

  const bannerMeta = [`${absolute} (your time)`, attemptLabel, serviceLabel].filter(
    (piece): piece is string => Boolean(piece),
  );

  return {
    bannerTitle,
    bannerMeta,
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

interface TaskMonitorSurfaceProps {
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
    <Banner role="note" className="my-3" inset>
      <BannerIcon icon={Clock} />
      <BannerTitle>
        <span className="block font-medium">{copy.bannerTitle}</span>
        <span className="block text-xs opacity-80">{copy.bannerMeta.join("  ·  ")}</span>
      </BannerTitle>
      <DomainStatus status={copy.tone}>{copy.tone === "warning" ? "Overdue" : "Scheduled"}</DomainStatus>
    </Banner>
  );
}
