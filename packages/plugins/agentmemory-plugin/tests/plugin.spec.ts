import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  normalizeAgentMemoryBaseUrl,
  parseAgentMemoryConfig,
  type AgentMemoryNarrativeSearchResult,
} from "../src/agentmemory-client.js";
import {
  captureTerminalRun,
  runObservations,
  sessionMessageObservations,
} from "../src/capture.js";
import manifest from "../src/manifest.js";
import {
  memoryObservationSessionId,
  memoryPartition,
  type MemoryPartitionKind,
} from "../src/memory-partitions.js";
import { MEMORY_TOOL_DEFINITIONS } from "../src/memory-tools.js";
import {
  beforePrompt,
  canReadIssueMemory,
  memoryGrantCandidates,
  recall,
} from "../src/runtime.js";
import plugin from "../src/worker.js";

interface StubRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
}

interface AgentMemoryStub {
  baseUrl: string;
  requests: StubRequest[];
  observations: Map<string, Record<string, unknown>>;
}

const servers: ReturnType<typeof createServer>[] = [];
const apiSecret = "test-secret";

function narrativeSearch(
  results: Array<{
    sessionId: string;
    title: string;
    narrative: string;
  }>,
): AgentMemoryNarrativeSearchResult {
  return {
    format: "narrative",
    results: results.map((result, index) => ({
      obsId: `obs-${index + 1}`,
      ...result,
      score: 1,
      timestamp: "2026-08-05T00:00:00.000Z",
    })),
    text: results
      .map((result, index) => `${index + 1}. ${result.title}\n${result.narrative}`)
      .join("\n\n"),
    tokens_used: 0,
    tokens_budget: 2_000,
    truncated: false,
  };
}

