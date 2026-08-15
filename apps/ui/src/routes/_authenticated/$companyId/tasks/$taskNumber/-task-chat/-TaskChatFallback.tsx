import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Component, type ErrorInfo, type ReactNode } from "react";
import type { TaskChatMessage } from "@/lib/task-chat-messages";

type TaskChatErrorBoundaryProps = {
  resetKey: string;
  messages: readonly TaskChatMessage[];
  emptyMessage: string;
  children: ReactNode;
};

type TaskChatErrorBoundaryState = { hasError: boolean };

export class TaskChatErrorBoundary extends Component<TaskChatErrorBoundaryProps, TaskChatErrorBoundaryState> {
  override state: TaskChatErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): TaskChatErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Task chat renderer failed; showing a safe AI Elements transcript", {
      error,
      info: info.componentStack,
    });
  }

  override componentDidUpdate(previous: TaskChatErrorBoundaryProps): void {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  override render() {
    if (this.state.hasError) {
      return <TaskChatFallbackThread messages={this.props.messages} emptyMessage={this.props.emptyMessage} />;
    }
    return this.props.children;
  }
}

function fallbackAuthorLabel(message: TaskChatMessage) {
  const custom = message.metadata.custom;
  if (typeof custom.authorName === "string") return custom.authorName;
  if (message.role === "assistant") return "Agent";
  if (message.role === "user") return "You";
  return "System";
}

function fallbackTextParts(message: TaskChatMessage) {
  const lines: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text.trim()) lines.push(part.text);
    } else if (part.type === "tool-call") {
      lines.push(`Tool: ${part.toolName}`);
    }
  }
  return lines;
}

function TaskChatFallbackThread({
  messages,
  emptyMessage,
}: {
  messages: readonly TaskChatMessage[];
  emptyMessage: string;
}) {
  return (
    <Conversation className="h-(--sz-70vh)">
      <ConversationContent>
        <Message from="assistant">
          <MessageContent>
            <MessageResponse>
              {
                "The rich transcript hit an internal rendering error. This safe transcript keeps every readable message available."
              }
            </MessageResponse>
          </MessageContent>
        </Message>
        {messages.length === 0 ? (
          <ConversationEmptyState description={emptyMessage} />
        ) : (
          messages.map((message) => (
            <Message key={message.id} from={message.role === "user" ? "user" : "assistant"}>
              <MessageContent>
                <p className="text-sm text-muted-foreground">{fallbackAuthorLabel(message)}</p>
                {fallbackTextParts(message).map((line, index) => (
                  <MessageResponse key={`${message.id}:${index}`}>{line}</MessageResponse>
                ))}
              </MessageContent>
            </Message>
          ))
        )}
      </ConversationContent>
    </Conversation>
  );
}
