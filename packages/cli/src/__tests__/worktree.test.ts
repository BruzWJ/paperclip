import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const databaseMocks = vi.hoisted(() => ({
  assertDistinctDatabaseIdentities: vi.fn(() => {
    throw new Error("Unexpected production identity assertion from worktree test");
  }),
  probeDatabaseIdentity: vi.fn(() => {
    throw new Error("Unexpected production identity probe from worktree test");
  }),
  revalidateDatabaseIdentity: vi.fn(() => {
    throw new Error("Unexpected production identity revalidation from worktree test");
  }),
  resolveDatabaseTarget: vi.fn(() => ({
    connectionString: "postgres://parent:pw@db.test/parent",
    source: "paperclip-env" as const,
    configPath: "/test/config.json",
    envPath: "/test/.env",
  })),
  validateExternalPostgresConnectionString: vi.fn((value: string) => value.trim()),
  redactExternalPostgresConnectionString: vi.fn((value: string) => {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  }),
  databaseIdentitiesEqual: vi.fn(
    (
      left: { clusterSystemIdentifier: string; databaseOid: string; databaseName: string },
      right: { clusterSystemIdentifier: string; databaseOid: string; databaseName: string },
    ) =>
      left.clusterSystemIdentifier === right.clusterSystemIdentifier &&
      left.databaseOid === right.databaseOid &&
      left.databaseName === right.databaseName,
  ),
}));

vi.mock("@paperclipai/db", () => ({
  assertDistinctDatabaseIdentities: databaseMocks.assertDistinctDatabaseIdentities,
  databaseIdentitiesEqual: databaseMocks.databaseIdentitiesEqual,
  probeDatabaseIdentity: databaseMocks.probeDatabaseIdentity,
  redactExternalPostgresConnectionString:
    databaseMocks.redactExternalPostgresConnectionString,
  resolveDatabaseTarget: databaseMocks.resolveDatabaseTarget,
  revalidateDatabaseIdentity: databaseMocks.revalidateDatabaseIdentity,
  validateExternalPostgresConnectionString:
    databaseMocks.validateExternalPostgresConnectionString,
}));

import type { VerifiedDatabaseIdentity } from "@paperclipai/db";
import {
  provisionWorktreeInstance,
  registerWorktreeCommands,
  resolveGitWorktreeAddArgs,
  resolveWorktreeMakeTargetPath,
  type WorktreeProvisioningDependencies,
} from "../commands/worktree.js";
import {
  renderPinnedWorktreeEnv,
  resolveWorktreeLocalPaths,
  sanitizeWorktreeInstanceId,
} from "../commands/worktree-lib.js";

const roots = new Set<string>();
const parentIdentity: VerifiedDatabaseIdentity = {
  clusterSystemIdentifier: "100",
  databaseOid: "200",
  databaseName: "parent",
};
const targetIdentity: VerifiedDatabaseIdentity = {
  clusterSystemIdentifier: "100",
  databaseOid: "201",
  databaseName: "target",
};
const parentUrl = "postgres://parent:pw@db.test/parent";
const targetUrl = "postgres://target:pw@db.test/target";
afterEach(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

function tempRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "paperclip-worktree-create-"),
  );
  roots.add(root);
  return root;
}

function parentConfig(root: string): string {
  const configPath = path.join(
    root,
    "parent",
    ".paperclip",
    "config.json",
  );
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ database: {} })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(path.dirname(configPath), ".env"),
    `DATABASE_URL=${parentUrl}\nBETTER_AUTH_SECRET=parent-secret\n`,
    { mode: 0o600 },
  );
  return configPath;
}

function dependencies(): WorktreeProvisioningDependencies {
  return {
    probeDatabaseIdentity: vi.fn(async (url: string) =>
      url === targetUrl ? targetIdentity : parentIdentity
    ),
    assertDistinctDatabaseIdentities: vi.fn(),
    revalidateDatabaseIdentity: vi.fn(
      async (_url, identity) => identity,
    ),
    generateSecret: () => "new-worktree-secret",
    generateInstanceNonce: () => "instance-nonce",
    now: () => new Date("2026-07-29T00:00:00.000Z"),
  };
}

