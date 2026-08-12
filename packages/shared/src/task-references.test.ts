import { describe, expect, it } from "vitest";
import {
  buildTaskReferenceHref,
  extractTaskReferenceIds,
  findTaskReferenceMatches,
  parseTaskReferenceHref,
} from "./task-references.js";

const TASK_1 = "123e4567-e89b-42d3-a456-426614174000";
const TASK_2 = "22222222-2222-4222-8222-222222222222";
const TASK_3 = "33333333-3333-4333-8333-333333333333";

describe("task references", () => {
  it("parses UUID task URIs", () => {
    expect(parseTaskReferenceHref(`task://${TASK_1}`)).toEqual({ taskId: TASK_1 });
  });

  it("builds only exact canonical UUID task URIs", () => {
    expect(buildTaskReferenceHref(TASK_1)).toBe(`task://${TASK_1}`);
    expect(() => buildTaskReferenceHref(TASK_1.toUpperCase())).toThrow();
    expect(() => buildTaskReferenceHref("PAP-123")).toThrow(
      "Cannot build a task reference href without a canonical task UUID",
    );
  });

  it("rejects identifier, HTTP/path, and noncanonical compatibility formats", () => {
    expect(parseTaskReferenceHref("task://PAP-123")).toBeNull();
    expect(parseTaskReferenceHref(`/PAP/tasks/PAP-123`)).toBeNull();
    expect(parseTaskReferenceHref(`/tasks/${TASK_1}`)).toBeNull();
    expect(parseTaskReferenceHref(`/PAP/tasks/${TASK_1}`)).toBeNull();
    expect(parseTaskReferenceHref(`https://paperclip.ing/PAP/tasks/${TASK_1}`)).toBeNull();
    expect(parseTaskReferenceHref(`task://${TASK_1.toUpperCase()}`)).toBeNull();
    expect(parseTaskReferenceHref(` task://${TASK_1} `)).toBeNull();
    expect(parseTaskReferenceHref("task://%zz")).toBeNull();
    expect(parseTaskReferenceHref(`task://%31${TASK_1.slice(1)}`)).toBeNull();
  });

  it("finds only explicit UUID task URIs", () => {
    const uri = `task://${TASK_1}`;
    const route = `https://x.test/PAP/tasks/${TASK_2}`;
    const text = `Ignore PAP-1, ${TASK_3}, and ${route}; see ${uri}.`;

    expect(findTaskReferenceMatches(text)).toEqual([
      {
        index: text.indexOf(uri),
        length: uri.length,
        taskId: TASK_1,
        matchedText: uri,
      },
    ]);
  });

  it("trims unmatched square brackets from task reference tokens", () => {
    const uri = `task://${TASK_1}`;
    expect(findTaskReferenceMatches(`See ${uri}] for context.`)).toEqual([
      { index: 4, length: uri.length, taskId: TASK_1, matchedText: uri },
    ]);
  });

  it("extracts and dedupes UUID references from markdown", () => {
    expect(
      extractTaskReferenceIds(
        `PAP-1 [first](task://${TASK_1}) task://${TASK_1} task://${TASK_2}`,
      ),
    ).toEqual([TASK_1, TASK_2]);
  });

  it("ignores inline code and fenced code blocks", () => {
    const markdown = [
      `Use task://${TASK_1} here.`,
      "",
      `\`task://${TASK_2}\` should not count.`,
      "",
      "```md",
      `task://${TASK_2}`,
      "```",
      "",
      `Final task://${TASK_3} mention.`,
    ].join("\n");

    expect(extractTaskReferenceIds(markdown)).toEqual([TASK_1, TASK_3]);
  });
});
