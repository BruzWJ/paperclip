import type {
  AttentionDetailImage,
  AttentionFeed,
  AttentionItem,
  AttentionItemDetail,
  AttentionSourceKind,
} from "@paperclipai/shared";
import {
  AlertTriangle,
  DollarSign,
  Eye,
  MessageSquare,
  ShieldCheck,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { formatMoneyAmount } from "./utils";

/**
 * Source kinds the queue can fully resolve in-row. Everything else deep-links
 * to its native surface — reviews and Board requests use the existing
 * task-aware continuation flow.
 */
export const INLINE_RESOLVABLE_SOURCE_KINDS: ReadonlySet<AttentionSourceKind> = new Set<AttentionSourceKind>([
  "approval",
  "join_request",
]);

export function isInlineResolvable(item: AttentionItem): boolean {
  return item.inlineResolvable && INLINE_RESOLVABLE_SOURCE_KINDS.has(item.sourceKind);
}

interface SourceMeta {
  label: string;
  icon: LucideIcon;
}

const SOURCE_META: Record<AttentionSourceKind, SourceMeta> = {
  approval: { label: "Approval", icon: ShieldCheck },
  join_request: { label: "Join request", icon: UserPlus },
  review: { label: "Review", icon: Eye },
  budget_alert: { label: "Budget", icon: DollarSign },
  mention_board: { label: "Agent request", icon: MessageSquare },
};

export function sourceMeta(kind: AttentionSourceKind): SourceMeta {
  return (
    SOURCE_META[kind] ?? {
      label: kind.replaceAll("_", " "),
      icon: AlertTriangle,
    }
  );
}

// ---------------------------------------------------------------------------
// Richer detail line (PAP-13409 §7) — render T1's structured `detail` block into
// a single secondary line under the title (the caller clamps it to 2 lines).
// ---------------------------------------------------------------------------

function quote(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return `“${trimmed}”`;
}

/**
 * A concise human-readable detail line for a row, e.g.
 *   "2 questions — “Which auth provider…”"
 *   "Deploy failed — “exit code 1 on migrate”".
 * Returns `null` when the detail carries nothing beyond the title, so the row
 * can fall back to `whyNow`.
 */
export function attentionDetailLine(item: AttentionItem): string | null {
  const detail = item.detail;
  if (!detail) return null;
  switch (detail.kind) {
    case "approval":
      return quote(detail.summaryExcerpt);
    case "budget":
      return `${Math.round(detail.observedPercent)}% of budget used (${formatMoneyAmount(detail.observedAmount, detail.budgetCurrency)} / ${formatMoneyAmount(detail.limitAmount, detail.budgetCurrency)})`;
    case "generic":
      return quote(detail.summaryExcerpt);
    default:
      return null;
  }
}

/** Screenshot / thumbnail images attached to the detail block, if any. */
export function attentionDetailImages(item: AttentionItem): AttentionDetailImage[] {
  return (item.detail as AttentionItemDetail | null)?.images ?? [];
}

/**
 * Content URL for an attention detail image asset. Already-absolute or data
 * URLs pass through unchanged (server may hand back a CDN URL; stories use data
 * URIs), otherwise we resolve the in-app asset content route.
 */
export function attentionImageUrl(assetId: string): string {
  if (assetId.startsWith("data:") || assetId.startsWith("http")) return assetId;
  return `/api/assets/${assetId}/content`;
}

/**
 * Decisions-only badge count. Every feed row *is* a pending decision (the
 * server drops anything without a decision verb into Activity, per the §0
 * invariant), and mentions/unread never enter the feed — so the row count is
 * the decisions-only number. `/inbox` keeps its own unread count untouched.
 */
export function attentionBadgeCount(feed: AttentionFeed | null | undefined): number {
  return feed?.items.length ?? 0;
}
