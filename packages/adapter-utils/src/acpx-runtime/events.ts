import type { AcpRuntimeEvent } from "acpx/runtime";

type RuntimeToolCall = Extract<AcpRuntimeEvent, { type: "tool_call" }>;
type RuntimeToolCallContent = NonNullable<RuntimeToolCall["content"]>[number];
type RuntimeToolCallLocation = NonNullable<RuntimeToolCall["locations"]>[number];

export type NormalizedAcpSessionEvent =
  | {
      readonly kind: "message_chunk";
      readonly channel: "assistant" | "thought";
      readonly content: { readonly type: "text"; readonly text: string };
    }
  | {
      readonly kind: "tool_call";
      readonly toolCallId: string;
      readonly title: string;
      readonly toolKind?: RuntimeToolCall["kind"];
      readonly status?: "pending" | "in_progress" | "completed" | "failed";
      readonly content?: readonly RuntimeToolCallContent[];
      readonly locations?: readonly RuntimeToolCallLocation[];
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
    }
  | {
      readonly kind: "tool_call_update";
      readonly toolCallId: string;
      readonly title?: string | null;
      readonly toolKind?: RuntimeToolCall["kind"] | null;
      readonly status?: "pending" | "in_progress" | "completed" | "failed" | null;
      readonly content?: readonly RuntimeToolCallContent[] | null;
      readonly locations?: readonly RuntimeToolCallLocation[] | null;
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
    };
