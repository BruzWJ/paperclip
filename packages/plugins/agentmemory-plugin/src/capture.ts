import { createHash } from "node:crypto";
import type {
  PluginContext,
  PluginEvent,
  PluginRunIssueCommentProjection,
  ProviderSafeRunTrace,
} from "@paperclipai/plugin-sdk";
import {
  AgentMemoryClient,
  type AgentMemoryObservation,
} from "./agentmemory-client.js";
import {
  memoryPartition,
  memorySessionId,
  type MemoryPartition,
} from "./memory-partitions.js";

const MEMORY_TOOL_NAMES = new Set([
  "read_issue_agent_memory",
  "read_issue_shared_memory",
  "read_company_agent_memory",
  "read_company_shared_memory",
]);
const captureQueues = new Map<string, Promise<void>>();
const MAX_TOOL_VALUE_CHARS = 8_000;

async function serializeCapture(
  key: string,
  capture: () => Promise<void>,
): Promise<void> {
  const predecessor = captureQueues.get(key) ?? Promise.resolve();
  const current = predecessor.catch(() => {}).then(capture);
  captureQueues.set(key, current);
  try {
    await current;
  } finally {
    if (captureQueues.get(key) === current) captureQueues.delete(key);
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
  const localName = name.slice(name.lastIndexOf(":") + 1);
  return MEMORY_TOOL_NAMES.has(localName);
}

function boundedToolValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= MAX_TOOL_VALUE_CHARS
      ? value
      : `${value.slice(0, MAX_TOOL_VALUE_CHARS)}\n[truncated by Paperclip]`;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "[unserializable tool value]";
  }
  return serialized.length <= MAX_TOOL_VALUE_CHARS
    ? value
    : `${serialized.slice(0, MAX_TOOL_VALUE_CHARS)}\n[truncated by Paperclip]`;
}

function observationDedupKey(input: {
  sourceKind: "run" | "comments";
  sourceId: string;
  index: number;
  observation: AgentMemoryObservation;
}): string {
  return createHash("sha256")
    .update(
      `paperclip-agentmemory-observation/v1\0${input.sourceKind}\0${input.sourceId}`
        + `\0${input.index}\0${input.observation.hookType}\0${input.observation.timestamp}`,
    )
    .digest("hex");
}

function withDedupIdentity(
  observation: AgentMemoryObservation,
  key: string,
): AgentMemoryObservation {
  const data = observation.data && typeof observation.data === "object"
    && !Array.isArray(observation.data)
    ? observation.data as Record<string, unknown>
    : { value: observation.data };
  return {
    ...observation,
    data: {
      ...data,
      tool_input: {
        paperclip_observation_key: key,
        input: data.tool_input ?? null,
      },
    },
  };
}

async function readFullRun(
  ctx: PluginContext,
  companyId: string,
  runId: string,
): Promise<ProviderSafeRunTrace> {
  let cursor: string | undefined;
  let first: ProviderSafeRunTrace | null = null;
  const turns: ProviderSafeRunTrace["turns"] = [];
  const outputComments: ProviderSafeRunTrace["outputComments"] = [];
  const seenCursors = new Set<string>();
  do {
    const page = await ctx.runtime.records.readRun({ companyId, runId, cursor });
    first ??= page;
    turns.push(...page.turns);
    outputComments.push(...page.outputComments);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error("Paperclip runtime returned a repeating run cursor");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  if (!first) throw new Error("Paperclip runtime returned no run record");
  return { ...first, turns, outputComments, nextCursor: null };
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
  return comments.sort((left, right) => left.sequence - right.sequence);
}

export function runObservations(trace: ProviderSafeRunTrace): AgentMemoryObservation[] {
  const observations: AgentMemoryObservation[] = [];
  for (const turn of trace.turns) {
    if (turn.kind === "user" && turn.text?.trim()) {
      observations.push({
        hookType: "prompt_submit",
        timestamp: turn.timestamp,
        data: { prompt: turn.text },
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
          hookType: "post_tool_use",
          timestamp: turn.completedAt ?? turn.timestamp,
          data: {
            tool_name: "paperclip_assistant_response",
            tool_input: {},
            tool_output: boundedToolValue(text),
          },
        });
      }
    }
    if (turn.kind !== "assistant" && turn.kind !== "shell") continue;
    for (const part of turn.content ?? []) {
      if (part.kind !== "tool" || isMemoryTool(part.name)) continue;
      if (part.state === "completed") {
        observations.push({
          hookType: "post_tool_use",
          timestamp: turn.completedAt ?? turn.timestamp,
          data: {
            tool_name: part.name,
            tool_input: boundedToolValue(part.input),
            tool_output: boundedToolValue(part.result ?? null),
          },
        });
      } else {
        observations.push({
          hookType: "post_tool_failure",
          timestamp: turn.completedAt ?? turn.timestamp,
          data: {
            tool_name: part.name,
            tool_input: boundedToolValue(part.input),
            error: boundedToolValue(part.errorKind ?? "tool_error"),
          },
        });
      }
    }
  }
  return observations;
}

function commentObservations(
  comments: readonly PluginRunIssueCommentProjection[],
): AgentMemoryObservation[] {
  return comments.map((comment) => ({
    hookType: "prompt_submit",
    timestamp: comment.createdAt,
    data: {
      prompt: `[Paperclip ${comment.author.kind} comment]\n${comment.body}`,
    },
  }));
}