async function startAgentMemoryStub(input: {
  search?: (
    body: Record<string, unknown>,
  ) => AgentMemoryNarrativeSearchResult;
} = {}): Promise<AgentMemoryStub> {
  const requests: StubRequest[] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const observations = new Map<string, Record<string, unknown>>();
  let nextObservation = 1;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://agentmemory.test");
      const path = url.pathname;
      const body = chunks.length > 0
        ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
        : {};
      requests.push({
        method: request.method ?? "GET",
        path,
        query: Object.fromEntries(url.searchParams),
        body,
      });

      let status = 200;
      let result: unknown;
      if (path === "/agentmemory/session/start") {
        const session = {
          id: body.sessionId,
          project: body.project,
          cwd: body.cwd,
          agentId: body.agentId,
          status: "active",
        };
        if (typeof body.sessionId === "string") {
          sessions.set(body.sessionId, session);
        }
        result = { session, context: "" };
      } else if (path === "/agentmemory/observe") {
        const observationId = `observation-${nextObservation++}`;
        const session = typeof body.sessionId === "string"
          ? sessions.get(body.sessionId)
          : undefined;
        if (typeof body.sessionId === "string") {
          observations.set(body.sessionId, {
            id: observationId,
            sessionId: body.sessionId,
            timestamp: body.timestamp,
            type: "conversation",
            title: "Paperclip capture",
            facts: [],
            narrative: "Captured Paperclip memory",
            concepts: [],
            files: [],
            importance: 5,
            agentId: session?.agentId,
          });
        }
        result = { observationId };
      } else if (path === "/agentmemory/observations") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const agentId = url.searchParams.get("agentId") ?? "";
        const observation = observations.get(sessionId);
        result = {
          observations:
            observation && (agentId === "*" || observation.agentId === agentId)
              ? [observation]
              : [],
        };
      } else if (path === "/agentmemory/search") {
        result = input.search?.(body) ?? narrativeSearch([]);
      } else if (path === "/agentmemory/health") {
        result = {
          status: "healthy",
          service: "agentmemory",
          version: "0.9.28",
        };
      } else {
        status = 404;
        result = { error: `Unexpected test request: ${path}` };
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    observations,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

function contextAccess(
  overrides: Partial<PluginBeforePromptInput["contextAccess"]> = {},
): PluginBeforePromptInput["contextAccess"] {
  return {
    carry_context: false,
    read_issue_comments: false,
    read_issue_agent_run: false,
    list_sub_issues: false,
    read_sub_issue_comments: false,
    read_sub_issue_agent_run: false,
    list_company_issues: false,
    read_company_issue_comments: false,
    read_company_issue_agent_run: false,
    ...overrides,
  };
}

function beforePromptInput(
  access: Partial<PluginBeforePromptInput["contextAccess"]> = {},
): PluginBeforePromptInput {
  return {
    companyId: "company-secret",
    issueId: "issue-secret",
    sessionId: "session-secret",
    runId: "run-secret",
    agentId: "agent-secret",
    projectId: "project-secret",
    sourceText: "What should we do next?",
    promptKind: "base",
    sessionOperation: "new",
    refId: "ref-secret",
    refOrdinal: 0,
    segmentOrdinal: 0,
    sourceMessageId: "source-current",
    sourceMessageSeq: 4,
    snapshotHighWaterSeq: 4,
    contextAccess: contextAccess(access),
  };
}

function canonicalMessage(input: {
  seq: number;
  modelStateSeq?: number;
  id: string;
  agentId: string | null;
  message: Record<string, unknown>;
}): PluginCanonicalSessionMessage {
  const created = Date.parse(
    `2026-08-05T00:00:${String(input.seq).padStart(2, "0")}.000Z`,
  );
  const message: Record<string, unknown> = {
    ...input.message,
    time: input.message.time ?? {
      created,
      ...(input.message.type === "assistant" ? { completed: created + 500 } : {}),
    },
  };
  return {
    row: {
      id: input.id,
      companyId: "company-secret",
      issueId: "issue-secret",
      sessionId: "session-secret",
      seq: input.seq,
      modelStateSeq: input.modelStateSeq ?? input.seq,
      type: String(message.type ?? "unknown"),
      runId: input.agentId ? `run-${input.seq}` : null,
      ownershipEpoch: input.agentId ? 1 : null,
      agentId: input.agentId,
      adapterConfigRevisionId: input.agentId ? "revision-secret" : null,
      timeCreated: new Date(created).toISOString(),
      timeUpdated: new Date(created + 500).toISOString(),
    },
    message: message as unknown as PluginCanonicalSessionMessage["message"],
  };
}

function stateStore() {
  const values = new Map<string, unknown>();
  const key = (input: { scopeKind: string; scopeId?: string; stateKey: string }) =>
    `${input.scopeKind}:${input.scopeId ?? ""}:${input.stateKey}`;
  return {
    values,
    api: {
      get: async (input: { scopeKind: string; scopeId?: string; stateKey: string }) =>
        values.get(key(input)) ?? null,
      set: async (
        input: { scopeKind: string; scopeId?: string; stateKey: string },
        value: unknown,
      ) => {
        values.set(key(input), value);
      },
      delete: async (input: {
        scopeKind: string;
        scopeId?: string;
        stateKey: string;
      }) => {
        values.delete(key(input));
      },
    },
  };
}

function beforePromptContext(input: {
  baseUrl: string;
  messages: readonly PluginCanonicalSessionMessage[];
  comments?: readonly PluginRunIssueCommentProjection[];
  state?: ReturnType<typeof stateStore>;
}) {
  const state = input.state ?? stateStore();
  const readSession = vi.fn(async (request: {
    snapshotHighWaterSeq: number;
    messages: { changedAfterSeq: number };
  }) => ({
    session: {
      companyId: "company-secret",
      issueId: "issue-secret",
      sessionId: "session-secret",
    },
    snapshotHighWaterSeq: request.snapshotHighWaterSeq,
    messages: {
      items: input.messages.filter((message) =>
        message.row.modelStateSeq > request.messages.changedAfterSeq
      ),
      nextCursor: null,
    },
    events: { items: [], nextCursor: null },
  }));
  const readIssueComments = vi.fn(async () => ({
    items: [...(input.comments ?? [])],
    nextCursor: null,
  }));
  const ctx = {
    config: { get: async () => ({ baseUrl: input.baseUrl, apiSecret }) },
    http: { fetch },
    runtime: { records: { readSession, readIssueComments } },
    state: state.api,
  } as unknown as PluginContext;
  return { ctx, state, readSession, readIssueComments };
}

function noLegacyMemoryCalls(requests: readonly StubRequest[]): void {
  expect(requests.some(({ path }) =>
    path === "/agentmemory/context" || path === "/agentmemory/session/end"
  )).toBe(false);
}

describe("AgentMemory manifest and partitions", () => {
  it("declares the four read-only tools and only generic host capabilities", () => {
    expect(manifest.tools).toEqual(
      MEMORY_TOOL_DEFINITIONS.map(({ declaration }) => declaration),
    );
    expect(manifest.tools?.map(({ name }) => name)).toEqual([
      "read_issue_agent_memory",
      "read_issue_shared_memory",
      "read_company_agent_memory",
      "read_company_shared_memory",
    ]);
    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      "agent.tools.register",
      "runtime.context.read",
      "runtime.records.read",
      "runtime.prompt.observe",
      "http.outbound",
    ]));
    expect(manifest.entrypoints.ui).toBeUndefined();
  });

  it("maps direct Paperclip scopes onto AgentMemory transport coordinates", () => {
    const coordinates = {
      companyId: "company-a",
      issueId: "issue-a",
      agentId: "agent-a",
    };
    const issueAgent = memoryPartition("issue_agent", coordinates);
    const issueShared = memoryPartition("issue_shared", coordinates);
    const companyAgent = memoryPartition("company_agent", coordinates);
    const companyShared = memoryPartition("company_shared", coordinates);

    expect(issueAgent.project).toBe(issueShared.project);
    expect(companyAgent.project).toBe(companyShared.project);
    expect(issueAgent.project).not.toBe(companyAgent.project);
    expect(issueAgent.agentId).toBe(companyAgent.agentId);
    expect(issueShared.agentId).toBe(companyShared.agentId);
    expect(issueAgent.agentId).not.toBe(issueShared.agentId);

    const otherIssue = memoryPartition("issue_agent", {
      ...coordinates,
      issueId: "issue-b",
    });
    const otherAgent = memoryPartition("issue_agent", {
      ...coordinates,
      agentId: "agent-b",
    });
    expect(otherIssue.project).not.toBe(issueAgent.project);
    expect(otherIssue.agentId).toBe(issueAgent.agentId);
    expect(otherAgent.project).toBe(issueAgent.project);
    expect(otherAgent.agentId).not.toBe(issueAgent.agentId);

    const otherCompany = memoryPartition("issue_agent", {
      ...coordinates,
      companyId: "company-b",
    });
    expect(otherCompany.project).not.toBe(issueAgent.project);
    expect(otherCompany.agentId).not.toBe(issueAgent.agentId);
    expect(JSON.stringify(issueAgent)).not.toContain("company-a");
    expect(JSON.stringify(issueAgent)).not.toContain("issue-a");
    expect(JSON.stringify(issueAgent)).not.toContain("agent-a");
  });
});

