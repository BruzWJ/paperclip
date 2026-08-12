import { describe, expect, it } from "vitest";
import {
  parseCanonicalGithubImportSourceUrl,
  validateCanonicalGithubImportSourceUrl,
} from "./company-portability-source.js";

describe("canonical GitHub company import source", () => {
  it("parses the exact ref and package directory without changing source identity", () => {
    const source =
      "https://github.com/paperclipai/companies?ref=feature%2Fdemo&path=gstack%2Fengineering";

    expect(validateCanonicalGithubImportSourceUrl(source)).toBe(source);
    expect(parseCanonicalGithubImportSourceUrl(source)).toEqual({
      hostname: "github.com",
      owner: "paperclipai",
      repo: "companies",
      ref: "feature/demo",
      basePath: "gstack/engineering",
      companyPath: "gstack/engineering/COMPANY.md",
    });
  });

  it("parses an exact repository-root source with no path fallback", () => {
    expect(
      parseCanonicalGithubImportSourceUrl(
        "https://ghe.example.com/paperclipai/companies?ref=0123456789abcdef",
      ),
    ).toEqual({
      hostname: "ghe.example.com",
      owner: "paperclipai",
      repo: "companies",
      ref: "0123456789abcdef",
      basePath: "",
      companyPath: "COMPANY.md",
    });
  });

  it.each([
    "https://github.com/paperclipai/companies",
    " https://github.com/paperclipai/companies?ref=main",
    "https://github.com/paperclipai/companies?ref=main ",
    "paperclipai/companies",
    "https://github.com/paperclipai/companies/tree/main/gstack",
    "https://github.com/paperclipai/companies/blob/main/gstack/COMPANY.md",
    "https://github.com/paperclipai/companies?path=gstack&ref=main",
    "https://github.com/paperclipai/companies?ref=main&companyPath=gstack%2FCOMPANY.md",
    "https://github.com/paperclipai/companies?ref=main&ref=release",
    "https://github.com/paperclipai/companies.git?ref=main",
  ])("rejects a non-canonical source alias (%s)", (source) => {
    expect(() => parseCanonicalGithubImportSourceUrl(source)).toThrow(
      /exact canonical URL grammar/,
    );
  });
});
