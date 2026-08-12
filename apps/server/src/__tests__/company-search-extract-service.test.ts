import { describe, expect, it } from "vitest";
import {
  COMPANY_SEARCH_EXTRACT_DEFAULT_MATCHES_PER_TASK,
  COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_TASK,
  companySearchExtractQuerySchema,
} from "@paperclipai/shared";
import { companySearchExtractService } from "../services/company-search-extract.js";
import { createMockDb } from "./helpers/mock-db.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: taskId,
    identifier: "EXT-1",
    title: "Extract target",
    request: null,
    boardPresentationStatus: "in_progress",
    ownerAgentId: null,
    ownerUserId: null,
    updatedAt: new Date("2026-04-21T12:00:00.000Z"),
    ...overrides,
  };
}

describe("extract-search query validation", () => {
  it("accepts supported extraction filters and rejects unsafe or ambiguous input", () => {
    const parsed = companySearchExtractQuerySchema.parse({
      contains: "github.com/paperclipai/paperclip/pull",
      kind: "url",
      scope: "comments",
      status: ["in_progress", "in_review"],
      limit: "200",
      offset: "5000",
      matchesPerTask: "200",
      updatedWithin: "30d",
    });

    expect(parsed.kind).toBe("url");
    expect(parsed.scope).toBe("comments");
    expect(parsed.status).toEqual(["in_progress", "in_review"]);
    expect(parsed.matchesPerTask).toBe(
      COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_TASK,
    );
    expect(() =>
      companySearchExtractQuerySchema.parse({ contains: ".*", kind: "regex" }),
    ).toThrow();
    expect(() =>
      companySearchExtractQuerySchema.parse({ contains: "x" }),
    ).toThrow();
    expect(() =>
      companySearchExtractQuerySchema.parse({
        contains: "needle",
        limit: "201",
      }),
    ).toThrow();
    expect(() =>
      companySearchExtractQuerySchema.parse({
        contains: "needle",
        matchesPerTask: "201",
      }),
    ).toThrow();
    expect(() =>
      companySearchExtractQuerySchema.parse({
        contains: "needle",
        updatedWithin: "30d",
        updatedAfter: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("companySearchExtractService", () => {
  it("expands and deduplicates URLs across task, comment, and document sources", async () => {
    const firstUrl = "https://github.com/paperclipai/paperclip/pull/123";
    const secondUrl = "https://github.com/paperclipai/paperclip/pull/456";
    const thirdUrl = "https://github.com/paperclipai/paperclip/pull/789";
    const { db } = createMockDb({
      select: [
        [
          taskRow({
            request: `Primary ${firstUrl} and duplicate ${firstUrl}.`,
          }),
        ],
        [
          {
            id: "comment-1",
            taskId,
            body: `Review ${secondUrl} and repeat ${firstUrl}`,
          },
        ],
        [
          {
            id: "document-1",
            taskId,
            key: "plan",
            title: `PR notes ${thirdUrl}`,
            body: `Also see [the second PR](${secondUrl}).`,
          },
        ],
      ],
    });

    const result = await companySearchExtractService(db).extract(
      companyId,
      companySearchExtractQuerySchema.parse({
        contains: "github.com/paperclipai/paperclip/pull",
        kind: "url",
      }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.matches.map((match) => match.value)).toEqual([
      firstUrl,
      secondUrl,
      thirdUrl,
    ]);
    expect(result.results[0]?.matches.map((match) => match.field)).toEqual([
      "request",
      "comment",
      "document_title",
    ]);
    expect(result.results[0]?.matchesTruncated).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("keeps URL sources selected by scheme-less queries", async () => {
    const titleUrl = "https://github.com/paperclipai/paperclip/pull/101";
    const requestUrl = "https://github.com/paperclipai/paperclip/pull/102";
    const documentTitleUrl =
      "https://github.com/paperclipai/paperclip/pull/103";
    const documentBodyUrl = "https://github.com/paperclipai/paperclip/pull/104";
    const { db } = createMockDb({
      select: [
        [
          taskRow({
            title: `Review ${titleUrl}`,
            request: `Then merge ${requestUrl}`,
          }),
        ],
        [],
        [
          {
            id: "document-1",
            taskId,
            key: "plan",
            title: `Tracking ${documentTitleUrl}`,
            body: `Final follow-up ${documentBodyUrl}`,
          },
        ],
      ],
    });

    const result = await companySearchExtractService(db).extract(
      companyId,
      companySearchExtractQuerySchema.parse({
        contains: "github.com/paperclipai/paperclip/pull",
        kind: "url",
        scope: "all",
      }),
    );

    expect(
      result.results[0]?.matches.map((match) => [match.field, match.value]),
    ).toEqual([
      ["title", titleUrl],
      ["request", requestUrl],
      ["document_title", documentTitleUrl],
      ["document_body", documentBodyUrl],
    ]);
  });

  it("returns only candidate rows selected by the status and update predicates", async () => {
    const { db, calls } = createMockDb({
      select: [
        [taskRow({ identifier: "EXT-RECENT", request: "needle" })],
        [],
        [],
      ],
    });

    const result = await companySearchExtractService(db).extract(
      companyId,
      companySearchExtractQuerySchema.parse({
        contains: "needle",
        updatedWithin: "30d",
        status: "in_review",
      }),
    );

    expect(result.results.map((row) => row.taskId)).toEqual([taskId]);
    expect(calls.filter((call) => call.method === "where")).toHaveLength(3);
  });

  it("uses the default distinct-match cap and marks truncation explicitly", async () => {
    const urls = Array.from(
      { length: COMPANY_SEARCH_EXTRACT_DEFAULT_MATCHES_PER_TASK + 1 },
      (_, index) =>
        `https://github.com/paperclipai/paperclip/pull/${index + 1}`,
    );
    const { db } = createMockDb({
      select: [[taskRow({ request: urls.join(" ") })], [], []],
    });

    const result = await companySearchExtractService(db).extract(
      companyId,
      companySearchExtractQuerySchema.parse({
        contains: "github.com/paperclipai/paperclip/pull",
        kind: "url",
      }),
    );

    expect(result.matchesPerTask).toBe(
      COMPANY_SEARCH_EXTRACT_DEFAULT_MATCHES_PER_TASK,
    );
    expect(result.results[0]?.matches).toHaveLength(
      COMPANY_SEARCH_EXTRACT_DEFAULT_MATCHES_PER_TASK,
    );
    expect(result.results[0]?.matchesTruncated).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("supports a bounded per-task match cap for complete machine extraction", async () => {
    const urls = Array.from(
      { length: COMPANY_SEARCH_EXTRACT_DEFAULT_MATCHES_PER_TASK + 1 },
      (_, index) =>
        `https://github.com/paperclipai/paperclip/pull/${index + 1}`,
    );
    const { db } = createMockDb({
      select: [[taskRow({ request: urls.join(" ") })], [], []],
    });

    const result = await companySearchExtractService(db).extract(
      companyId,
      companySearchExtractQuerySchema.parse({
        contains: "github.com/paperclipai/paperclip/pull",
        kind: "url",
        matchesPerTask: String(COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_TASK),
      }),
    );

    expect(result.matchesPerTask).toBe(
      COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_TASK,
    );
    expect(result.results[0]?.matches).toHaveLength(urls.length);
    expect(result.results[0]?.matchesTruncated).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("does not invent results when the company-scoped candidate query is empty", async () => {
    const { db } = createMockDb({ select: [[]] });

    const result = await companySearchExtractService(db).extract(
      companyId,
      companySearchExtractQuerySchema.parse({ contains: "needle" }),
    );

    expect(result.results).toEqual([]);
  });
});
