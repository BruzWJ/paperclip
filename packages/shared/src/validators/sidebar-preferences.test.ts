import { describe, expect, it } from "vitest";
import { upsertSidebarOrderPreferenceSchema } from "./sidebar-preferences.js";

const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("upsertSidebarOrderPreferenceSchema", () => {
  it("accepts one exact ordered UUID sequence", () => {
    expect(
      upsertSidebarOrderPreferenceSchema.parse({ orderedIds: [firstId, secondId] }),
    ).toEqual({ orderedIds: [firstId, secondId] });
  });

  it("rejects duplicates and UUID aliases instead of normalizing them", () => {
    expect(
      upsertSidebarOrderPreferenceSchema.safeParse({ orderedIds: [firstId, firstId] }).success,
    ).toBe(false);
    expect(
      upsertSidebarOrderPreferenceSchema.safeParse({ orderedIds: [` ${firstId} `] }).success,
    ).toBe(false);
    expect(
      upsertSidebarOrderPreferenceSchema.safeParse({ orderedIds: [firstId.toUpperCase()] }).success,
    ).toBe(false);
  });
});
