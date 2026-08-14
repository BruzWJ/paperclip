import { Spinner } from "@/components/ui/spinner";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ReasoningMessagePart, ThreadMessage, ToolCallMessagePart } from "@assistant-ui/react";
import { Brain, ChevronDown } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { isCoTSegmentActive } from "../../lib/task-chat-messages";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIconPicker";

import { cleanToolDisplayText, toolCountSummary } from "./TaskChatMessageUtils";

import { TaskChatToolPart, getToolIcon } from "./TaskChatToolPart";

import { TaskChatCtx, countCoTSegments, findCoTSegmentIndex } from "./TaskChatShared";

export type TaskChatCoTPart = ReasoningMessagePart | ToolCallMessagePart;

interface RollingTickerState {
  key: number;
  current: string;
  exiting: string | null;
}

export function TaskChatChainOfThought({
  message,
  cotParts,
}: {
  message: ThreadMessage;
  cotParts: readonly TaskChatCoTPart[];
}) {
  const { agentMap } = useContext(TaskChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const runAgentId = typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const authorAgentId = typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  const isMessageRunning = message.role === "assistant" && message.status?.type === "running";

  const myIndex = useMemo(() => findCoTSegmentIndex(message.content, cotParts), [message.content, cotParts]);

  const allReasoningText = cotParts
    .filter((p): p is { type: "reasoning"; text: string } => p.type === "reasoning" && !!p.text)
    .map((p) => p.text)
    .join("\n");
  const toolParts = cotParts.filter((p): p is ToolCallMessagePart => p.type === "tool-call");

  const isActive = isCoTSegmentActive({
    isMessageRunning,
    segmentIndex: myIndex,
    segmentCount: countCoTSegments(message.content),
  });
  const [expanded, setExpanded] = useState(isActive);

  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  const headerVerb = isActive ? "Working" : "Worked";

  const toolSummary = toolCountSummary(toolParts);
  const hasContent = allReasoningText.trim().length > 0 || toolParts.length > 0;

  return (
    <Collapsible open={expanded && hasContent} onOpenChange={setExpanded}>
      <CollapsibleTrigger asChild disabled={!hasContent}>
        <Button type="button" variant="ghost" className="h-auto w-full items-start justify-start">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
                {agentIcon ? (
                  <AgentIcon icon={agentIcon} className="h-4 w-4 shrink-0" />
                ) : isActive ? (
                  <Spinner className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <DomainStatus status="completed" aria-label="Completed">
                    <span className="sr-only">Completed</span>
                  </DomainStatus>
                )}
                {isActive ? <span className="shimmer-text">{headerVerb}</span> : headerVerb}
              </span>
              {toolSummary ? <span className="text-xs text-muted-foreground/40">· {toolSummary}</span> : null}
            </div>
          </div>
          {hasContent ? (
            <ChevronDown
              className={cn(
                "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform",
                expanded && "rotate-180",
              )}
            />
          ) : null}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1 py-1">
        {isActive ? (
          <>
            {allReasoningText ? <TaskChatReasoningPart text={allReasoningText} /> : null}
            {toolParts.length > 0 ? <TaskChatRollingToolPart toolParts={toolParts} /> : null}
          </>
        ) : (
          <>
            {allReasoningText ? <TaskChatReasoningPart text={allReasoningText} /> : null}
            {toolParts.map((tool) => (
              <TaskChatToolPart
                key={tool.toolCallId}
                toolName={tool.toolName}
                args={tool.args}
                argsText={tool.argsText}
                result={tool.result}
              />
            ))}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function TaskChatReasoningPart({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim());
  const lastLine = lines[lines.length - 1] ?? text.slice(-200);
  const prevRef = useRef(lastLine);
  const [ticker, setTicker] = useState<RollingTickerState>({
    key: 0,
    current: lastLine,
    exiting: null,
  });

  useEffect(() => {
    if (lastLine !== prevRef.current) {
      const prev = prevRef.current;
      prevRef.current = lastLine;
      setTicker((t) => ({ key: t.key + 1, current: lastLine, exiting: prev }));
    }
  }, [lastLine]);

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null && (
          <span
            key={`out-${ticker.key}`}
            className="cot-line-exit absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-muted-foreground/70"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-muted-foreground/70",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

export function TaskChatRollingToolPart({ toolParts }: { toolParts: ToolCallMessagePart[] }) {
  const latest = toolParts[toolParts.length - 1];
  if (!latest) return null;

  const fullText = cleanToolDisplayText(latest);

  const prevRef = useRef(fullText);
  const [ticker, setTicker] = useState<RollingTickerState>({
    key: 0,
    current: fullText,
    exiting: null,
  });

  useEffect(() => {
    if (fullText !== prevRef.current) {
      const prev = prevRef.current;
      prevRef.current = fullText;
      setTicker((t) => ({ key: t.key + 1, current: fullText, exiting: prev }));
    }
  }, [fullText]);

  const ToolIcon = getToolIcon(latest.toolName);
  const isRunning = latest.result === undefined;

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        {isRunning ? (
          <Spinner className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        ) : (
          <ToolIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        )}
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null && (
          <span
            key={`out-${ticker.key}`}
            className="cot-line-exit absolute inset-x-0 truncate text-(length:--text-compact) leading-5 text-muted-foreground/70"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) leading-5 text-muted-foreground/70",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}
