import { Spinner } from "@/components/ui/spinner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import type { ThreadMessage } from "@assistant-ui/react";
import { ChevronDown } from "lucide-react";
import { useContext, useState } from "react";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIconPicker";

import {
  AGENT_COMMENT_BUBBLE_WIDTH_CLASS,
  TaskChatCtx,
  TaskChatImmediateParentLabel,
  getThreadMessageCopyText,
  replyTargetForMessage,
  resolveAssistantMessageFoldedState,
} from "./TaskChatShared";
import {
  TaskChatFollowUpBadge,
  TaskChatSourceTrustIndicator,
  useTaskChatCopy,
} from "./TaskChatMessagePrimitives";

import { TaskChatAssistantParts } from "./TaskChatMessageParts";

import { TaskChatMessageActionBar } from "./TaskChatMessageActionBar";
import { commentDateLabel, initialsForName } from "./TaskChatMessageUtils";

export function TaskChatAssistantMessage({
  message,
  isRunActive,
  isStoppingRun,
}: {
  message: ThreadMessage;
  isRunActive: boolean;
  isStoppingRun: boolean;
}) {
  const companyId = useCompanyRouteId();
  const {
    agentMap,
    onStopRun,
    stopRunLabel = "Stop run",
    stoppingRunLabel = "Stopping...",
    stopRunVariant = "stop",
    onReply,
  } = useContext(TaskChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId = typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const authorName =
    typeof custom.authorName === "string"
      ? custom.authorName
      : typeof custom.runAgentName === "string"
        ? custom.runAgentName
        : "Agent";
  const authorAgentId = typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId = typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runAgentRef = runAgentId;
  const runStatus = typeof custom.runStatus === "string" ? custom.runStatus : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  const commentId = typeof custom.commentId === "string" ? custom.commentId : null;
  const sourceTrustIndicator = (
    <TaskChatSourceTrustIndicator appearance="status" value={custom.sourceTrust} />
  );
  const notices = Array.isArray(custom.notices)
    ? custom.notices.filter((notice): notice is string => typeof notice === "string" && notice.length > 0)
    : [];
  const waitingText = typeof custom.waitingText === "string" ? custom.waitingText : "";
  const isRunning = message.role === "assistant" && message.status?.type === "running";
  const canStopRun = Boolean(runId) && (isRunActive || runStatus === "queued" || runStatus === "running");
  const chainOfThoughtLabel =
    typeof custom.chainOfThoughtLabel === "string" ? custom.chainOfThoughtLabel : null;
  const hasCoT = message.content.some((p) => p.type === "reasoning" || p.type === "tool-call");
  const isFoldable = !isRunning && !!chainOfThoughtLabel;
  const [folded, setFolded] = useState(isFoldable);
  const [prevFoldKey, setPrevFoldKey] = useState({
    messageId: message.id,
    isFoldable,
  });
  const { copied, copy } = useTaskChatCopy("Unable to copy message");
  const copyText = getThreadMessageCopyText(message);
  const replyTarget = replyTargetForMessage(message, authorName);

  // Derive fold state synchronously during render (not in useEffect) so the
  // browser never paints the un-folded intermediate state — prevents the
  // visible "jump" when loading a page with already-folded work sections.
  if (message.id !== prevFoldKey.messageId || isFoldable !== prevFoldKey.isFoldable) {
    const nextFolded = resolveAssistantMessageFoldedState({
      messageId: message.id,
      currentFolded: folded,
      isFoldable,
      previousMessageId: prevFoldKey.messageId,
      previousIsFoldable: prevFoldKey.isFoldable,
    });
    setPrevFoldKey({ messageId: message.id, isFoldable });
    if (nextFolded !== folded) {
      setFolded(nextFolded);
    }
  }

  const followUpRequested = custom.followUpRequested === true;
  const followUpBadge = <TaskChatFollowUpBadge requested={followUpRequested} />;

  const kind = typeof custom.kind === "string" ? custom.kind : null;
  const hasCommentText = message.content.some(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
  );
  // A genuine posted agent comment (kind "comment" with real text) renders in a
  // left-aligned neutral bubble — the mirror of the human blue bubble. Run
  // activity (chain-of-thought, tool calls, waiting shimmer, "worked N min")
  // keeps the existing flat / metadata treatment (PAP-95 rev 6).
  const isGenuineComment = kind === "comment" && !!commentId && !isRunning && hasCommentText;

  const agentAvatar = (
    <Avatar size="sm" className="shrink-0">
      {agentIcon ? (
        <AvatarFallback>
          <AgentIcon icon={agentIcon} className="h-3.5 w-3.5" />
        </AvatarFallback>
      ) : (
        <AvatarFallback>{initialsForName(authorName)}</AvatarFallback>
      )}
    </Avatar>
  );

  const messageActionBar = (
    <TaskChatMessageActionBar
      message={message}
      anchorId={anchorId}
      copied={copied}
      onCopy={() => copy(copyText)}
      replyTarget={replyTarget}
      onReply={onReply}
      canStopRun={canStopRun}
      runId={runId}
      runAgentRef={runAgentRef}
      companyId={companyId}
      isStoppingRun={isStoppingRun}
      onStopRun={onStopRun}
      stopRunLabel={stopRunLabel}
      stoppingRunLabel={stoppingRunLabel}
      stopRunVariant={stopRunVariant}
    />
  );

  // Genuine agent comment → neutral left-aligned bubble (mirror of the human
  // blue bubble in TaskChatUserMessage). See PAP-95 rev 6.
  if (isGenuineComment) {
    return (
      <div id={anchorId}>
        <TaskChatImmediateParentLabel custom={custom} />
        <Message className="group py-1.5">
          <MessageContent className="items-start gap-0">
            {/* Icon + name together in a header ABOVE the bubble (PAP-95 rev 7). */}
            <MessageHeader className="mb-1 gap-1.5 px-1">
              <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                {agentIcon ? (
                  <AgentIcon icon={agentIcon} className="h-4 w-4" />
                ) : (
                  <Avatar size="sm" className="size-5">
                    <AvatarFallback className="text-(length:--text-nano)">
                      {initialsForName(authorName)}
                    </AvatarFallback>
                  </Avatar>
                )}
              </span>
              <span className="text-sm font-medium text-foreground">{authorName}</span>
              {sourceTrustIndicator}
              {followUpBadge}
            </MessageHeader>
            {/* Agent response bubble. */}
            <Bubble variant="outline" className={cn("min-w-0", AGENT_COMMENT_BUBBLE_WIDTH_CLASS)}>
              <BubbleContent className="break-words overflow-x-auto overflow-y-visible rounded-bl-(--rad-4) bg-card px-3 py-2 text-sm text-foreground">
                <div className="min-w-0 max-w-full space-y-3">
                  <TaskChatAssistantParts message={message} hasCoT={false} />
                  {notices.length > 0 ? (
                    <div className="space-y-2">
                      {notices.map((notice, index) => (
                        <Alert key={`${message.id}:notice:${index}`}>
                          <AlertDescription>{notice}</AlertDescription>
                        </Alert>
                      ))}
                    </div>
                  ) : null}
                </div>
              </BubbleContent>
            </Bubble>
            {messageActionBar}
          </MessageContent>
        </Message>
      </div>
    );
  }

  return (
    <div id={anchorId}>
      <TaskChatImmediateParentLabel custom={custom} />
      <Message className="group items-start gap-2.5 py-1.5">
        <MessageAvatar className="self-start bg-transparent">{agentAvatar}</MessageAvatar>

        <Collapsible open={!folded} onOpenChange={(open) => setFolded(!open)} asChild>
          <MessageContent className="gap-0">
            {isFoldable ? (
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start px-0 py-0.5 text-left"
                >
                  <span className="text-sm font-medium text-foreground">{authorName}</span>
                  {sourceTrustIndicator}
                  <span className="text-xs text-muted-foreground/60">
                    {chainOfThoughtLabel?.toLowerCase()}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {message.createdAt ? (
                      <span className="text-(length:--text-micro) text-muted-foreground/50">
                        {commentDateLabel(message.createdAt)}
                      </span>
                    ) : null}
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 text-muted-foreground/40 transition-transform",
                        !folded && "rotate-180",
                      )}
                    />
                  </span>
                </Button>
              </CollapsibleTrigger>
            ) : (
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{authorName}</span>
                {sourceTrustIndicator}
                {followUpBadge}
                {isRunning ? <DomainStatus status="running">Running</DomainStatus> : null}
              </div>
            )}

            <CollapsibleContent className="contents">
              <div className="space-y-3">
                <TaskChatAssistantParts message={message} hasCoT={hasCoT} />
                {message.content.length === 0 && waitingText ? (
                  <div className="rounded-lg px-1 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
                        {agentIcon ? (
                          <AgentIcon icon={agentIcon} className="h-4 w-4 shrink-0" />
                        ) : (
                          <Spinner className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="shimmer-text">{waitingText}</span>
                      </span>
                    </div>
                  </div>
                ) : null}
                {notices.length > 0 ? (
                  <div className="space-y-2">
                    {notices.map((notice, index) => (
                      <Alert key={`${message.id}:notice:${index}`}>
                        <AlertDescription>{notice}</AlertDescription>
                      </Alert>
                    ))}
                  </div>
                ) : null}
              </div>

              {messageActionBar}
            </CollapsibleContent>
          </MessageContent>
        </Collapsible>
      </Message>
    </div>
  );
}
