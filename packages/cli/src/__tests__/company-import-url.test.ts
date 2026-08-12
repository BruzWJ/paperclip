import { describe, expect, it } from "vitest";
import { validateCanonicalGithubImportSourceUrl } from "@paperclipai/shared/company-portability-source";

describe("validateCanonicalGithubImportSourceUrl", () => {
  it.each([
    "https://github.com/paperclipai/companies?ref=main",
    "https://github.com/paperclipai/companies?ref=feature%2Fdemo&path=gstack%2Fengineering",
    "https://ghe.example.com/paperclipai/companies?ref=v2.0.0&path=gstack",
  ])("preserves an exact canonical GitHub source URL (%s)", (source) => {
    expect(validateCanonicalGithubImportSourceUrl(source)).toBe(source);
  });

  it.each([
    " https://github.com/paperclipai/companies?ref=main",
    "https://github.com/paperclipai/companies?ref=main ",
    "https://github.com/paperclipai/companies?ref=main%20",
    "https://github.com/paperclipai/companies?ref=main&path=%20gstack",
  ])("rejects whitespace aliases (%s)", (source) => {
    expect(() => validateCanonicalGithubImportSourceUrl(source)).toThrow(
      /exact canonical URL grammar/,
    );
  });

  it.each(["paperclipai/companies", "paperclipai/companies/gstack"])(
    "rejects owner/repo shorthand (%s)",
    (source) => {
      expect(() => validateCanonicalGithubImportSourceUrl(source)).toThrow(
        /exact canonical URL grammar/,
      );
    },
  );

  it.each([
    "https://github.com/paperclipai/companies/tree/main/gstack",
    "https://github.com/paperclipai/companies/blob/main/gstack/COMPANY.md",
  ])("rejects GitHub web URL aliases (%s)", (source) => {
    expect(() => validateCanonicalGithubImportSourceUrl(source)).toThrow(
      /exact canonical URL grammar/,
    );
  });

  it.each([
    "https://github.com/paperclipai/companies",
    "https://github.com/paperclipai/companies?path=gstack",
    "https://github.com/paperclipai/companies?path=gstack&ref=main",
    "https://github.com/paperclipai/companies?ref=main&companyPath=gstack%2FCOMPANY.md",
    "https://github.com/paperclipai/companies?ref=main&ref=release",
  ])("rejects non-canonical query aliases (%s)", (source) => {
    expect(() => validateCanonicalGithubImportSourceUrl(source)).toThrow(
      /exact canonical URL grammar/,
    );
  });

  it.each([
    "http://github.com/paperclipai/companies?ref=main",
    "https://github.com/paperclipai/companies.git?ref=main",
    "https://github.com/paperclipai/companies/?ref=main",
    "https://github.com/paperclipai/companies?ref=main#readme",
  ])("rejects alternate repository identities (%s)", (source) => {
    expect(() => validateCanonicalGithubImportSourceUrl(source)).toThrow(
      /exact canonical URL grammar/,
    );
  });
});
