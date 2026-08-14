import "./context-retrieval.test-suite-02-projects-only-the-shared-provider.js";
import * as t from "./context-retrieval.test-support.js";
const { describe, it, expectTypeOf, service, scope, expect, repository, task } = t;
const { ContextRetrievalDenied, ContextRetrievalInvalidCursor } = t;

describe("context retrieval", () => {
  it("uses the identical shared trace DTO at the gateway and plugin boundary", () => {
    type GatewayTrace = Awaited<ReturnType<testSupport.ContextRetrievalService["readTaskAgentRun"]>>;
    type PluginTrace = testSupport.WorkerToHostMethods["run.tasks.readTaskAgentRun"][1];

    expectTypeOf<GatewayTrace>().toEqualTypeOf<PluginTrace>();
  });

  it("lists top-level company tasks and direct children only", async () => {
    const api = service();
    const company = await api.listCompanyTasks(scope({ list_company_tasks: true }));
    expect(company.items.map((row) => row.id)).toEqual(["top-1", "top-2"]);
    expect(company.items.every((row) => row.parentId === null)).toBe(true);

    const children = await api.listSubTasks(scope({ list_sub_tasks: true }));
    expect(children.items).toHaveLength(1);
    expect(children.items[0].parentId).toBe("active");
  });

  it("projects immutable creators through the provider-safe allowlist", async () => {
    const repo = repository();
    const unsafeCreatorTask = (
      id: string,
      creator: Record<string, unknown>,
    ): testSupport.ContextRetrievalTaskProjection => ({
      ...task(id, null),
      creator: creator as never,
    });
    repo.listTopLevelTasks = async () => [
      unsafeCreatorTask("creator-agent", {
        kind: "agent-execution",
        agentId: "agent-creator",
        taskExecutionAuthorityId: "must-not-leak-authority",
        adapterConfigRevisionId: "must-not-leak-revision",
      }),
      unsafeCreatorTask("creator-user", {
        kind: "user/board",
        userId: "user-creator",
        creatorAuthorityId: "must-not-leak-authority",
      }),
      unsafeCreatorTask("creator-plugin", {
        kind: "plugin",
        pluginKey: "plugin-key",
        pluginInstallationId: "must-not-leak-installation",
        callbackKey: "must-not-leak-callback",
      }),
      unsafeCreatorTask("creator-routine", {
        kind: "routine",
        routineId: "routine-1",
        routineDispatchId: "must-not-leak-dispatch",
      }),
      unsafeCreatorTask("creator-system", {
        kind: "system",
        sourceKind: "recovery",
        sourceId: "must-not-leak-source",
      }),
    ];

    const result = await service(repo).listCompanyTasks(scope({ list_company_tasks: true }));

    expect(result.items.map((row) => row.creator)).toEqual([
      { kind: "agent-execution", agentId: "agent-creator" },
      { kind: "user/board", userId: "user-creator" },
      { kind: "plugin", pluginKey: "plugin-key" },
      { kind: "routine", routineId: "routine-1" },
      { kind: "system", sourceKind: "recovery" },
    ]);
    expect(JSON.stringify(result.items)).not.toContain("must-not-leak");
  });

  it("does not let an explicit leaked id widen comment reach", async () => {
    const api = service();
    await expect(
      api.readTaskComments(scope({ read_task_comments: true }), {
        taskId: "child",
      }),
    ).rejects.toBeInstanceOf(ContextRetrievalDenied);

    await expect(
      api.readTaskComments(scope({ read_sub_task_comments: true }), {
        taskId: "child",
      }),
    ).resolves.toMatchObject({
      items: [{ id: "comment-1" }, { id: "comment-2" }],
    });
  });

  it("returns chronological comments and a sanitized V2 trace", async () => {
    const api = service();
    const comments = await api.readTaskComments(scope({ read_sub_task_comments: true }), { taskId: "child" });
    expect(comments.items.map((row) => row.sequence)).toEqual([1, 2]);

    const trace = await api.readTaskAgentRun(scope({ read_sub_task_agent_run: true }), {
      runId: "run-child",
    });
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
      nextCursor: null,
    });
  });

  it("keeps plugin comment attribution provider-safe and rejects leaked installation identity", async () => {
    const repo = repository();
    repo.listTaskComments = async ({ taskId }) => [
      {
        id: "plugin-comment",
        taskId,
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

    const result = await service(repo).readTaskComments(scope({ read_task_comments: true }));
    expect(result.items[0]?.author).toEqual({
      kind: "plugin",
      pluginKey: "paperclip.example",
    });
    expect(JSON.stringify(result)).not.toContain("pluginInstallationId");

    repo.listTaskComments = async ({ taskId }) => [
      {
        id: "malformed-plugin-comment",
        taskId,
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
    await expect(service(repo).readTaskComments(scope({ read_task_comments: true }))).rejects.toThrow(
      "non-canonical shape",
    );
  });

  it("preserves empty active and folded run-progress bodies across pagination", async () => {
    const repo = repository();
    const rows = [
      {
        id: "progress-active",
        taskId: "active",
        body: "",
        author: { kind: "agent" as const, agentId: "agent-1" },
        runId: "run-active",
        sequence: 1,
        createdAt: "2026-07-25T00:00:00.000Z",
      },
      {
        id: "progress-folded",
        taskId: "active",
        body: "",
        author: { kind: "agent" as const, agentId: "agent-1" },
        runId: "run-folded",
        sequence: 2,
        createdAt: "2026-07-25T00:01:00.000Z",
      },
    ];
    repo.listTaskComments = async ({ after, limit }) =>
      rows
        .filter((row) => after === null || String(row.sequence).padStart(20, "0") > after.sortValue)
        .slice(0, limit);
    const api = service(repo);

    const first = await api.readTaskComments(scope({ read_task_comments: true }), { limit: 1 });
    expect(first.items).toMatchObject([{ id: "progress-active", body: "", runId: "run-active" }]);
    expect(first.nextCursor).toBeTypeOf("string");

    await expect(
      api.readTaskComments(scope({ read_task_comments: true }), {
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).resolves.toMatchObject({
      items: [{ id: "progress-folded", body: "", runId: "run-folded" }],
      nextCursor: null,
    });
  });

  it("rejects a forged run-trace cursor before reading canonical rows", async () => {
    await expect(
      service().readTaskAgentRun(scope({ read_sub_task_agent_run: true }), {
        runId: "run-child",
        cursor: "forged",
      }),
    ).rejects.toBeInstanceOf(ContextRetrievalInvalidCursor);
  });
});
