import { describe, expect, it } from "vitest";
import { buildPrompt } from "./build-prompt.js";
import {
  PRUNE_MINIMUM,
} from "./algorithms.js";
import { decodeCompactionConfig } from "./config.js";
import { isMedia, isPdfAttachment } from "./media.js";
import {
  filterCompacted,
  latest,
  buildCompactionPrompt,
  buildCompactionTranscript,
  serializeCompactionTranscript,
} from "./transcript.js";
import { isOverflow, usable } from "./overflow.js";
import {
  createIssueSessionCompaction,
  type IssueSessionCompactionPersistence,
} from "./runtime.js";
import { maxOutputTokens, OUTPUT_TOKEN_MAX } from "./provider-transform.js";
import { CHARS_PER_TOKEN, estimate } from "./token.js";
import type {
  Config,
  ProviderModel,
  ToolPart,
  WithParts,
} from "./types.js";

const model: ProviderModel = {
  providerID: "provider",
  id: "model",
  api: { id: "model", npm: "@ai-sdk/openai" },
  limit: { context: 100_000, input: 80_000, output: 30_000 },
};

function persistence(input?: {
  config?: Config;
  messages?: WithParts[];
  events?: string[];
  summarize?: IssueSessionCompactionPersistence["summarize"];
  replayOverflow?: NonNullable<IssueSessionCompactionPersistence["replayOverflow"]>;
  appendSyntheticContinue?: NonNullable<
    IssueSessionCompactionPersistence["appendSyntheticContinue"]
  >;
  publishCompactionEnded?: IssueSessionCompactionPersistence["publishCompactionEnded"];
  pruned?: ToolPart[];
}): IssueSessionCompactionPersistence {
  const events = input?.events ?? [];
  return {
    async config() {
      return input?.config ?? {};
    },
    async messages() {
      return input?.messages;
    },
    async modelForCompaction() {
      return model;
    },
    async updateToolPruned({ part }) {
      input?.pruned?.push(part);
    },
    async createCompactionRequest() {
      events.push("create");
      return { parentId: "request" };
    },
    summarize:
      input?.summarize ??
      (async ({ parentId, tailStartId }) => {
        events.push("summarize");
        return {
          requestMessageId: parentId,
          summaryMessageId: "summary",
          tailStartId,
          result: "continue",
        };
      }),
    publishCompactionEnded:
      input?.publishCompactionEnded ??
      (async () => {
        events.push("publish");
      }),
    replayOverflow:
      input?.replayOverflow ??
      (async () => {
        events.push("replay");
        return { replayMessageId: "replay" };
      }),
    appendSyntheticContinue:
      input?.appendSyntheticContinue ??
      (async () => {
        events.push("continue");
      }),
  };
}

