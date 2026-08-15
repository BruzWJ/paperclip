import { MessageAction, MessageActions } from "@/components/ai-elements/message";
import { copyTextToClipboard } from "@/lib/clipboard";
import { CheckIcon, CopyIcon, LinkIcon, ReplyIcon, SquareIcon } from "lucide-react";
import { useContext, useState } from "react";
import { toast } from "sonner";
import type { TaskChatMessage } from "@/lib/task-chat-messages";

import { getThreadMessageCopyText, replyTargetForMessage, TaskChatCtx } from "./-TaskChatShared";
import { taskChatMessageCustom } from "./-TaskChatMessageUtils";

export interface TaskChatMessageActionBarProps {
  message: TaskChatMessage;
  authorLabel: string;
  anchorId?: string | null;
  copyLabel?: string;
  linkLabel?: string;
  isRunActive?: boolean;
  isStoppingRun?: boolean;
}

export function TaskChatMessageActionBar({
  message,
  authorLabel,
  anchorId,
  copyLabel = "Copy message",
  linkLabel = "Copy link to message",
  isRunActive = false,
  isStoppingRun = false,
}: TaskChatMessageActionBarProps) {
  const {
    onReply,
    onStopRun,
    stopRunLabel = "Stop run",
    stoppingRunLabel = "Stopping…",
  } = useContext(TaskChatCtx);
  const [copiedText, setCopiedText] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const custom = taskChatMessageCustom(message);
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const replyTarget = replyTargetForMessage(message, authorLabel);

  async function copy(value: string, kind: "text" | "link") {
    try {
      await copyTextToClipboard(value);
      if (kind === "text") setCopiedText(true);
      else setCopiedLink(true);
      window.setTimeout(() => {
        if (kind === "text") setCopiedText(false);
        else setCopiedLink(false);
      }, 2000);
    } catch (error) {
      toast.error("Copy failed", {
        description: error instanceof Error ? error.message : "Unable to copy this message",
      });
    }
  }

  return (
    <MessageActions>
      <MessageAction
        tooltip={copyLabel}
        label={copyLabel}
        aria-label={copyLabel}
        onClick={() => void copy(getThreadMessageCopyText(message), "text")}
      >
        {copiedText ? <CheckIcon className="size-4"  data-icon="inline-start"/> : <CopyIcon className="size-4"  data-icon="inline-start"/>}
      </MessageAction>
      {anchorId ? (
        <MessageAction
          tooltip={linkLabel}
          label={linkLabel}
          aria-label={linkLabel}
          onClick={() =>
            void copy(`${window.location.origin}${window.location.pathname}#${anchorId}`, "link")
          }
        >
          {copiedLink ? <CheckIcon className="size-4"  data-icon="inline-start"/> : <LinkIcon className="size-4"  data-icon="inline-start"/>}
        </MessageAction>
      ) : null}
      {replyTarget && onReply ? (
        <MessageAction tooltip="Reply" label="Reply" aria-label="Reply" onClick={() => onReply(replyTarget)}>
          <ReplyIcon className="size-4"  data-icon="inline-end"/>
        </MessageAction>
      ) : null}
      {isRunActive && runId && onStopRun ? (
        <MessageAction
          tooltip={isStoppingRun ? stoppingRunLabel : stopRunLabel}
          label={isStoppingRun ? stoppingRunLabel : stopRunLabel}
          aria-label={isStoppingRun ? stoppingRunLabel : stopRunLabel}
          disabled={isStoppingRun}
          onClick={() => void onStopRun(runId)}
        >
          <SquareIcon className="size-4"  data-icon="inline-end"/>
        </MessageAction>
      ) : null}
    </MessageActions>
  );
}
