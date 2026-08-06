import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  memoryPartitionOwnsSessionId,
  type MemoryPartition,
} from "./memory-partitions.js";

interface AgentMemoryConfig {
  baseUrl: string;
  apiSecret: string;
}

export interface AgentMemoryObservation {
  hookType: "prompt_submit" | "post_tool_use" | "post_tool_failure";
  timestamp: string;
  data: unknown;
}

interface AgentMemoryNarrativeSearchItem {
  obsId: string;
  sessionId: string;
  title: string;
  narrative: string;
  score: number;
  timestamp: string;
}

export interface AgentMemoryNarrativeSearchResult {
  format: "narrative";
  results: AgentMemoryNarrativeSearchItem[];
  text: string;
  tokens_used: number;
  tokens_budget: number;
  truncated: boolean;
}

interface AgentMemoryHealth {
  status: "healthy" | "degraded" | "critical";
  service: "agentmemory";
  version: string;
}

const OBSERVATION_RECEIPT_POLL_INTERVAL_MS = 250;
const OBSERVATION_RECEIPT_POLL_ATTEMPTS = 120;

type ObservationReceiptStatus =
  | { kind: "missing" }
  | { kind: "pending" }
  | { kind: "complete"; observationId: string; timestamp: string };

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return normalized === "localhost"
    || normalized === "::1"
    || (isIP(normalized) === 4 && normalized.split(".")[0] === "127");
}

export function normalizeAgentMemoryBaseUrl(value: unknown): string {
  const baseUrl = typeof value === "string"
    ? value.trim().replace(/\/+$/, "")
    : "";
  if (!baseUrl) throw new Error("AgentMemory baseUrl is not configured");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("AgentMemory baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("AgentMemory baseUrl must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "AgentMemory baseUrl must not contain credentials, a query, or a fragment",
    );
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      "AgentMemory baseUrl must use https unless it targets loopback",
    );
  }
  return baseUrl;
}