async function recordIntoPartitions(input: {
  ctx: PluginContext;
  client: AgentMemoryClient;
  partitions: readonly MemoryPartition[];
  sourceKind: "run" | "comments";
  sourceId: string;
  title: string;
  observations: readonly AgentMemoryObservation[];
  completionScope: {
    scopeKind: "run" | "issue";
    scopeId: string;
    stateKeyPrefix: string;
  };
}): Promise<void> {
  const observations = input.observations.map((observation, index) =>
    withDedupIdentity(
      observation,
      observationDedupKey({
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        index,
        observation,
      }),
    )
  );
  for (const partition of input.partitions) {
    const completionKey = {
      scopeKind: input.completionScope.scopeKind,
      scopeId: input.completionScope.scopeId,
      stateKey: `${input.completionScope.stateKeyPrefix}:${partition.kind}`,
    };
    if (await input.ctx.state.get(completionKey)) continue;
    await input.client.recordSession({
      partition,
      sessionId: memorySessionId({
        partition,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
      }),
      title: input.title,
      observations,
    });
    await input.ctx.state.set(completionKey, true);
  }
}

async function captureIssueCommentsUnlocked(input: {
  ctx: PluginContext;
  client: AgentMemoryClient;
  companyId: string;
  issueId: string;
}): Promise<void> {
  const stateKey = {
    scopeKind: "issue" as const,
    scopeId: input.issueId,
    stateKey: "agentmemory:last-shared-comment-sequence",
  };
  const prior = await input.ctx.state.get(stateKey);
  const priorSequence = typeof prior === "number" && Number.isSafeInteger(prior)
    ? prior
    : 0;
  const comments = (await readAllComments(
    input.ctx,
    input.companyId,
    input.issueId,
  )).filter((comment) => comment.sequence > priorSequence);
  if (comments.length === 0) return;
  const maxSequence = comments.at(-1)!.sequence;
  await recordIntoPartitions({
    ctx: input.ctx,
    client: input.client,
    partitions: [
      memoryPartition("issue_shared", input),
      memoryPartition("company_shared", input),
    ],
    sourceKind: "comments",
    sourceId: `${input.issueId}:${maxSequence}`,
    title: "Paperclip shared issue comments",
    observations: commentObservations(comments),
    completionScope: {
      scopeKind: "issue",
      scopeId: input.issueId,
      stateKeyPrefix: `agentmemory:comments:${maxSequence}`,
    },
  });
  await input.ctx.state.set(stateKey, maxSequence);
}

export async function captureIssueComments(input: {
  ctx: PluginContext;
  client: AgentMemoryClient;
  companyId: string;
  issueId: string;
}): Promise<void> {
  return serializeCapture(
    `comments:${input.companyId}:${input.issueId}`,
    () => captureIssueCommentsUnlocked(input),
  );
}

export async function captureTerminalRun(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<void> {
  const payload = payloadRecord(event);
  const companyId = nonEmptyString(event.companyId);
  const runId = nonEmptyString(payload.runId) ?? nonEmptyString(event.entityId);
  const issueId = nonEmptyString(payload.issueId);
  const agentId = nonEmptyString(payload.agentId);
  if (!companyId || !runId || !issueId || !agentId) {
    throw new Error("Agent run event is missing canonical company, run, issue, or agent identity");
  }
  await serializeCapture(`run:${companyId}:${runId}`, async () => {
    const stateKey = {
      scopeKind: "run" as const,
      scopeId: runId,
      stateKey: "agentmemory:captured",
    };
    if (await ctx.state.get(stateKey)) return;

    const client = await AgentMemoryClient.connect(ctx, companyId);
    const trace = await readFullRun(ctx, companyId, runId);
    const eventOutcome = event.eventType === "agent.run.finished"
      ? "succeeded"
      : event.eventType === "agent.run.cancelled"
        ? "cancelled"
        : "failed";
    const payloadOutcome = nonEmptyString(payload.outcome);
    if (payloadOutcome && payloadOutcome !== eventOutcome) {
      throw new Error("Agent run event type and payload outcome disagree");
    }
    const reason = nonEmptyString(payload.reason);
    const terminalObservation: AgentMemoryObservation = eventOutcome === "succeeded"
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
    await recordIntoPartitions({
      ctx,
      client,
      partitions: [
        memoryPartition("issue_agent", { companyId, issueId, agentId }),
        memoryPartition("company_agent", { companyId, agentId }),
      ],
      sourceKind: "run",
      sourceId: runId,
      title: "Paperclip agent run",
      observations: [...runObservations(trace), terminalObservation],
      completionScope: {
        scopeKind: "run",
        scopeId: runId,
        stateKeyPrefix: "agentmemory:partition",
      },
    });
    await captureIssueComments({ ctx, client, companyId, issueId });
    await ctx.state.set(stateKey, true);
  });
}

export async function captureCommentEvent(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<void> {
  const payload = payloadRecord(event);
  const companyId = nonEmptyString(event.companyId);
  const issueId = nonEmptyString(payload.issueId);
  if (!companyId || !issueId) {
    throw new Error("Issue comment event is missing canonical company or issue identity");
  }
  const client = await AgentMemoryClient.connect(ctx, companyId);
  await captureIssueComments({ ctx, client, companyId, issueId });
}
