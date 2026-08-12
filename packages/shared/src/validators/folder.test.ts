import { describe, expect, it } from "vitest";
import { createFolderSchema, updateFolderSchema } from "./folder.js";

describe("folder mutation schemas", () => {
  it("preserves exact accepted names and colors", () => {
    expect(
      createFolderSchema.parse({ kind: "routine", name: "Operations", color: "indigo" }),
    ).toMatchObject({ name: "Operations", color: "indigo" });
  });

  it("rejects padded names and colors instead of rewriting them", () => {
    expect(
      createFolderSchema.safeParse({ kind: "routine", name: " Operations" }).success,
    ).toBe(false);
    expect(updateFolderSchema.safeParse({ color: "indigo " }).success).toBe(false);
  });
});
