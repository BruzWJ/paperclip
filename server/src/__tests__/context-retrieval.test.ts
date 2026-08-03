import { describe, expect, expectTypeOf, it } from "vitest";
import type { WorkerToHostMethods } from "@paperclipai/plugin-sdk/protocol";
import { resolveContextDial } from "../services/context-dial-resolver.ts";
import {
  ContextRetrievalDenied,
  ContextRetrievalInvalidCursor,
  createContextRetrievalService,
  type CanonicalRunTrace,
  type ContextRetrievalIssueProjection,
  type ContextRetrievalRepository,
} from "../services/context-retrieval.ts";
import {
  IssueSessionInvalidCursor,
} from "../services/issue-session/store.ts";

function issue(
  id: string,
  parentId: string | null,
  updatedAt = "2026-07-25T00:00:00.000Z",
): ContextRetrievalIssueProjection {
  return {
    id,
    identifier: `PAP-${id}`,
    title: `Issue ${id}`,
    request: `Request ${id}`,
    status: "open",
    disposition: null,
    priority: "medium",
    creator: { kind: "system", sourceKind: "watchdog" },
    owner: { kind: "agent", agentId: "agent-1" },
    parentId,
    directChildCount: 0,
    updatedAt,
  };
}

function repository(): ContextRetrievalRepository {
  const reach = new Map([
    ["active", { sameCompany: true, active: true, descendant: false }],
    ["child", { sameCompany: true, active: false, descendant: true }],
    ["other", { sameCompany: true, active: false, descendant: false }],
  ]);
  return {
    async issueReach({ issueId }) {
      return reach.get(issueId) ?? null;
    },
    async listTopLevelIssues() {
      return [issue("top-1", null), issue("top-2", null)];
    },
    async listDirectChildren({ issueId }) {
      return [issue("child", issueId)];
    },
    async listIssueComments({ issueId }) {
      return [
        {
          id: "comment-1",
          issueId,
          body: "First",
          author: { kind: "user", userId: "board-user" },
          runId: null,
          sequence: 1,
          createdAt: "2026-07-25T00:00:00.000Z",
        },
        {
          id: "comment-2",
          issueId,
          body: "Second",
          author: { kind: "agent", agentId: "agent-2" },
          runId: "run-1",
          sequence: 2,
          createdAt: "2026-07-25T00:01:00.000Z",
        },
      ];
    },
    async runIssue({ runId }) {
      return runId === "run-child" ? { issueId: "child" } : null;
    },
    async readCanonicalRunTrace({ runId, projection }) {
      expect(projection).toBe("run-trace");
      return {
        runId,
        runKind: "productive",
        triggeredByRunId: null,
        issueId: "child",
        status: "succeeded",
        startedAt: "2026-07-25T00:00:00.000Z",
        finishedAt: "2026-07-25T00:01:00.000Z",
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          knownDeltaAmount: "0",
        },
        checkpoint: null,
        turns: [
          {
            seq: 0,
            id: "msg_user",
            kind: "user",
            timestamp: "2026-07-25T00:00:00.000Z",
            text: "Inspect this",
            ...( { nativeSessionId: "forbidden" } as Record<string, unknown>),
          },
        ],
        outcome: null,
        comments: [],
      };
    },
  };
}

function service(repo = repository()) {
  return createContextRetrievalService({
    cursorSecret: "test-cursor-secret",
    repository: repo,
  });
}

function scope(
  grants: Parameters<typeof resolveContextDial>[0]["agent"],
) {
  return {
    companyId: "company-1",
    activeIssueId: "active",
    dial: resolveContextDial({ agent: grants }).effective,
  };
}

