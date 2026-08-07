import { useState, type ReactNode } from "react";
import { cn, formatShortDate } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, Copy, MoreHorizontal } from "lucide-react";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Short relative timestamp for an agent bubble — "2h ago" within a week, then
 * an absolute short date. Mirrors the task thread's `commentDateLabel` so both
 * surfaces read identically.
 */
export function agentBubbleDateLabel(date: Date | string | undefined): string {
  if (!date) return "";
  const then = new Date(date).getTime();
  if (Date.now() - then < WEEK_MS) return timeAgo(date);
  return formatShortDate(date);
}

/**
 * Shared agent-bubble action row — copy · timestamp · ⋯ menu.
 *
 * Rendered below every agent bubble. Each caller supplies its own copy text,
 * timestamp label, and any extra overflow-menu items.
 */
export function AgentBubbleActionRow({
  copyText,
  dateLabel,
  dateTitle,
  anchorHref,
  menuItems,
  className,
}: {
  copyText: string;
  /** Short relative label shown inline (e.g. "2h ago"). */
  dateLabel?: string;
  /** Full datetime shown in the hover tooltip. */
  dateTitle?: string;
  /** Anchor href for the timestamp link (deep-link to the comment). */
  anchorHref?: string;
  /** Extra DropdownMenuItem nodes appended after the default "Copy message". */
  menuItems?: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className={cn("mt-2 flex items-center gap-1", className)}>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Copy message"
        aria-label="Copy message"
        onClick={() => {
          void navigator.clipboard.writeText(copyText).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {dateLabel ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={anchorHref}
              className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
            >
              {dateLabel}
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {dateTitle}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            title="More actions"
            aria-label="More actions"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              void navigator.clipboard.writeText(copyText);
            }}
          >
            <Copy className="mr-2 h-3.5 w-3.5" />
            Copy message
          </DropdownMenuItem>
          {menuItems}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
