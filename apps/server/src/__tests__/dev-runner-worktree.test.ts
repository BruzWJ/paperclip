import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const databaseMocks = vi.hoisted(() => ({
  assertDistinctDatabaseIdentities: vi.fn(() => {
    throw new Error("Unexpected production identity assertion from worktree bootstrap test");
  }),
  assertSameDatabaseIdentity: vi.fn(() => {
    throw new Error("Unexpected production identity assertion from worktree bootstrap test");
  }),
  probeDatabaseIdentity: vi.fn(() => {
    throw new Error("Unexpected production identity probe from worktree bootstrap test");
  }),
  resolveDatabaseTarget: vi.fn(() => {
    throw new Error("Unexpected production database target resolution from worktree bootstrap test");
  }),
  redactExternalPostgresConnectionString: vi.fn((value: string) => {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  }),
}));

vi.mock("@paperclipai/db", () => ({
  assertDistinctDatabaseIdentities: databaseMocks.assertDistinctDatabaseIdentities,
  assertSameDatabaseIdentity: databaseMocks.assertSameDatabaseIdentity,
  probeDatabaseIdentity: databaseMocks.probeDatabaseIdentity,
  redactExternalPostgresConnectionString:
    databaseMocks.redactExternalPostgresConnectionString,
  resolveDatabaseTarget: databaseMocks.resolveDatabaseTarget,
}));

import {
  redactExternalPostgresConnectionString,
  type VerifiedDatabaseIdentity,
} from "@paperclipai/db";
import {
  bootstrapDevRunnerWorktreeEnv,
  isLinkedGitWorktreeCheckout,
  resolveWorktreeEnvFilePath,
  resolveWorktreeMarkerFilePath,
  type WorktreeEnvBootstrapDependencies,
} from "../dev-runner-worktree.ts";

const tempRoots = new Set<string>();
const targetIdentity: VerifiedDatabaseIdentity = {
  clusterSystemIdentifier: "100",
  databaseOid: "200",
  databaseName: "paperclip_worktree",
};
const parentIdentity: VerifiedDatabaseIdentity = {
  clusterSystemIdentifier: "100",
  databaseOid: "201",
  databaseName: "paperclip_parent",
};
const targetUrl =
  "postgres://worktree:secret@db.example.test/paperclip_worktree";
const parentUrl =
  "postgres://parent:secret@db.example.test/paperclip_parent";
const targetSecret = "worktree-auth-secret";
const parentSecret = "parent-auth-secret";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function tempRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "paperclip-worktree-bootstrap-"),
  );
  tempRoots.add(root);
  return root;
}

