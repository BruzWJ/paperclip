import { useEffect, useMemo, useRef } from "react";
import {
  useExternalStoreRuntime,
  type ThreadMessage,
  type AppendMessage,
  type ExternalStoreAdapter,
} from "@assistant-ui/react";

export interface PaperclipIssueRuntimeOwnerChange {
  ownerAgentId: string;
}

export interface PaperclipIssueRuntimeSendOptions {
  body: string;
  ownerChange?: PaperclipIssueRuntimeOwnerChange;
  mentionAgentId?: string;
  replyToCommentId?: string;
}

interface UsePaperclipIssueRuntimeOptions {
  messages: readonly ThreadMessage[];
  isRunning: boolean;
  onSend: (options: PaperclipIssueRuntimeSendOptions) => Promise<void>;
  onCancel?: (() => Promise<void>) | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readTextContent(message: AppendMessage) {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function usePaperclipIssueRuntime({
  messages,
  isRunning,
  onSend,
  onCancel,
}: UsePaperclipIssueRuntimeOptions) {
  const onSendRef = useRef(onSend);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  const adapter = useMemo<ExternalStoreAdapter<ThreadMessage>>(() => ({
    messages,
    isRunning,
    onNew: async (message) => {
      const body = readTextContent(message);
      if (!body.trim()) return;

      const custom = asRecord(message.runConfig?.custom);
      const ownerChangeRecord = asRecord(custom?.ownerChange);
      const ownerChange =
        ownerChangeRecord &&
        typeof ownerChangeRecord.ownerAgentId === "string" &&
        ownerChangeRecord.ownerAgentId.length > 0
          ? { ownerAgentId: ownerChangeRecord.ownerAgentId }
          : undefined;
      const mentionAgentId =
        typeof custom?.mentionAgentId === "string" && custom.mentionAgentId.length > 0
          ? custom.mentionAgentId
          : undefined;
      const replyToCommentId =
        typeof custom?.replyToCommentId === "string" && custom.replyToCommentId.length > 0
          ? custom.replyToCommentId
          : undefined;

      await onSendRef.current({
        body,
        ownerChange,
        mentionAgentId,
        replyToCommentId,
      });
    },
    ...(onCancel ? {
      onCancel: async () => {
        await onCancelRef.current?.();
      },
    } : {}),
  }), [messages, isRunning, !!onCancel]);

  return useExternalStoreRuntime(adapter);
}
