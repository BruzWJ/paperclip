import type { SourceTrustMetadata } from "@paperclipai/shared";
import { BadgeCheck, MoreHorizontal, Reply as ReplyIcon, ShieldAlert } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatDateTime } from "@/lib/utils";
import { isSourceTrustMetadata, type TaskChatReplyTarget } from "./TaskChatShared";
import { commentDateLabel } from "./TaskChatMessageUtils";

export function useTaskChatCopy(fallback: string) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    (text: string) => {
      void copyTextToClipboard(text)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch((error) => {
          toast.error("Copy failed", {
            description: error instanceof Error ? error.message : fallback,
          });
        });
    },
    [fallback],
  );
  return { copied, copy };
}

export function TaskChatSourceTrustIndicator({
  appearance,
  value,
}: {
  appearance: "badge" | "status";
  value: unknown;
}) {
  if (!isSourceTrustMetadata(value)) return null;
  const sourceTrust: SourceTrustMetadata = value;
  const promoted = sourceTrust.disposition === "promoted";
  const label = promoted ? "Promoted from low-trust" : "Low-trust source";
  const description = promoted
    ? `Promoted from low-trust${sourceTrust.promotedAt ? ` on ${new Date(sourceTrust.promotedAt).toLocaleString()}` : ""}.`
    : "Authored by a low-trust review agent. Raw comment is not auto-shared with higher-trust agents.";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {appearance === "status" ? (
          <DomainStatus status={promoted ? "promoted" : "low_trust_review"} aria-label={label}>
            {label}
          </DomainStatus>
        ) : (
          <Badge variant={promoted ? "secondary" : "destructive"} aria-label={label}>
            {promoted ? <BadgeCheck /> : <ShieldAlert />}
            {label}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}

export function TaskChatTimestamp({ anchorId, createdAt }: { anchorId?: string; createdAt?: Date | string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a href={anchorId ? `#${anchorId}` : undefined}>{commentDateLabel(createdAt)}</a>
      </TooltipTrigger>
      <TooltipContent side="bottom">{createdAt ? formatDateTime(createdAt) : ""}</TooltipContent>
    </Tooltip>
  );
}

export function TaskChatReplyMenu({
  align = "end",
  onReply,
  replyTarget,
}: {
  align?: "start" | "end";
  onReply?: (target: TaskChatReplyTarget) => void;
  replyTarget: TaskChatReplyTarget | null;
}) {
  if (!replyTarget || !onReply) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" title="More actions" aria-label="More actions">
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <DropdownMenuItem onSelect={() => onReply(replyTarget)}>
          <ReplyIcon className="mr-2 h-3.5 w-3.5" />
          Reply
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TaskChatFollowUpBadge({ requested }: { requested: boolean }) {
  return requested ? (
    <Badge variant="outline" className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)">
      Follow-up
    </Badge>
  ) : null;
}
