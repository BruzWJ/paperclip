import { Button } from "@/components/ui/button";
import { buildSystemNoticeProps } from "@/lib/system-notice-comment";
import type { ThreadMessage } from "@assistant-ui/react";
import { Check, Copy, Paperclip } from "lucide-react";
import { useContext } from "react";
import { MarkdownBody } from "../MarkdownBody";
import { SystemNotice } from "../SystemNotice";
import {
  TaskChatCtx,
  TaskChatImmediateParentLabel,
  getThreadMessageCopyText,
  isTaskCommentMetadata,
  isTaskCommentPresentation,
  replyTargetForMessage,
} from "./TaskChatShared";
import { TaskChatReplyMenu, TaskChatTimestamp, useTaskChatCopy } from "./TaskChatMessagePrimitives";

export interface SystemNoticeCommentRowProps {
  message: ThreadMessage;
  anchorId?: string;
}

/** Renders a posted system notice with copy, permalink, and reply affordances. */
export function SystemNoticeCommentRow({ message, anchorId }: SystemNoticeCommentRowProps) {
  const { onImageClick, agentMap, onReply } = useContext(TaskChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const presentation = isTaskCommentPresentation(custom.presentation) ? custom.presentation : null;
  const commentMetadata = isTaskCommentMetadata(custom.commentMetadata) ? custom.commentMetadata : null;
  const runAgentId = typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runAgent = runAgentId ? (agentMap?.get(runAgentId) ?? null) : null;
  const runAgentRef = runAgent?.id ?? null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const authorType = typeof custom.authorType === "string" ? custom.authorType : null;
  const authorName = typeof custom.authorName === "string" ? custom.authorName : null;
  const bodyText = getThreadMessageCopyText(message);
  const { copied, copy } = useTaskChatCopy("Unable to copy system notice");
  const { copied: copiedLink, copy: copyLink } = useTaskChatCopy("Unable to copy system notice link");
  const replyTarget = replyTargetForMessage(message, authorName ?? "Paperclip");

  const runAgentName = runAgent?.name ?? null;
  const source =
    authorType === "system"
      ? runAgentRef && runId
        ? { label: runAgentName ?? "Paperclip", agentId: runAgentRef, runId }
        : { label: runAgentName ?? "Paperclip" }
      : runAgentRef && runId
        ? {
            label: authorName ?? runAgentName ?? "Paperclip",
            agentId: runAgentRef,
            runId,
          }
        : authorName
          ? { label: authorName }
          : undefined;

  const noticeProps = buildSystemNoticeProps({
    presentation,
    metadata: commentMetadata,
    body: (
      <MarkdownBody className="text-sm leading-6" softBreaks onImageClick={onImageClick}>
        {bodyText}
      </MarkdownBody>
    ),
    timestamp: message.createdAt ? new Date(message.createdAt).toISOString() : undefined,
    source,
    runAgentId: runAgentRef,
  });

  const handleCopyLink = () => {
    if (!anchorId || typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}#${anchorId}`;
    copyLink(url);
  };

  return (
    <div id={anchorId} className="group">
      <div className="py-1">
        <TaskChatImmediateParentLabel custom={custom} />
        <SystemNotice {...noticeProps} />
        <div className="mt-1 flex items-center justify-end gap-1.5 px-1 opacity-0 transition-opacity group-hover:opacity-100">
          <TaskChatTimestamp anchorId={anchorId} createdAt={message.createdAt} />
          {anchorId ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="Copy link"
              aria-label="Copy link to system notice"
              onClick={handleCopyLink}
            >
              {copiedLink ? <Check className="h-3.5 w-3.5" /> : <Paperclip className="h-3.5 w-3.5" />}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="Copy notice text"
            aria-label="Copy system notice"
            onClick={() => copy(bodyText)}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
          <TaskChatReplyMenu replyTarget={replyTarget} onReply={onReply} />
        </div>
      </div>
    </div>
  );
}
