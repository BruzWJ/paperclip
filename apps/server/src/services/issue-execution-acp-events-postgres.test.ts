import { describe, expect, it } from "vitest";
import {
  PostgresIssueExecutionAcpEventRejected,
  canonicalPaperclipMcpToolName,
  projectedAcpToolName,
} from "./issue-execution-acp-events-postgres.js";

describe("canonical Paperclip MCP tool identity", () => {
  it("uses only the exact Paperclip server/tool envelope", () => {
    expect(canonicalPaperclipMcpToolName({
      server: "paperclip",
      tool: "acme.search__find_record",
      arguments: { query: "status" },
    })).toBe("acme.search__find_record");

    expect(canonicalPaperclipMcpToolName({
      server: "external",
      tool: "acme.search__find_record",
      arguments: {},
    })).toBeNull();
  });

  it("does not treat another server's tool identity as Paperclip identity", () => {
    expect(canonicalPaperclipMcpToolName({
      server: "external",
      tool: "acme.search__find_record",
      arguments: {},
    })).toBeNull();
    expect(projectedAcpToolName({
      server: "external",
      tool: "acme.search__find_record",
      arguments: {},
    }, "Find record")).toBe("provider-tool:Find record");
  });

  it("fails closed for a Paperclip envelope without exact identity", () => {
    expect(() => canonicalPaperclipMcpToolName({
      server: "paperclip",
      tool: "acme.search__find_record",
      arguments: {},
      displayAlias: "search",
    })).toThrow(PostgresIssueExecutionAcpEventRejected);
  });
});
