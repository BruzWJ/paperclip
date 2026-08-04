import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  createDb: vi.fn(() => {
    throw new Error("Unexpected database access from run startup test");
  }),
  resolveDatabaseTarget: vi.fn(() => {
    throw new Error("Unexpected database target resolution from run startup test");
  }),
  redactExternalPostgresConnectionString: vi.fn(() => {
    throw new Error("Unexpected database URL redaction from run startup test");
  }),
  validateExternalPostgresConnectionString: vi.fn(() => {
    throw new Error("Unexpected database URL validation from run startup test");
  }),
}));

vi.mock("@paperclipai/db", () => ({
  createDb: databaseMocks.createDb,
  resolveDatabaseTarget: databaseMocks.resolveDatabaseTarget,
  redactExternalPostgresConnectionString:
    databaseMocks.redactExternalPostgresConnectionString,
  validateExternalPostgresConnectionString:
    databaseMocks.validateExternalPostgresConnectionString,
}));

vi.mock("@paperclipai/server/worktree-bootstrap", () => ({
  bootstrapDevRunnerWorktreeEnv: vi.fn(async () => {
    throw new Error("Unexpected production worktree bootstrap from run startup test");
  }),
}));

import {
  runCommand,
  type RunCommandDependencies,
} from "../commands/run.js";

const roots = new Set<string>();
const originalPaperclipHome = process.env.PAPERCLIP_HOME;

afterEach(() => {
  if (originalPaperclipHome === undefined) {
    delete process.env.PAPERCLIP_HOME;
  } else {
    process.env.PAPERCLIP_HOME = originalPaperclipHome;
  }
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

function freshHome(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "paperclip-run-bootstrap-"),
  );
  roots.add(root);
  return path.join(root, "home");
}

describe("run linked-worktree preflight", () => {
  it("performs no local initialization when immutable worktree verification fails", async () => {
    const home = freshHome();
    process.env.PAPERCLIP_HOME = home;
    const dependencies: RunCommandDependencies = {
      bootstrapWorktreeEnv: vi.fn(async () => {
        throw new Error("immutable marker drift");
      }),
    };

    await expect(
      runCommand({}, dependencies),
    ).rejects.toThrow("immutable marker drift");
    expect(fs.existsSync(home)).toBe(false);
  });

  it("rejects an uninitialized linked checkout before creating instance paths", async () => {
    const home = freshHome();
    process.env.PAPERCLIP_HOME = home;
    const dependencies: RunCommandDependencies = {
      bootstrapWorktreeEnv: vi.fn(async () => ({
        envPath: "/repo/.paperclip/.env",
        markerPath: "/repo/.paperclip/worktree-instance.json",
        missingEnv: true,
      })),
    };

    await expect(
      runCommand({}, dependencies),
    ).rejects.toThrow("no immutable creation metadata");
    expect(fs.existsSync(home)).toBe(false);
  });
});