function writeMode0600(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function setupLinkedWorktree(root: string): {
  parentConfigPath: string;
} {
  writeMode0600(
    path.join(root, ".git"),
    "gitdir: /tmp/paperclip/.git/worktrees/feature\n",
  );
  const parentRoot = path.join(root, "parent");
  const parentConfigPath = path.join(
    parentRoot,
    ".paperclip",
    "config.json",
  );
  writeMode0600(
    parentConfigPath,
    `${JSON.stringify({
      database: { backup: {} },
    })}\n`,
  );
  writeMode0600(
    path.join(parentRoot, ".paperclip", ".env"),
    `DATABASE_URL=${parentUrl}\nBETTER_AUTH_SECRET=${parentSecret}\n`,
  );
  writeMode0600(
    path.join(root, ".paperclip", "config.json"),
    "{}\n",
  );
  writeMode0600(
    resolveWorktreeEnvFilePath(root),
    `DATABASE_URL=${targetUrl}\nBETTER_AUTH_SECRET=${targetSecret}\n`,
  );
  writeMode0600(
    resolveWorktreeMarkerFilePath(root),
    `${JSON.stringify({
      formatVersion: 1,
      worktreeInstanceId: "feature-instance",
      createdAt: "2026-08-03T00:00:00.000Z",
      branding: { name: "feature", color: "#123456" },
      target: {
        locator: redactExternalPostgresConnectionString(targetUrl),
        identity: targetIdentity,
      },
      parent: {
        configPath: parentConfigPath,
        locator: redactExternalPostgresConnectionString(parentUrl),
        identity: parentIdentity,
      },
      fingerprints: {
        targetDatabaseUrlSha256: sha256(targetUrl),
        betterAuthSecretSha256: sha256(targetSecret),
        parentBetterAuthSecretSha256: sha256(parentSecret),
      },
    })}\n`,
  );
  return { parentConfigPath };
}

function dependencies(
  parentConfigPath: string,
): WorktreeEnvBootstrapDependencies {
  return {
    resolveDatabaseTarget: vi.fn(() => ({
      connectionString: parentUrl,
      source: "paperclip-env",
      configPath: parentConfigPath,
      envPath: path.join(
        path.dirname(parentConfigPath),
        ".env",
      ),
    })),
    probeDatabaseIdentity: vi.fn(async (url: string) =>
      url === targetUrl ? targetIdentity : parentIdentity
    ),
    assertSameDatabaseIdentity: vi.fn((expected, actual, context) => {
      if (
        actual.clusterSystemIdentifier !== expected.clusterSystemIdentifier ||
        actual.databaseOid !== expected.databaseOid ||
        actual.databaseName !== expected.databaseName
      ) {
        throw new Error(`${context ?? "Database"} identity changed`);
      }
    }),
    assertDistinctDatabaseIdentities: vi.fn(),
  };
}

describe("linked-worktree creation artifact bootstrap", () => {
  it("detects a linked checkout from its gitdir file", () => {
    const root = tempRoot();
    writeMode0600(
      path.join(root, ".git"),
      "gitdir: /tmp/paperclip/.git/worktrees/feature\n",
    );
    expect(isLinkedGitWorktreeCheckout(root)).toBe(true);
  });

  it("reports a wholly uninitialized linked checkout", async () => {
    const root = tempRoot();
    writeMode0600(
      path.join(root, ".git"),
      "gitdir: /tmp/paperclip/.git/worktrees/feature\n",
    );
    await expect(
      bootstrapDevRunnerWorktreeEnv(root, {}),
    ).resolves.toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      markerPath: resolveWorktreeMarkerFilePath(root),
      missingEnv: true,
    });
  });

  it("validates physical identities, permissions, and fingerprints before pinning", async () => {
    const root = tempRoot();
    const { parentConfigPath } = setupLinkedWorktree(root);
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: parentUrl,
      DATABASE_MIGRATION_URL: parentUrl,
      BETTER_AUTH_SECRET: parentSecret,
    };
    await expect(
      bootstrapDevRunnerWorktreeEnv(
        root,
        env,
        dependencies(parentConfigPath),
      ),
    ).resolves.toMatchObject({ missingEnv: false });
    expect(env.DATABASE_URL).toBe(targetUrl);
    expect(env.BETTER_AUTH_SECRET).toBe(targetSecret);
    expect(env.DATABASE_MIGRATION_URL).toBeUndefined();
    expect(env.PAPERCLIP_CONFIG).toBe(
      path.join(root, ".paperclip", "config.json"),
    );
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("feature-instance");
  });

  it("leaves inherited values untouched when a fingerprint is changed", async () => {
    const root = tempRoot();
    const { parentConfigPath } = setupLinkedWorktree(root);
    writeMode0600(
      resolveWorktreeEnvFilePath(root),
      `DATABASE_URL=${targetUrl}?changed=true\nBETTER_AUTH_SECRET=${targetSecret}\n`,
    );
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: parentUrl,
      BETTER_AUTH_SECRET: parentSecret,
    };
    await expect(
      bootstrapDevRunnerWorktreeEnv(
        root,
        env,
        dependencies(parentConfigPath),
      ),
    ).rejects.toThrow("does not match");
    expect(env.DATABASE_URL).toBe(parentUrl);
    expect(env.BETTER_AUTH_SECRET).toBe(parentSecret);
  });

  it("rejects a replaced physical target before pinning inherited values", async () => {
    const root = tempRoot();
    const { parentConfigPath } = setupLinkedWorktree(root);
    const deps = dependencies(parentConfigPath);
    deps.probeDatabaseIdentity = vi.fn(async (url: string) =>
      url === targetUrl
        ? { ...targetIdentity, databaseOid: "999" }
        : parentIdentity
    );
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: parentUrl,
      BETTER_AUTH_SECRET: parentSecret,
    };

    await expect(
      bootstrapDevRunnerWorktreeEnv(root, env, deps),
    ).rejects.toThrow("target identity changed");
    expect(env.DATABASE_URL).toBe(parentUrl);
    expect(env.BETTER_AUTH_SECRET).toBe(parentSecret);
  });
});
