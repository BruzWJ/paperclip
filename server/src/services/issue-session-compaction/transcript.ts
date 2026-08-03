import { isMedia } from "./media.js";
import { AbortedError } from "./message-support.js";
import type {
  AssistantMessageInfo,
  CompactionPart,
  MessagePart,
  UserMessageInfo,
  WithParts,
} from "./types.js";

export const COMPACTION_TRANSCRIPT_VERSION =
  "paperclip.compaction-transcript/v1" as const;
export const COMPACTION_TRANSCRIPT_HEADER =
  "PAPERCLIP_COMPACTION_TRANSCRIPT_V1" as const;
export const COMPACTION_INSTRUCTION_HEADER =
  "PAPERCLIP_COMPACTION_INSTRUCTION_V1" as const;
export const PRUNED_TOOL_OUTPUT = "[Old tool result content cleared]" as const;
export const INTERRUPTED_TOOL_OUTPUT =
  "[Tool execution was interrupted]" as const;
export const TOOL_OUTPUT_MAX_CHARS = 2_000;

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export type CompactionTranscriptPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      toolName: string;
      input: CanonicalJsonValue;
      status: "completed" | "error" | "pending" | "running";
      output: string;
    };

export interface CompactionTranscriptEntry {
  id: string;
  role: "user" | "assistant" | "system" | "shell";
  parts: CompactionTranscriptPart[];
}

export interface CompactionTranscript {
  version: typeof COMPACTION_TRANSCRIPT_VERSION;
  entries: CompactionTranscriptEntry[];
}

function canonicalizeJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError(`${path} must not contain a JSON cycle`);
    }
    ancestors.add(value);
    const result = value.map((item, index) =>
      canonicalizeJsonValue(item, `${path}[${index}]`, ancestors),
    );
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    if (ancestors.has(record)) {
      throw new TypeError(`${path} must not contain a JSON cycle`);
    }
    ancestors.add(record);
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = canonicalizeJsonValue(
        record[key],
        `${path}.${key}`,
        ancestors,
      );
    }
    ancestors.delete(record);
    return result;
  }
  throw new TypeError(`${path} must be JSON-compatible`);
}