describe("context retrieval", () => {
  it("uses the identical shared trace DTO at the gateway and plugin boundary", () => {
    type GatewayTrace = Awaited<
      ReturnType<ReturnType<typeof createContextRetrievalService>["readIssueAgentRun"]>
    >;
    type PluginTrace =
      WorkerToHostMethods["run.issues.readIssueAgentRun"][1];

    expectTypeOf<GatewayTrace>().toEqualTypeOf<PluginTrace>();
  });

  it("lists top-level company issues and direct children only", async () => {
    const api = service();
    const company = await api.listCompanyIssues(
      scope({ list_company_issues: true }),
    );
    expect(company.items.map((row) => row.id)).toEqual(["top-1", "top-2"]);
    expect(company.items.every((row) => row.parentId === null)).toBe(true);

    const children = await api.listSubIssues(
      scope({ list_sub_issues: true }),
    );
    expect(children.items).toHaveLength(1);
    expect(children.items[0].parentId).toBe("active");
  });

  it("projects immutable creators through the provider-safe allowlist", async () => {
    const repo = repository();
    const unsafeCreatorIssue = (
      id: string,
      creator: Record<string, unknown>,
    ): ContextRetrievalIssueProjection => ({
      ...issue(id, null),
      creator: creator as never,
    });
    repo.listTopLevelIssues = async () => [
      unsafeCreatorIssue("creator-agent", {
        kind: "agent-execution",
        agentId: "agent-creator",
        issueExecutionAuthorityId: "must-not-leak-authority",
        adapterConfigRevisionId: "must-not-leak-revision",
      }),
      unsafeCreatorIssue("creator-user", {
        kind: "user/board",
        userId: "user-creator",
        creatorAuthorityId: "must-not-leak-authority",
      }),
      unsafeCreatorIssue("creator-plugin", {
        kind: "plugin",
        pluginKey: "plugin-key",
        pluginInstallationId: "must-not-leak-installation",
        callbackKey: "must-not-leak-callback",
      }),
      unsafeCreatorIssue("creator-routine", {
        kind: "routine",
        routineId: "routine-1",
        routineDispatchId: "must-not-leak-dispatch",
      }),
      unsafeCreatorIssue("creator-system", {
        kind: "system",
        sourceKind: "watchdog",
        sourceId: "must-not-leak-source",
      }),
    ];

    const result = await service(repo).listCompanyIssues(
      scope({ list_company_issues: true }),
    );

    expect(result.items.map((row) => row.creator)).toEqual([
      { kind: "agent-execution", agentId: "agent-creator" },
      { kind: "user/board", userId: "user-creator" },
      { kind: "plugin", pluginKey: "plugin-key" },
      { kind: "routine", routineId: "routine-1" },
      { kind: "system", sourceKind: "watchdog" },
    ]);
    expect(JSON.stringify(result.items)).not.toContain("must-not-leak");
  });

  it("does not let an explicit leaked id widen comment reach", async () => {
    const api = service();
    await expect(
      api.readIssueComments(scope({ read_issue_comments: true }), {
        issueId: "child",
      }),
    ).rejects.toBeInstanceOf(ContextRetrievalDenied);

    await expect(
      api.readIssueComments(scope({ read_sub_issue_comments: true }), {
        issueId: "child",
      }),
    ).resolves.toMatchObject({
      items: [{ id: "comment-1" }, { id: "comment-2" }],
    });
  });

  it("returns chronological comments and a sanitized V2 trace", async () => {
    const api = service();
    const comments = await api.readIssueComments(
      scope({ read_sub_issue_comments: true }),
      { issueId: "child" },
    );
    expect(comments.items.map((row) => row.sequence)).toEqual([1, 2]);

    const trace = await api.readIssueAgentRun(
      scope({ read_sub_issue_agent_run: true }),
      { runId: "run-child" },
    );
    expect(trace).toEqual({
      runId: "run-child",
      runKind: "productive",
      status: "succeeded",
      startedAt: "2026-07-25T00:00:00.000Z",
      finishedAt: "2026-07-25T00:01:00.000Z",
      outcome: null,
      turns: [
        {
          kind: "user",
          timestamp: "2026-07-25T00:00:00.000Z",
          text: "Inspect this",
        },
      ],
      outputComments: [],
    });
  });

  it("keeps plugin comment attribution provider-safe and rejects leaked installation identity", async () => {
    const repo = repository();
    repo.listIssueComments = async ({ issueId }) => [
      {
        id: "plugin-comment",
        issueId,
        body: "Plugin-authored update",
        author: {
          kind: "plugin",
          pluginKey: "paperclip.example",
        },
        runId: null,
        sequence: 1,
        createdAt: "2026-07-25T00:00:00.000Z",
      },
    ];

    const result = await service(repo).readIssueComments(
      scope({ read_issue_comments: true }),
    );
    expect(result.items[0]?.author).toEqual({
      kind: "plugin",
      pluginKey: "paperclip.example",
    });
    expect(JSON.stringify(result)).not.toContain("pluginInstallationId");

    repo.listIssueComments = async ({ issueId }) => [
      {
        id: "malformed-plugin-comment",
        issueId,
        body: "Malformed",
        author: {
          kind: "plugin",
          pluginKey: "paperclip.example",
          pluginInstallationId: "must-not-leak",
        } as never,
        runId: null,
        sequence: 1,
        createdAt: "2026-07-25T00:00:00.000Z",
      },
    ];
    await expect(
      service(repo).readIssueComments(scope({ read_issue_comments: true })),
    ).rejects.toThrow("non-canonical shape");
  });

  it("preserves empty active and folded run-progress bodies across pagination", async () => {
    const repo = repository();
    const rows = [
      {
        id: "progress-active",
        issueId: "active",
        body: "",
        author: { kind: "agent" as const, agentId: "agent-1" },
        runId: "run-active",
        sequence: 1,
        createdAt: "2026-07-25T00:00:00.000Z",
      },
      {
        id: "progress-folded",
        issueId: "active",
        body: "",
        author: { kind: "agent" as const, agentId: "agent-1" },
        runId: "run-folded",
        sequence: 2,
        createdAt: "2026-07-25T00:01:00.000Z",
      },
    ];
    repo.listIssueComments = async ({ after, limit }) =>
      rows
        .filter((row) =>
          after === null ||
          String(row.sequence).padStart(20, "0") > after.sortValue,
        )
        .slice(0, limit);
    const api = service(repo);

    const first = await api.readIssueComments(
      scope({ read_issue_comments: true }),
      { limit: 1 },
    );
    expect(first.items).toMatchObject([
      { id: "progress-active", body: "", runId: "run-active" },
    ]);
    expect(first.nextCursor).toBeTypeOf("string");

    await expect(
      api.readIssueComments(scope({ read_issue_comments: true }), {
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).resolves.toMatchObject({
      items: [{ id: "progress-folded", body: "", runId: "run-folded" }],
      nextCursor: null,
    });
  });

  it("maps a forged canonical Session cursor to the retrieval cursor contract", async () => {
    const repo = repository();
    repo.readCanonicalRunTrace = async () => {
      throw new IssueSessionInvalidCursor();
    };

    await expect(
      service(repo).readIssueAgentRun(
        scope({ read_sub_issue_agent_run: true }),
        { runId: "run-child", cursor: "forged" },
      ),
    ).rejects.toBeInstanceOf(ContextRetrievalInvalidCursor);
  });

  it("projects only the shared provider run-trace allowlist and recursively filters opaque tool values", async () => {
    const repo = repository();
    repo.readCanonicalRunTrace = async () => ({
      runId: "run-child",
      runKind: "productive",
      triggeredByRunId: "must-not-leak-parent-run",
      issueId: "child",
      status: "succeeded",
      startedAt: "2026-07-25T00:00:00.000Z",
      finishedAt: "2026-07-25T00:01:00.000Z",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        knownDeltaAmount: "0",
      },
      checkpoint: null,
      turns: [
        {
          seq: 0,
          id: "agent-switch",
          kind: "agent-switched",
          timestamp: "2026-07-25T00:00:00.000Z",
          agentId: "must-not-leak-agent",
        },
        {
          seq: 1,
          id: "model-switch",
          kind: "model-switched",
          timestamp: "2026-07-25T00:00:00.000Z",
          model: {
            id: "must-not-leak-model",
            providerId: "must-not-leak-provider",
          },
        },
        {
          seq: 2,
          id: "admitted-input-message-id",
          kind: "user",
          timestamp: "2026-07-25T00:00:00.500Z",
          text: "Inspect the settled result",
        },
        {
          seq: 3,
          id: "assistant",
          kind: "assistant",
          timestamp: "2026-07-25T00:00:01.000Z",
          completedAt: "2026-07-25T00:00:02.000Z",
          agentId: "agent-author",
          model: {
            id: "must-not-leak-model",
            providerId: "must-not-leak-provider",
          },
          content: [
            {
              kind: "reasoning",
              id: "reasoning-part-id",
              text: "Safe reasoning summary",
            },
            {
              kind: "tool",
              id: "pending-call-part-id",
              callId: "pending-call-id",
              name: "pending_lookup",
              state: "pending",
              input: { query: "not settled" },
            },
            {
              kind: "tool",
              id: "call-1",
              callId: "call-1",
              name: "lookup",
              state: "completed",
              input: {
                query: "safe-query",
                authorityId: "must-not-leak-authority",
                adapterConfigRevisionId: "must-not-leak-revision",
                nested: {
                  businessValue: "keep-me",
                  providerMetadata: "must-not-leak-provider",
                  nativeSessionId: "must-not-leak-session",
                  controlPlane: "must-not-leak-control-plane",
                  agentId: "must-not-leak-agent",
                  checkpointId: "must-not-leak-checkpoint",
                  messageId: "must-not-leak-message",
                  turnId: "must-not-leak-turn",
                  partId: "must-not-leak-part",
                  callId: "must-not-leak-call",
                  updateId: "must-not-leak-update",
                  lineage: "must-not-leak-lineage",
                  accountingMetadata: "must-not-leak-accounting",
                  safeArray: [
                    {
                      visible: "array-value",
                      traceId: "must-not-leak-trace",
                      parentRunId: "must-not-leak-parent",
                    },
                  ],
                },
              },
              output: {
                result: "safe-result",
                costAmount: "4.2",
                tokenCount: 10,
                credential: "must-not-leak-credential",
                nested: { businessValue: "keep-me-too" },
              },
            },
            {
              kind: "tool",
              id: "call-2",
              callId: "call-2",
              name: "failing_lookup",
              state: "error",
              input: { query: "safe-error-query" },
              output: { detail: "safe-error-result" },
              errorKind: "tool_error",
            },
          ],
          finish: "tool-calls",
        },
        {
          seq: 4,
          id: "shell-message-id",
          kind: "shell",
          timestamp: "2026-07-25T00:00:03.000Z",
          completedAt: "2026-07-25T00:00:04.000Z",
          callId: "must-not-leak-shell-call",
          command: "printf safe",
          output: "safe shell output",
        },
        {
          seq: 5,
          id: "compaction-message-id",
          kind: "compaction",
          timestamp: "2026-07-25T00:00:05.000Z",
          text: "Safe compacted summary",
          recent: "must-not-leak-checkpoint-tail",
          compactionReason: "auto",
        },
      ],
      outcome: "succeeded",
      comments: [
        {
          commentId: "comment-update",
          messageId: "must-not-leak-comment-message-link",
          sourceKind: "issue_update",
          projectedEventSeq: 71,
        },
        {
          commentId: "comment-final",
          messageId: "must-not-leak-final-message-link",
          sourceKind: "run_progress",
          projectedEventSeq: 72,
        },
      ],
    } as unknown as CanonicalRunTrace);

    const trace = await service(repo).readIssueAgentRun(
      scope({ read_sub_issue_agent_run: true }),
      { runId: "run-child" },
    );

    expect(trace).toEqual({
      runId: "run-child",
      runKind: "productive",
      status: "succeeded",
      startedAt: "2026-07-25T00:00:00.000Z",
      finishedAt: "2026-07-25T00:01:00.000Z",
      outcome: "succeeded",
      turns: [
        {
          kind: "user",
          timestamp: "2026-07-25T00:00:00.500Z",
          text: "Inspect the settled result",
        },
        {
          kind: "assistant",
          timestamp: "2026-07-25T00:00:01.000Z",
          completedAt: "2026-07-25T00:00:02.000Z",
          content: [
            {
              kind: "reasoning",
              text: "Safe reasoning summary",
            },
            {
              kind: "tool",
              name: "lookup",
              state: "completed",
              input: {
                query: "safe-query",
                nested: {
                  businessValue: "keep-me",
                  safeArray: [{ visible: "array-value" }],
                },
              },
              result: {
                result: "safe-result",
                nested: { businessValue: "keep-me-too" },
              },
            },
            {
              kind: "tool",
              name: "failing_lookup",
              state: "error",
              input: { query: "safe-error-query" },
              result: { detail: "safe-error-result" },
              errorKind: "tool_error",
            },
          ],
          finish: "tool-calls",
        },
        {
          kind: "shell",
          timestamp: "2026-07-25T00:00:03.000Z",
          completedAt: "2026-07-25T00:00:04.000Z",
          content: [
            {
              kind: "tool",
              name: "shell",
              state: "completed",
              input: { command: "printf safe" },
              result: { output: "safe shell output" },
            },
          ],
        },
        {
          kind: "compaction",
          timestamp: "2026-07-25T00:00:05.000Z",
          text: "Safe compacted summary",
          compactionReason: "auto",
        },
      ],
      outputComments: [
        { commentId: "comment-update" },
        { commentId: "comment-final" },
      ],
    });
    expect(JSON.stringify(trace)).not.toContain("must-not-leak");
    expect(trace).not.toHaveProperty("events");
    expect(trace).not.toHaveProperty("usage");
    expect(trace).not.toHaveProperty("checkpoint");
    expect(trace).not.toHaveProperty("issueId");
    expect(trace).not.toHaveProperty("triggeredByRunId");
  });

  it("uses signed scope-bound keyset cursors", async () => {
    const repo = repository();
    repo.listTopLevelIssues = async () => [
      issue("top-1", null, "2026-07-25T00:00:00.000Z"),
      issue("top-2", null, "2026-07-25T00:01:00.000Z"),
    ];
    const api = service(repo);
    const first = await api.listCompanyIssues(
      scope({ list_company_issues: true }),
      { limit: 1 },
    );
    expect(first.nextCursor).toBeTypeOf("string");

    await expect(
      api.listSubIssues(scope({ list_company_issues: true }), {
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(ContextRetrievalInvalidCursor);

    const tampered = `${first.nextCursor?.slice(0, -1)}x`;
    await expect(
      api.listCompanyIssues(scope({ list_company_issues: true }), {
        cursor: tampered,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(ContextRetrievalInvalidCursor);
  });
});
