import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPaperclipEnvironmentFiles } from "../config/env.js";

const temporaryRoots = new Set<string>();

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-env-"));
  temporaryRoots.add(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

describe("CLI environment loading", () => {
  it("loads DATABASE_URL from the current-directory .env before onboarding", () => {
    const root = temporaryRoot();
    const configPath = path.join(root, "instance", "config.json");
    fs.writeFileSync(
      path.join(root, ".env"),
      "DATABASE_URL=postgresql://repository.invalid/paperclip\n",
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = {};

    loadPaperclipEnvironmentFiles(configPath, {
      cwd: root,
      environment,
    });

    expect(environment.DATABASE_URL).toBe(
      "postgresql://repository.invalid/paperclip",
    );
  });

  it("preserves shell and instance environment precedence", () => {
    const root = temporaryRoot();
    const instanceRoot = path.join(root, "instance");
    const configPath = path.join(instanceRoot, "config.json");
    fs.mkdirSync(instanceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(instanceRoot, ".env"),
      "DATABASE_URL=postgresql://instance.invalid/paperclip\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, ".env"),
      "DATABASE_URL=postgresql://repository.invalid/paperclip\n",
      "utf8",
    );

    const instanceEnvironment: NodeJS.ProcessEnv = {};
    loadPaperclipEnvironmentFiles(configPath, {
      cwd: root,
      environment: instanceEnvironment,
    });
    expect(instanceEnvironment.DATABASE_URL).toBe(
      "postgresql://instance.invalid/paperclip",
    );

    const shellEnvironment: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgresql://shell.invalid/paperclip",
    };
    loadPaperclipEnvironmentFiles(configPath, {
      cwd: root,
      environment: shellEnvironment,
    });
    expect(shellEnvironment.DATABASE_URL).toBe(
      "postgresql://shell.invalid/paperclip",
    );
  });

  it("loads newly generated instance values on a repeated startup pass", () => {
    const root = temporaryRoot();
    const instanceRoot = path.join(root, "instance");
    const configPath = path.join(instanceRoot, "config.json");
    fs.mkdirSync(instanceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(root, ".env"),
      "DATABASE_URL=postgresql://repository.invalid/paperclip\n",
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = {};

    loadPaperclipEnvironmentFiles(configPath, {
      cwd: root,
      environment,
    });
    fs.writeFileSync(
      path.join(instanceRoot, ".env"),
      "BETTER_AUTH_SECRET=generated-after-onboarding\n",
      "utf8",
    );
    loadPaperclipEnvironmentFiles(configPath, {
      cwd: root,
      environment,
    });

    expect(environment.BETTER_AUTH_SECRET).toBe(
      "generated-after-onboarding",
    );
  });
});
