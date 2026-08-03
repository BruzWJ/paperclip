import { describe, expect, it } from "vitest";
import {
  COMPANY_SEARCH_MAX_QUERY_LENGTH,
  companySearchQuerySchema,
} from "@paperclipai/shared";
import {
  COMPANY_SEARCH_BRANCH_FETCH_LIMIT,
  companySearchBranchFetchLimit,
  companySearchService,
} from "../services/company-search.js";
import { createMockDb } from "./helpers/mock-db.js";

describe("company search query validation", () => {
  it("normalizes supported filters and rejects invalid query dimensions", () => {
    const parsed = companySearchQuerySchema.parse({
      q: "x".repeat(COMPANY_SEARCH_MAX_QUERY_LENGTH + 50),
      limit: "50",
      offset: "200",
      scope: "all",
      status: "todo,blocked",
      priority: ["critical", "low"],
      sort: "priority",
      updatedWithin: "7d",
    });

    expect(parsed.q).toHaveLength(COMPANY_SEARCH_MAX_QUERY_LENGTH);
    expect(parsed.status).toEqual(["todo", "blocked"]);
    expect(parsed.priority).toEqual(["critical", "low"]);
    expect(parsed.sort).toBe("priority");
    expect(parsed.updatedWithin).toBe("7d");
    expect(() => companySearchQuerySchema.parse({ q: "needle", limit: "500" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", offset: "9000" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", scope: "not-a-scope" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", status: "not-a-status" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", priority: "urgent" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", sort: "oldest" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", updatedWithin: "forever" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", projectId: "not-a-uuid" })).toThrow();
  });

  it("includes offset in the bounded per-branch fetch window", () => {
    expect(companySearchBranchFetchLimit(50, 0)).toBe(51);
    expect(companySearchBranchFetchLimit(50, 200)).toBe(COMPANY_SEARCH_BRANCH_FETCH_LIMIT);
    expect(companySearchBranchFetchLimit(Number.NaN, -10)).toBe(51);
  });
});

describe("companySearchService", () => {
  it("returns the canonical empty response without querying persistence", async () => {
    const mock = createMockDb();
    const query = companySearchQuerySchema.parse({
      q: "   ",
      scope: "all",
      sort: "relevance",
      limit: 25,
      offset: 0,
    });

    const result = await companySearchService(mock.db).search(
      "00000000-0000-4000-8000-000000000001",
      query,
    );

    expect(result).toMatchObject({
      query: "",
      normalizedQuery: "",
      scope: "all",
      sort: "relevance",
      limit: 25,
      offset: 0,
      results: [],
      zeroResults: null,
      hasMore: false,
    });
    expect(result.countsByType).toEqual({
      issue: 0,
      comment: 0,
      document: 0,
      artifact: 0,
      agent: 0,
      project: 0,
    });
    expect(mock.calls).toEqual([]);
  });
});