export function parseAgentMemoryConfig(
  value: unknown,
): AgentMemoryConfig {
  if (!isRecord(value)) {
    throw new Error("AgentMemory config must be an object");
  }
  const unsupportedKey = Object.keys(value)
    .find((key) => key !== "baseUrl" && key !== "apiSecret");
  if (unsupportedKey) {
    throw new Error(
      `AgentMemory config contains unsupported field: ${unsupportedKey}`,
    );
  }
  const baseUrl = normalizeAgentMemoryBaseUrl(value.baseUrl);
  const apiSecret = typeof value.apiSecret === "string" ? value.apiSecret : "";
  if (!apiSecret.trim()) {
    throw new Error("AgentMemory apiSecret is not configured");
  }
  return { baseUrl, apiSecret };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function jsonResponseBody(
  response: Response,
  path: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    throw new Error(`AgentMemory request ${path} returned an empty response`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`AgentMemory request ${path} returned invalid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`AgentMemory request ${path} returned an invalid response`);
  }
  return parsed;
}

async function responseBody(response: Response, path: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`AgentMemory request ${path} failed with ${response.status}`);
  }
  return jsonResponseBody(response, path);
}

function parseNarrativeSearchResult(
  value: Record<string, unknown>,
): AgentMemoryNarrativeSearchResult {
  if (
    value.format !== "narrative"
    || typeof value.text !== "string"
    || !Array.isArray(value.results)
    || typeof value.tokens_used !== "number"
    || !Number.isFinite(value.tokens_used)
    || typeof value.tokens_budget !== "number"
    || !Number.isFinite(value.tokens_budget)
    || typeof value.truncated !== "boolean"
  ) {
    throw new Error("AgentMemory search returned an invalid narrative response");
  }
  const results = value.results.map((item) => {
    if (
      !isRecord(item)
      || typeof item.obsId !== "string"
      || typeof item.sessionId !== "string"
      || typeof item.title !== "string"
      || typeof item.narrative !== "string"
      || typeof item.score !== "number"
      || !Number.isFinite(item.score)
      || typeof item.timestamp !== "string"
    ) {
      throw new Error("AgentMemory search returned an invalid narrative result");
    }
    return {
      obsId: item.obsId,
      sessionId: item.sessionId,
      title: item.title,
      narrative: item.narrative,
      score: item.score,
      timestamp: item.timestamp,
    };
  });
  return {
    format: "narrative",
    results,
    text: value.text,
    tokens_used: value.tokens_used,
    tokens_budget: value.tokens_budget,
    truncated: value.truncated,
  };
}

export class AgentMemoryClient {
  readonly backendIdentity: string;

  private constructor(
    private readonly ctx: PluginContext,
    private readonly config: AgentMemoryConfig,
  ) {
    this.backendIdentity = createHash("sha256")
      .update(`paperclip-agentmemory-backend/v1\0${config.baseUrl}`)
      .digest("hex");
  }

  static async connect(ctx: PluginContext): Promise<AgentMemoryClient> {
    const config = parseAgentMemoryConfig(await ctx.config.get());
    return new AgentMemoryClient(ctx, config);
  }

  private async request(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.ctx.http.fetch(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return responseBody(response, path);
  }

  private async read(path: string): Promise<Record<string, unknown>> {
    const response = await this.ctx.http.fetch(`${this.config.baseUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.config.apiSecret}` },
    });
    return responseBody(response, path);
  }

  private async observationReceiptStatus(
    partition: MemoryPartition,
    sessionId: string,
  ): Promise<ObservationReceiptStatus> {
    const query = new URLSearchParams({
      sessionId,
      // The session id is a Paperclip-owned opaque capability. Wildcarding
      // this one exact receipt lookup lets us detect a corrupted wrong-agent
      // row instead of mistaking it for absence and writing a duplicate.
      agentId: "*",
    });
    const result = await this.read(`/agentmemory/observations?${query}`);
    if (!Array.isArray(result.observations)) {
      throw new Error("AgentMemory observations returned an invalid response");
    }
    if (result.observations.length > 1) {
      throw new Error(
        "AgentMemory deterministic observation session contains multiple observations",
      );
    }
    if (result.observations.length === 0) return { kind: "missing" };
    const observation = result.observations[0];
    const complete = isRecord(observation)
      && observation.sessionId === sessionId
      && observation.agentId === partition.agentId
      && typeof observation.id === "string"
      && observation.id.length > 0
      && typeof observation.timestamp === "string"
      && typeof observation.type === "string"
      && typeof observation.title === "string"
      && Array.isArray(observation.facts)
      && typeof observation.narrative === "string"
      && Array.isArray(observation.concepts)
      && Array.isArray(observation.files)
      && typeof observation.importance === "number"
      && Number.isFinite(observation.importance);
    if (!complete) return { kind: "pending" };
    return {
      kind: "complete",
      observationId: observation.id as string,
      timestamp: observation.timestamp as string,
    };
  }

  async hasObservationReceipt(
    partition: MemoryPartition,
    sessionId: string,
  ): Promise<boolean> {
    return (await this.observationReceiptStatus(partition, sessionId)).kind
      === "complete";
  }

  private async waitForObservationReceipt(
    partition: MemoryPartition,
    sessionId: string,
    expected?: { observationId?: string; timestamp?: string },
  ): Promise<void> {
    for (let attempt = 0; attempt < OBSERVATION_RECEIPT_POLL_ATTEMPTS; attempt += 1) {
      const receipt = await this.observationReceiptStatus(partition, sessionId);
      if (
        receipt.kind === "complete"
        && (expected?.observationId === undefined
          || receipt.observationId === expected.observationId)
        && (expected?.timestamp === undefined
          || receipt.timestamp === expected.timestamp)
      ) {
        return;
      }
      if (attempt + 1 < OBSERVATION_RECEIPT_POLL_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, OBSERVATION_RECEIPT_POLL_INTERVAL_MS);
        });
      }
    }
    throw new Error(
      "AgentMemory did not produce a compressed observation receipt",
    );
  }

  async search(
    partition: MemoryPartition,
    query: string,
  ): Promise<AgentMemoryNarrativeSearchResult> {
    const response = await this.request("/agentmemory/search", {
      query,
      limit: 8,
      project: partition.project,
      format: "narrative",
      token_budget: 2_000,
      agentId: partition.agentId,
    });
    const parsed = parseNarrativeSearchResult(response);
    const results = parsed.results.filter(({ sessionId }) =>
      memoryPartitionOwnsSessionId(partition, sessionId)
    );
    return {
      ...parsed,
      results,
      text: results
        .map(({ title, narrative }, index) =>
          `${index + 1}. ${title}\n${narrative}`
        )
        .join("\n\n"),
    };
  }

  async health(): Promise<AgentMemoryHealth> {
    const path = "/agentmemory/health";
    const response = await this.ctx.http.fetch(`${this.config.baseUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.config.apiSecret}` },
    });
    const parsed = await jsonResponseBody(response, path);
    if (
      (parsed.status !== "healthy"
        && parsed.status !== "degraded"
        && parsed.status !== "critical")
      || parsed.service !== "agentmemory"
      || typeof parsed.version !== "string"
      || !parsed.version
      || response.status !== (parsed.status === "critical" ? 503 : 200)
    ) {
      throw new Error("AgentMemory health returned an invalid response");
    }
    return {
      status: parsed.status,
      service: parsed.service,
      version: parsed.version,
    };
  }

  /**
   * Records exactly one observation in its deterministic AgentMemory session.
   * A compressed row, rather than the raw row written first by AgentMemory,
   * is the acknowledgement that the observation is available to search.
   */
  async recordObservation(input: {
    partition: MemoryPartition;
    sessionId: string;
    title: string;
    observation: AgentMemoryObservation;
  }): Promise<void> {
    const common = {
      sessionId: input.sessionId,
      project: input.partition.project,
      cwd: input.partition.cwd,
    };
    const existing = await this.observationReceiptStatus(
      input.partition,
      input.sessionId,
    );
    if (existing.kind === "complete") return;
    if (existing.kind === "pending") {
      await this.waitForObservationReceipt(input.partition, input.sessionId);
      return;
    }

    const started = await this.request("/agentmemory/session/start", {
      ...common,
      title: input.title,
      agentId: input.partition.agentId,
    });
    const startedSession = started.session;
    if (
      !isRecord(startedSession)
      || startedSession.id !== input.sessionId
      || startedSession.project !== input.partition.project
      || startedSession.cwd !== input.partition.cwd
      || startedSession.agentId !== input.partition.agentId
      || startedSession.status !== "active"
      || typeof started.context !== "string"
    ) {
      throw new Error("AgentMemory session/start returned an invalid response");
    }

    const result = await this.request("/agentmemory/observe", {
      ...common,
      hookType: input.observation.hookType,
      timestamp: input.observation.timestamp,
      data: input.observation.data,
    });
    if (
      !(typeof result.observationId === "string" && result.observationId.length > 0)
      && !(result.deduplicated === true && result.sessionId === input.sessionId)
    ) {
      throw new Error("AgentMemory observe rejected the observation");
    }
    await this.waitForObservationReceipt(input.partition, input.sessionId, {
      observationId: typeof result.observationId === "string"
        ? result.observationId
        : undefined,
      timestamp: input.observation.timestamp,
    });
  }
}
