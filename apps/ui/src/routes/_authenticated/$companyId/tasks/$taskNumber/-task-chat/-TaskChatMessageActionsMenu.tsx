import { MessageAction, MessageActions } from "@/components/ai-elements/message";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { copyTextToClipboard } from "@/lib/clipboard";
import type { TaskChatMessage } from "@/lib/task-chat-messages";
import { CheckIcon, CopyIcon, LinkIcon, MoreHorizontalIcon, ReplyIcon } from "lucide-react";
import { useContext, useState } from "react";
import { toast } from "sonner";

import { getThreadMessageCopyText, replyTargetForMessage, TaskChatCtx } from "./-TaskChatShared";

interface TaskChatMessageActionsMenuProps {
  message: TaskChatMessage;
  authorLabel: string;
  anchorId?: string | null;
  copyLabel?: string;
  linkLabel?: string;
  align?: "start" | "end";
}

export function TaskChatMessageActionsMenu({
  message,
  authorLabel,
  anchorId,
  copyLabel = "Copy message",
  linkLabel = "Copy link to message",
  align = "start",
}: TaskChatMessageActionsMenuProps) {
  const { onReply } = useContext(TaskChatCtx);
  const [copiedKind, setCopiedKind] = useState<"text" | "link" | null>(null);
  const replyTarget = replyTargetForMessage(message, authorLabel);

  async function copy(value: string, kind: "text" | "link") {
    try {
      await copyTextToClipboard(value);
      setCopiedKind(kind);
      window.setTimeout(() => setCopiedKind(null), 2000);
    } catch (error) {
      toast.error("Copy failed", {
        description: error instanceof Error ? error.message : "Unable to copy this message",
      });
    }
  }

  return (
    <MessageActions className="shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MessageAction
            label="Message actions"
            className="text-muted-foreground opacity-70 hover:opacity-100 focus-visible:opacity-100 data-[state=open]:bg-accent data-[state=open]:opacity-100"
          >
            {copiedKind ? (
              <CheckIcon className="size-4" data-icon="inline-start" />
            ) : (
              <MoreHorizontalIcon className="size-4" data-icon="inline-start" />
            )}
          </MessageAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          <DropdownMenuItem onSelect={() => void copy(getThreadMessageCopyText(message), "text")}>
            <CopyIcon className="size-4" data-icon="inline-start" />
            {copyLabel}
          </DropdownMenuItem>
          {anchorId ? (
            <DropdownMenuItem
              onSelect={() =>
                void copy(`${window.location.origin}${window.location.pathname}#${anchorId}`, "link")
              }
            >
              <LinkIcon className="size-4" data-icon="inline-start" />
              {linkLabel}
            </DropdownMenuItem>
          ) : null}
          {replyTarget && onReply ? (
            <DropdownMenuItem onSelect={() => onReply(replyTarget)}>
              <ReplyIcon className="size-4" data-icon="inline-start" />
              Reply
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="sr-only" aria-live="polite">
        {copiedKind === "text"
          ? "Message copied to clipboard"
          : copiedKind === "link"
            ? "Message link copied to clipboard"
            : ""}
      </span>
    </MessageActions>
  );
}
