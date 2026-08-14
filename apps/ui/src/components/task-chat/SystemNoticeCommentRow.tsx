import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatDateTime } from "@/lib/utils";
import { buildSystemNoticeProps } from "@/lib/system-notice-comment";
import type { ThreadMessage } from "@assistant-ui/react";
import {
  Check,
  Copy,
  MoreHorizontal,
  Paperclip,
  Reply as ReplyIcon,
} from "lucide-react";
import { useContext, useState } from "react";
import { MarkdownBody } from "../MarkdownBody";
import { SystemNotice } from "../SystemNotice";
import {
  TaskChatCtx,
  TaskChatImmediateParentLabel,
  isTaskCommentMetadata,
  isTaskCommentPresentation,
  replyTargetForMessage,
} from "./TaskChatShared";
import { commentDateLabel } from "./TaskChatMessageUtils";

export interface SystemNoticeCommentRowProps {
  message: ThreadMessage;
  anchorId?: string;
}

/** Renders a posted system notice with copy, permalink, and reply affordances. */
export function SystemNoticeCommentRow({
  message,
  anchorId,
}: SystemNoticeCommentRowProps) {
  const { onImageClick, agentMap, onReply } = useContext(TaskChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const presentation = isTaskCommentPresentation(custom.presentation)
    ? custom.presentation
    : null;
  const commentMetadata = isTaskCommentMetadata(custom.commentMetadata)
    ? custom.commentMetadata
    : null;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runAgent = runAgentId ? (agentMap?.get(runAgentId) ?? null) : null;
  const runAgentRef = runAgent?.id ?? null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const authorType =
    typeof custom.authorType === "string" ? custom.authorType : null;
  const authorName =
    typeof custom.authorName === "string" ? custom.authorName : null;
  const bodyText = message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n");
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
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
      <MarkdownBody
        className="text-sm leading-6"
        softBreaks
        onImageClick={onImageClick}
      >
        {bodyText}
      </MarkdownBody>
    ),
    timestamp: message.createdAt
      ? new Date(message.createdAt).toISOString()
      : undefined,
    source,
    runAgentId: runAgentRef,
  });

  const reportCopyFailure = (error: unknown, fallback: string) => {
    toast.error("Copy failed", {
      description: error instanceof Error ? error.message : fallback,
    });
  };
  const handleCopy = () => {
    void copyTextToClipboard(bodyText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((error) =>
        reportCopyFailure(error, "Unable to copy system notice"),
      );
  };
  const handleCopyLink = () => {
    if (!anchorId || typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}#${anchorId}`;
    void copyTextToClipboard(url)
      .then(() => {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      })
      .catch((error) =>
        reportCopyFailure(error, "Unable to copy system notice link"),
      );
  };

  return (
    <div id={anchorId} className="group">
      <div className="py-1">
        <TaskChatImmediateParentLabel custom={custom} />
        <SystemNotice {...noticeProps} />
        <div className="mt-1 flex items-center justify-end gap-1.5 px-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <a href={anchorId ? `#${anchorId}` : undefined}>
                {message.createdAt ? commentDateLabel(message.createdAt) : ""}
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {message.createdAt ? formatDateTime(message.createdAt) : ""}
            </TooltipContent>
          </Tooltip>
          {anchorId ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="Copy link"
              aria-label="Copy link to system notice"
              onClick={handleCopyLink}
            >
              {copiedLink ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Paperclip className="h-3.5 w-3.5" />
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="Copy notice text"
            aria-label="Copy system notice"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          {replyTarget && onReply ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title="More actions"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onReply(replyTarget)}>
                  <ReplyIcon className="mr-2 h-3.5 w-3.5" />
                  Reply
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </div>
  );
}
