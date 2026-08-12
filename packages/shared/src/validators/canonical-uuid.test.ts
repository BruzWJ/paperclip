import { describe, expect, it } from "vitest";
import { canonicalUuidSchema } from "./canonical-uuid.js";

const CANONICAL_UUID = "abcdefab-cdef-4abc-8def-abcdefabcdef";

describe("canonicalUuidSchema", () => {
  it("accepts only the exact lowercase canonical representation", () => {
    expect(canonicalUuidSchema.parse(CANONICAL_UUID)).toBe(CANONICAL_UUID);
    expect(canonicalUuidSchema.safeParse(CANONICAL_UUID.toUpperCase()).success).toBe(false);
    expect(canonicalUuidSchema.safeParse(` ${CANONICAL_UUID}`).success).toBe(false);
    expect(canonicalUuidSchema.safeParse("00000000-0000-0000-0000-000000000000").success).toBe(false);
  });
});
