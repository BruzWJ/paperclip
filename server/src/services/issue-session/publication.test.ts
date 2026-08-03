import { describe, expect, it } from "vitest";
import type { IssueSessionDbTransaction } from "./event-store.js";
import {
  prepareIssueSessionLiveEvent,
  issueSessionEventsAsNdjson,
  publishIssueSessionEventInTx,
  publishIssueSessionFinalCommentInTx,
  publishIssueSessionToolPrunedEffectInTx,
  redactIssueSessionPublicationValue,
} from "./publication.js";

const noTransaction = {} as IssueSessionDbTransaction;

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
      issueId: "22222222-2222-4222-8222-222222222222",
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

describe("Issue Session durable publication boundary", () => {
  it("accepts only a terminal dependency binding, never copied final comment bytes", async () => {
    await expect(
      publishIssueSessionFinalCommentInTx(noTransaction, {
        eventId: "evt_terminal",
        progressCommentId: "33333333-3333-4333-8333-333333333333",
        comment: { body: "copied final" },
      } as never),
    ).rejects.toThrow("contains unknown durable fields");
  });

  it("recursively redacts secret-shaped fields and secret literals", () => {
    expect(
      redactIssueSessionPublicationValue({
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
      redactIssueSessionPublicationValue(
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
    const redacted = redactIssueSessionPublicationValue(
      {
        reasoning: [{ text: `reasoning ${secret}` }],
        tool: {
          input: { command: `tool input ${secret}` },
          result: `tool result ${secret}`,
        },
        error: { message: `error ${secret}` },
        chunks: [`chunk ${secret}`],
        metadata: { trace: `metadata ${secret}` },
        compaction: { summary: `summary ${secret}` },
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
      compaction: { summary: "summary ***REDACTED***" },
      credentialEnvelope: "***REDACTED***",
    });
  });

  it("preserves closed numeric token accounting while redacting token text", () => {
    expect(
      redactIssueSessionPublicationValue({
        tokens: {
          input: 10,
          output: 20,
          reasoning: 5,
          cache: { read: 2, write: 3 },
        },
        maxOutputTokens: 1_000,
        outputTokenMax: 900,
        preserve_recent_tokens: 2_000,
        sourceTotalTokens: 40,
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
      outputTokenMax: 900,
      preserve_recent_tokens: 2_000,
      sourceTotalTokens: 40,
      accessToken: "***REDACTED***",
      password: "***REDACTED***",
    });
  });

  it("rejects nonempty event metadata before touching PostgreSQL", async () => {
    const input = candidate();
    await expect(
      publishIssueSessionEventInTx(noTransaction, {
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
      publishIssueSessionEventInTx(noTransaction, {
        ...input,
        providerPayload: { raw: true },
      } as typeof input),
    ).rejects.toThrow("contains unknown durable fields");

    await expect(
      publishIssueSessionEventInTx(noTransaction, {
        ...input,
        event: {
          ...input.event,
          providerMetadata: { raw: true },
        } as typeof input.event,
      }),
    ).rejects.toThrow("contains unknown durable fields");

    await expect(
      publishIssueSessionEventInTx(noTransaction, {
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
      publishIssueSessionEventInTx(noTransaction, {
        ...input,
        companions: {
          toolSource: {
            kind: "completed",
            assistantMessageId: "msg_assistant",
            toolId: "tool",
            sourceOutputText: "safe",
            normalizationCodecVersion: "",
          },
        },
      }),
    ).rejects.toThrow(
      "Session tool-source normalization codec version must be a non-empty string",
    );

    await expect(
      publishIssueSessionEventInTx(noTransaction, {
        ...input,
        companions: { toolSource: null } as never,
      }),
    ).rejects.toThrow(
      "Session tool-source companion must be a plain object",
    );
  });

  it("rejects invalid comment companion enums and author identities before append", async () => {
    const input = candidate();
    await expect(
      publishIssueSessionEventInTx(noTransaction, {
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
      publishIssueSessionEventInTx(noTransaction, {
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
    ) as IssueSessionDbTransaction;
    await expect(
      publishIssueSessionEventInTx(databaseReached, {
        ...input,
        projection: {
          comment: {
            phase: "direct",
            sourceKind: "plugin_withdrawal",
            sourceId: "plugin-withdrawal",
            messageId: input.event.data.messageID,
            comment: {
              id: "33333333-3333-4333-8333-333333333333",
              body: "Plugin withdrew the issue.",
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

  it("accepts the complete typed tool-prune provenance shape before entering PostgreSQL", async () => {
    const databaseReached = new Proxy(
      {},
      {
        get() {
          throw new Error("database reached");
        },
      },
    ) as IssueSessionDbTransaction;
    await expect(
      publishIssueSessionToolPrunedEffectInTx(databaseReached, {
        id: "44444444-4444-4444-8444-444444444444",
        companyId: "11111111-1111-4111-8111-111111111111",
        issueId: "22222222-2222-4222-8222-222222222222",
        sessionId: "ses_publication_boundary_test",
        seq: 1,
        kind: "tool-pruned",
        disposition: "active",
        invalidatedAt: null,
        invalidatedByRevertEventId: null,
        invalidatedBoundaryMessageId: null,
        invalidatedBoundarySeq: null,
        historyScopeKind: "turns-recovery",
        historyScopeId: "lineage",
        audience: "turns",
        contextEpoch: 1,
        executionLineageId: "33333333-3333-4333-8333-333333333330",
        sourceHighWaterSeq: 1,
        latestFinishedAssistantMessageId: null,
        sourceRunId: "33333333-3333-4333-8333-333333333333",
        sourceRunKind: "productive",
        sourceRefId: "33333333-3333-4333-8333-333333333334",
        sourceRefOrdinal: 0,
        sourceSegmentOrdinal: 0,
        recoveryIdentityDigest: null,
        compactionRequestMessageId: null,
        summaryAssistantMessageId: null,
        failedAssistantMessageId: null,
        failedAssistantErrorKind: null,
        assistantMessageId: "assistant",
        toolId: "tool",
        prunedAt: new Date(1),
        tailStartMessageId: null,
        replayMessageId: null,
        continuationMessageId: null,
        postCheckpointAction: "none",
        compactionRunId: null,
        compactionRunKind: "compaction",
        promptTransmissionPhase: null,
        protocolSettlementState: null,
        promptSettlementReferenceId: null,
        accountingId: null,
        costEventId: null,
        settlementVersion: 0,
        settledAt: null,
        compactionFailureKind: null,
        structuralPositions: null,
        settingsSnapshot: null,
        modelSnapshot: null,
        triggerModelSnapshot: null,
        createdAt: new Date(1),
      }),
    ).rejects.toThrow("database reached");
  });

  it("accepts a recovery checkpoint companion without prompt-owner snapshots", async () => {
    const input = candidate();
    const databaseReached = new Proxy(
      {},
      {
        get() {
          throw new Error("database reached");
        },
      },
    ) as IssueSessionDbTransaction;
    await expect(
      publishIssueSessionEventInTx(databaseReached, {
        event: {
          ...input.event,
          type: "session.next.compaction.ended",
          data: {
            sessionID: input.event.sessionId,
            messageID: "msg_summary",
            timestamp: 1,
            reason: "auto",
            text: "summary",
            recent: "",
          },
        },
        envelope: {
          ...input.envelope,
          runId: "55555555-5555-4555-8555-555555555555",
          agentId: "66666666-6666-4666-8666-666666666666",
        },
        projection: {
          compactionControl: {
            id: "77777777-7777-4777-8777-777777777777",
            kind: "checkpoint",
            disposition: "active",
            invalidatedAt: null,
            invalidatedByRevertEventId: null,
            invalidatedBoundaryMessageId: null,
            invalidatedBoundarySeq: null,
            historyScopeKind: "turns-recovery",
            historyScopeId: "lineage",
            audience: "turns",
            contextEpoch: 1,
            executionLineageId:
              "33333333-3333-4333-8333-333333333330",
            sourceHighWaterSeq: 1,
            latestFinishedAssistantMessageId: null,
            sourceRunId:
              "33333333-3333-4333-8333-333333333333",
            sourceRunKind: "productive",
            sourceRefId:
              "33333333-3333-4333-8333-333333333334",
            sourceRefOrdinal: 0,
            sourceSegmentOrdinal: 0,
            recoveryIdentityDigest: null,
            compactionRequestMessageId: "msg_request",
            summaryAssistantMessageId: "msg_summary",
            failedAssistantMessageId: null,
            failedAssistantErrorKind: null,
            assistantMessageId: null,
            toolId: null,
            prunedAt: null,
            tailStartMessageId: null,
            replayMessageId: null,
            continuationMessageId: null,
            postCheckpointAction: "none",
            compactionRunId:
              "55555555-5555-4555-8555-555555555555",
            compactionRunKind: "compaction",
            promptTransmissionPhase: null,
            protocolSettlementState: null,
            promptSettlementReferenceId: null,
            accountingId: null,
            costEventId: null,
            settlementVersion: 0,
            settledAt: null,
            compactionFailureKind: null,
            structuralPositions: [
              { messageId: "msg_request", index: 0 },
            ],
            settingsSnapshot: null,
            modelSnapshot: null,
            triggerModelSnapshot: null,
            createdAt: new Date(1),
          },
        },
      }),
    ).rejects.toThrow("database reached");
  });

  it("redacts and schema-validates live-only deltas without persisting them", () => {
    const event = prepareIssueSessionLiveEvent({
      type: "session.next.tool.input.delta",
      data: {
        sessionID: "ses_publication_boundary_test",
        assistantMessageID: "msg_publication_boundary_test",
        callID: "call_1",
        timestamp: 1,
        delta: "--api-key sk-abcdefghijklmnopqrst",
      },
    });
    expect(event).toMatchObject({
      type: "session.next.tool.input.delta",
      data: {
        delta: "--api-key ***REDACTED***",
      },
    });

    expect(() =>
      prepareIssueSessionLiveEvent({
        type: "session.next.text.delta",
        data: {
          sessionID: "ses_publication_boundary_test",
          assistantMessageID: "msg_publication_boundary_test",
          textID: "text_1",
          timestamp: 1,
          delta: "safe",
          unknown: true,
        },
      }),
    ).toThrow("unknown or non-canonical shape");
  });

  it("renders retained run-log reads only from canonical Session events", () => {
    const content = issueSessionEventsAsNdjson([
      {
        id: "evt_publication_boundary_test",
        companyId: "11111111-1111-4111-8111-111111111111",
        issueId: "22222222-2222-4222-8222-222222222222",
        sessionId: "ses_publication_boundary_test",
        seq: 1,
        type: "session.next.context.updated.1",
        data: {
          sessionID: "ses_publication_boundary_test",
          messageID: "msg_publication_boundary_test",
          timestamp: 1,
          text: "***REDACTED***",
        },
        runId: "33333333-3333-4333-8333-333333333333",
        ownershipEpoch: 1,
        agentId: null,
        adapterConfigRevisionId: null,
        sourceKind: "test",
        sourceId: "source",
        immutableSourceKey: "source",
        sourceRecordId: "source",
        sourceIdentityDigest: "a".repeat(64),
        createdAt: new Date(1),
      },
    ]);
    const row = JSON.parse(content.trim()) as {
      stream: string;
      seq: number;
      chunk: string;
    };
    expect(row.stream).toBe("system");
    expect(row.seq).toBe(1);
    expect(JSON.parse(row.chunk)).toMatchObject({
      type: "session.next.context.updated",
      data: { text: "***REDACTED***" },
    });
    expect(content).not.toContain("local_file");
    expect(content).not.toContain(".ndjson");
  });
});
