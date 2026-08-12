import { describe, expect, it } from "vitest";
import type { TaskSessionDbTransaction } from "./event-store.js";
import {
  publishTaskSessionEventInTx,
  publishTaskSessionFinalCommentInTx,
  redactTaskSessionPublicationValue,
} from "./publication.js";

const noTransaction = {} as TaskSessionDbTransaction;

function candidate() {
  return {
    event: {
      id: "evt_publication_boundary_test",
      sessionId: "ses_publication_boundary_test",
      seq: 1,
      type: "session.next.context.updated" as const,
      data: {
        sessionID: "ses_publication_boundary_test",
        messageID: "msg_publication_boundary_test",
        timestamp: 1,
        text: "safe",
      },
    },
    envelope: {
      companyId: "11111111-1111-4111-8111-111111111111",
      taskId: "22222222-2222-4222-8222-222222222222",
      runId: null,
      ownershipEpoch: null,
      agentId: null,
      adapterConfigRevisionId: null,
      sourceKind: "test",
      sourceId: "source",
      immutableSourceKey: "source",
      sourceRecordId: "source",
      sourceIdentityDigest: "a".repeat(64),
      createdAt: new Date(1),
    },
  };
}

describe("Task Session durable publication boundary", () => {
  it("accepts only a terminal dependency binding, never copied final comment bytes", async () => {
    await expect(
      publishTaskSessionFinalCommentInTx(noTransaction, {
        eventId: "evt_terminal",
        progressCommentId: "33333333-3333-4333-8333-333333333333",
        comment: { body: "copied final" },
      } as never),
    ).rejects.toThrow("contains unknown durable fields");
  });

  it("recursively redacts secret-shaped fields and secret literals", () => {
    expect(
      redactTaskSessionPublicationValue({
        apiKey: "sk-abcdefghijklmnopqrst",
        nested: [
          {
            text: "Authorization: Bearer abcdefghijklmnop",
            password: "plain-secret",
          },
        ],
      }),
    ).toEqual({
      apiKey: "***REDACTED***",
      nested: [
        {
          text: "Authorization: Bearer ***REDACTED***",
          password: "***REDACTED***",
        },
      ],
    });
  });

  it("applies literal redaction recursively without flattening typed timestamps", () => {
    const timestamp = new Date(1);
    expect(
      redactTaskSessionPublicationValue(
        {
          timestamp,
          nested: { value: "prefix runtime-secret suffix" },
        },
        {
          redactText: (value) =>
            value.replaceAll("runtime-secret", "***REDACTED***"),
          redactValue: () => {
            throw new Error(
              "the publication boundary must preserve non-JSON typed values",
            );
          },
        },
      ),
    ).toEqual({
      timestamp,
      nested: { value: "prefix ***REDACTED*** suffix" },
    });
  });

  it("redacts every secret-bearing publication surface recursively", () => {
    const secret = "opaque-runtime-value";
    const redacted = redactTaskSessionPublicationValue(
      {
        reasoning: [{ text: `reasoning ${secret}` }],
        tool: {
          input: { command: `tool input ${secret}` },
          result: `tool result ${secret}`,
        },
        error: { message: `error ${secret}` },
        chunks: [`chunk ${secret}`],
        metadata: { trace: `metadata ${secret}` },
        summary: { text: `summary ${secret}` },
        credentialEnvelope: { value: secret },
      },
      {
        redactText: (value) =>
          value.replaceAll(secret, "***REDACTED***"),
        redactValue: (value) => value,
      },
    );
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted).toMatchObject({
      reasoning: [{ text: "reasoning ***REDACTED***" }],
      tool: {
        input: { command: "tool input ***REDACTED***" },
        result: "tool result ***REDACTED***",
      },
      error: { message: "error ***REDACTED***" },
      chunks: ["chunk ***REDACTED***"],
      metadata: { trace: "metadata ***REDACTED***" },
      summary: { text: "summary ***REDACTED***" },
      credentialEnvelope: "***REDACTED***",
    });
  });

  it("preserves closed numeric token accounting while redacting token text", () => {
    expect(
      redactTaskSessionPublicationValue({
        tokens: {
          input: 10,
          output: 20,
          reasoning: 5,
          cache: { read: 2, write: 3 },
        },
        maxOutputTokens: 1_000,
        accessToken: "must-not-survive",
        password: 1234,
      }),
    ).toEqual({
      tokens: {
        input: 10,
        output: 20,
        reasoning: 5,
        cache: { read: 2, write: 3 },
      },
      maxOutputTokens: 1_000,
      accessToken: "***REDACTED***",
      password: "***REDACTED***",
    });
  });

  it("rejects nonempty event metadata before touching PostgreSQL", async () => {
    const input = candidate();
    await expect(
      publishTaskSessionEventInTx(noTransaction, {
        ...input,
        event: {
          ...input.event,
          metadata: { provider: "must-not-survive" },
        },
      }),
    ).rejects.toThrow(
      "Durable Session events cannot carry event-level metadata",
    );
  });

  it("rejects unknown event-envelope and noncanonical data fields", async () => {
    const input = candidate();
    await expect(
      publishTaskSessionEventInTx(noTransaction, {
        ...input,
        providerPayload: { raw: true },
      } as typeof input),
    ).rejects.toThrow("contains unknown durable fields");

    await expect(
      publishTaskSessionEventInTx(noTransaction, {
        ...input,
        event: {
          ...input.event,
          providerMetadata: { raw: true },
        } as typeof input.event,
      }),
    ).rejects.toThrow("contains unknown durable fields");

    await expect(
      publishTaskSessionEventInTx(noTransaction, {
        ...input,
        event: {
          ...input.event,
          data: {
            ...input.event.data,
            rawProviderPayload: "forbidden",
          },
        },
      }),
    ).rejects.toThrow(
      "Durable Session event contains an unknown or non-canonical shape",
    );
  });

  it("validates typed companions before the event append", async () => {
    const input = candidate();
    await expect(
      publishTaskSessionEventInTx(noTransaction, {
        ...input,
        companions: {
          sourceUserExecution: {
            messageId: "msg_publication_boundary_test",
            sourceAgentId: "agent-1",
            providerId: "",
            modelId: "model-1",
            variant: null,
          },
        },
      }),
    ).rejects.toThrow(
      "Session source-user provider id must be a non-empty string",
    );

    await expect(
      publishTaskSessionEventInTx(noTransaction, {
        ...input,
        companions: { sourceUserExecution: null } as never,
      }),
    ).rejects.toThrow(
      "Session source-user companion must be a plain object",
    );
  });

  it("rejects invalid comment companion enums and author identities before append", async () => {
    const input = candidate();
    await expect(
      publishTaskSessionEventInTx(noTransaction, {
        ...input,
        projection: {
          comment: {
            phase: "invented",
            sourceKind: "human_comment",
            sourceId: "source",
            messageId: input.event.data.messageID,
            comment: {
              id: "comment",
              body: "safe",
              authorType: "user",
              authorAgentId: null,
              authorUserId: "user",
              authorPluginInstallationId: null,
              authorPluginKey: null,
              replyToCommentId: null,
              replyToProjectedEventSeq: null,
              threadRootCommentId: null,
              threadRootProjectedEventSeq: null,
            },
          },
        } as never,
      }),
    ).rejects.toThrow("invalid publication phase");

    await expect(
      publishTaskSessionEventInTx(noTransaction, {
        ...input,
        projection: {
          comment: {
            phase: "direct",
            sourceKind: "human_comment",
            sourceId: "source",
            messageId: input.event.data.messageID,
            comment: {
              id: "comment",
              body: "safe",
              authorType: "user",
              authorAgentId: null,
              authorUserId: null,
              authorPluginInstallationId: null,
              authorPluginKey: null,
              replyToCommentId: null,
              replyToProjectedEventSeq: null,
              threadRootCommentId: null,
              threadRootProjectedEventSeq: null,
            },
          },
        },
      }),
    ).rejects.toThrow("invalid author identity");
  });

  it("preserves a plugin installation author as a first-class identity", async () => {
    const input = candidate();
    const databaseReached = new Proxy(
      {},
      {
        get() {
          throw new Error("database reached");
        },
      },
    ) as TaskSessionDbTransaction;
    await expect(
      publishTaskSessionEventInTx(databaseReached, {
        ...input,
        projection: {
          comment: {
            phase: "direct",
            sourceKind: "plugin_withdrawal",
            sourceId: "plugin-withdrawal",
            messageId: input.event.data.messageID,
            comment: {
              id: "33333333-3333-4333-8333-333333333333",
              body: "Plugin withdrew the task.",
              authorType: "plugin",
              authorAgentId: null,
              authorUserId: null,
              authorPluginInstallationId:
                "44444444-4444-4444-8444-444444444444",
              authorPluginKey: "example.plugin",
              replyToCommentId: null,
              replyToProjectedEventSeq: null,
              threadRootCommentId: null,
              threadRootProjectedEventSeq: null,
            },
          },
        },
      }),
    ).rejects.toThrow("database reached");
  });

});
