import { approvalLabel, typeIcon } from "@/features/approvals/ApprovalPayload";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { ACTIONABLE_APPROVAL_STATUSES } from "@/lib/inbox";
import { timeAgo } from "@/lib/timeAgo";
import type { Approval } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";

import { InboxRowUnreadSlot, NonTaskUnreadState } from "./-InboxRowShared";

import { approvalStatusLabel } from "./-inbox-row-model";

export function ApprovalInboxRow({
  approval,
  requesterName,
  onApprove,
  onReject,
  isPending,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  selected = false,
  className,
}: {
  approval: Approval;
  requesterName: string | null;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
  unreadState?: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const companyId = useCompanyRouteId();
  const Icon = typeIcon[approval.type] ?? ShieldCheck;
  const label = approvalLabel(approval.type, approval.payload as Record<string, unknown> | null);
  const showResolutionButtons =
    approval.type !== "budget_override_required" && ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
  const showUnreadSlot = unreadState !== null;

  return (
    <Item variant={selected ? "muted" : "default"} size="sm" className={className}>
      {showUnreadSlot ? (
        <InboxRowUnreadSlot
          unreadState={unreadState}
          onMarkRead={onMarkRead}
          onArchive={onArchive}
          archiveDisabled={archiveDisabled}
        />
      ) : null}
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          <Link to="/$companyId/approvals/$approvalId" params={{ companyId, approvalId: approval.id }}>
            {label}
          </Link>
        </ItemTitle>
        <ItemDescription>
          {approvalStatusLabel(approval.status)}
          {requesterName ? ` · requested by ${requesterName}` : ""}
          {` · updated ${timeAgo(approval.updatedAt)}`}
        </ItemDescription>
      </ItemContent>
      {showResolutionButtons ? (
        <ItemActions>
          <Button size="sm" onClick={onApprove} disabled={isPending}>
            Approve
          </Button>
          <Button variant="destructive" size="sm" onClick={onReject} disabled={isPending}>
            Reject
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );
}