describe("Paperclip session compaction behavior", () => {
  it("executes exact output-limit, token-estimator, and usable/overflow bodies", () => {
    expect(OUTPUT_TOKEN_MAX).toBe(32_000);
    expect(maxOutputTokens(model)).toBe(30_000);
    expect(maxOutputTokens({ ...model, limit: { ...model.limit, output: 0 } })).toBe(32_000);
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(estimate("123456")).toBe(2);
    expect(usable({ cfg: {}, model })).toBe(60_000);
    expect(
      usable({ cfg: {}, model, outputTokenMax: 10_000 }),
    ).toBe(70_000);
    expect(
      usable({ cfg: { compaction: { reserved: 5_000 } }, model }),
    ).toBe(75_000);
    expect(
      isOverflow({
        cfg: { compaction: { auto: false } },
        model,
        tokens: {
          total: 90_000,
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    ).toBe(false);
  });

  it("executes the exact five-knob config schema", () => {
    expect(decodeCompactionConfig(undefined)).toBeUndefined();
    expect(
      decodeCompactionConfig({
        auto: false,
        prune: true,
        tail_turns: 0,
        preserve_recent_tokens: 2_000,
        reserved: 20_000,
      }),
    ).toEqual({
      auto: false,
      prune: true,
      tail_turns: 0,
      preserve_recent_tokens: 2_000,
      reserved: 20_000,
    });
    expect(() => decodeCompactionConfig({ reserved: -1 })).toThrow();
  });

  it("runs tail selection with sequential estimates through the session service", async () => {
    const messages: WithParts[] = [
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "1" }] },
      {
        info: { id: "a1", role: "assistant", parentID: "u1" },
        parts: [{ type: "text", text: "1a" }],
      },
      { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "2" }] },
      {
        info: { id: "a2", role: "assistant", parentID: "u2" },
        parts: [{ type: "text", text: "2a" }],
      },
      { info: { id: "u3", role: "user" }, parts: [{ type: "text", text: "3" }] },
      {
        info: { id: "a3", role: "assistant", parentID: "u3" },
        parts: [{ type: "text", text: "3a" }],
      },
      {
        info: { id: "request", role: "user" },
        parts: [{ type: "compaction", auto: false }],
      },
    ];
    let selected: string[] = [];
    let tailStartId: string | undefined;
    const flow = createIssueSessionCompaction(
      persistence({
        config: {
          compaction: {
            tail_turns: 2,
            preserve_recent_tokens: 60,
          },
        },
        messages,
        summarize: async (value) => {
          selected = value.messages.map((message) => message.info.id);
          tailStartId = value.tailStartId;
          return {
            requestMessageId: value.parentId,
            summaryMessageId: "summary",
            tailStartId: value.tailStartId,
            result: "continue",
          };
        },
      }),
    );
    await flow.process({
      parentID: "request",
      messages,
      sessionID: "session",
      auto: false,
    });
    expect(selected).toEqual(["u1", "a1", "u2", "a2"]);
    expect(tailStartId).toBe("u3");
  });

  it("honors sparse zero and numeric tail overrides through public compaction selection", async () => {
    const messages: WithParts[] = [
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "one" }] },
      { info: { id: "a1", role: "assistant", parentID: "u1" }, parts: [{ type: "text", text: "one-a" }] },
      { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "two" }] },
      { info: { id: "a2", role: "assistant", parentID: "u2" }, parts: [{ type: "text", text: "two-a" }] },
      { info: { id: "u3", role: "user" }, parts: [{ type: "text", text: "three" }] },
      { info: { id: "a3", role: "assistant", parentID: "u3" }, parts: [{ type: "text", text: "three-a" }] },
      { info: { id: "request", role: "user" }, parts: [{ type: "compaction", auto: false }] },
    ];
    const selectedFor = async (config: Config) => {
      let selected: string[] = [];
      let tailStartId: string | undefined;
      const flow = createIssueSessionCompaction(
        persistence({
          config,
          messages,
          summarize: async (value) => {
            selected = value.messages.map((message) => message.info.id);
            tailStartId = value.tailStartId;
            return {
              requestMessageId: value.parentId,
              summaryMessageId: "summary",
              tailStartId: value.tailStartId,
              result: "continue",
            };
          },
        }),
      );
      await flow.process({
        parentID: "request",
        messages,
        sessionID: "session",
        auto: false,
      });
      return { selected, tailStartId };
    };

    await expect(
      selectedFor({ compaction: { tail_turns: 0, preserve_recent_tokens: 0 } }),
    ).resolves.toEqual({
      selected: ["u1", "a1", "u2", "a2", "u3", "a3"],
      tailStartId: undefined,
    });
    await expect(
      selectedFor({ compaction: { tail_turns: 1, preserve_recent_tokens: 100 } }),
    ).resolves.toEqual({
      selected: ["u1", "a1", "u2", "a2"],
      tailStartId: "u3",
    });
  });

  it("executes pruning with skill, last-two-turn, 40k, and strict 20k protection", async () => {
    const oldOutput = "x".repeat((40_000 + PRUNE_MINIMUM + 10) * 4);
    const messages: WithParts[] = [
      {
        info: { id: "u0", role: "user" },
        parts: [{ type: "text", text: "old" }],
      },
      {
        info: { id: "a0", role: "assistant", parentID: "u0" },
        parts: [
          {
            type: "tool",
            tool: "read",
            callID: "old",
            state: {
              status: "completed",
              input: {},
              output: oldOutput,
              time: {},
            },
          },
          {
            type: "tool",
            tool: "skill",
            callID: "protected",
            state: {
              status: "completed",
              input: {},
              output: oldOutput,
              time: {},
            },
          },
        ],
      },
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "one" }] },
      { info: { id: "a1", role: "assistant", parentID: "u1" }, parts: [] },
      { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "two" }] },
      { info: { id: "a2", role: "assistant", parentID: "u2" }, parts: [] },
    ];
    const pruned: ToolPart[] = [];
    const flow = createIssueSessionCompaction(
      persistence({
        config: { compaction: { prune: true } },
        messages,
        pruned,
      }),
    );
    await flow.prune({ sessionID: "session" });
    expect(pruned.map((part) => part.callID)).toEqual(["old"]);
    expect(
      pruned[0]?.state.status === "completed"
        ? pruned[0].state.time.compacted
        : undefined,
    ).toEqual(expect.any(Number));
  });

  it("reorders checkpoint summary/tail and selects only compaction work by maximum id", () => {
    const messages: WithParts[] = [
      { info: { id: "old", role: "user" }, parts: [{ type: "text", text: "old" }] },
      {
        info: { id: "request", role: "user" },
        parts: [{ type: "compaction", tail_start_id: "tail" }],
      },
      {
        info: {
          id: "summary",
          role: "assistant",
          parentID: "request",
          summary: true,
          finish: "stop",
        },
        parts: [{ type: "text", text: "summary" }],
      },
      { info: { id: "tail", role: "user" }, parts: [{ type: "text", text: "tail" }] },
    ];
    expect(filterCompacted(messages).map((message) => message.info.id)).toEqual([
      "tail",
      "summary",
      "request",
      "old",
    ]);
    expect(
      latest([
        ...messages,
        {
          info: {
            id: "x",
            role: "assistant",
            parentID: "tail",
            finish: "stop",
          },
          parts: [{ type: "text", text: "finished" }],
        },
        {
          info: { id: "z", role: "user" },
          parts: [{ type: "compaction", tail_start_id: "tail" }],
        },
      ]).pendingCompactions,
    ).toEqual([
      { type: "compaction", tail_start_id: "tail" },
    ]);
  });

  it("builds one canonical provider-neutral transcript and prompt", () => {
    const messages: WithParts[] = [
      {
        info: { id: "user", role: "user" },
        parts: [
          { type: "text", text: "request" },
          {
            type: "file",
            mime: "image/png",
            url: "data:image/png,abc",
            filename: "input.png",
          },
        ],
      },
      {
        info: {
          id: "assistant",
          role: "assistant",
          parentID: "user",
          providerID: "provider",
          modelID: "model",
        },
        parts: [
          {
            type: "tool",
            tool: "read",
            callID: "call",
            state: {
              status: "completed",
              input: { z: 1, a: { y: true, x: false } },
              output: "x".repeat(2_001),
              attachments: [{ mime: "image/png", url: "data:image/png,abc" }],
              time: {},
            },
          },
          {
            type: "tool",
            tool: "interrupted",
            callID: "interrupted",
            state: {
              status: "error",
              input: {},
              error: "failed",
              metadata: { interrupted: true, output: "partial" },
            },
          },
          {
            type: "tool",
            tool: "pending",
            callID: "pending",
            state: { status: "pending", input: {} },
          },
        ],
      },
    ];
    const sizing = serializeCompactionTranscript(messages, {
      transformForPrompt: false,
    });
    expect(sizing).toContain("x".repeat(2_001));
    expect(sizing).not.toContain("Attached image/png");

    const transcript = buildCompactionTranscript(messages, {
      transformForPrompt: true,
    });
    expect(transcript.version).toBe("paperclip.compaction-transcript/v1");
    expect(transcript.entries).toHaveLength(2);
    expect(transcript.entries[0]).toEqual({
      id: "user",
      role: "user",
      parts: [
        { type: "text", text: "request" },
        { type: "text", text: "[Attached image/png: input.png]" },
      ],
    });
    const json = JSON.stringify(transcript);
    expect(json).toContain(
      '"input":{"a":{"x":false,"y":true},"z":1}',
    );
    expect(json).toContain(
      "[Tool output truncated for compaction: omitted 1 chars]",
    );
    expect(json).toContain("partial");
    expect(json).toContain("[Tool execution was interrupted]");
    expect(json).not.toContain("data:image");

    const prompt = buildCompactionPrompt({
      messages,
      instruction: "summarize exactly",
    });
    expect(prompt).toBe(
      `PAPERCLIP_COMPACTION_TRANSCRIPT_V1\n${json}\nPAPERCLIP_COMPACTION_INSTRUCTION_V1\nsummarize exactly`,
    );
  });

  it("executes actual media and PDF classification", () => {
    expect(isPdfAttachment("application/pdf")).toBe(true);
    expect(isPdfAttachment("image/png")).toBe(false);
    expect(isMedia("image/png")).toBe(true);
    expect(isMedia("application/pdf")).toBe(true);
    expect(isMedia("text/plain")).toBe(false);
  });

  it("publishes the summary checkpoint before overflow replay", async () => {
    const events: string[] = [];
    let replayParts: WithParts["parts"] = [];
    let finalReplayMessageId: string | null | undefined;
    let finalPostCheckpointAction: string | undefined;
    const messages: WithParts[] = [
      { info: { id: "u0", role: "user" }, parts: [{ type: "text", text: "old" }] },
      {
        info: { id: "u1", role: "user" },
        parts: [
          { type: "text", text: "retry" },
          {
            type: "file",
            mime: "application/pdf",
            url: "data:application/pdf,abc",
            filename: "large.pdf",
          },
        ],
      },
      {
        info: { id: "request", role: "user" },
        parts: [{ type: "compaction", auto: true, overflow: true }],
      },
    ];
    const flow = createIssueSessionCompaction(
      persistence({
        events,
        messages,
        replayOverflow: async ({ replay }) => {
          events.push("replay");
          replayParts = replay.parts;
          return { replayMessageId: "replay-message" };
        },
        publishCompactionEnded: async ({ control }) => {
          events.push("publish");
          finalReplayMessageId = control.replayMessageId;
          finalPostCheckpointAction = control.postCheckpointAction;
        },
      }),
    );
    expect(
      await flow.process({
        parentID: "request",
        messages,
        sessionID: "session",
        auto: true,
        overflow: true,
      }),
    ).toBe("continue");
    expect(events).toEqual(["summarize", "publish", "replay"]);
    expect(finalReplayMessageId).toBeNull();
    expect(finalPostCheckpointAction).toBe("overflow-replay");
    expect(replayParts).toEqual([
      { type: "text", text: "retry" },
      { type: "text", text: "[Attached application/pdf: large.pdf]" },
    ]);
  });

  it("publishes the summary checkpoint before synthetic auto-continue", async () => {
    const events: string[] = [];
    let continuation = "";
    let finalPostCheckpointAction: string | undefined;
    const messages: WithParts[] = [
      { info: { id: "u0", role: "user" }, parts: [{ type: "text", text: "old" }] },
      {
        info: { id: "request", role: "user" },
        parts: [{ type: "compaction", auto: true, overflow: true }],
      },
    ];
    const flow = createIssueSessionCompaction(
      persistence({
        events,
        messages,
        appendSyntheticContinue: async ({ text }) => {
          events.push("continue");
          continuation = text;
        },
        publishCompactionEnded: async ({ control }) => {
          events.push("publish");
          finalPostCheckpointAction = control.postCheckpointAction;
        },
      }),
    );
    expect(
      await flow.process({
        parentID: "request",
        messages,
        sessionID: "session",
        auto: true,
        overflow: true,
      }),
    ).toBe("continue");
    expect(events).toEqual(["summarize", "publish", "continue"]);
    expect(finalPostCheckpointAction).toBe("auto-continue");
    expect(continuation).toBe(
      "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n" +
        "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
    );
  });

  it("stops a second summary overflow with the canonical discriminator", async () => {
    const events: string[] = [];
    const messages: WithParts[] = [
      { info: { id: "u0", role: "user" }, parts: [{ type: "text", text: "old" }] },
      {
        info: { id: "request", role: "user" },
        parts: [{ type: "compaction", auto: true, overflow: true }],
      },
    ];
    const flow = createIssueSessionCompaction(
      persistence({
        events,
        messages,
        summarize: async ({ parentId }) => ({
          requestMessageId: parentId,
          summaryMessageId: "summary",
          result: "compact",
        }),
      }),
    );
    await expect(
      flow.process({
        parentID: "request",
        messages,
        sessionID: "session",
        auto: true,
        overflow: true,
      }),
    ).rejects.toThrow(
      "Session too large to compact - context exceeds model limit even after stripping media",
    );
    expect(events).toEqual([]);
  });

  it("creates only the request marker and chains the anchored-summary template", async () => {
    const events: string[] = [];
    const flow = createIssueSessionCompaction(persistence({ events }));
    await flow.create({
      sessionID: "session",
      agent: "agent",
      model: { providerID: "provider", modelID: "model" },
      auto: false,
    });
    expect(events).toEqual(["create"]);

    const prompt = buildPrompt({
      previousSummary: "prior",
      context: [],
    });
    expect(prompt).toContain("<previous-summary>\nprior\n</previous-summary>");
    expect(prompt).toContain("## Objective");
    expect(prompt).toContain("Do not mention the summary process");
  });
});
