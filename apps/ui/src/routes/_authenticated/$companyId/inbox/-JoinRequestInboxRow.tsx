import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { timeAgo } from "@/lib/timeAgo";
import type { JoinRequest } from "@paperclipai/shared";
import { UserPlus } from "lucide-react";

import { InboxRowUnreadSlot, NonTaskUnreadState } from "./-InboxRowShared";

import { formatJoinRequestInboxLabel } from "./-inbox-row-model";

export function JoinRequestInboxRow({
  joinRequest,
  onApprove,
  onReject,
  isPending,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  className,
}: {
  joinRequest: JoinRequest;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
  unreadState?: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  className?: string;
}) {
  const label = formatJoinRequestInboxLabel(joinRequest);
  const showUnreadSlot = unreadState !== null;

  return (
    <Item variant="outline" size="sm" className={className}>
      {showUnreadSlot ? (
        <InboxRowUnreadSlot
          unreadState={unreadState}
          onMarkRead={onMarkRead}
          onArchive={onArchive}
          archiveDisabled={archiveDisabled}
        />
      ) : null}
      <ItemMedia variant="icon">
        <UserPlus />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription>
          requested {timeAgo(joinRequest.createdAt)} from IP {joinRequest.requestIp}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <ButtonGroup>
          <Button size="sm" onClick={onApprove} disabled={isPending}>
            Approve
          </Button>
          <Button variant="destructive" size="sm" onClick={onReject} disabled={isPending}>
            Reject
          </Button>
        </ButtonGroup>
      </ItemActions>
    </Item>
  );
}
