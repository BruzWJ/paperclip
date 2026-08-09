import { describe, expect, it } from "vitest";
import { localExecutionCorrelationFingerprint } from "./local-execution-correlation.js";

describe("local execution correlation fingerprint", () => {
  it("is stable per immutable adapter revision and distinct across revisions", () => {
    const first = localExecutionCorrelationFingerprint("revision-1");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(localExecutionCorrelationFingerprint("revision-1")).toBe(first);
    expect(localExecutionCorrelationFingerprint("revision-2")).not.toBe(first);
  });

  it("rejects non-canonical revision ids", () => {
    expect(() => localExecutionCorrelationFingerprint(" revision-1"))
      .toThrow(/exact and non-empty/);
    expect(() => localExecutionCorrelationFingerprint(""))
      .toThrow(/exact and non-empty/);
  });
});
