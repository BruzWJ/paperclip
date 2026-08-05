import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type {
  PluginContext,
  PluginEvent,
  ProviderSafeRunTrace,
} from "@paperclipai/plugin-sdk";
import {
  AgentMemoryClient,
  normalizeAgentMemoryBaseUrl,
} from "../src/agentmemory-client.js";
import { captureTerminalRun, runObservations } from "../src/capture.js";
import manifest from "../src/manifest.js";
import { memoryPartition } from "../src/memory-partitions.js";
import plugin from "../src/worker.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

async function startAgentMemoryStub(
  requests: Array<{ path: string; body: Record<string, unknown> }>,
): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = chunks.length > 0
        ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
        : {};
      requests.push({ path: request.url ?? "", body });
      response.writeHead(200, { "content-type": "application/json" });
      const responseBody = request.url === "/agentmemory/search"
        ? { format: "narrative", text: "remembered context", results: [{}] }
        : request.url === "/agentmemory/session/start"
          ? { session: { id: body.sessionId, status: "active" }, context: "" }
          : request.url === "/agentmemory/observe"
            ? { observationId: `obs-${requests.length}` }
            : { success: true };
      response.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const secretRef = {
  type: "secret_ref" as const,
  secretId: "00000000-0000-4000-8000-000000000099",
};

describe("AgentMemory manifest", () => {
  it("declares only the four read-only memory tools", () => {
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([
      "read_issue_agent_memory",
      "read_issue_shared_memory",
      "read_company_agent_memory",
      "read_company_shared_memory",
    ]);
    expect(manifest.capabilities).toContain("runtime.context.read");
    expect(manifest.capabilities).toContain("runtime.records.read");
    expect(manifest.entrypoints.ui).toBeUndefined();
  });

  it("uses deterministic opaque partition coordinates", () => {
    const input = {
      companyId: "company-secret",
      issueId: "issue-secret",
      agentId: "agent-secret",
    };
    const first = memoryPartition("issue_agent", input);
    const second = memoryPartition("issue_agent", input);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain("company-secret");
    expect(JSON.stringify(first)).not.toContain("issue-secret");
    expect(JSON.stringify(first)).not.toContain("agent-secret");
  });

  it("uses a distinct exact AgentMemory agent identity for every partition", () => {
    const input = {
      companyId: "company-secret",
      issueId: "issue-secret",
      agentId: "agent-secret",
    };
    const partitions = [
      memoryPartition("issue_agent", input),
      memoryPartition("issue_shared", input),
      memoryPartition("company_agent", input),
      memoryPartition("company_shared", input),
    ];
    expect(new Set(partitions.map((partition) => partition.agentId)).size).toBe(4);
    expect(partitions.every((partition) => partition.agentId !== "*")).toBe(true);
  });
});

