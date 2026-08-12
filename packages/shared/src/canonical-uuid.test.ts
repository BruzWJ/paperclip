import { describe, expect, it } from "vitest";
import { isCanonicalUuid } from "./canonical-uuid.js";

describe("isCanonicalUuid", () => {
  it("accepts only the exact canonical UUID representation", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";

    expect(isCanonicalUuid(uuid)).toBe(true);
    for (const version of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
      expect(isCanonicalUuid(`123e4567-e89b-${version}2d3-a456-426614174000`)).toBe(true);
    }
    expect(isCanonicalUuid(uuid.toUpperCase())).toBe(false);
    expect(isCanonicalUuid(` ${uuid} `)).toBe(false);
    expect(isCanonicalUuid("123e4567-e89b-02d3-a456-426614174000")).toBe(false);
    expect(isCanonicalUuid("123e4567-e89b-92d3-a456-426614174000")).toBe(false);
    expect(isCanonicalUuid("123e4567-e89b-42d3-7456-426614174000")).toBe(false);
    expect(isCanonicalUuid("project-alpha")).toBe(false);
    expect(isCanonicalUuid(null)).toBe(false);
  });
});
