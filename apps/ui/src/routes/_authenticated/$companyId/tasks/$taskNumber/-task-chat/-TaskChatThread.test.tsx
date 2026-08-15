import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("TaskChat composer submission", () => {
  it("uses trimming only as a blank predicate and submits the original body", () => {
    const source = readFileSync(new URL("./-useTaskChatComposerController.ts", import.meta.url), "utf8");
    expect(source.match(/if \(\(!body\.trim\(\)/g)).toHaveLength(2);
    expect(source).toContain("const submittedBody = body;");
    expect(source).not.toContain("const submittedBody = body.trim();");
    expect(source).not.toContain("const submittedBody = trimmed;");
  });
});
