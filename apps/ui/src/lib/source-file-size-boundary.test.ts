// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const skippedDirectories = new Set([".git", "dist", "node_modules", "storybook-static"]);
const registryOwnedDirectories = new Set(["src/components/ui", "src/components/kibo-ui"]);
// TanStack Router owns this file and overwrites it whenever the route graph changes.
const generatedFiles = new Set(["src/routeTree.gen.ts"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = relative(uiRoot, absolutePath).replaceAll("\\", "/");

    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) return [];
      if (registryOwnedDirectories.has(relativePath)) return [];
      return sourceFiles(absolutePath);
    }

    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [absolutePath] : [];
  });
}

describe("UI source file size boundary", () => {
  it("keeps every hand-authored TypeScript module at 500 lines or fewer", () => {
    const oversized = sourceFiles(uiRoot)
      .map((file) => ({
        file: relative(uiRoot, file).replaceAll("\\", "/"),
        lines: readFileSync(file, "utf8").match(/\n/g)?.length ?? 0,
      }))
      .filter(({ file, lines }) => !generatedFiles.has(file) && lines > 500)
      .sort((left, right) => right.lines - left.lines);

    expect(oversized).toEqual([]);
  });
});
