import * as t from "./context-retrieval.test-support.js";
const { describe, it, repository, service, scope, expect, task } = t;
const { ContextRetrievalInvalidCursor } = t;

describe("context retrieval", () => {
  it("projects only the shared provider run-trace allowlist and recursively filters opaque tool values", async () => {
    const repo = repository();
    repo.readCanonicalRunTrace = async () =>
      ({
        runId: "run-child",
        runKind: "productive",
        taskId: "child",
        status: "succeeded",
        startedAt: "2026-07-25T00:00:00.000Z",
        finishedAt: "2026-07-25T00:01:00.000Z",
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          knownDeltaAmount: "0",
        },
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
        ],
        outcome: "succeeded",
        comments: [
          {
            commentId: "comment-update",
            messageId: "must-not-leak-comment-message-link",
            sourceKind: "task_update",
            projectedEventSeq: 71,
          },
          {
            commentId: "comment-final",
            messageId: "must-not-leak-final-message-link",
            sourceKind: "run_progress",
            projectedEventSeq: 72,
          },
        ],
      }) as unknown as testSupport.CanonicalRunTrace;

    const trace = await service(repo).readTaskAgentRun(scope({ read_sub_task_agent_run: true }), {
      runId: "run-child",
    });

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
      ],
      outputComments: [{ commentId: "comment-update" }, { commentId: "comment-final" }],
      nextCursor: null,
    });
    expect(JSON.stringify(trace)).not.toContain("must-not-leak");
    expect(trace).not.toHaveProperty("events");
    expect(trace).not.toHaveProperty("usage");
    expect(trace).not.toHaveProperty("taskId");
  });

  it("uses signed scope-bound keyset cursors", async () => {
    const repo = repository();
    repo.listTopLevelTasks = async () => [
      task("top-1", null, "2026-07-25T00:00:00.000Z"),
      task("top-2", null, "2026-07-25T00:01:00.000Z"),
    ];
    const api = service(repo);
    const first = await api.listCompanyTasks(scope({ list_company_tasks: true }), { limit: 1 });
    expect(first.nextCursor).toBeTypeOf("string");

    await expect(
      api.listSubTasks(scope({ list_company_tasks: true }), {
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(ContextRetrievalInvalidCursor);

    const tampered = `${first.nextCursor?.slice(0, -1)}x`;
    await expect(
      api.listCompanyTasks(scope({ list_company_tasks: true }), {
        cursor: tampered,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(ContextRetrievalInvalidCursor);
  });
});
