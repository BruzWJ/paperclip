import { AlertTriangle, Info, PauseCircle, User } from "lucide-react";
import { Banner, BannerAction, BannerClose, BannerIcon, BannerTitle } from "@/components/kibo-ui/banner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { cn } from "@/lib/utils";
import type { NamedAgentSummary } from "@/lib/presentation-contracts";
import { AgentIcon } from "../../../../../../features/agents/AgentIconPicker";
import {
  classifyOwnerTransition,
  resolveRunStatusPresentation,
  type ComposerOwnerPreview,
  type PauseAffectsSummary,
  type PlainAgentNameCandidate,
  type OwnerChangeInterruptCopy,
  type TimelineOwnerLike,
} from "@/lib/owner-transition";

/**
 * Presentational views for the owner-transition UX clarity surfaces (PAP-10669).
 * All logic lives in `lib/owner-transition.ts`; these components only render it,
 * so they can be exercised in isolation by component tests and Storybook.
 */

export interface OwnerChipResolvers {
  agentMap?: ReadonlyMap<string, NamedAgentSummary> | null;
  resolveUserLabel?: (userId: string) => string | null;
  currentUserId?: string | null;
}

function agentName(agentId: string, resolvers: OwnerChipResolvers): string {
  return resolvers.agentMap?.get(agentId)?.name ?? agentId.slice(0, 8);
}

function agentIcon(agentId: string, resolvers: OwnerChipResolvers): string | null {
  return resolvers.agentMap?.get(agentId)?.icon ?? null;
}

function userLabel(userId: string, resolvers: OwnerChipResolvers): string {
  const label = resolvers.resolveUserLabel?.(userId) ?? null;
  const base = label ?? "Board";
  return resolvers.currentUserId && resolvers.currentUserId === userId ? `${base} (you)` : base;
}

/** A labelled owner chip that never lets an exceptional user or board owner
 * read like an agent owner. */
export function OwnerChip({
  owner,
  resolvers,
  className,
}: {
  owner: TimelineOwnerLike;
  resolvers: OwnerChipResolvers;
  className?: string;
}) {
  if (owner.ownerKind === "agent" && owner.ownerAgentId) {
    return (
      <Badge variant="secondary" className={className} data-testid="owner-chip" data-kind="agent">
        <span className="sr-only">Agent </span>
        <AgentIcon
          icon={agentIcon(owner.ownerAgentId, resolvers)}
          className="h-3 w-3 shrink-0 text-muted-foreground"
        />
        <span className="max-w-(--sz-12rem) truncate">{agentName(owner.ownerAgentId, resolvers)}</span>
      </Badge>
    );
  }
  if (owner.ownerKind === "user" && owner.ownerUserId) {
    return (
      <Badge variant="secondary" className={className} data-testid="owner-chip" data-kind="user">
        <span className="sr-only">User </span>
        <User className="h-3 w-3 shrink-0 text-muted-foreground"  data-icon="inline-start"/>
        <span className="max-w-(--sz-12rem) truncate">{userLabel(owner.ownerUserId, resolvers)}</span>
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={className} data-testid="owner-chip" data-kind="board">
      Board escalation
    </Badge>
  );
}

/** The "Dispatch" sub-row that makes each owner state self-describing. */
export function OwnerDispatchRow({
  to,
  resolvers,
  interruptedRunAttached = false,
}: {
  to: TimelineOwnerLike;
  resolvers: OwnerChipResolvers;
  interruptedRunAttached?: boolean;
}) {
  const info = classifyOwnerTransition(to, {
    agentName: to.ownerAgentId ? agentName(to.ownerAgentId, resolvers) : null,
    interruptedRunAttached,
  });
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-xs"
      data-testid="owner-dispatch-row"
      data-kind={info.kind}
    >
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Dispatch</span>
      <span className={cn(info.kind === "agent_dispatch" ? "text-foreground" : "text-muted-foreground")}>
        {info.dispatchText}
      </span>
    </div>
  );
}

/** Run status text that distinguishes an intentional operator interrupt
 * (amber "interrupted") from a generic muted "cancelled". */
export function RunStatusBadge({
  status,
  operatorInterrupted = false,
  className,
}: {
  status: string;
  operatorInterrupted?: boolean;
  className?: string;
}) {
  const p = resolveRunStatusPresentation(status, { operatorInterrupted });
  return (
    <DomainStatus
      status={operatorInterrupted ? "warning" : status}
      className={className}
      data-testid="run-status-badge"
      data-interrupted={operatorInterrupted ? "true" : "false"}
    >
      {p.label}
      {p.srHint ? <span className="sr-only"> — {p.srHint}</span> : null}
    </DomainStatus>
  );
}

function PreviewChip({
  chip,
  resolvers,
}: {
  chip: NonNullable<ComposerOwnerPreview["chip"]>;
  resolvers: OwnerChipResolvers;
}) {
  return (
    <OwnerChip
      owner={{ ownerKind: "agent", ownerAgentId: chip.id, ownerUserId: null }}
      resolvers={resolvers}
    />
  );
}

