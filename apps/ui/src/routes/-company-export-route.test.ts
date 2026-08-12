import { describe, expect, it } from "vitest";
import { parseCompanyExportFilePath } from "./_authenticated/$companyId/company/export/$/index.js";

describe("company export file route", () => {
  it("accepts only the exact files/<portable-path> contract", () => {
    expect(parseCompanyExportFilePath(undefined)).toBeNull();
    expect(parseCompanyExportFilePath("files/agents/lead/AGENT.md")).toBe(
      "agents/lead/AGENT.md",
    );
  });

  it.each([
    "files/",
    "agents/lead/AGENT.md",
    "files//agents/lead/AGENT.md",
    "files/agents/../AGENT.md",
    "files/agents\\lead\\AGENT.md",
    "files/ agents/lead/AGENT.md",
    "files/agents/lead/AGENT.md/",
  ])("rejects the non-canonical route %j", (splat) => {
    expect(() => parseCompanyExportFilePath(splat)).toThrow();
  });
});
