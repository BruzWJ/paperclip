import { describe, expect, it } from "vitest";
import {
  buildCompactionTranscript,
  canonicalJsonStringify,
  serializeCompactionTranscript,
} from "./transcript.js";
import type { WithParts } from "./types.js";

describe("Paperclip recovery-compaction transcript", () => {
  it("uses the fixed record/key order and closed role/part vocabulary", () => {
    const messages: WithParts[] = [
      {
        info: { id: "synthetic", role: "user", kind: "synthetic" },
        parts: [{ type: "text", text: "synthetic context" }],
      },
      {
        info: { id: "system", role: "auxiliary", kind: "system" },
        parts: [{ type: "text", text: "system fact" }],
      },
      {
        info: { id: "shell", role: "auxiliary", kind: "shell" },
        parts: [{ type: "text", text: "pnpm test" }],
      },
      {
        info: { id: "control", role: "auxiliary", kind: "control" },
        parts: [{ type: "text", text: "hidden control" }],
      },
      {
        info: { id: "compaction", role: "user", kind: "compaction-request" },
        parts: [{ type: "compaction" }],
      },
    ];

    expect(
      serializeCompactionTranscript(messages, { transformForPrompt: true }),
    ).toBe(
      '{"version":"paperclip.compaction-transcript/v1","entries":[{"id":"synthetic","role":"user","parts":[{"type":"text","text":"synthetic context"}]},{"id":"system","role":"system","parts":[{"type":"text","text":"system fact"}]},{"id":"shell","role":"shell","parts":[{"type":"text","text":"Shell command: pnpm test"}]}]}',
    );
  });

  it("skips ordinary failed assistants and retains only meaningful aborted output", () => {
    const messages: WithParts[] = [
      {
        info: { id: "failed", role: "assistant", error: { name: "Other" } },
        parts: [{ type: "text", text: "must not replay" }],
      },
      {
        info: {
          id: "empty-abort",
          role: "assistant",
          error: { name: "MessageAbortedError" },
        },
        parts: [{ type: "reasoning", text: "not sufficient" }],
      },
      {
        info: {
          id: "useful-abort",
          role: "assistant",
          error: { name: "MessageAbortedError" },
        },
        parts: [{ type: "text", text: "durable partial" }],
      },
    ];

    expect(
      buildCompactionTranscript(messages, { transformForPrompt: true }).entries,
    ).toEqual([
      {
        id: "useful-abort",
        role: "assistant",
        parts: [{ type: "text", text: "durable partial" }],
      },
    ]);
  });

  it("rejects non-JSON tool inputs and sorts nested object keys", () => {
    expect(canonicalJsonStringify({ z: [3, { b: 2, a: 1 }], a: true })).toBe(
      '{"a":true,"z":[3,{"a":1,"b":2}]}',
    );
    expect(() => canonicalJsonStringify({ value: Number.NaN })).toThrow(
      "finite JSON numbers",
    );
    expect(() => canonicalJsonStringify({ value: undefined })).toThrow(
      "JSON-compatible",
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalJsonStringify(cycle)).toThrow("JSON cycle");
  });
});
