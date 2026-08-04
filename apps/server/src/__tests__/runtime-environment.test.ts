import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeEnvironmentFiles } from "../runtime-environment.js";

const temporaryRoots = new Set<string>();

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-runtime-env-"));
  temporaryRoots.add(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

describe("runtime environment loading", () => {
  it("loads the repository-root .env selected by the runtime entry", () => {
    const root = temporaryRoot();
    const paperclipEnvFilePath = path.join(root, ".paperclip", ".env");
    writeFileSync(
      path.join(root, ".env"),
      "DATABASE_URL=postgresql://repository.invalid/paperclip\n",
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = {};

    loadRuntimeEnvironmentFiles({
      cwd: root,
      paperclipEnvFilePath,
      environment,
    });

    expect(environment.DATABASE_URL).toBe(
      "postgresql://repository.invalid/paperclip",
    );
  });

  it("keeps the process environment authoritative over environment files", () => {
    const root = temporaryRoot();
    const paperclipDirectory = path.join(root, ".paperclip");
    const paperclipEnvFilePath = path.join(paperclipDirectory, ".env");
    mkdirSync(paperclipDirectory, { recursive: true });
    writeFileSync(
      paperclipEnvFilePath,
      "DATABASE_URL=postgresql://instance.invalid/paperclip\n",
      "utf8",
    );
    writeFileSync(
      path.join(root, ".env"),
      "DATABASE_URL=postgresql://repository.invalid/paperclip\n",
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgresql://process.invalid/paperclip",
    };

    loadRuntimeEnvironmentFiles({
      cwd: root,
      paperclipEnvFilePath,
      environment,
    });

    expect(environment.DATABASE_URL).toBe(
      "postgresql://process.invalid/paperclip",
    );
  });
});
