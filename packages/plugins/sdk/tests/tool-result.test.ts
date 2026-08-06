import { describe, expect, it } from "vitest";
import { decodeToolResult } from "../src/tool-result.js";

describe("decodeToolResult", () => {
  it("decodes the exact success and failure branches", () => {
    expect(decodeToolResult({
      ok: true,
      content: "found",
      data: { records: ["one"], count: 1 },
    })).toEqual({
      ok: true,
      content: "found",
      data: { records: ["one"], count: 1 },
    });
    expect(decodeToolResult({
      ok: false,
      error: "not found",
      data: { query: "missing" },
    })).toEqual({
      ok: false,
      error: "not found",
      data: { query: "missing" },
    });
  });

  it.each([
    null,
    {},
    { content: "legacy" },
    { ok: true },
    { ok: true, content: "found", error: "ambiguous" },
    { ok: false },
    { ok: false, error: "failed", content: "ambiguous" },
    { ok: true, content: "found", data: [] },
    { ok: true, content: "found", data: { invalid: undefined } },
    { ok: true, content: "found", data: { invalid: Number.NaN } },
  ])("rejects non-canonical result %#", (value) => {
    expect(() => decodeToolResult(value)).toThrow("Invalid plugin ToolResult");
  });
});
