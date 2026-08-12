import { describe, expect, it } from "vitest";
import { applySearchOperatorSuggestion, parseSearchQuery, searchOperatorSuggestions } from "./search-query-parser";

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const LABEL_ID = "22222222-2222-4222-8222-222222222222";

const context = {
  agents: [{ id: AGENT_ID, name: "Codex Coder" }],
  projects: [{ id: PROJECT_ID, name: "Paperclip App" }],
  labels: [{ id: LABEL_ID, name: "bug" }],
};

describe("parseSearchQuery", () => {
  it("parses status operators", () => {
    expect(parseSearchQuery("status:todo auth", context)).toMatchObject({
      query: "auth",
      filters: { status: ["todo"] },
      pills: [{ key: "status", value: "todo", label: "status:todo" }],
    });
  });

  it("parses an exact canonical owner UUID and resolves only its display label", () => {
    expect(parseSearchQuery(`owner:${AGENT_ID} crash`, context)).toMatchObject({
      query: "crash",
      filters: { ownerAgentId: AGENT_ID },
      pills: [{ key: "owner", value: AGENT_ID, label: "owner:Codex Coder" }],
    });
  });

  it("does not treat owner aliases or names as identities", () => {
    expect(parseSearchQuery('owner:me owner:"Codex Coder"', context)).toMatchObject({
      query: 'owner:me owner:"Codex Coder"',
      filters: {},
      pills: [],
    });
  });

  it("parses an exact canonical project UUID", () => {
    expect(parseSearchQuery(`project:${PROJECT_ID}`, context).filters).toEqual({
      projectId: PROJECT_ID,
    });
  });

  it("parses an exact canonical label UUID", () => {
    expect(parseSearchQuery(`label:${LABEL_ID}`, context).filters).toEqual({
      labelId: LABEL_ID,
    });
  });

  it("keeps non-canonical selector spellings in free text", () => {
    expect(
      parseSearchQuery("owner:33333333-3333-4333-8333-333333333333 project:Paperclip label:bug", context),
    ).toMatchObject({
      query: "project:Paperclip label:bug",
      filters: { ownerAgentId: AGENT_ID },
    });
    expect(parseSearchQuery(`owner:33333333-3333-4333-8333-AAAAAAAAAAAA owner:"${AGENT_ID}"`, context)).toMatchObject({
      query: `owner:33333333-3333-4333-8333-AAAAAAAAAAAA owner:"${AGENT_ID}"`,
      filters: {},
    });
    expect(
      parseSearchQuery(
        "owner:33333333-3333-4333-8333-333333333333 OWNER:33333333-3333-4333-8333-333333333333",
        context,
      ),
    ).toMatchObject({
      query: "OWNER:33333333-3333-4333-8333-333333333333",
      filters: { ownerAgentId: AGENT_ID },
    });
  });

  it("parses priority operators", () => {
    expect(parseSearchQuery("priority:high", context).filters).toEqual({
      priority: ["high"],
    });
  });

  it("parses updated:>7d as updatedWithin", () => {
    expect(parseSearchQuery("updated:>7d", context).filters).toEqual({
      updatedWithin: "7d",
    });
  });

  it("parses is:open quick filters", () => {
    expect(parseSearchQuery("is:open", context).filters).toEqual({
      status: ["backlog", "todo", "in_progress", "in_review", "blocked"],
    });
  });

  it("preserves quoted phrases in free text", () => {
    expect(parseSearchQuery('"auth flake" status:blocked', context)).toMatchObject({
      query: '"auth flake"',
      filters: { status: ["blocked"] },
    });
  });

  it("parses mixed free text and multiple operators", () => {
    expect(parseSearchQuery(`auth status:in_progress priority:critical project:${PROJECT_ID}`, context)).toMatchObject({
      query: "auth",
      filters: {
        status: ["in_progress"],
        priority: ["critical"],
        projectId: PROJECT_ID,
      },
    });
  });

  it("falls unknown operators through to plain text", () => {
    expect(parseSearchQuery("assignee:me auth", context)).toMatchObject({
      query: "assignee:me auth",
      filters: {},
      pills: [],
    });
  });

  it("falls malformed values through to plain text", () => {
    expect(parseSearchQuery("status:notreal updated:>soon updated:7d priority:urgent", context)).toMatchObject({
      query: "status:notreal updated:>soon updated:7d priority:urgent",
      filters: {},
      pills: [],
    });
  });
});

describe("search operator suggestions", () => {
  it("suggests syntax for the current partial token", () => {
    expect(searchOperatorSuggestions("auth sta").map((suggestion) => suggestion.token)).toEqual([
      "status:todo",
      "status:blocked",
    ]);
  });

  it("replaces only the current token when applying a suggestion", () => {
    expect(applySearchOperatorSuggestion("auth sta", "status:todo")).toBe("auth status:todo");
    expect(applySearchOperatorSuggestion("", "updated:>7d")).toBe("updated:>7d");
  });
});