describe("worktree provisioning", () => {
  it("writes one immutable marker and an exact two-key mode-0600 env", async () => {
    const root = tempRoot();
    const cwd = path.join(root, "worktree");
    fs.mkdirSync(cwd);
    const deps = dependencies();
    const result = await provisionWorktreeInstance(
      {
        cwd,
        parentConfigPath: parentConfig(root),
        targetDatabaseUrl: targetUrl,
        instanceId: "feature",
        homeDir: path.join(root, "homes"),
        serverPort: 3101,
        branding: { name: "feature", color: "#123456" },
      },
      deps,
    );

    expect(
      fs.readFileSync(result.paths.envPath, "utf8"),
    ).toBe(
      renderPinnedWorktreeEnv({
        databaseUrl: targetUrl,
        betterAuthSecret: "new-worktree-secret",
      }),
    );
    expect(fs.statSync(result.paths.envPath).mode & 0o777).toBe(
      0o600,
    );
    expect(
      fs.statSync(result.paths.markerPath).mode & 0o777,
    ).toBe(0o600);
    expect(result.marker.worktreeInstanceId).toBe(
      "feature-instance-nonce",
    );
    expect(result.paths.instanceId).toBe(
      result.marker.worktreeInstanceId,
    );
    expect(result.marker.target.identity).toEqual(targetIdentity);
    expect(result.marker.parent.identity).toEqual(parentIdentity);
    expect(JSON.stringify(result.marker.fingerprints)).not.toContain(
      "new-worktree-secret",
    );
    expect(
      fs.existsSync(result.paths.creationLockPath),
    ).toBe(false);
    expect(deps.assertDistinctDatabaseIdentities).toHaveBeenCalledWith(
      parentIdentity,
      targetIdentity,
      "Parent and worktree PostgreSQL targets",
    );
    expect(deps.revalidateDatabaseIdentity).toHaveBeenCalledTimes(2);
  });

  it("rejects the parent physical target before creating local paths", async () => {
    const root = tempRoot();
    const cwd = path.join(root, "worktree");
    fs.mkdirSync(cwd);
    const paths = resolveWorktreeLocalPaths({
      cwd,
      homeDir: path.join(root, "homes"),
      instanceId: "feature",
    });
    const deps = dependencies();
    deps.assertDistinctDatabaseIdentities = vi.fn(() => {
      throw new Error("Parent and worktree PostgreSQL targets must be distinct");
    });
    await expect(
      provisionWorktreeInstance(
        {
          cwd,
          parentConfigPath: parentConfig(root),
          targetDatabaseUrl: targetUrl,
          instanceId: "feature",
          homeDir: path.join(root, "homes"),
          serverPort: 3101,
          branding: { name: "feature", color: "#123456" },
        },
        deps,
      ),
    ).rejects.toThrow("must be distinct");
    expect(fs.existsSync(paths.repoConfigDir)).toBe(false);
    expect(fs.existsSync(paths.instanceRoot)).toBe(false);
  });

  it("registers only creation, listing, and checkout cleanup", () => {
    const program = new Command();
    program.exitOverride();
    registerWorktreeCommands(program);
    const topLevel = program.commands.map(
      (command) => command.name(),
    );
    const worktree = program.commands.find(
      (command) => command.name() === "worktree",
    )!;
    expect(topLevel).toEqual(
      expect.arrayContaining([
        "worktree",
        "worktree:make",
        "worktree:list",
        "worktree:cleanup",
      ]),
    );
    expect(worktree.commands.map((command) => command.name())).toEqual([
      "init",
    ]);
    expect(
      program.commands
        .find((command) => command.name() === "worktree:make")!
        .options.map((option) => option.long),
    ).toEqual([
      "--database-url",
      "--start-point",
      "--instance",
      "--home",
      "--server-port",
    ]);
    expect(
      worktree.commands[0]!.options.map((option) => option.long),
    ).toEqual([
      "--database-url",
      "--name",
      "--instance",
      "--home",
      "--server-port",
    ]);
  });

  it("keeps checkout naming and git arguments deterministic", () => {
    expect(sanitizeWorktreeInstanceId(" Feature / One ")).toBe(
      "feature-one",
    );
    expect(resolveWorktreeMakeTargetPath("feature")).toBe(
      path.resolve(os.homedir(), "paperclip-feature"),
    );
    expect(
      resolveGitWorktreeAddArgs({
        branchName: "paperclip-feature",
        targetPath: "/tmp/paperclip-feature",
        branchExists: false,
        startPoint: "origin/main",
      }),
    ).toEqual([
      "worktree",
      "add",
      "-b",
      "paperclip-feature",
      "/tmp/paperclip-feature",
      "origin/main",
    ]);
  });
});
