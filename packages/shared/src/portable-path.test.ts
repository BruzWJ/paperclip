import { describe, expect, it } from "vitest";
import {
  MAX_PORTABLE_PATH_SEGMENT_LENGTH,
  MAX_PORTABLE_RELATIVE_PATH_LENGTH,
  isPortableRelativePath,
  portableRelativePathSchema,
} from "./portable-path.js";

describe("portable relative paths", () => {
  it("accepts exact slash-separated package paths", () => {
    for (const pathValue of [
      "COMPANY.md",
      ".paperclip.yaml",
      "agents/release-captain/AGENTS.md",
      "company packages/acme/README.md",
    ]) {
      expect(isPortableRelativePath(pathValue)).toBe(true);
      expect(portableRelativePathSchema.parse(pathValue)).toBe(pathValue);
    }
  });

  it("rejects every path shape that would require normalization", () => {
    for (const pathValue of [
      "",
      "/COMPANY.md",
      "COMPANY.md/",
      "agents//lead/AGENTS.md",
      "agents\\lead\\AGENTS.md",
      ".",
      "..",
      "agents/./lead/AGENTS.md",
      "agents/../lead/AGENTS.md",
      " COMPANY.md",
      "COMPANY.md ",
      "agents/ lead/AGENTS.md",
      "agents/lead /AGENTS.md",
      "agents/\tlead/AGENTS.md",
      "C:/company/COMPANY.md",
    ]) {
      expect(isPortableRelativePath(pathValue), pathValue).toBe(false);
      expect(portableRelativePathSchema.safeParse(pathValue).success).toBe(
        false,
      );
    }
  });

  it("enforces portable path and segment bounds", () => {
    expect(
      isPortableRelativePath("a".repeat(MAX_PORTABLE_PATH_SEGMENT_LENGTH)),
    ).toBe(true);
    expect(
      isPortableRelativePath("a".repeat(MAX_PORTABLE_PATH_SEGMENT_LENGTH + 1)),
    ).toBe(false);
    expect(
      isPortableRelativePath(
        `a/${"b".repeat(MAX_PORTABLE_RELATIVE_PATH_LENGTH)}`,
      ),
    ).toBe(false);
  });
});
