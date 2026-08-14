import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import type { ThreadMessage } from "@assistant-ui/react";
import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { MarkdownBody } from "../MarkdownBody";

import { commentDateLabel } from "./TaskChatMessageUtils";

export type TaskChatErrorBoundaryProps = {
  resetKey: string;
  messages: readonly ThreadMessage[];
  emptyMessage: string;
  variant: "full" | "embedded";
  children: ReactNode;
};

export type TaskChatErrorBoundaryState = {
  hasError: boolean;
};

export class TaskChatErrorBoundary extends Component<
  TaskChatErrorBoundaryProps,
  TaskChatErrorBoundaryState
> {
  override state: TaskChatErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): TaskChatErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      "Task chat renderer failed; falling back to safe transcript view",
      {
        error,
        info: info.componentStack,
      },
    );
  }

  override componentDidUpdate(prevProps: TaskChatErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  override render() {
    if (this.state.hasError) {
      return (
        <TaskChatFallbackThread
          messages={this.props.messages}
          emptyMessage={this.props.emptyMessage}
          variant={this.props.variant}
        />
      );
    }
    return this.props.children;
  }
}

export function fallbackAuthorLabel(message: ThreadMessage) {
  const custom = message.metadata?.custom as
    Record<string, unknown> | undefined;
  if (typeof custom?.["authorName"] === "string") return custom["authorName"];
  if (typeof custom?.["runAgentName"] === "string")
    return custom["runAgentName"];
  if (message.role === "assistant") return "Agent";
  if (message.role === "user") return "You";
  return "System";
}

export function fallbackTextParts(message: ThreadMessage) {
  const contentLines: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text.trim().length > 0) contentLines.push(part.text);
      continue;
    }
    if (part.type === "tool-call") {
      const lines = [`Tool: ${part.toolName}`];
      if (part.argsText?.trim()) lines.push(`Args:\n${part.argsText}`);
      if (typeof part.result === "string" && part.result.trim())
        lines.push(`Result:\n${part.result}`);
      contentLines.push(lines.join("\n\n"));
    }
  }

  const custom = message.metadata?.custom as
    Record<string, unknown> | undefined;
  if (
    contentLines.length === 0 &&
    typeof custom?.["waitingText"] === "string" &&
    custom["waitingText"].trim()
  ) {
    contentLines.push(custom["waitingText"]);
  }
  return contentLines;
}

export function TaskChatFallbackThread({
  messages,
  emptyMessage,
  variant,
}: {
  messages: readonly ThreadMessage[];
  emptyMessage: string;
  variant: "full" | "embedded";
}) {
  return (
    <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
      <Alert variant="destructive">
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>Chat renderer hit an internal state error.</AlertTitle>
        <AlertDescription>
          Showing a safe fallback transcript instead of crashing the tasks page.
        </AlertDescription>
      </Alert>

      {messages.length === 0 ? (
        <Empty>
          <EmptyDescription>{emptyMessage}</EmptyDescription>
        </Empty>
      ) : (
        <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
          {messages.map((message) => {
            const lines = fallbackTextParts(message);
            return (
              <Card
                key={message.id}
                className="block border-border/60 bg-card/70 px-4 py-3"
              >
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="font-medium text-foreground">
                    {fallbackAuthorLabel(message)}
                  </span>
                  {message.createdAt ? (
                    <span className="text-(length:--text-micro) text-muted-foreground">
                      {commentDateLabel(message.createdAt)}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {lines.length > 0 ? (
                    lines.map((line, index) => (
                      <MarkdownBody key={`${message.id}:fallback:${index}`}>
                        {line}
                      </MarkdownBody>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No message content.
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
