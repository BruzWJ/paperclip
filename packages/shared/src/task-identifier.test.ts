import { describe, expect, it } from "vitest";
import { parseTaskIdentifier } from "./task-identifier.js";

describe("parseTaskIdentifier", () => {
  it("accepts only exact task display identifiers", () => {
    expect(parseTaskIdentifier("PAP-123")).toBe("PAP-123");
    expect(parseTaskIdentifier("pap-123")).toBeNull();
    expect(parseTaskIdentifier(" PAP-123 ")).toBeNull();
    expect(parseTaskIdentifier("123e4567-e89b-42d3-a456-426614174000")).toBeNull();
  });
});
