import { describe, expect, it } from "vitest";
import {
  buildTaskReferenceHref,
  extractTaskReferenceIdentifiers,
  findTaskReferenceMatches,
  normalizeTaskIdentifier,
  parseTaskReferenceHref,
} from "./task-references.js";

describe("task references", () => {
  it("normalizes identifiers to uppercase", () => {
    expect(normalizeTaskIdentifier("pap-123")).toBe("PAP-123");
    expect(normalizeTaskIdentifier("pc1a2-7")).toBe("PC1A2-7");
    expect(normalizeTaskIdentifier("not-a-task")).toBeNull();
  });

  it("parses relative and absolute task hrefs", () => {
    expect(parseTaskReferenceHref("/tasks/PAP-123")).toEqual({ identifier: "PAP-123" });
    expect(parseTaskReferenceHref("/PAP/tasks/pap-456")).toEqual({ identifier: "PAP-456" });
    expect(parseTaskReferenceHref("https://paperclip.ing/PAP/tasks/pap-789#comment-1")).toEqual({
      identifier: "PAP-789",
    });
    expect(parseTaskReferenceHref("https://paperclip.ing/projects/PAP-789")).toBeNull();
  });

  it("builds canonical task hrefs", () => {
    expect(buildTaskReferenceHref("pap-123")).toBe("/tasks/PAP-123");
  });

  it("finds identifiers and task paths in plain text", () => {
    expect(findTaskReferenceMatches("See PAP-1, /tasks/PC1A2-2, and https://x.test/PAP/tasks/pc1a2-3.")).toEqual([
      { index: 4, length: 5, identifier: "PAP-1", matchedText: "PAP-1" },
      { index: 11, length: 14, identifier: "PC1A2-2", matchedText: "/tasks/PC1A2-2" },
      {
        index: 31,
        length: 32,
        identifier: "PC1A2-3",
        matchedText: "https://x.test/PAP/tasks/pc1a2-3",
      },
    ]);
  });

  it("trims unmatched square brackets from task path tokens", () => {
    expect(findTaskReferenceMatches("See /tasks/PAP-123] for context.")).toEqual([
      { index: 4, length: 14, identifier: "PAP-123", matchedText: "/tasks/PAP-123" },
    ]);
  });

  it("extracts and dedupes references from markdown", () => {
    expect(extractTaskReferenceIdentifiers("PAP-1 [again](/tasks/pap-1) PAP-2")).toEqual(["PAP-1", "PAP-2"]);
  });

  it("ignores inline code and fenced code blocks", () => {
    const markdown = [
      "Use PAP-1 here.",
      "",
      "`PAP-2` should not count.",
      "",
      "```md",
      "PAP-3",
      "/tasks/PAP-4",
      "```",
      "",
      "Final /tasks/PAP-5 mention.",
    ].join("\n");

    expect(extractTaskReferenceIdentifiers(markdown)).toEqual(["PAP-1", "PAP-5"]);
  });
});
