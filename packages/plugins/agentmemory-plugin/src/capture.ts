import { createHash } from "node:crypto";
import {
  pluginAgentToolName,
  type PluginBeforePromptInput,
  type PluginCanonicalSessionMessage,
  type PluginContext,
  type PluginEvent,
  type PluginRunIssueCommentProjection,
  type ProviderSafeRunTrace,
} from "@paperclipai/plugin-sdk";
import {
  AgentMemoryClient,
  type AgentMemoryObservation,
} from "./agentmemory-client.js";
import {
  memoryPartition,
  memoryObservationSessionId,
  type MemoryPartition,
} from "./memory-partitions.js";
import { MEMORY_TOOL_DEFINITIONS, PLUGIN_ID } from "./memory-tools.js";

const MEMORY_TOOL_NAMES = new Set(
  MEMORY_TOOL_DEFINITIONS.map(
    ({ declaration }) => pluginAgentToolName(PLUGIN_ID, declaration.name),
  ),
);
const captureQueues = new Map<string, Promise<void>>();
const MAX_TOOL_VALUE_CHARS = 8_000;
const SESSION_PAGE_LIMIT = 100;

async function serializeCapture<T>(
  key: string,
  capture: () => Promise<T>,
): Promise<T> {
  const predecessor = captureQueues.get(key) ?? Promise.resolve();
  const current = predecessor.catch(() => {}).then(capture);
  const tail = current.then(() => undefined, () => undefined);
  captureQueues.set(key, tail);
  try {
    return await current;
  } finally {
    if (captureQueues.get(key) === tail) captureQueues.delete(key);
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function payloadRecord(event: PluginEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function isMemoryTool(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name);
}

function boundedToolValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= MAX_TOOL_VALUE_CHARS
      ? value
      : `${value.slice(0, MAX_TOOL_VALUE_CHARS)}\n[truncated by Paperclip]`;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error("Paperclip returned a non-JSON tool value", { cause: error });
  }
  if (serialized === undefined) {
    throw new Error("Paperclip returned a non-JSON tool value");
  }
  return serialized.length <= MAX_TOOL_VALUE_CHARS
    ? value
    : `${serialized.slice(0, MAX_TOOL_VALUE_CHARS)}\n[truncated by Paperclip]`;
}

function observationIdentity(kind: string, ...coordinates: readonly unknown[]): string {
  return createHash("sha256")
    .update(
      `paperclip-agentmemory-observation/v3\0${kind}\0${coordinates
        .map((value) => JSON.stringify(value) ?? "null")
        .join("\0")}`,
    )
    .digest("hex");
}

export interface MemoryObservation {
  identity: string;
  value: AgentMemoryObservation;
}

async function readFullRunTurns(
  ctx: PluginContext,
  companyId: string,
  runId: string,
): Promise<ProviderSafeRunTrace["turns"]> {
  const first = await ctx.runtime.records.readRun({ companyId, runId });
  if (first.runId !== runId) {
    throw new Error("Paperclip returned a run outside the requested scope");
  }
  const turns: ProviderSafeRunTrace["turns"] = [...first.turns];
  const seenCursors = new Set<string>();
  let cursor = first.nextCursor ?? undefined;
  while (cursor) {
    if (seenCursors.has(cursor)) {
      throw new Error("Paperclip runtime returned a repeating run cursor");
    }
    seenCursors.add(cursor);
    const page = await ctx.runtime.records.readRun({ companyId, runId, cursor });
    if (
      page.runId !== first.runId
      || page.runKind !== first.runKind
      || page.status !== first.status
      || page.startedAt !== first.startedAt
      || page.finishedAt !== first.finishedAt
      || page.outcome !== first.outcome
    ) {
      throw new Error("Paperclip returned inconsistent pages for one run");
    }
    turns.push(...page.turns);
    cursor = page.nextCursor ?? undefined;
  }
  return turns;
}

