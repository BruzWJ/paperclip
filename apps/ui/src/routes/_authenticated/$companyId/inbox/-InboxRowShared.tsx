import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

export type NonTaskUnreadState = "visible" | "fading" | "hidden" | null;

/** Shared unread-dot / mark-read / dismiss slot for non-task inbox rows. */
export function InboxRowUnreadSlot({
  unreadState,
  onMarkRead,
  onArchive,
  archiveDisabled,
}: {
  unreadState: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
}) {
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";

  return (
    <span className="hidden sm:inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
      {showUnreadDot ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onMarkRead}
          className="size-4 rounded-full p-0"
          aria-label="Mark as read"
        >
          <Badge
            aria-hidden
            className={cn(
              "size-2 p-0 transition-opacity duration-300",
              unreadState === "fading" ? "opacity-0" : "opacity-100",
            )}
          />
        </Button>
      ) : onArchive ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onArchive}
          disabled={archiveDisabled}
          className="size-4 rounded-md p-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
          aria-label="Dismiss from inbox"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <span className="inline-flex h-4 w-4" aria-hidden="true" />
      )}
    </span>
  );
}
