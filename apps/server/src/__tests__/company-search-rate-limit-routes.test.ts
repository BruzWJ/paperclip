import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { createCompanySearchRateLimiter } from "../services/company-search-rate-limit.js";
import type { CompanySearchQuery, CompanySearchResponse } from "@paperclipai/shared";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    accessService: () => mockAccessService,
  };
});

function createSearchResponse(query: CompanySearchQuery): CompanySearchResponse {
  return {
    query: query.q,
    normalizedQuery: query.q.trim().toLowerCase(),
    scope: query.scope,
    limit: query.limit,
    offset: query.offset,
    results: [],
    sort: query.sort,
    countsByType: { issue: 0, comment: 0, document: 0, artifact: 0, agent: 0, project: 0 },
    filterOptionCounts: {
      status: {},
      priority: {},
      ownerAgentId: {},
      ownerUserId: {},
      projectId: {},
      labelId: {},
      updatedWithin: {},
    },
    zeroResults: null,
    hasMore: false,
  };
}

describe("company search route rate limiting", () => {
  beforeEach(() => {
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_company_member",
      explanation: "The authenticated user has a persisted active company membership.",
    });
  });

  it("rejects repeated same-actor search calls before invoking search", async () => {
    const search = vi.fn(async (_companyId: string, query: CompanySearchQuery) => createSearchResponse(query));
    const app = express();
    app.use((req, _res, next) => {
      req.actor = testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        isInstanceAdmin: true,
      });
      next();
    });
    app.use("/api", issueRoutes({} as never, {} as never, {
      ordinaryIssues: {} as never,
      searchService: { search },
      searchRateLimiter: createCompanySearchRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    }));

    await request(app).get("/api/companies/company-1/search?q=wizard").expect(200);
    const limited = await request(app).get("/api/companies/company-1/search?q=wizard").expect(429);

    expect(search).toHaveBeenCalledTimes(1);
    expect(limited.body).toMatchObject({
      error: "Search rate limit exceeded",
      retryAfterSeconds: 60,
    });
    expect(limited.headers["retry-after"]).toBe("60");
  });
  it("resolves ownerUserId=me for board actors before invoking search", async () => {
    const search = vi.fn(async (_companyId: string, query: CompanySearchQuery) => createSearchResponse(query));
    const app = express();
    app.use((req, _res, next) => {
      req.actor = testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        isInstanceAdmin: true,
      });
      next();
    });
    app.use("/api", issueRoutes({} as never, {} as never, {
      ordinaryIssues: {} as never,
      searchService: { search },
      searchRateLimiter: createCompanySearchRateLimiter({
        maxRequests: 10,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    }));

    await request(app).get("/api/companies/company-1/search?q=wizard&ownerUserId=me").expect(200);

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[1].ownerUserId).toBe("user-1");
  });

  it("rejects invalid filter and sort params before invoking search", async () => {
    const search = vi.fn(async (_companyId: string, query: CompanySearchQuery) => createSearchResponse(query));
    const app = express();
    app.use((req, _res, next) => {
      req.actor = testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        isInstanceAdmin: true,
      });
      next();
    });
    app.use("/api", issueRoutes({} as never, {} as never, {
      ordinaryIssues: {} as never,
      searchService: { search },
      searchRateLimiter: createCompanySearchRateLimiter({
        maxRequests: 10,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    }));

    await request(app).get("/api/companies/company-1/search?q=wizard&sort=nope").expect(400);
    await request(app).get("/api/companies/company-1/search?q=wizard&ownerAgentId=nope").expect(400);

    expect(search).not.toHaveBeenCalled();
  });

});
