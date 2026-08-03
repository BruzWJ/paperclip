/** Paperclip's message and persistence types for recovery compaction. */

export type MessageID = string;

export interface CompactionConfig {
  auto?: boolean;
  prune?: boolean;
  tail_turns?: number;
  preserve_recent_tokens?: number;
  reserved?: number;
}

export interface Config {
  compaction?: CompactionConfig;
}

export interface ProviderModel {
  providerID: string;
  id: string;
  variant?: string;
  api: {
    id: string;
    npm: string;
  };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
}

export interface TokenUsage {
  total: number;
  input: number;
  output: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface UserMessageInfo {
  id: MessageID;
  role: "user";
  /** The persisted message source, never inferred from its lowered role. */
  kind?: "source" | "synthetic" | "compaction-request";
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
    variant?: string;
  };
  format?: unknown;
  tools?: unknown;
  system?: unknown;
}

export interface AssistantMessageInfo {
  id: MessageID;
  role: "assistant";
  parentID?: MessageID;
  providerID?: string;
  modelID?: string;
  summary?: boolean;
  finish?: string;
  error?: unknown;
}

/**
 * Canonical non-turn records stay typed in the bridge rather than being
 * coerced into user input. They are intentionally not provider-lowered by
 * the compaction converter.
 */
export interface AuxiliaryMessageInfo {
  id: MessageID;
  role: "auxiliary";
  kind: "system" | "shell" | "control";
}

export type MessageInfo =
  | UserMessageInfo
  | AssistantMessageInfo
  | AuxiliaryMessageInfo;

export interface TextPart {
  type: "text";
  text: string;
  ignored?: boolean;
  metadata?: Record<string, any>;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
  metadata?: Record<string, any>;
}

export interface StepStartPart {
  type: "step-start";
}

export interface FilePart {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
}

export interface CompactionPart {
  type: "compaction";
  tail_start_id?: MessageID;
  auto?: boolean;
  overflow?: boolean;
}

export interface ToolAttachment {
  mime: string;
  url: string;
  filename?: string;
}

export interface CompletedToolState {
  status: "completed";
  input: unknown;
  output: string;
  attachments?: ToolAttachment[];
  metadata?: Record<string, unknown>;
  time: {
    start?: number;
    end?: number;
    compacted?: number;
  };
}

export interface ErrorToolState {
  status: "error";
  input: unknown;
  error: string;
  metadata?: {
    interrupted?: boolean;
    output?: string;
    [key: string]: unknown;
  };
  time?: Record<string, number | undefined>;
}

export interface PendingToolState {
  status: "pending" | "running";
  input: unknown;
  time?: Record<string, number | undefined>;
}

export interface ToolPart {
  type: "tool";
  tool: string;
  callID: string;
  state: CompletedToolState | ErrorToolState | PendingToolState;
  metadata?: Record<string, any>;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | StepStartPart
  | FilePart
  | CompactionPart
  | ToolPart;

export interface WithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

export type UserWithParts = WithParts & {
  info: UserMessageInfo;
};

export type AssistantWithParts = WithParts & {
  info: AssistantMessageInfo;
};