/** One-line interpretation of what submitting the comment will durably do. */
export function ComposerOwnerPreviewRow({
  preview,
  resolvers,
}: {
  preview: ComposerOwnerPreview;
  resolvers: OwnerChipResolvers;
}) {
  if (preview.kind === "none") return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-1.5 text-xs",
        preview.tone === "warn" ? "text-destructive" : "text-muted-foreground",
      )}
      data-testid="composer-owner-preview"
      data-kind={preview.kind}
      role="status"
      aria-live="polite"
    >
      <span>{preview.text}</span>
      {preview.chip ? <PreviewChip chip={preview.chip} resolvers={resolvers} /> : null}
      {preview.suffix ? <span>{preview.suffix}</span> : null}
    </div>
  );
}

/** Inline coach shown when the body contains a plain agent name without a chip,
 * offering a one-click upgrade to a real mention. */
export function ComposerMentionCoach({
  candidate,
  agentDisplayName,
  onInsert,
  onDismiss,
}: {
  candidate: PlainAgentNameCandidate;
  agentDisplayName: string;
  onInsert: () => void;
  onDismiss: () => void;
}) {
  return (
    <Banner data-testid="composer-mention-coach" aria-live="polite" visible inset onClose={onDismiss}>
      <BannerIcon icon={Info} />
      <BannerTitle>
        Did you mean <strong>@{candidate.matchedText}</strong>? Plain text won't notify an agent or make it
        the owner.
      </BannerTitle>
      <BannerAction
        type="button"
        onClick={onInsert}
        aria-label={`Insert mention for ${agentDisplayName} into your comment`}
      >
        Insert mention
      </BannerAction>
      <BannerClose type="button" aria-label="Dismiss suggestion" />
    </Banner>
  );
}

/** Live banner shown at the top of the owner picker while a run is in flight,
 * warning that changing owner will interrupt it. (design surface 2) */
export function OwnerRunningBanner({
  copy,
  className,
  compact = false,
}: {
  copy: OwnerChangeInterruptCopy;
  className?: string;
  compact?: boolean;
}) {
  return (
    <Banner
      role="status"
      aria-live="polite"
      data-testid="owner-running-banner"
      className={cn(compact && "items-start", className)}
      inset
    >
      <BannerIcon icon={AlertTriangle} />
      <BannerTitle>{copy.banner}</BannerTitle>
      {compact ? null : <DomainStatus status="running">Run active</DomainStatus>}
    </Banner>
  );
}

/** Interrupt-and-change-owner confirm step shown when an operator picks a
 * different owner while a run is live. (design surface 2) */
export function InterruptOwnerChangeConfirm({
  copy,
  to,
  resolvers,
  onConfirm,
  onCancel,
  compact = false,
}: {
  copy: OwnerChangeInterruptCopy;
  /** The target the operator selected. */
  to: TimelineOwnerLike;
  resolvers: OwnerChipResolvers;
  onConfirm: () => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Banner data-testid="interrupt-owner-change-confirm" className="flex-col items-stretch! gap-3" inset>
        <div className="flex min-w-0 items-start gap-2">
          <BannerIcon icon={AlertTriangle} />
          <BannerTitle>
            <span className="block font-medium">{copy.confirmTitle}</span>
            <span className="mt-1 flex flex-wrap items-center gap-1">
              <span>Change owner to</span>
              <OwnerChip owner={to} resolvers={resolvers} />
            </span>
          </BannerTitle>
        </div>
        <div className="flex w-full flex-col gap-2">
          <BannerAction
            type="button"
            size="default"
            className="min-h-11 w-full"
            onClick={onConfirm}
            data-testid="interrupt-owner-change-confirm-action"
          >
            {copy.confirmAction}
          </BannerAction>
          <BannerAction type="button" size="default" className="min-h-11 w-full" onClick={onCancel}>
            {copy.cancelAction}
          </BannerAction>
        </div>
      </Banner>
    );
  }

  return (
    <Banner data-testid="interrupt-owner-change-confirm" inset>
      <BannerIcon icon={AlertTriangle} />
      <BannerTitle>
        <span className="block font-medium">{copy.confirmTitle}</span>
        <span className="flex flex-wrap items-center gap-1">
          <span>Change owner to</span>
          <OwnerChip owner={to} resolvers={resolvers} />
        </span>
      </BannerTitle>
      <BannerAction type="button" onClick={onCancel}>
        {copy.cancelAction}
      </BannerAction>
      <BannerAction type="button" onClick={onConfirm} data-testid="interrupt-owner-change-confirm-action">
        {copy.confirmAction}
      </BannerAction>
    </Banner>
  );
}

/** "What this affects" bucket summary for the pause/hold dialog. (design surface 4) */
export function PauseAffectsSummaryView({
  summary,
  className,
}: {
  summary: PauseAffectsSummary;
  className?: string;
}) {
  const visibleBuckets = summary.buckets.filter((bucket) => bucket.count > 0);
  return (
    <Alert data-testid="pause-affects-summary" className={className}>
      <PauseCircle aria-hidden  data-icon="inline-start"/>
      <AlertTitle>What this affects</AlertTitle>
      <AlertDescription>
        {summary.nothingLive ? (
          <p role="status" data-testid="pause-nothing-live">
            Nothing live to pause — no agent run is in flight or queued. This records a hold so new work won't
            start until you resume.
          </p>
        ) : null}
        {visibleBuckets.length > 0 ? (
          <ul className="space-y-1">
            {visibleBuckets.map((bucket) => (
              <li key={bucket.key} data-bucket={bucket.key}>
                <strong>{bucket.label}:</strong> {bucket.count} — {bucket.detail}
              </li>
            ))}
          </ul>
        ) : (
          <p>No tasks are affected.</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
