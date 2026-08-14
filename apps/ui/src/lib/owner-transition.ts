import { parseAgentMentionHref } from "@paperclipai/shared";

/**
 * Shared logic for the "interrupt owner change" UX clarity surfaces (PAP-10669).
 *
 * The single rule every surface enforces: an *agent* appearance — agent chip,
 * owner-change copy, or a queued dispatch — is reserved for either (a) a durable
 * `ownerAgentId` mutation, or (b) a structured agent mention (`agent://<id>`).
 * Plain text such as `QA` or `please get QA on this` never implies an agent
 * dispatch.
 *
 * The canonical run envelope records an operator-triggered interruption with
 * the terminal reason code `operator_interrupted`.
 */

// --- Run interruption ---------------------------------------------------------

/**
 * Whether a run's terminal record reflects an intentional operator interrupt
 * (a board comment that cancelled the active run) rather than an unexplained
 * failure or a plain control-plane cancel.
 */
export function isOperatorInterruptedRun(terminalReasonCode: string | null | undefined): boolean {
  return terminalReasonCode === "operator_interrupted";
}

export interface RunStatusPresentation {
  label: string;
  /** Screen-reader-only clarifier, or null. */
  srHint: string | null;
}

/**
 * Resolve the visible run status. A board-triggered interrupt reads as
 * "interrupted" (amber, operator-intentional) instead of a muted "cancelled"
 * that looks like an adapter failure.
 */
export function resolveRunStatusPresentation(
  status: string,
  opts: { operatorInterrupted?: boolean } = {},
): RunStatusPresentation {
  if (status === "cancelled" && opts.operatorInterrupted) {
    return {
      label: "interrupted",
      srHint: "interrupted by board comment",
    };
  }
  return {
    label: status === "timed_out" ? "timed out" : status.replace(/_/g, " "),
    srHint: null,
  };
}

// --- Structured mention vs plain text -----------------------------------------

const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^)]*)\)/g;

/** Ordered list of agent ids referenced via structured `agent://` mentions. */
export function extractAgentMentionIds(body: string): string[] {
  const ids: string[] = [];
  if (!body) return ids;
  for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
    const href = match[1] ?? "";
    const parsed = parseAgentMentionHref(href);
    if (parsed?.agentId && !ids.includes(parsed.agentId)) {
      ids.push(parsed.agentId);
    }
  }
  return ids;
}

export function bodyHasAgentMention(body: string): boolean {
  return extractAgentMentionIds(body).length > 0;
}