describe("AgentMemory recall", () => {
  it("searches active issue-agent memory through the managed HTTP client", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const baseUrl = await startAgentMemoryStub(requests);
    const harness = createTestHarness({
      manifest,
      config: { baseUrl, apiSecret: secretRef },
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool(
      "read_issue_agent_memory",
      {
        issueId: "00000000-0000-4000-8000-000000000002",
        query: "What decisions were made?",
      },
    );

    expect(result).toMatchObject({ content: "remembered context" });
    const search = requests.find((request) => request.path === "/agentmemory/search");
    expect(search?.body.query).toBe("What decisions were made?");
    expect(search?.body.project).not.toContain("00000000-0000-4000-8000-000000000002");
  });

  it("denies company memory when the current context matrix cannot list company issues", async () => {
    const harness = createTestHarness({
      manifest,
      config: { baseUrl: "http://127.0.0.1:3111", apiSecret: secretRef },
    });
    await plugin.definition.setup(harness.ctx);
    await expect(harness.executeTool(
      "read_company_shared_memory",
      { query: "company direction" },
    )).resolves.toMatchObject({
      error: expect.stringContaining("list_company_issues"),
    });
  });
});

describe("AgentMemory REST contract", () => {
  function clientContext(
    responder: (path: string, body: Record<string, unknown>) => unknown,
  ): PluginContext {
    return {
      config: {
        get: async () => ({
          baseUrl: "https://agentmemory.example",
          apiSecret: secretRef,
        }),
      },
      secrets: { resolve: async () => "test-secret" },
      http: {
        fetch: async (url: string | URL, init?: RequestInit) => {
          const path = new URL(url).pathname;
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response(JSON.stringify(responder(path, body)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    } as unknown as PluginContext;
  }

  it("rejects plaintext non-loopback services", () => {
    expect(() => normalizeAgentMemoryBaseUrl("http://memory.internal:3111"))
      .toThrow(/https unless it targets loopback/);
    expect(normalizeAgentMemoryBaseUrl("http://127.0.0.1:3111"))
      .toBe("http://127.0.0.1:3111");
  });

  it("rejects a logical observation failure returned with HTTP 201/200 semantics", async () => {
    const client = await AgentMemoryClient.connect(clientContext((path, body) => {
      if (path === "/agentmemory/session/start") {
        return { session: { id: body.sessionId }, context: "" };
      }
      if (path === "/agentmemory/observe") {
        return { success: false, error: "Session observation limit reached (500)" };
      }
      return { success: true };
    }), "company");

    await expect(client.recordSession({
      partition: memoryPartition("company_shared", { companyId: "company" }),
      sessionId: "session",
      title: "capture",
      observations: [{
        hookType: "prompt_submit",
        timestamp: "2026-08-05T00:00:00.000Z",
        data: { prompt: "hello" },
      }],
    })).rejects.toThrow(/observe rejected/);
  });

  it("chunks capture below AgentMemory's per-session observation limit", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = await AgentMemoryClient.connect(clientContext((path, body) => {
      requests.push({ path, body });
      if (path === "/agentmemory/session/start") {
        return { session: { id: body.sessionId }, context: "" };
      }
      if (path === "/agentmemory/observe") {
        return { observationId: `obs-${requests.length}` };
      }
      return { success: true };
    }), "company");
    const observations = Array.from({ length: 401 }, (_, index) => ({
      hookType: "prompt_submit" as const,
      timestamp: `2026-08-05T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      data: { prompt: `prompt-${index}` },
    }));

    await client.recordSession({
      partition: memoryPartition("company_shared", { companyId: "company" }),
      sessionId: "session",
      title: "capture",
      observations,
    });

    const starts = requests.filter((request) =>
      request.path === "/agentmemory/session/start"
    );
    expect(starts.map((request) => request.body.sessionId)).toEqual([
      "session_part_1",
      "session_part_2",
    ]);
    expect(requests.filter((request) => request.path === "/agentmemory/observe"))
      .toHaveLength(401);
  });
});

describe("AgentMemory automatic capture", () => {
  it("drops reasoning and memory-tool recursion from private run observations", () => {
    const observations = runObservations({
      runId: "run-a",
      runKind: "productive",
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      outcome: "succeeded",
      turns: [
        {
          kind: "assistant",
          timestamp: "2026-08-05T00:00:00.000Z",
          content: [
            { kind: "reasoning", text: "secret reasoning" },
            { kind: "text", text: "public final" },
            {
              kind: "tool",
              name: "lookup",
              state: "completed",
              input: { query: "safe" },
              result: { answer: "safe" },
            },
            {
              kind: "tool",
              name: "paperclip.agentmemory:read_issue_agent_memory",
              state: "completed",
              input: { query: "old" },
              result: { memory: "recursive" },
            },
          ],
        },
        {
          kind: "shell",
          timestamp: "2026-08-05T00:00:01.000Z",
          content: [{
            kind: "tool",
            name: "shell",
            state: "completed",
            input: { command: "pnpm test" },
            result: { output: "passed" },
          }],
        },
      ],
      outputComments: [],
      nextCursor: null,
    });
    const serialized = JSON.stringify(observations);
    expect(serialized).toContain("public final");
    expect(serialized).toContain("lookup");
    expect(serialized).toContain("pnpm test");
    expect(serialized).not.toContain("secret reasoning");
    expect(serialized).not.toContain("read_issue_agent_memory");
    expect(serialized).not.toContain("recursive");
  });

  it("records terminal runs into private and shared partitions and advances idempotency state", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const baseUrl = await startAgentMemoryStub(requests);
    const state = new Map<string, unknown>();
    const trace: ProviderSafeRunTrace = {
      runId: "run-secret",
      runKind: "productive",
      status: "succeeded",
      startedAt: "2026-08-05T00:00:00.000Z",
      finishedAt: "2026-08-05T00:01:00.000Z",
      outcome: "succeeded",
      turns: [{
        kind: "user",
        timestamp: "2026-08-05T00:00:00.000Z",
        text: "Build the memory bridge",
      }],
      outputComments: [],
      nextCursor: null,
    };
    const key = (input: { scopeKind: string; scopeId?: string; stateKey: string }) =>
      `${input.scopeKind}:${input.scopeId ?? ""}:${input.stateKey}`;
    const ctx = {
      config: { get: async () => ({ baseUrl, apiSecret: secretRef }) },
      secrets: { resolve: async () => "test-secret" },
      http: { fetch },
      runtime: {
        records: {
          readRun: async () => trace,
          readIssueComments: async () => ({
            items: [{
              id: "comment-secret",
              issueId: "issue-secret",
              body: "Shared decision",
              author: { kind: "user", userId: "user-secret" },
              runId: null,
              sequence: 1,
              createdAt: "2026-08-05T00:00:30.000Z",
            }],
            nextCursor: null,
          }),
        },
      },
      state: {
        get: async (input: { scopeKind: string; scopeId?: string; stateKey: string }) => state.get(key(input)),
        set: async (input: { scopeKind: string; scopeId?: string; stateKey: string }, value: unknown) => {
          state.set(key(input), value);
        },
      },
    } as unknown as PluginContext;
    const event: PluginEvent = {
      eventId: "event-secret",
      eventType: "agent.run.finished",
      occurredAt: "2026-08-05T00:01:00.000Z",
      actorType: "agent",
      actorId: "agent-secret",
      entityType: "agent_run",
      entityId: "run-secret",
      companyId: "company-secret",
      payload: {
        runId: "run-secret",
        issueId: "issue-secret",
        agentId: "agent-secret",
      },
    };

    await Promise.all([
      captureTerminalRun(ctx, event),
      captureTerminalRun(ctx, event),
    ]);

    expect(requests.filter((request) => request.path === "/agentmemory/session/start")).toHaveLength(4);
    expect(state.get("run:run-secret:agentmemory:captured")).toBe(true);
    expect(state.get("issue:issue-secret:agentmemory:last-shared-comment-sequence")).toBe(1);
    const outbound = JSON.stringify(requests);
    expect(outbound).not.toContain("company-secret");
    expect(outbound).not.toContain("issue-secret");
    expect(outbound).not.toContain("agent-secret");
    expect(outbound).toContain("Build the memory bridge");
    expect(outbound).toContain("Shared decision");
    expect(outbound).toContain("paperclip_observation_key");
    expect(outbound).toContain("paperclip_agent_run_terminal");
    expect(requests.some((request) => request.path === "/agentmemory/summarize")).toBe(false);

    trace.runId = "run-cancelled";
    trace.status = "cancelled";
    trace.outcome = null;
    trace.turns = [];
    await captureTerminalRun(ctx, {
      ...event,
      eventId: "event-cancelled",
      eventType: "agent.run.cancelled",
      entityId: "run-cancelled",
      payload: {
        ...event.payload as Record<string, unknown>,
        runId: "run-cancelled",
        outcome: "cancelled",
        reason: "cancelled before provider prompt",
      },
    });

    expect(requests.filter((request) => request.path === "/agentmemory/session/start"))
      .toHaveLength(6);
    expect(state.get("run:run-cancelled:agentmemory:captured")).toBe(true);
    expect(JSON.stringify(requests.slice(-8))).toContain("cancelled before provider prompt");
  });
});
