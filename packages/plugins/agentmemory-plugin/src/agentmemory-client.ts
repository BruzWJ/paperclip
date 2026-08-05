import type {
  EnvSecretRefBinding,
  PluginContext,
} from "@paperclipai/plugin-sdk";
import type { MemoryPartition } from "./memory-partitions.js";

export interface AgentMemoryConfig {
  baseUrl: string;
  apiSecret: EnvSecretRefBinding;
}

export interface AgentMemoryObservation {
  hookType: "prompt_submit" | "post_tool_use" | "post_tool_failure";
  timestamp: string;
  data: unknown;
}

const MAX_OBSERVATIONS_PER_SESSION = 400;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized.startsWith("127.");
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
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      "AgentMemory baseUrl must use https unless it targets loopback",
    );
  }
  return baseUrl;
}

function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && (value as Record<string, unknown>).type === "secret_ref"
      && typeof (value as Record<string, unknown>).secretId === "string",
  );
}

function parseConfig(value: Record<string, unknown>): AgentMemoryConfig {
  const baseUrl = normalizeAgentMemoryBaseUrl(value.baseUrl);
  if (!isSecretRef(value.apiSecret)) {
    throw new Error("AgentMemory apiSecret must be a Paperclip secret reference");
  }
  return { baseUrl, apiSecret: value.apiSecret };
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class AgentMemoryClient {
  private constructor(
    private readonly ctx: PluginContext,
    private readonly config: AgentMemoryConfig,
    private readonly secret: string,
  ) {}

  static async connect(ctx: PluginContext, companyId: string): Promise<AgentMemoryClient> {
    const config = parseConfig(await ctx.config.get(companyId));
    const secret = await ctx.secrets.resolve(config.apiSecret, {
      companyId,
      configPath: "apiSecret",
    });
    if (!secret.trim()) {
      throw new Error("AgentMemory apiSecret resolved to an empty value");
    }
    return new AgentMemoryClient(ctx, config, secret);
  }

  private async request(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.ctx.http.fetch(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const parsed = await responseBody(response);
    if (!response.ok) {
      const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      throw new Error(
        `AgentMemory request ${path} failed with ${response.status}: ${detail.slice(0, 500)}`,
      );
    }
    return parsed;
  }

  async search(partition: MemoryPartition, query: string): Promise<unknown> {
    return this.request("/agentmemory/search", {
      query,
      limit: 8,
      project: partition.project,
      format: "narrative",
      token_budget: 2_000,
      agentId: partition.agentId,
    });
  }

  async recordSession(input: {
    partition: MemoryPartition;
    sessionId: string;
    title: string;
    observations: readonly AgentMemoryObservation[];
  }): Promise<void> {
    if (input.observations.length === 0) return;
    for (
      let offset = 0, chunkIndex = 0;
      offset < input.observations.length;
      offset += MAX_OBSERVATIONS_PER_SESSION, chunkIndex += 1
    ) {
      const observations = input.observations.slice(
        offset,
        offset + MAX_OBSERVATIONS_PER_SESSION,
      );
      const sessionId = input.observations.length <= MAX_OBSERVATIONS_PER_SESSION
        ? input.sessionId
        : `${input.sessionId}_part_${chunkIndex + 1}`;
      const common = {
        sessionId,
        project: input.partition.project,
        cwd: input.partition.cwd,
      };
      const started = await this.request("/agentmemory/session/start", {
        ...common,
        title: input.title,
        agentId: input.partition.agentId,
      });
      const startedSession = started && typeof started === "object"
        && !Array.isArray(started)
        ? (started as Record<string, unknown>).session
        : null;
      if (
        !startedSession
        || typeof startedSession !== "object"
        || Array.isArray(startedSession)
        || (startedSession as Record<string, unknown>).id !== sessionId
      ) {
        throw new Error("AgentMemory session/start returned an invalid response");
      }

      let captureError: unknown;
      try {
        for (const observation of observations) {
          const result = await this.request("/agentmemory/observe", {
            ...common,
            hookType: observation.hookType,
            timestamp: observation.timestamp,
            data: observation.data,
          });
          if (
            !result
            || typeof result !== "object"
            || Array.isArray(result)
            || !(
              typeof (result as Record<string, unknown>).observationId === "string"
              || (result as Record<string, unknown>).deduplicated === true
            )
          ) {
            const detail = JSON.stringify(result);
            throw new Error(
              `AgentMemory observe rejected the observation${detail ? `: ${detail.slice(0, 500)}` : ""}`,
            );
          }
        }
      } catch (error) {
        captureError = error;
      }

      try {
        const ended = await this.request("/agentmemory/session/end", { sessionId });
        if (
          !ended
          || typeof ended !== "object"
          || Array.isArray(ended)
          || (ended as Record<string, unknown>).success !== true
        ) {
          throw new Error("AgentMemory session/end returned an invalid response");
        }
      } catch (error) {
        if (!captureError) throw error;
      }
      if (captureError) throw captureError;
    }
  }
}

export function renderSearchResult(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.trim()) {
      return record.text;
    }
    if (Array.isArray(record.results) && record.results.length === 0) {
      return "No matching memories were found in this partition.";
    }
  }
  return JSON.stringify(value, null, 2);
}