describe("AgentMemory authorization and search", () => {
  it("derives memory reach from the matching context-access cells", () => {
    expect(memoryGrantCandidates("issue_agent", "active"))
      .toEqual(["read_issue_agent_run", "read_company_issue_agent_run"]);
    expect(memoryGrantCandidates("issue_shared", "descendant"))
      .toEqual(["read_sub_issue_comments", "read_company_issue_comments"]);
    expect(memoryGrantCandidates("issue_agent", "company"))
      .toEqual(["read_company_issue_agent_run"]);
    expect(memoryGrantCandidates("issue_shared", "outside")).toEqual([]);
    expect(canReadIssueMemory(
      "issue_shared",
      { visible: false, relation: "descendant" },
      contextAccess({ read_sub_issue_comments: true }),
    )).toBe(false);
    expect(canReadIssueMemory(
      "issue_agent",
      { visible: true, relation: "active" },
      contextAccess({ read_company_issue_agent_run: true }),
    )).toBe(true);
  });

  it("sends the requested scope's exact backend coordinates and drops non-owned sessions", async () => {
    const partition = memoryPartition("issue_agent", {
      companyId: "company",
      issueId: "issue",
      agentId: "agent",
    });
    const ownedSession = memoryObservationSessionId({
      partition,
      observationIdentity: "owned-source",
    });
    const wrongIssueSession = memoryObservationSessionId({
      partition: memoryPartition("issue_agent", {
        companyId: "company",
        issueId: "other-issue",
        agentId: "agent",
      }),
      observationIdentity: "wrong-issue-source",
    });
    const wrongPrincipalSession = memoryObservationSessionId({
      partition: memoryPartition("issue_shared", {
        companyId: "company",
        issueId: "issue",
      }),
      observationIdentity: "wrong-principal-source",
    });
    const stub = await startAgentMemoryStub({
      search: () => narrativeSearch([
        { sessionId: ownedSession, title: "Owned", narrative: "keep" },
        {
          sessionId: wrongIssueSession,
          title: "Wrong issue",
          narrative: "drop",
        },
        {
          sessionId: wrongPrincipalSession,
          title: "Wrong principal",
          narrative: "drop",
        },
      ]),
    });
    const client = await AgentMemoryClient.connect({
      config: { get: async () => ({ baseUrl: stub.baseUrl, apiSecret }) },
      http: { fetch },
    } as unknown as PluginContext);

    await expect(client.search(partition, "decision")).resolves.toMatchObject({
      text: "1. Owned\nkeep",
      results: [{ sessionId: ownedSession }],
    });
    expect(stub.requests.find(({ path }) => path === "/agentmemory/search")?.body)
      .toEqual({
        query: "decision",
        limit: 8,
        project: partition.project,
        format: "narrative",
        token_budget: 2_000,
        agentId: partition.agentId,
      });
  });

  it("executes all four tools with their direct scopes and matching context grants", async () => {
    const stub = await startAgentMemoryStub();
    const cases: Array<{
      toolName: string;
      kind: MemoryPartitionKind;
      params: Record<string, string>;
      access: Partial<PluginBeforePromptInput["contextAccess"]>;
      partitionInput: { companyId: string; issueId?: string; agentId?: string };
      reachesIssue: boolean;
    }> = [
      {
        toolName: "read_issue_agent_memory",
        kind: "issue_agent",
        params: { issueId: "issue-agent-target", query: "agent issue" },
        access: { read_issue_agent_run: true },
        partitionInput: {
          companyId: "company-secret",
          issueId: "issue-agent-target",
          agentId: "agent-secret",
        },
        reachesIssue: true,
      },
      {
        toolName: "read_issue_shared_memory",
        kind: "issue_shared",
        params: { issueId: "issue-shared-target", query: "shared issue" },
        access: { read_issue_comments: true },
        partitionInput: {
          companyId: "company-secret",
          issueId: "issue-shared-target",
        },
        reachesIssue: true,
      },
      {
        toolName: "read_company_agent_memory",
        kind: "company_agent",
        params: { query: "agent company" },
        access: {
          list_company_issues: true,
          read_company_issue_agent_run: true,
        },
        partitionInput: {
          companyId: "company-secret",
          agentId: "agent-secret",
        },
        reachesIssue: false,
      },
      {
        toolName: "read_company_shared_memory",
        kind: "company_shared",
        params: { query: "shared company" },
        access: {
          list_company_issues: true,
          read_company_issue_comments: true,
        },
        partitionInput: { companyId: "company-secret" },
        reachesIssue: false,
      },
    ];

    for (const testCase of cases) {
      expect(
        MEMORY_TOOL_DEFINITIONS.find(
          ({ declaration }) => declaration.name === testCase.toolName,
        )?.partitionKind,
      ).toBe(testCase.kind);
      const issueReach = vi.fn(async () => ({
        visible: true,
        relation: "active" as const,
      }));
      const result = await recall({
        ctx: {
          config: { get: async () => ({ baseUrl: stub.baseUrl, apiSecret }) },
          http: { fetch },
        } as unknown as PluginContext,
        kind: testCase.kind,
        params: testCase.params,
        runContext: {
          handle: testCase.toolName,
          resolve: async () => ({
            companyId: "company-secret",
            issueId: "active-issue",
            agentId: "agent-secret",
            runId: "run-secret",
            projectId: null,
            contextAccess: contextAccess(testCase.access),
          }),
          issueReach,
          issues: {} as never,
        },
      });

      expect(result).toMatchObject({ ok: true });
      expect(issueReach).toHaveBeenCalledTimes(testCase.reachesIssue ? 1 : 0);
      if (testCase.reachesIssue) {
        expect(issueReach).toHaveBeenCalledWith(testCase.params.issueId);
      }
      const partition = memoryPartition(testCase.kind, testCase.partitionInput);
      expect(stub.requests.at(-1)).toMatchObject({
        path: "/agentmemory/search",
        body: {
          query: testCase.params.query,
          project: partition.project,
          agentId: partition.agentId,
        },
      });
    }
  });

  it("enforces issue visibility and company listing before calling AgentMemory", async () => {
    const stub = await startAgentMemoryStub();
    const ctx = {
      config: { get: async () => ({ baseUrl: stub.baseUrl, apiSecret }) },
      http: { fetch },
    } as unknown as PluginContext;
    const resolved = {
      companyId: "company",
      issueId: "active-issue",
      agentId: "agent",
      runId: "run",
      projectId: null,
      contextAccess: contextAccess({
        read_sub_issue_comments: true,
        read_company_issue_comments: true,
      }),
    };

    await expect(recall({
      ctx,
      kind: "issue_shared",
      params: { issueId: "hidden-issue", query: "decision" },
      runContext: {
        handle: "test",
        resolve: async () => resolved,
        issueReach: async () => ({ visible: false, relation: "outside" }),
        issues: {} as never,
      },
    })).resolves.toMatchObject({
      ok: false,
      error: "Issue memory is outside the current issue-listing reach",
    });
    await expect(recall({
      ctx,
      kind: "company_shared",
      params: { query: "strategy" },
      runContext: {
        handle: "test",
        resolve: async () => resolved,
        issueReach: async () => ({ visible: false, relation: "outside" }),
        issues: {} as never,
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("list_company_issues"),
    });
    expect(stub.requests).toEqual([]);
  });
});

describe("AgentMemory automatic before-prompt capture", () => {
  it("captures each between-message update before the next provider prompt without recapturing old rows", async () => {
    const access = {
      read_issue_agent_run: true,
      read_issue_comments: true,
      list_company_issues: true,
      read_company_issue_agent_run: true,
      read_company_issue_comments: true,
    };
    const firstPrompt: PluginBeforePromptInput = {
      ...beforePromptInput(access),
      sourceText: "First prompt",
      sourceMessageId: "source-first",
      sourceMessageSeq: 1,
      snapshotHighWaterSeq: 1,
    };
    const secondPrompt: PluginBeforePromptInput = {
      ...beforePromptInput(access),
      sourceText: "Second prompt",
      sourceMessageId: "source-second",
      sourceMessageSeq: 4,
      snapshotHighWaterSeq: 4,
      sessionOperation: "resume",
    };
    const firstSource = canonicalMessage({
      seq: 1,
      id: firstPrompt.sourceMessageId,
      agentId: firstPrompt.agentId,
      message: { type: "user", text: firstPrompt.sourceText },
    });
    const assistant = canonicalMessage({
      seq: 2,
      id: "assistant-between-prompts",
      agentId: secondPrompt.agentId,
      message: {
        type: "assistant",
        content: [
          { type: "text", text: "Assistant update between prompts" },
          {
            type: "tool",
            name: "lookup",
            state: {
              status: "completed",
              input: { query: "current state" },
              content: [{ type: "text", text: "Tool update between prompts" }],
            },
          },
        ],
      },
    });
    const secondSource = canonicalMessage({
      seq: 4,
      id: secondPrompt.sourceMessageId,
      agentId: secondPrompt.agentId,
      message: { type: "user", text: secondPrompt.sourceText },
    });
    const interveningComment: PluginRunIssueCommentProjection = {
      id: "comment-between-prompts",
      issueId: secondPrompt.issueId,
      body: "Comment update between prompts",
      author: { kind: "user", userId: "user" },
      runId: null,
      sequence: 3,
      createdAt: "2026-08-05T00:00:03.000Z",
    };
    const stub = await startAgentMemoryStub();
    const messages: PluginCanonicalSessionMessage[] = [firstSource];
    const comments: PluginRunIssueCommentProjection[] = [];
    const runtime = beforePromptContext({
      baseUrl: stub.baseUrl,
      messages,
      comments,
    });

    await expect(beforePrompt(runtime.ctx, firstPrompt)).resolves.toBeNull();
    messages.push(assistant, secondSource);
    comments.push(interveningComment);
    await expect(beforePrompt(runtime.ctx, secondPrompt)).resolves.toBeNull();

    expect(stub.requests.some(({ path }) => path === "/agentmemory/search"))
      .toBe(false);
    const observes = stub.requests.filter(({ path }) =>
      path === "/agentmemory/observe"
    );
    expect(observes.filter(({ body }) =>
      JSON.stringify(body.data).includes(firstPrompt.sourceText)
    )).toHaveLength(2);
    expect(observes.filter(({ body }) =>
      JSON.stringify(body.data).includes("Assistant update between prompts")
    )).toHaveLength(2);
    expect(observes.filter(({ body }) =>
      JSON.stringify(body.data).includes("Tool update between prompts")
    )).toHaveLength(2);
    expect(observes.filter(({ body }) =>
      JSON.stringify(body.data).includes(interveningComment.body)
    )).toHaveLength(2);
    expect(runtime.readSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      messages: expect.objectContaining({ changedAfterSeq: 1 }),
    }));
    noLegacyMemoryCalls(stub.requests);
  });

  it("fails the before-message capture barrier without searching", async () => {
    const prompt = beforePromptInput({ read_issue_agent_run: true });
    const source = canonicalMessage({
      seq: prompt.sourceMessageSeq,
      id: prompt.sourceMessageId,
      agentId: prompt.agentId,
      message: { type: "user", text: prompt.sourceText },
    });
    const stub = await startAgentMemoryStub();
    const runtime = beforePromptContext({
      baseUrl: stub.baseUrl,
      messages: [source],
    });
    const delegatedFetch = runtime.ctx.http.fetch;
    runtime.ctx.http.fetch = async (url, init) =>
      new URL(url).pathname === "/agentmemory/observe"
        ? new Response(JSON.stringify({ error: "capture unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
        : delegatedFetch(url, init);

    await expect(beforePrompt(runtime.ctx, prompt)).rejects.toThrow(
      "AgentMemory request /agentmemory/observe failed with 503",
    );
    expect(stub.requests.some(({ path }) => path === "/agentmemory/search"))
      .toBe(false);
    expect(runtime.state.values.size).toBe(0);
  });

  it("backfills canonical history when a saved checkpoint receipt is missing", async () => {
    const prompt = beforePromptInput();
    const current = canonicalMessage({
      seq: prompt.sourceMessageSeq,
      id: prompt.sourceMessageId,
      agentId: prompt.agentId,
      message: { type: "user", text: prompt.sourceText },
    });
    const stub = await startAgentMemoryStub();
    const runtime = beforePromptContext({
      baseUrl: stub.baseUrl,
      messages: [current],
    });

    await expect(beforePrompt(runtime.ctx, prompt)).resolves.toBeNull();
    expect(runtime.readSession).toHaveBeenCalledOnce();
    expect(stub.requests.filter(({ path }) => path === "/agentmemory/observe"))
      .toHaveLength(2);

    await expect(beforePrompt(runtime.ctx, prompt)).resolves.toBeNull();
    expect(runtime.readSession).toHaveBeenCalledOnce();
    expect(stub.requests.filter(({ path }) => path === "/agentmemory/observe"))
      .toHaveLength(2);

    stub.observations.clear();
    await expect(beforePrompt(runtime.ctx, prompt)).resolves.toBeNull();
    expect(runtime.readSession).toHaveBeenCalledTimes(2);
    expect(stub.requests.filter(({ path }) => path === "/agentmemory/observe"))
      .toHaveLength(4);
    expect(stub.requests.some(({ path }) => path === "/agentmemory/search"))
      .toBe(false);
    noLegacyMemoryCalls(stub.requests);
  });
});

describe("AgentMemory capture and receipt contract", () => {
  it("requires a compressed observation row before treating a receipt as durable", async () => {
    const partition = memoryPartition("company_shared", { companyId: "company" });
    const sessionId = memoryObservationSessionId({
      partition,
      observationIdentity: "source",
    });
    const stub = await startAgentMemoryStub();
    const client = await AgentMemoryClient.connect({
      config: { get: async () => ({ baseUrl: stub.baseUrl, apiSecret }) },
      http: { fetch },
    } as unknown as PluginContext);

    stub.observations.set(sessionId, {
      id: "raw-observation",
      sessionId,
      timestamp: "2026-08-05T00:00:00.000Z",
      type: "raw",
      agentId: partition.agentId,
      data: { prompt: "not indexed yet" },
    });
    await expect(client.hasObservationReceipt(partition, sessionId))
      .resolves.toBe(false);

    stub.observations.set(sessionId, {
      id: "compressed-observation",
      sessionId,
      timestamp: "2026-08-05T00:00:00.000Z",
      type: "conversation",
      title: "Compressed",
      facts: [],
      narrative: "Indexed memory",
      concepts: [],
      files: [],
      importance: 5,
      agentId: partition.agentId,
    });
    await expect(client.hasObservationReceipt(partition, sessionId))
      .resolves.toBe(true);
  });

  it("uses canonical source coordinates instead of content hashes", () => {
    const prompt = beforePromptInput();
    const first = canonicalMessage({
      seq: 1,
      id: "message-a",
      agentId: prompt.agentId,
      message: {
        type: "user",
        text: "identical content",
        time: { created: 1_754_352_001_000 },
      },
    });
    const second = canonicalMessage({
      seq: 1,
      id: "message-b",
      agentId: prompt.agentId,
      message: {
        type: "user",
        text: "identical content",
        time: { created: 1_754_352_001_000 },
      },
    });
    const firstIdentity = sessionMessageObservations(first, prompt)[0]!.identity;
    const secondIdentity = sessionMessageObservations(second, prompt)[0]!.identity;
    expect(firstIdentity).not.toBe(secondIdentity);

    const sameTurn: ProviderSafeRunTrace["turns"] = [{
      kind: "user",
      timestamp: "2026-08-05T00:00:00.000Z",
      text: "identical content",
    }];
    expect(runObservations(sameTurn, "run-a")[0]!.identity)
      .not.toBe(runObservations(sameTurn, "run-b")[0]!.identity);
  });

  it("projects useful output without reasoning or memory-tool recursion", () => {
    const prompt = beforePromptInput();
    const observations = sessionMessageObservations(canonicalMessage({
      seq: 2,
      id: "assistant-message",
      agentId: prompt.agentId,
      message: {
        type: "assistant",
        content: [
          { type: "reasoning", text: "private reasoning" },
          { type: "text", text: "public final" },
          {
            type: "tool",
            name: "lookup",
            state: {
              status: "completed",
              input: { query: "safe" },
              content: [{ type: "text", text: "safe result" }],
            },
          },
          {
            type: "tool",
            name: pluginAgentToolName(
              manifest.id,
              "read_issue_agent_memory",
            ),
            state: {
              status: "completed",
              input: { query: "old" },
              result: "recursive memory",
            },
          },
        ],
      },
    }), prompt);
    const serialized = JSON.stringify(observations);
    expect(serialized).toContain("public final");
    expect(serialized).toContain("safe result");
    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toContain("recursive memory");
    expect(new Set(observations.map(({ identity }) => identity)).size)
      .toBe(observations.length);

    const memoryTurns: ProviderSafeRunTrace["turns"] = MEMORY_TOOL_DEFINITIONS
      .map(({ declaration }, index) => ({
        kind: "assistant" as const,
        timestamp: `2026-08-05T00:00:0${index}.000Z`,
        content: [{
          kind: "tool" as const,
          name: pluginAgentToolName(manifest.id, declaration.name),
          state: "completed" as const,
          input: { query: "old" },
          result: { memory: "must not recurse" },
        }],
      }));
    expect(runObservations(memoryTurns, "run")).toEqual([]);
  });

  it("captures a terminal run once without context or session-end side effects", async () => {
    const stub = await startAgentMemoryStub();
    const state = stateStore();
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
        text: "Build the bridge",
      }],
      outputComments: [],
      nextCursor: null,
    };
    const ctx = {
      config: { get: async () => ({ baseUrl: stub.baseUrl, apiSecret }) },
      http: { fetch },
      runtime: { records: { readRun: async () => trace } },
      state: state.api,
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
        companyId: "company-secret",
        issueId: "issue-secret",
        runId: "run-secret",
        agentId: "agent-secret",
        outcome: "succeeded",
        reason: null,
      },
    };

    await captureTerminalRun(ctx, event);
    await captureTerminalRun(ctx, event);

    expect(stub.requests.filter(({ path }) => path === "/agentmemory/observe"))
      .toHaveLength(4);
    expect(JSON.stringify(stub.requests)).toContain("Build the bridge");
    expect(JSON.stringify(stub.requests)).toContain("paperclip_agent_run_terminal");
    noLegacyMemoryCalls(stub.requests);
  });
});

