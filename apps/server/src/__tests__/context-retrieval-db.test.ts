import { describe, expect, it } from "vitest";
import { decodeIssueSessionMessage } from "@paperclipai/shared/issue-session";
import {
  mapContextCommentAuthor,
  mapContextIssueRow,
  sanitizeCanonicalMessage,
} from "../services/context-retrieval-db.js";

describe("context retrieval DB projection", () => {
  it("maps the exact four comment-author shapes and fails closed otherwise", () => {
    const base = {
      id: "comment",
      issueId: "issue",
      body: "body",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      authorPluginKey: null,
      runId: null,
      sequence: 1,
      createdAt: "2026-07-25T00:00:00.000Z",
    };
    expect(mapContextCommentAuthor(base)).toEqual({ kind: "system" });
    expect(mapContextCommentAuthor({
      ...base,
      authorType: "agent",
      authorAgentId: "agent-1",
    })).toEqual({ kind: "agent", agentId: "agent-1" });
    expect(mapContextCommentAuthor({
      ...base,
      authorType: "user",
      authorUserId: "user-1",
    })).toEqual({ kind: "user", userId: "user-1" });
    expect(mapContextCommentAuthor({
      ...base,
      authorType: "plugin",
      authorPluginKey: "paperclip.example",
    })).toEqual({ kind: "plugin", pluginKey: "paperclip.example" });

    for (const malformed of [
      { ...base, authorType: "plugin", authorPluginKey: null },
      { ...base, authorType: "plugin", authorPluginKey: "" },
      {
        ...base,
        authorType: "plugin",
        authorAgentId: "agent-1",
        authorPluginKey: "paperclip.example",
      },
      { ...base, authorType: "unknown" },
      { ...base, authorType: "agent", authorAgentId: null },
    ]) {
      expect(() => mapContextCommentAuthor(malformed)).toThrow(
        "invalid author shape",
      );
    }
  });

  it("maps only the canonical minimal issue contract", () => {
    const result = mapContextIssueRow({
      id: "issue",
      identifier: "PAP-1",
      title: null,
      request: "Immutable request",
      status: "open",
      disposition: null,
      priority: "high",
      parentId: null,
      ownerKind: "agent",
      ownerAgentId: "owner",
      ownerUserId: null,
      creatorKind: "agent-execution",
      creatorAuthorityId: "authority",
      creatorAgentId: "creator-agent",
      creatorAdapterConfigRevisionId: "revision",
      creatorUserId: null,
      creatorPluginInstallationId: null,
      creatorPluginKey: null,
      creatorCallbackKey: null,
      creatorCallbackVersion: null,
      creatorRoutineId: null,
      creatorRoutineDispatchId: null,
      creatorSystemSourceKind: null,
      creatorSystemSourceId: null,
      directChildCount: "2",
      updatedAt: "2026-07-25T00:00:00.000Z",
    });
    expect(result).toEqual({
      id: "issue",
      identifier: "PAP-1",
      title: null,
      request: "Immutable request",
      status: "open",
      disposition: null,
      priority: "high",
      creator: {
        kind: "agent-execution",
        agentId: "creator-agent",
      },
      owner: { kind: "agent", agentId: "owner" },
      parentId: null,
      directChildCount: 2,
      updatedAt: "2026-07-25T00:00:00.000Z",
    });
  });

  it("projects schema-validated V2 turns without tokens, cost, or provider metadata", () => {
    const turn = sanitizeCanonicalMessage(
      decodeIssueSessionMessage({
        id: "msg_assistant",
        type: "assistant",
        agent: "agent-1",
        model: { id: "model-1", providerID: "provider-1" },
        content: [
          {
            type: "reasoning",
            id: "reasoning-1",
            text: "Safe summary",
            providerMetadata: {
              provider: { hidden: "provider-internal" },
            },
          },
          {
            type: "tool",
            id: "call-1",
            name: "company_lookup",
            provider: {
              executed: true,
              metadata: {
                provider: { hidden: "provider-internal" },
              },
            },
            state: {
              status: "completed",
              input: { query: "safe", apiKey: "secret" },
              content: [{ type: "text", text: "done" }],
              structured: { answer: 42, accessToken: "secret" },
              result: { password: "secret" },
            },
            time: { created: 1_700_000_000_000 },
          },
        ],
        finish: "stop",
        cost: 4.25,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 3,
          cache: { read: 10, write: 0 },
        },
        time: {
          created: 1_700_000_000_000,
          completed: 1_700_000_001_000,
        },
      }),
      8,
    );

    expect(turn).toMatchObject({
      seq: 8,
      id: "msg_assistant",
      kind: "assistant",
      agentId: "agent-1",
      model: { id: "model-1", providerId: "provider-1" },
      finish: "stop",
      content: [
        {
          kind: "reasoning",
          id: "reasoning-1",
          text: "Safe summary",
        },
        {
          kind: "tool",
          callId: "call-1",
          name: "company_lookup",
          state: "completed",
          input: { query: "safe", apiKey: "***REDACTED***" },
          output: {
            content: [{ type: "text", text: "done" }],
            structured: { answer: 42, accessToken: "***REDACTED***" },
            result: { password: "***REDACTED***" },
          },
        },
      ],
    });
    expect(turn).not.toHaveProperty("tokens");
    expect(turn).not.toHaveProperty("cost");
    expect(JSON.stringify(turn)).not.toContain("provider-internal");
  });
});
