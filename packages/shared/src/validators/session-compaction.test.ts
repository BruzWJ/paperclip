import { describe, expect, it } from "vitest";
import {
  sessionCompactionSettingsSchema,
  updateSessionCompactionSettingsSchema,
} from "./session-compaction.js";

describe("session compaction validators", () => {
  it("accepts a sparse override document without materializing defaults", () => {
    expect(
      sessionCompactionSettingsSchema.parse({
        auto: false,
        reserved: 0,
        preserve_recent_tokens: 0,
      }),
    ).toEqual({ auto: false, reserved: 0, preserve_recent_tokens: 0 });
    expect(sessionCompactionSettingsSchema.parse({})).toEqual({});
  });

  it("preserves reset documents and rejects invalid overrides", () => {
    expect(updateSessionCompactionSettingsSchema.parse({})).toEqual({});
    expect(() =>
      updateSessionCompactionSettingsSchema.parse({ reserved: -1 }),
    ).toThrow();
    expect(() =>
      updateSessionCompactionSettingsSchema.parse({ modelRef: null }),
    ).toThrow();
  });
});