describe("AgentMemory configuration", () => {
  it("accepts secure or loopback URLs and rejects credential-bearing URLs", () => {
    expect(normalizeAgentMemoryBaseUrl("http://127.0.0.1:3111/"))
      .toBe("http://127.0.0.1:3111");
    expect(normalizeAgentMemoryBaseUrl("https://agentmemory.example/api"))
      .toBe("https://agentmemory.example/api");
    expect(() => normalizeAgentMemoryBaseUrl("http://memory.internal:3111"))
      .toThrow(/https unless it targets loopback/);
    expect(() => normalizeAgentMemoryBaseUrl(
      "https://user:pass@agentmemory.example",
    )).toThrow(/must not contain credentials/);
    expect(() => normalizeAgentMemoryBaseUrl(
      "https://agentmemory.example?token=secret",
    )).toThrow(/must not contain credentials/);
  });

  it("uses one exact config contract for validation and connection", async () => {
    expect(parseAgentMemoryConfig({
      baseUrl: "https://agentmemory.example/",
      apiSecret,
    })).toEqual({
      baseUrl: "https://agentmemory.example",
      apiSecret,
    });
    expect(() => parseAgentMemoryConfig({
      baseUrl: "https://agentmemory.example",
      apiSecret,
      legacyEndpoint: "https://legacy.example",
    })).toThrow(/unsupported field: legacyEndpoint/);
    const invalid = {
      baseUrl: "https://agentmemory.example",
      apiSecret: "",
    };
    await expect(plugin.definition.onValidateConfig!(invalid)).resolves.toEqual({
      ok: false,
      errors: ["AgentMemory apiSecret is not configured"],
    });
    await expect(AgentMemoryClient.connect({
      config: { get: async () => invalid },
    } as unknown as PluginContext)).rejects.toThrow(
      "AgentMemory apiSecret is not configured",
    );
  });

  it("probes health without doing work during plugin setup", async () => {
    const stub = await startAgentMemoryStub();
    const ctx = {
      config: { get: async () => ({ baseUrl: stub.baseUrl, apiSecret }) },
      http: { fetch },
      tools: { register: vi.fn() },
      events: { on: vi.fn() },
    } as unknown as PluginContext;

    await plugin.definition.setup(ctx);
    expect(stub.requests).toEqual([]);
    await expect(plugin.definition.onHealth!()).resolves.toEqual({
      status: "ok",
      message: "AgentMemory 0.9.28 reported healthy",
    });
    expect(stub.requests.map(({ path }) => path))
      .toEqual(["/agentmemory/health"]);
  });
});
