import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ThreadMessage } from "@assistant-ui/react";
import { Link } from "@tanstack/react-router";
import { Check, Copy, MoreHorizontal, PauseCircle, Reply as ReplyIcon, Search, Square } from "lucide-react";
import { TaskChatTimestamp } from "./TaskChatMessagePrimitives";
import type { TaskChatReplyTarget } from "./TaskChatShared";

export interface TaskChatMessageActionBarProps {
  message: ThreadMessage;
  anchorId?: string;
  copied: boolean;
  onCopy: () => void;
  replyTarget: TaskChatReplyTarget | null;
  onReply?: (target: TaskChatReplyTarget) => void;
  canStopRun: boolean;
  runId: string | null;
  runAgentRef: string | null;
  companyId: string;
  isStoppingRun: boolean;
  onStopRun?: (runId: string) => Promise<void>;
  stopRunLabel: string;
  stoppingRunLabel: string;
  stopRunVariant: "stop" | "pause";
}

/** Shared copy, reply, run-control, and permalink actions for agent messages. */
export function TaskChatMessageActionBar({
  message,
  anchorId,
  copied,
  onCopy,
  replyTarget,
  onReply,
  canStopRun,
  runId,
  runAgentRef,
  companyId,
  isStoppingRun,
  onStopRun,
  stopRunLabel,
  stoppingRunLabel,
  stopRunVariant,
}: TaskChatMessageActionBarProps) {
  return (
    <div className="mt-2 flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Copy message"
        aria-label="Copy message"
        onClick={onCopy}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
      <TaskChatTimestamp anchorId={anchorId} createdAt={message.createdAt} />
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
          <DropdownMenuItem onClick={onCopy}>
            <Copy className="mr-2 h-3.5 w-3.5" />
            Copy message
          </DropdownMenuItem>
          {replyTarget && onReply ? (
            <DropdownMenuItem onSelect={() => onReply(replyTarget)}>
              <ReplyIcon className="mr-2 h-3.5 w-3.5" />
              Reply
            </DropdownMenuItem>
          ) : null}
          {canStopRun && onStopRun && runId ? (
            <DropdownMenuItem
              disabled={isStoppingRun}
              variant="destructive"
              onSelect={() => void onStopRun(runId)}
            >
              {stopRunVariant === "pause" ? (
                <PauseCircle className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Square className="mr-2 h-3.5 w-3.5 fill-current" />
              )}
              {isStoppingRun ? stoppingRunLabel : stopRunLabel}
            </DropdownMenuItem>
          ) : null}
          {runId && runAgentRef ? (
            <DropdownMenuItem asChild>
              <Link
                to="/$companyId/agents/$agentId/runs/$runId"
                params={{ companyId, agentId: runAgentRef, runId }}
                target="_blank"
                rel="noreferrer noopener"
              >
                <Search className="mr-2 h-3.5 w-3.5" />
                View run
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
