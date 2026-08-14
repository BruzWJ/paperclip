import type { TextMessagePart, ThreadMessage } from "@assistant-ui/react";
import { memo, useMemo } from "react";

import { TaskChatTextPart } from "./TaskChatMessageUtils";

import {
  TaskChatChainOfThought,
  TaskChatCoTPart,
} from "./TaskChatChainOfThought";

export const TaskChatTextParts = memo(function TaskChatTextParts({
  message,
  recessed = false,
  onAccent = false,
}: {
  message: ThreadMessage;
  recessed?: boolean;
  onAccent?: boolean;
}) {
  return (
    <>
      {message.content
        .filter((part): part is TextMessagePart => part.type === "text")
        .map((part, index) => (
          <TaskChatTextPart
            key={`${message.id}:text:${index}`}
            text={part.text}
            recessed={recessed}
            onAccent={onAccent}
          />
        ))}
    </>
  );
});

export function groupAssistantParts(
  content: readonly ThreadMessage["content"][number][],
): Array<
  | { type: "text"; part: TextMessagePart; index: number }
  | { type: "cot"; parts: TaskChatCoTPart[]; startIndex: number }
> {
  const groups: Array<
    | { type: "text"; part: TextMessagePart; index: number }
    | { type: "cot"; parts: TaskChatCoTPart[]; startIndex: number }
  > = [];
  let pendingCoT: TaskChatCoTPart[] = [];
  let pendingStartIndex = -1;

  const flushCoT = () => {
    if (pendingCoT.length === 0) return;
    groups.push({
      type: "cot",
      parts: pendingCoT,
      startIndex: pendingStartIndex,
    });
    pendingCoT = [];
    pendingStartIndex = -1;
  };

  content.forEach((part, index) => {
    if (part.type === "reasoning" || part.type === "tool-call") {
      if (pendingCoT.length === 0) pendingStartIndex = index;
      pendingCoT.push(part);
      return;
    }
    flushCoT();
    if (part.type === "text") {
      groups.push({ type: "text", part, index });
    }
  });
  flushCoT();

  return groups;
}

export const TaskChatAssistantParts = memo(function TaskChatAssistantParts({
  message,
  hasCoT,
}: {
  message: ThreadMessage;
  hasCoT: boolean;
}) {
  const groupedParts = useMemo(
    () => groupAssistantParts(message.content),
    [message.content],
  );
  return (
    <>
      {groupedParts.map((group) => {
        if (group.type === "text") {
          return (
            <TaskChatTextPart
              key={`${message.id}:text:${group.index}`}
              text={group.part.text}
              recessed={hasCoT}
            />
          );
        }
        return (
          <TaskChatChainOfThought
            key={`${message.id}:cot:${group.startIndex}`}
            message={message}
            cotParts={group.parts}
          />
        );
      })}
    </>
  );
});
