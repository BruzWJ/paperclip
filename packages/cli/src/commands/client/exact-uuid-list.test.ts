import { describe, expect, it } from "vitest";
import { parseExactCanonicalUuidList } from "./exact-uuid-list.js";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "abcdefab-cdef-4abc-8def-abcdefabcdef";

describe("parseExactCanonicalUuidList", () => {
  it("accepts only an exact duplicate-free UUID list", () => {
    expect(parseExactCanonicalUuidList(`${FIRST_ID},${SECOND_ID}`, "--ids")).toEqual([
      FIRST_ID,
      SECOND_ID,
    ]);
    expect(parseExactCanonicalUuidList(undefined, "--ids")).toBeUndefined();
  });

  it.each([
    "",
    ` ${FIRST_ID}`,
    `${FIRST_ID},`,
    `${FIRST_ID},${FIRST_ID}`,
    SECOND_ID.toUpperCase(),
  ])("rejects the noncanonical list %j", (value) => {
    expect(() => parseExactCanonicalUuidList(value, "--ids")).toThrow(/exact canonical UUIDs/);
  });
});
