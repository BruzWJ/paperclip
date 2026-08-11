import { describe, expect, it } from "vitest";
import { normalizeAcpToolOutput } from "./tool-output.js";

describe("canonical ACP tool output", () => {
  it("preserves a raw JavaScript string byte-for-code-unit", () => {
    const value = "line one\r\nline two\u0000\ud800";
    expect(normalizeAcpToolOutput({ rawOutput: value })).toBe(value);
  });

  it("canonicalizes every present non-string JSON value", () => {
    expect(
      normalizeAcpToolOutput({
        rawOutput: { z: [3, { y: true, a: null }], a: 1 },
      }),
    ).toBe('{"a":1,"z":[3,{"a":null,"y":true}]}');
    expect(normalizeAcpToolOutput({ rawOutput: 0 })).toBe("0");
    expect(normalizeAcpToolOutput({ rawOutput: false })).toBe("false");
    expect(normalizeAcpToolOutput({ rawOutput: null })).toBe("null");
    expect(normalizeAcpToolOutput({ rawOutput: ["b", "a"] })).toBe(
      '["b","a"]',
    );
  });

  it("joins ordered all-text stable content", () => {
    expect(
      normalizeAcpToolOutput({
        content: [
          { type: "content", content: { type: "text", text: "first" } },
          { type: "content", content: { type: "text", text: "second" } },
        ],
      }),
    ).toBe("first\nsecond");
  });

  it("canonicalizes mixed stable content and removes metadata recursively", () => {
    expect(
      normalizeAcpToolOutput({
        content: [
          {
            type: "diff",
            path: "/work/a.ts",
            newText: "next",
            oldText: "prior",
            _meta: { secret: "outer" },
          },
          {
            type: "terminal",
            terminalId: "terminal-1",
            _meta: { secret: "terminal" },
          },
          {
            type: "content",
            content: {
              type: "text",
              text: "tail",
              _meta: { secret: "nested" },
            },
          },
        ],
      }),
    ).toBe(
      '[{"newText":"next","oldText":"prior","path":"/work/a.ts","type":"diff"},{"terminalId":"terminal-1","type":"terminal"},{"content":{"text":"tail","type":"text"},"type":"content"}]',
    );
  });

  it("uses empty output only when raw output and usable content are absent", () => {
    expect(normalizeAcpToolOutput({})).toBe("");
    expect(normalizeAcpToolOutput({ content: [] })).toBe("");
  });

  it("fails malformed non-JSON raw state instead of inventing output", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const rawOutput of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      undefined,
      new Date(0),
      cyclic,
    ]) {
      if (rawOutput === undefined) continue;
      expect(() => normalizeAcpToolOutput({ rawOutput })).toThrow(
        /ACP tool output/,
      );
    }
    const sparse = Array<string>(1);
    expect(() => normalizeAcpToolOutput({ rawOutput: sparse })).toThrow(
      /sparse array/,
    );
  });
});
