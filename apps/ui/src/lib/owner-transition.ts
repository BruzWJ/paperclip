export type { TaskOwnerReference as TimelineOwnerLike } from "@/lib/presentation-contracts";

// --- Standalone owner picker interrupt (PAP-10675, design surface 2) ----------

export interface OwnerChangeInterruptCopy {
  /** `role=status` banner shown while a run is live and the picker is open. */
  banner: string;
  /** Heading for the interrupt-and-change-owner confirm step. */
  confirmTitle: string;
  /** Primary action label for the confirm step. */
  confirmAction: string;
  /** Label for backing out of the confirm step. */
  cancelAction: string;
}

/**
 * Copy for the owner picker's live-run states: a banner warning that an
 * in-flight run will be interrupted, and the confirm step shown when the
 * operator picks a different owner mid-run. Naming the running agent keeps
 * the interrupt consequence concrete instead of a bare "are you sure".
 */
export function describeOwnerChangeInterrupt(
  opts: { runningAgentName?: string | null } = {},
): OwnerChangeInterruptCopy {
  const who = opts.runningAgentName?.trim() || "An agent";
  return {
    banner: `${who} is running — changing the owner will interrupt this run.`,
    confirmTitle: "Interrupt the current run?",
    confirmAction: "Interrupt & change owner",
    cancelAction: "Cancel",
  };
}

// --- Pause/hold "What this affects" buckets (PAP-10675, design surface 4) ------

type PauseAffectsBucketKey = "live_runs" | "queued_runs" | "inactive";

interface PauseAffectsTaskLike {
  activeRun: { status: "queued" | "running" } | null;
  skipped?: boolean;
}

interface PauseAffectsBucket {
  key: PauseAffectsBucketKey;
  label: string;
  count: number;
  /** One-line clarifier of what pausing does to this bucket. */
  detail: string;
}

export interface PauseAffectsSummary {
  buckets: PauseAffectsBucket[];
  /** Total non-skipped tasks the operation affects. */
  affectedTaskCount: number;
  /** True when no run is live or queued — there is nothing to interrupt. */
  nothingLive: boolean;
}

const PAUSE_BUCKET_LABEL: Record<PauseAffectsBucketKey, string> = {
  live_runs: "Live agent runs",
  queued_runs: "Queued runs",
  inactive: "No active run",
};

const PAUSE_BUCKET_DETAIL: Record<PauseAffectsBucketKey, string> = {
  live_runs: "interrupted now; transmitted prompts are not replayed",
  queued_runs: "held — they won't start until you resume",
  inactive: "the hold prevents new work from starting",
};

/**
 * Partition the tasks an operation affects into the disjoint buckets the
 * pause dialog summarises. Each non-skipped task lands in exactly one bucket:
 * a live run, a queued run, or inactive work.
 */
export function computePauseAffectsSummary(tasks: readonly PauseAffectsTaskLike[]): PauseAffectsSummary {
  const counts: Record<PauseAffectsBucketKey, number> = {
    live_runs: 0,
    queued_runs: 0,
    inactive: 0,
  };
  let affectedTaskCount = 0;

  for (const task of tasks) {
    if (task.skipped) continue;
    affectedTaskCount += 1;
    if (task.activeRun?.status === "running") counts.live_runs += 1;
    else if (task.activeRun?.status === "queued") counts.queued_runs += 1;
    else counts.inactive += 1;
  }

  const order: PauseAffectsBucketKey[] = ["live_runs", "queued_runs", "inactive"];

  return {
    buckets: order.map((key) => ({
      key,
      label: PAUSE_BUCKET_LABEL[key],
      count: counts[key],
      detail: PAUSE_BUCKET_DETAIL[key],
    })),
    affectedTaskCount,
    nothingLive: counts.live_runs === 0 && counts.queued_runs === 0,
  };
}