/** Strip every markdown link so chip labels/hrefs are not mistaken for plain text. */
function plainTextOutsideLinks(body: string): string {
  return body.replace(MARKDOWN_LINK_RE, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface OwnerAgentMention {
  agentId: string;
  name: string;
}

export interface PlainAgentNameCandidate {
  agentId: string;
  /** The agent display name that matched in the body. */
  matchedText: string;
}

/**
 * Find a plain-text token in `body` that names a known agent by display name but
 * is *not* a structured `agent://` mention. This is the signal the
 * composer coach uses to offer an "Insert mention" upgrade. Returns the
 * highest-confidence (longest-token) match, or null.
 */
export function findPlainAgentNameCandidate(
  body: string,
  mentions: readonly OwnerAgentMention[],
): PlainAgentNameCandidate | null {
  if (!body.trim() || mentions.length === 0) return null;
  const text = plainTextOutsideLinks(body);
  let best: PlainAgentNameCandidate | null = null;

  for (const mention of mentions) {
    const token = mention.name.trim();
    if (token.length < 2) continue;
    const re = new RegExp(`(?<![\\w@/])${escapeRegExp(token)}(?![\\w/])`, "i");
    if (re.test(text)) {
      if (!best || token.length > best.matchedText.length) {
        best = { agentId: mention.agentId, matchedText: token };
      }
    }
  }

  return best;
}

// --- Composer interpretation preview ------------------------------------------

export type OwnerPreviewTone = "neutral" | "warn";

export type ComposerOwnerPreviewKind =
  "interrupt_change_owner" | "dispatch_owner" | "notify_agent" | "plain_text_only" | "none";

export interface ComposerOwnerPreview {
  kind: ComposerOwnerPreviewKind;
  tone: OwnerPreviewTone;
  /** Copy rendered before the optional chip. */
  text: string;
  /** Copy rendered after the optional chip. */
  suffix?: string;
  /** Entity to render as a mini chip, if any. */
  chip?: { kind: "agent"; id: string };
}

function parseOwnerAgentValue(value: string): string | null {
  if (!value.startsWith("agent:")) return null;
  return value.slice("agent:".length) || null;
}

export interface ComposerOwnerPreviewInput {
  /** Current agent-owner picker value, encoded as "agent:<id>". */
  ownerTarget: string;
  /** The task's current agent-owner value in the same encoding. */
  currentOwnerValue: string;
  /** Whether an agent run is currently in flight on this task. */
  hasActiveRun: boolean;
  /** Whether the comment body contains a structured agent mention. */
  bodyHasAgentMention: boolean;
  /** First agent id structurally mentioned in the body, if any. */
  mentionedAgentId?: string | null;
  /** A plain-text agent-name candidate detected in the body, if any. */
  plainNameCandidate?: PlainAgentNameCandidate | null;
}

/**
 * Compute the one-line interpretation of what submitting this comment will
 * durably do. This is the composer footer preview (design surface 1c) and the
 * core of the agent-vs-user disambiguation.
 */
export function computeComposerOwnerPreview(input: ComposerOwnerPreviewInput): ComposerOwnerPreview {
  const hasOwnerChange = input.ownerTarget !== input.currentOwnerValue;

  if (hasOwnerChange) {
    const ownerAgentId = parseOwnerAgentValue(input.ownerTarget);
    if (ownerAgentId) {
      return input.hasActiveRun
        ? {
            kind: "interrupt_change_owner",
            tone: "neutral",
            text: "Interrupt current run and change owner to",
            chip: { kind: "agent", id: ownerAgentId },
          }
        : {
            kind: "dispatch_owner",
            tone: "neutral",
            text: "Change owner and queue execution for",
            chip: { kind: "agent", id: ownerAgentId },
          };
    }
  }

  if (input.bodyHasAgentMention) {
    return {
      kind: "notify_agent",
      tone: "neutral",
      text: "Notify",
      chip: input.mentionedAgentId ? { kind: "agent", id: input.mentionedAgentId } : undefined,
      suffix: input.mentionedAgentId ? undefined : "the mentioned agent",
    };
  }

  if (input.plainNameCandidate) {
    return {
      kind: "plain_text_only",
      tone: "warn",
      text: "No agent will be notified. Use @ to mention an agent.",
    };
  }

  return { kind: "none", tone: "neutral", text: "" };
}

// --- Timeline owner transition / dispatch classification ----------------------

export type OwnerTransitionKind = "agent_dispatch" | "user_owner" | "board_owner";

export type { TaskOwnerReference as TimelineOwnerLike } from "@/lib/presentation-contracts";
import type { TaskOwnerReference } from "@/lib/presentation-contracts";

export interface OwnerTransitionInfo {
  kind: OwnerTransitionKind;
  /** Copy rendered after the "Dispatch" label in the activity card. */
  dispatchText: string;
}

/**
 * Classify the dispatch outcome of an owner change, given the destination
 * owner. This drives the timeline "Dispatch" sub-row so the three required
 * states are self-describing in the activity log.
 */
export function classifyOwnerTransition(
  to: TaskOwnerReference,
  opts: { agentName?: string | null; interruptedRunAttached?: boolean } = {},
): OwnerTransitionInfo {
  if (to.ownerKind === "agent" && to.ownerAgentId) {
    const who = opts.agentName ?? "the owner agent";
    const suffix = opts.interruptedRunAttached ? " (interrupted run attached)" : "";
    return { kind: "agent_dispatch", dispatchText: `queued for ${who}${suffix}` };
  }
  if (to.ownerKind === "user" && to.ownerUserId) {
    return {
      kind: "user_owner",
      dispatchText: "not created — creator withdrawal returned ownership to the user",
    };
  }
  return {
    kind: "board_owner",
    dispatchText: "not created — this task is escalated to the board",
  };
}

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

export type PauseAffectsBucketKey = "live_runs" | "queued_runs" | "inactive";

export interface PauseAffectsTaskLike {
  activeRun: { status: "queued" | "running" } | null;
  skipped?: boolean;
}

export interface PauseAffectsBucket {
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