export function canonicalJsonValue(value: unknown): CanonicalJsonValue {
  return canonicalizeJsonValue(value, "value", new Set());
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function truncateToolOutput(
  text: string,
  maxChars = TOOL_OUTPUT_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`;
}

function toolOutput(
  part: Extract<MessagePart, { type: "tool" }>,
  truncateCompletedOutput: boolean,
): string {
  switch (part.state.status) {
    case "completed":
      if (part.state.time.compacted) return PRUNED_TOOL_OUTPUT;
      return truncateCompletedOutput
        ? truncateToolOutput(part.state.output)
        : part.state.output;
    case "error": {
      const interruptedOutput = part.state.metadata?.output;
      return part.state.metadata?.interrupted === true &&
        typeof interruptedOutput === "string"
        ? interruptedOutput
        : part.state.error;
    }
    case "pending":
    case "running":
      return INTERRUPTED_TOOL_OUTPUT;
  }
}

function transcriptParts(
  message: WithParts,
  options: { transformForPrompt: boolean },
): CompactionTranscriptPart[] {
  const parts: CompactionTranscriptPart[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && !part.ignored) {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "reasoning") {
      parts.push({ type: "reasoning", text: part.text });
      continue;
    }
    if (part.type === "file" && message.info.role === "user") {
      if (!options.transformForPrompt) continue;
      if (
        part.mime === "text/plain" ||
        part.mime === "application/x-directory"
      ) {
        continue;
      }
      parts.push({
        type: "text",
        text: isMedia(part.mime)
          ? `[Attached ${part.mime}: ${part.filename ?? "file"}]`
          : `[Attached file ${part.mime}: ${part.filename ?? "file"}]`,
      });
      continue;
    }
    if (part.type === "tool" && message.info.role === "assistant") {
      parts.push({
        type: "tool",
        toolCallId: part.callID,
        toolName: part.tool,
        input: canonicalJsonValue(part.state.input),
        status: part.state.status,
        output: toolOutput(part, options.transformForPrompt),
      });
    }
  }
  return parts;
}

function transcriptRole(
  message: WithParts,
): CompactionTranscriptEntry["role"] | undefined {
  if (message.info.role === "user") return "user";
  if (message.info.role === "assistant") return "assistant";
  if (message.info.kind === "system") return "system";
  if (message.info.kind === "shell") return "shell";
  return undefined;
}

function shouldIncludeAssistant(message: WithParts): boolean {
  if (message.info.role !== "assistant" || !message.info.error) return true;
  if (!AbortedError.isInstance(message.info.error)) return false;
  return message.parts.some(
    (part) => part.type !== "step-start" && part.type !== "reasoning",
  );
}

export function buildCompactionTranscript(
  messages: readonly WithParts[],
  options: { transformForPrompt: boolean },
): CompactionTranscript {
  const entries: CompactionTranscriptEntry[] = [];
  for (const message of messages) {
    if (
      message.info.role === "user" &&
      message.parts.some((part) => part.type === "compaction")
    ) {
      continue;
    }
    if (!shouldIncludeAssistant(message)) continue;
    const role = transcriptRole(message);
    if (!role) continue;
    let parts = transcriptParts(message, options);
    if (role === "shell") {
      parts = parts.map((part) =>
        part.type === "text"
          ? { type: "text", text: `Shell command: ${part.text}` }
          : part,
      );
    }
    if (parts.length === 0) continue;
    entries.push({ id: message.info.id, role, parts });
  }
  return { version: COMPACTION_TRANSCRIPT_VERSION, entries };
}

export function serializeCompactionTranscript(
  messages: readonly WithParts[],
  options: { transformForPrompt: boolean },
): string {
  return JSON.stringify(buildCompactionTranscript(messages, options));
}

export function buildCompactionPrompt(input: {
  messages: readonly WithParts[];
  instruction: string;
}): string {
  const transcript = serializeCompactionTranscript(input.messages, {
    transformForPrompt: true,
  });
  return `${COMPACTION_TRANSCRIPT_HEADER}\n${transcript}\n${COMPACTION_INSTRUCTION_HEADER}\n${input.instruction}`;
}

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[];
  const completed = new Set<string>();
  let retain: string | undefined;
  for (const msg of msgs) {
    result.push(msg);
    if (retain) {
      if (msg.info.id === retain) break;
      continue;
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find(
        (item): item is CompactionPart => item.type === "compaction",
      );
      if (!part) continue;
      if (!part.tail_start_id) break;
      retain = part.tail_start_id;
      if (msg.info.id === retain) break;
      continue;
    }
    if (
      msg.info.role === "assistant" &&
      msg.info.summary &&
      msg.info.finish &&
      !msg.info.error
    ) {
      completed.add(msg.info.parentID!);
    }
  }
  result.reverse();
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some(
        (item): item is CompactionPart =>
          item.type === "compaction" && item.tail_start_id !== undefined,
      ),
  );
  const compaction = result[compactionIndex];
  const part = compaction?.parts.find(
    (item): item is CompactionPart =>
      item.type === "compaction" && item.tail_start_id !== undefined,
  );
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1;
  const tailIndex = part?.tail_start_id
    ? result.findIndex((msg) => msg.info.id === part.tail_start_id)
    : -1;
  if (
    tailIndex >= 0 &&
    tailIndex < compactionIndex &&
    summaryIndex > compactionIndex
  ) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ];
  }
  return result;
}

export function latest(msgs: WithParts[]) {
  let user: UserMessageInfo | undefined;
  let assistant: AssistantMessageInfo | undefined;
  let finished: AssistantMessageInfo | undefined;
  for (const msg of msgs) {
    const info = msg.info;
    if (info.role === "user" && (!user || info.id > user.id)) user = info;
    if (info.role === "assistant" && (!assistant || info.id > assistant.id)) {
      assistant = info;
    }
    if (
      info.role === "assistant" &&
      info.finish &&
      (!finished || info.id > finished.id)
    ) {
      finished = info;
    }
  }
  const pendingCompactions = msgs.flatMap((message) =>
    finished && message.info.id <= finished.id
      ? []
      : message.parts.filter(
          (part): part is CompactionPart => part.type === "compaction",
        ),
  );
  return { user, assistant, finished, pendingCompactions };
}
