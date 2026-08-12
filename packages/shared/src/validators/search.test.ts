import { describe, expect, it } from "vitest";
import { companySearchQuerySchema } from "./search.js";

describe("company search list filters", () => {
  it("accepts repeated status and priority query values", () => {
    expect(companySearchQuerySchema.parse({
      status: ["todo", "blocked"],
      priority: ["high", "low"],
    })).toMatchObject({
      status: ["todo", "blocked"],
      priority: ["high", "low"],
    });
  });

  it("rejects comma-separated aliases", () => {
    expect(companySearchQuerySchema.safeParse({ status: "todo,blocked" }).success).toBe(false);
    expect(companySearchQuerySchema.safeParse({ priority: "high,low" }).success).toBe(false);
  });

  it.each([
    { ownerAgentId: "null" },
    { ownerAgentId: " NULL " },
    { ownerAgentId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    { projectId: " aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa " },
    { labelId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    { scope: ["tasks", "all"] },
    { q: " wizard" },
    { ownerUserId: " user-1" },
    { updatedAfter: "2026-01-01" },
    { limit: "01" },
    { offset: 0 },
    { status: ["todo", "todo"] },
    { unknown: "value" },
  ])("rejects non-canonical scalar query input %j", (input) => {
    expect(companySearchQuerySchema.safeParse(input).success).toBe(false);
  });
});