async function readAllComments(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<PluginRunIssueCommentProjection[]> {
  let cursor: string | undefined;
  const comments: PluginRunIssueCommentProjection[] = [];
  const seenCursors = new Set<string>();
  do {
    const page = await ctx.runtime.records.readIssueComments({
      companyId,
      issueId,
      cursor,
      limit: 100,
    });
    comments.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error("Paperclip runtime returned a repeating comment cursor");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return comments;
}

export function runObservations(
  turns: readonly ProviderSafeRunTrace["turns"][number][],
  runId = "unknown-run",
): MemoryObservation[] {
  const observations: MemoryObservation[] = [];
  for (const [turnIndex, turn] of turns.entries()) {
    if (
      (turn.kind === "user" || turn.kind === "synthetic")
      && turn.text?.trim()
    ) {
      observations.push({
        identity: observationIdentity("run-turn", runId, turnIndex, "prompt"),
        value: {
          hookType: "prompt_submit",
          timestamp: turn.timestamp,
          data: { prompt: turn.text },
        },
      });
      continue;
    }
    if (turn.kind === "assistant") {
      const text = (turn.content ?? [])
        .flatMap((part) => part.kind === "text" ? [part.text] : [])
        .join("\n")
        .trim();
      if (text) {
        observations.push({
          identity: observationIdentity(
            "run-turn",
            runId,
            turnIndex,
            "assistant-text",
          ),
          value: {
            hookType: "post_tool_use",
            timestamp: turn.completedAt ?? turn.timestamp,
            data: {
              tool_name: "paperclip_assistant_response",
              tool_input: {},
              tool_output: boundedToolValue(text),
            },
          },
        });
      }
    }
    if (turn.kind !== "assistant" && turn.kind !== "shell") continue;
    for (const [partIndex, part] of (turn.content ?? []).entries()) {
      if (part.kind !== "tool" || isMemoryTool(part.name)) continue;
      if (part.state === "completed") {
        observations.push({
          identity: observationIdentity(
            "run-turn",
            runId,
            turnIndex,
            "tool",
            partIndex,
          ),
          value: {
            hookType: "post_tool_use",
            timestamp: turn.completedAt ?? turn.timestamp,
            data: {
              tool_name: part.name,
              tool_input: boundedToolValue(part.input),
              tool_output: boundedToolValue(part.result ?? null),
            },
          },
        });
      } else {
        observations.push({
          identity: observationIdentity(
            "run-turn",
            runId,
            turnIndex,
            "tool",
            partIndex,
          ),
          value: {
            hookType: "post_tool_failure",
            timestamp: turn.completedAt ?? turn.timestamp,
            data: {
              tool_name: part.name,
              tool_input: boundedToolValue(part.input),
              error: boundedToolValue(part.result ?? part.errorKind ?? "tool_error"),
            },
          },
        });
      }
    }
  }
  return observations;
}

function commentObservations(
  comments: readonly PluginRunIssueCommentProjection[],
): MemoryObservation[] {
  return comments.map((comment) => ({
    identity: observationIdentity(
      "issue-comment",
      comment.issueId,
      comment.id,
      comment.sequence,
    ),
    value: {
      hookType: "prompt_submit",
      timestamp: comment.createdAt,
      data: {
        prompt: `[Paperclip ${comment.author.kind} comment]\n${comment.body}`,
      },
    },
  }));
}

interface CapturedMemoryReceipt {
  partition: MemoryPartition;
  sessionId: string;
}

async function recordIntoPartitions(input: {
  client: AgentMemoryClient;
  partitions: readonly MemoryPartition[];
  title: string;
  observations: readonly MemoryObservation[];
}): Promise<CapturedMemoryReceipt[]> {
  const allowedKinds = input.partitions.map((partition) => partition.kind);
  if (new Set(allowedKinds).size !== allowedKinds.length) {
    throw new Error("AgentMemory partition capture contains duplicate partitions");
  }
  const receipts: CapturedMemoryReceipt[] = [];
  for (const partition of input.partitions) {
    for (const observation of input.observations) {
      const sessionId = memoryObservationSessionId({
        partition,
        observationIdentity: observation.identity,
      });
      await input.client.recordObservation({
        partition,
        sessionId,
        title: input.title,
        observation: observation.value,
      });
      receipts.push({ partition, sessionId });
    }
  }
  return receipts;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function messageText(value: Record<string, unknown>): string | null {
  return nonEmptyString(value.text);
}

function toolStateValue(state: Record<string, unknown>): unknown {
  const output = Object.fromEntries(
    ["structured", "content", "result"]
      .filter((key) => state[key] !== undefined)
      .map((key) => [key, state[key]]),
  );
  return Object.keys(output).length > 0 ? output : null;
}

function messageTimestamp(
  message: Record<string, unknown>,
  fallback: string,
  field: "created" | "completed",
): string {
  const time = jsonRecord(message.time);
  const value = time?.[field];
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : fallback;
}

function sessionToolObservation(
  part: Record<string, unknown>,
  timestamp: string,
): AgentMemoryObservation | null {
  const name = nonEmptyString(part.name);
  const state = jsonRecord(part.state);
  if (!name || !state || isMemoryTool(name)) return null;
  const status = nonEmptyString(state.status);
  if (status === "completed") {
    return {
      hookType: "post_tool_use",
      timestamp,
      data: {
        tool_name: name,
        tool_input: boundedToolValue(state.input ?? null),
        tool_output: boundedToolValue(toolStateValue(state)),
      },
    };
  }
  if (status !== "error") return null;
  const error = jsonRecord(state.error);
  return {
    hookType: "post_tool_failure",
    timestamp,
    data: {
      tool_name: name,
      tool_input: boundedToolValue(state.input ?? null),
      error: boundedToolValue(
        toolStateValue(state) ?? error?.type ?? "tool_error",
      ),
    },
  };
}

/**
 * Projects only provider-useful, current-agent facts from a canonical Session
 * message. Reasoning and AgentMemory tool calls are deliberately not retained.
 */
export function sessionMessageObservations(
  record: PluginCanonicalSessionMessage,
  input: Pick<PluginBeforePromptInput, "agentId" | "sourceMessageId">,
): MemoryObservation[] {
  const message = jsonRecord(record.message);
  if (!message) return [];
  const type = nonEmptyString(message.type);
  const belongsToAgent = record.row.agentId === input.agentId;
  const isCurrentSource = record.row.id === input.sourceMessageId;
  if (type === "user" || type === "synthetic") {
    const text = messageText(message);
    if ((!belongsToAgent && !isCurrentSource) || !text) return [];
    return [{
      identity: observationIdentity(
        "session-message",
        record.row.sessionId,
        record.row.id,
        record.row.modelStateSeq,
        "prompt",
      ),
      value: {
        hookType: "prompt_submit",
        timestamp: messageTimestamp(message, record.row.timeCreated, "created"),
        data: { prompt: text },
      },
    }];
  }
  if (type === "shell" && belongsToAgent) {
    const command = nonEmptyString(message.command);
    const output = typeof message.output === "string" ? message.output : null;
    const time = jsonRecord(message.time);
    if (
      !command
      || output === null
      || typeof time?.completed !== "number"
      || !Number.isFinite(time.completed)
    ) {
      return [];
    }
    return [{
      identity: observationIdentity(
        "session-message",
        record.row.sessionId,
        record.row.id,
        record.row.modelStateSeq,
        "shell",
      ),
      value: {
        hookType: "post_tool_use",
        timestamp: messageTimestamp(
          message,
          record.row.timeUpdated || record.row.timeCreated,
          "completed",
        ),
        data: {
          tool_name: "shell",
          tool_input: boundedToolValue({ command }),
          tool_output: boundedToolValue({ output }),
        },
      },
    }];
  }
  if (type !== "assistant" || !belongsToAgent) return [];

  const timestamp = messageTimestamp(
    message,
    record.row.timeUpdated || record.row.timeCreated,
    "completed",
  );
  const content = jsonArray(message.content)
    .map(jsonRecord)
    .filter((part): part is Record<string, unknown> => part !== null);
  const observations: MemoryObservation[] = [];
  const time = jsonRecord(message.time);
  const assistantCompleted = typeof time?.completed === "number"
    && Number.isFinite(time.completed);
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => nonEmptyString(part.text))
    .filter((part): part is string => part !== null)
    .join("\n")
    .trim();
  if (text && assistantCompleted) {
    observations.push({
      identity: observationIdentity(
        "session-message",
        record.row.sessionId,
        record.row.id,
        record.row.modelStateSeq,
        "assistant-text",
      ),
      value: {
        hookType: "post_tool_use",
        timestamp,
        data: {
          tool_name: "paperclip_assistant_response",
          tool_input: {},
          tool_output: boundedToolValue(text),
        },
      },
    });
  }
  for (const [partIndex, part] of content.entries()) {
    if (part.type !== "tool") continue;
    const observation = sessionToolObservation(part, timestamp);
    if (observation) {
      observations.push({
        identity: observationIdentity(
          "session-message",
          record.row.sessionId,
          record.row.id,
          record.row.modelStateSeq,
          "tool",
          partIndex,
        ),
        value: observation,
      });
    }
  }
  return observations;
}

function sessionStateIdentity(
  input: PluginBeforePromptInput,
  backendIdentity: string,
): string {
  return createHash("sha256")
    .update(
      `paperclip-agentmemory-checkpoint/v2\0${backendIdentity}`
        + `\0${input.sessionId}\0${input.agentId}`,
    )
    .digest("hex");
}

function sessionCheckpointKey(
  input: PluginBeforePromptInput,
  backendIdentity: string,
) {
  return {
    scopeKind: "issue" as const,
    scopeId: input.issueId,
    stateKey:
      `agentmemory:session-checkpoint-v3:${sessionStateIdentity(input, backendIdentity)}`,
  };
}

interface CaptureCheckpoint {
  sequence: number;
  receipts: Array<{
    kind: MemoryPartition["kind"];
    sessionId: string;
  }>;
}

function parseCaptureCheckpoint(value: unknown): CaptureCheckpoint | null {
  if (value === null) return null;
  const record = jsonRecord(value);
  if (
    !record
    || !Number.isSafeInteger(record.sequence)
    || (record.sequence as number) < -1
    || !Array.isArray(record.receipts)
  ) {
    throw new Error("AgentMemory capture checkpoint is invalid");
  }
  const receipts = record.receipts.map((value) => {
    const receipt = jsonRecord(value);
    if (
      !receipt
      || (
        receipt.kind !== "issue_agent"
        && receipt.kind !== "issue_shared"
        && receipt.kind !== "company_agent"
        && receipt.kind !== "company_shared"
      )
      || typeof receipt.sessionId !== "string"
      || !receipt.sessionId
    ) {
      throw new Error("AgentMemory capture checkpoint is invalid");
    }
    return {
      kind: receipt.kind as MemoryPartition["kind"],
      sessionId: receipt.sessionId,
    };
  });
  if (new Set(receipts.map(({ kind }) => kind)).size !== receipts.length) {
    throw new Error("AgentMemory capture checkpoint is invalid");
  }
  return { sequence: record.sequence as number, receipts };
}

function checkpointFromReceipts(
  sequence: number,
  receipts: readonly CapturedMemoryReceipt[],
): CaptureCheckpoint {
  const latest = new Map<MemoryPartition["kind"], string>();
  for (const receipt of receipts) {
    latest.set(receipt.partition.kind, receipt.sessionId);
  }
  return {
    sequence,
    receipts: [...latest].map(([kind, sessionId]) => ({ kind, sessionId })),
  };
}

async function checkpointReceiptsExist(input: {
  client: AgentMemoryClient;
  checkpoint: CaptureCheckpoint;
  partitions: readonly MemoryPartition[];
}): Promise<boolean> {
  if (input.checkpoint.receipts.length !== input.partitions.length) return false;
  for (const partition of input.partitions) {
    const receipt = input.checkpoint.receipts.find(
      ({ kind }) => kind === partition.kind,
    );
    if (
      !receipt
      || !await input.client.hasObservationReceipt(partition, receipt.sessionId)
    ) {
      return false;
    }
  }
  return true;
}

function privateCaptureQueueKey(input: {
  companyId: string;
  issueId: string;
  agentId: string;
  backendIdentity: string;
}): string {
  return `private:${input.backendIdentity}:${input.companyId}:${input.issueId}:${input.agentId}`;
}

function terminalRunStateKey(runId: string, backendIdentity: string) {
  return {
    scopeKind: "run" as const,
    scopeId: runId,
    stateKey: `agentmemory:terminal-checkpoint-v3:${backendIdentity}`,
  };
}

async function readSessionMessages(input: {
  ctx: PluginContext;
  prompt: PluginBeforePromptInput;
  afterSeq: number;
}): Promise<PluginCanonicalSessionMessage[]> {
  const messages: PluginCanonicalSessionMessage[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await input.ctx.runtime.records.readSession({
      companyId: input.prompt.companyId,
      sessionId: input.prompt.sessionId,
      snapshotHighWaterSeq: input.prompt.snapshotHighWaterSeq,
      messages: {
        changedAfterSeq: input.afterSeq,
        cursor,
        limit: SESSION_PAGE_LIMIT,
      },
    });
    if (
      result.session.companyId !== input.prompt.companyId
      || result.session.issueId !== input.prompt.issueId
      || result.session.sessionId !== input.prompt.sessionId
      || result.snapshotHighWaterSeq !== input.prompt.snapshotHighWaterSeq
    ) {
      throw new Error("Paperclip returned a canonical Session outside the before-prompt scope");
    }
    messages.push(...result.messages.items);
    cursor = result.messages.nextCursor ?? undefined;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error("Paperclip runtime returned a repeating Session message cursor");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return messages;
}

function sessionObservations(
  records: readonly PluginCanonicalSessionMessage[],
  prompt: PluginBeforePromptInput,
): MemoryObservation[] {
  return records.flatMap((record) => sessionMessageObservations(record, prompt));
}

function privatePartitions(prompt: PluginBeforePromptInput): MemoryPartition[] {
  return [
    memoryPartition("issue_agent", prompt),
    memoryPartition("company_agent", prompt),
  ];
}

async function captureSessionRange(input: {
  ctx: PluginContext;
  client: AgentMemoryClient;
  prompt: PluginBeforePromptInput;
  records: readonly PluginCanonicalSessionMessage[];
}): Promise<void> {
  const observations = sessionObservations(input.records, input.prompt);
  const receipts = observations.length > 0
    ? await recordIntoPartitions({
      client: input.client,
      partitions: privatePartitions(input.prompt),
      title: "Paperclip canonical Session messages",
      observations,
    })
    : [];
  if (receipts.length === 0) {
    throw new Error("AgentMemory prompt capture produced no durable observation");
  }
  await input.ctx.state.set(
    sessionCheckpointKey(input.prompt, input.client.backendIdentity),
    checkpointFromReceipts(input.prompt.sourceMessageSeq, receipts),
  );
}

/**
 * Captures every newly visible canonical Session message through the exact
 * prompt source before allowing provider dispatch.
 */
export async function capturePromptSession(input: {
  ctx: PluginContext;
  client: AgentMemoryClient;
  prompt: PluginBeforePromptInput;
}): Promise<void> {
  return serializeCapture(
    privateCaptureQueueKey({
      ...input.prompt,
      backendIdentity: input.client.backendIdentity,
    }),
    async () => {
      if (
        input.prompt.snapshotHighWaterSeq !== input.prompt.sourceMessageSeq
        || input.prompt.sourceMessageSeq < 0
      ) {
        throw new Error("AgentMemory requires the prompt snapshot to end at its exact source");
      }
      const checkpointKey = sessionCheckpointKey(
        input.prompt,
        input.client.backendIdentity,
      );
      const checkpoint = parseCaptureCheckpoint(
        await input.ctx.state.get(checkpointKey),
      );
      const partitions = privatePartitions(input.prompt);
      const checkpointValid = checkpoint
        ? await checkpointReceiptsExist({
          client: input.client,
          checkpoint,
          partitions,
        })
        : false;
      const afterSeq = checkpointValid && checkpoint ? checkpoint.sequence : -1;
      if (afterSeq > input.prompt.snapshotHighWaterSeq) {
        throw new Error("AgentMemory Session checkpoint exceeds the prompt snapshot");
      }
      const messages = afterSeq < input.prompt.snapshotHighWaterSeq
        ? await readSessionMessages({
            ctx: input.ctx,
            prompt: input.prompt,
            afterSeq,
          })
        : [];
      const seenMessageIds = new Set<string>();
      let previousModelStateSeq = afterSeq;
      let previousMessageId = "";
      for (const record of messages) {
        if (
          !Number.isSafeInteger(record.row.modelStateSeq)
          || record.row.modelStateSeq <= afterSeq
          || record.row.modelStateSeq > input.prompt.snapshotHighWaterSeq
          || !Number.isSafeInteger(record.row.seq)
          || record.row.seq < 0
          || record.row.seq > record.row.modelStateSeq
          || seenMessageIds.has(record.row.id)
          || record.row.companyId !== input.prompt.companyId
          || record.row.issueId !== input.prompt.issueId
          || record.row.sessionId !== input.prompt.sessionId
          || record.row.modelStateSeq < previousModelStateSeq
          || (
            record.row.modelStateSeq === previousModelStateSeq
            && record.row.id <= previousMessageId
          )
        ) {
          throw new Error("Paperclip returned a Session message outside the requested sequence window");
        }
        seenMessageIds.add(record.row.id);
        previousModelStateSeq = record.row.modelStateSeq;
        previousMessageId = record.row.id;
      }
      if (afterSeq < input.prompt.sourceMessageSeq) {
        const source = messages.find((record) =>
          record.row.id === input.prompt.sourceMessageId
        );
        const message = source ? jsonRecord(source.message) : null;
        if (
          !source
          || source.row.seq !== input.prompt.sourceMessageSeq
          || source.row.modelStateSeq !== input.prompt.sourceMessageSeq
          || (message?.type !== "user" && message?.type !== "synthetic")
          || message.text !== input.prompt.sourceText
        ) {
          throw new Error("Paperclip canonical Session read did not contain the exact prompt source");
        }
      }

      if (afterSeq < input.prompt.sourceMessageSeq) {
        await captureSessionRange({
          ...input,
          records: messages,
        });
      }
    },
  );
}

async function captureIssueCommentsUnlocked(input: {
  ctx: PluginContext;
  client: AgentMemoryClient;
  companyId: string;
  issueId: string;
  maxSequence?: number;
}): Promise<void> {
  const backendIdentity = input.client.backendIdentity;
  const stateKey = {
    scopeKind: "issue" as const,
    scopeId: input.issueId,
    stateKey: `agentmemory:shared-comment-checkpoint-v3:${backendIdentity}`,
  };
  const partitions = [
    memoryPartition("issue_shared", input),
    memoryPartition("company_shared", input),
  ];
  const checkpoint = parseCaptureCheckpoint(await input.ctx.state.get(stateKey));
  const checkpointValid = checkpoint
    ? await checkpointReceiptsExist({
      client: input.client,
      checkpoint,
      partitions,
    })
    : false;
  const priorSequence = checkpointValid && checkpoint ? checkpoint.sequence : -1;
  const allComments = await readAllComments(
    input.ctx,
    input.companyId,
    input.issueId,
  );
  let previousSequence = -1;
  for (const comment of allComments) {
    if (
      !Number.isSafeInteger(comment.sequence)
      || comment.sequence < 0
      || comment.sequence <= previousSequence
      || comment.issueId !== input.issueId
    ) {
      throw new Error("Paperclip returned invalid canonical issue-comment ordering");
    }
    previousSequence = comment.sequence;
  }
  if (
    input.maxSequence !== undefined
    && priorSequence > input.maxSequence
  ) {
    return;
  }
  const comments = allComments.filter((comment) =>
    comment.sequence > priorSequence
    && (input.maxSequence === undefined || comment.sequence <= input.maxSequence)
  );
  for (const comment of comments) {
    const receipts = await recordIntoPartitions({
      client: input.client,
      partitions,
      title: "Paperclip shared issue comment",
      observations: commentObservations([comment]),
    });
    await input.ctx.state.set(
      stateKey,
      checkpointFromReceipts(comment.sequence, receipts),
    );
  }
}

/**
 * Captures shared comments through the exact prompt snapshot cutoff.
 */
export async function capturePromptComments(input: {
  ctx: PluginContext;
  client: AgentMemoryClient;
  companyId: string;
  issueId: string;
  snapshotHighWaterSeq: number;
}): Promise<void> {
  return serializeCapture(
    `comments:${input.client.backendIdentity}:${input.companyId}:${input.issueId}`,
    () => captureIssueCommentsUnlocked({
      ctx: input.ctx,
      client: input.client,
      companyId: input.companyId,
      issueId: input.issueId,
      maxSequence: input.snapshotHighWaterSeq,
    }),
  );
}

export async function captureTerminalRun(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<void> {
  const payload = payloadRecord(event);
  const companyId = nonEmptyString(event.companyId);
  const runId = nonEmptyString(payload.runId);
  const issueId = nonEmptyString(payload.issueId);
  const agentId = nonEmptyString(payload.agentId);
  if (
    !companyId
    || !runId
    || !issueId
    || !agentId
    || payload.companyId !== companyId
    || event.entityId !== runId
    || event.entityType !== "agent_run"
    || event.actorId !== agentId
    || event.actorType !== "agent"
  ) {
    throw new Error("Agent run event is missing canonical company, run, issue, or agent identity");
  }
  const client = await AgentMemoryClient.connect(ctx);
  await serializeCapture(privateCaptureQueueKey({
    companyId,
    issueId,
    agentId,
    backendIdentity: client.backendIdentity,
  }), async () => {
    const stateKey = terminalRunStateKey(runId, client.backendIdentity);
    const partitions = [
      memoryPartition("issue_agent", { companyId, issueId, agentId }),
      memoryPartition("company_agent", { companyId, agentId }),
    ];
    const checkpoint = parseCaptureCheckpoint(await ctx.state.get(stateKey));
    if (
      checkpoint
      && await checkpointReceiptsExist({ client, checkpoint, partitions })
    ) {
      return;
    }

    const turns = await readFullRunTurns(ctx, companyId, runId);
    const eventOutcome = event.eventType === "agent.run.finished"
      ? "succeeded"
      : event.eventType === "agent.run.cancelled"
        ? "cancelled"
        : "failed";
    const payloadOutcome = nonEmptyString(payload.outcome);
    if (payloadOutcome !== eventOutcome) {
      throw new Error("Agent run event type and payload outcome disagree");
    }
    const reason = nonEmptyString(payload.reason);
    const terminalValue: AgentMemoryObservation = eventOutcome === "succeeded"
      ? {
        hookType: "post_tool_use",
        timestamp: event.occurredAt,
        data: {
          tool_name: "paperclip_agent_run_terminal",
          tool_input: { outcome: eventOutcome },
          tool_output: { outcome: eventOutcome, reason },
        },
      }
      : {
        hookType: "post_tool_failure",
        timestamp: event.occurredAt,
        data: {
          tool_name: "paperclip_agent_run_terminal",
          tool_input: { outcome: eventOutcome },
          error: reason ?? eventOutcome,
        },
      };
    const terminalObservation: MemoryObservation = {
      identity: observationIdentity(
        "run-terminal",
        runId,
        event.eventId,
        eventOutcome,
      ),
      value: terminalValue,
    };
    const receipts = await recordIntoPartitions({
      client,
      partitions,
      title: "Paperclip agent run",
      observations: [...runObservations(turns, runId), terminalObservation],
    });
    await ctx.state.set(stateKey, checkpointFromReceipts(0, receipts));
  });
}
