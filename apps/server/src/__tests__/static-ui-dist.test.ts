import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireStaticUiDist } from "../app.js";

const tempRoots: string[] = [];

function createModuleDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-static-ui-"));
  tempRoots.push(root);
  const moduleDirectory = path.join(root, "dist");
  fs.mkdirSync(moduleDirectory);
  return moduleDirectory;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("requireStaticUiDist", () => {
  it("uses only the server-owned ui-dist artifact", () => {
    const moduleDirectory = createModuleDirectory();
    const uiDist = path.resolve(moduleDirectory, "../ui-dist");
    fs.mkdirSync(uiDist);
    fs.writeFileSync(path.join(uiDist, "index.html"), "<!doctype html>");

    expect(requireStaticUiDist(moduleDirectory)).toBe(uiDist);
  });

  it("fails fast when the canonical artifact is absent", () => {
    const moduleDirectory = createModuleDirectory();
    const monorepoUiDist = path.resolve(moduleDirectory, "../../ui/dist");
    fs.mkdirSync(monorepoUiDist, { recursive: true });
    fs.writeFileSync(path.join(monorepoUiDist, "index.html"), "not canonical");

    expect(() => requireStaticUiDist(moduleDirectory)).toThrow(
      /canonical server artifact/,
    );
  });
});
