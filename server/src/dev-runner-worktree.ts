import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  assertDistinctDatabaseIdentities,
  assertSameDatabaseIdentity,
  probeDatabaseIdentity,
  redactExternalPostgresConnectionString,
  resolveDatabaseTarget,
  type VerifiedDatabaseIdentity,
} from "@paperclipai/db";

const WORKTREE_MARKER_FORMAT_VERSION = 1;

function parseEnvFile(contents: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = rawLine.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (!match) {
      throw new Error("Pinned worktree env contains an invalid line.");
    }
    const key = match[1]!;
    const rawValue = match[2]!.trim();
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      entries[key] = rawValue.slice(1, -1);
    } else {
      entries[key] = rawValue;
    }
  }
  return entries;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function parseIdentity(
  value: unknown,
  field: string,
): VerifiedDatabaseIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "clusterSystemIdentifier",
      "databaseOid",
      "databaseName",
    ]) ||
    typeof value.clusterSystemIdentifier !== "string" ||
    typeof value.databaseOid !== "string" ||
    typeof value.databaseName !== "string"
  ) {
    throw new Error(`Worktree marker ${field} is invalid.`);
  }
  return {
    clusterSystemIdentifier: value.clusterSystemIdentifier,
    databaseOid: value.databaseOid,
    databaseName: value.databaseName,
  };
}

type ParsedWorktreeMarker = {
  worktreeInstanceId: string;
  targetIdentity: VerifiedDatabaseIdentity;
  parentIdentity: VerifiedDatabaseIdentity;
  targetLocator: string;
  parentConfigPath: string;
  parentLocator: string;
  targetDatabaseUrlSha256: string;
  betterAuthSecretSha256: string;
  parentBetterAuthSecretSha256: string;
};

function parseWorktreeMarker(markerPath: string): ParsedWorktreeMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot parse immutable worktree marker ${markerPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "formatVersion",
      "worktreeInstanceId",
      "createdAt",
      "branding",
      "target",
      "parent",
      "fingerprints",
    ]) ||
    parsed.formatVersion !== WORKTREE_MARKER_FORMAT_VERSION ||
    typeof parsed.worktreeInstanceId !== "string" ||
    parsed.worktreeInstanceId.length === 0 ||
    typeof parsed.createdAt !== "string" ||
    !isRecord(parsed.branding) ||
    !hasExactKeys(parsed.branding, ["name", "color"]) ||
    typeof parsed.branding.name !== "string" ||
    typeof parsed.branding.color !== "string" ||
    !isRecord(parsed.target) ||
    !hasExactKeys(parsed.target, ["locator", "identity"]) ||
    !isRecord(parsed.parent) ||
    !hasExactKeys(parsed.parent, ["configPath", "locator", "identity"]) ||
    !isRecord(parsed.fingerprints) ||
    !hasExactKeys(parsed.fingerprints, [
      "targetDatabaseUrlSha256",
      "betterAuthSecretSha256",
      "parentBetterAuthSecretSha256",
    ]) ||
    typeof parsed.target.locator !== "string" ||
    typeof parsed.parent.configPath !== "string" ||
    typeof parsed.parent.locator !== "string" ||
    typeof parsed.fingerprints.targetDatabaseUrlSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(
      parsed.fingerprints.targetDatabaseUrlSha256,
    ) ||
    typeof parsed.fingerprints.betterAuthSecretSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(
      parsed.fingerprints.betterAuthSecretSha256,
    ) ||
    typeof parsed.fingerprints.parentBetterAuthSecretSha256 !==
      "string" ||
    !/^[0-9a-f]{64}$/.test(
      parsed.fingerprints.parentBetterAuthSecretSha256,
    )
  ) {
    throw new Error(`Immutable worktree marker ${markerPath} is invalid.`);
  }
  return {
    worktreeInstanceId: parsed.worktreeInstanceId,
    targetIdentity: parseIdentity(
      parsed.target.identity,
      "target.identity",
    ),
    parentIdentity: parseIdentity(
      parsed.parent.identity,
      "parent.identity",
    ),
    targetLocator: parsed.target.locator,
    parentConfigPath: path.resolve(parsed.parent.configPath),
    parentLocator: parsed.parent.locator,
    targetDatabaseUrlSha256:
      parsed.fingerprints.targetDatabaseUrlSha256,
    betterAuthSecretSha256:
      parsed.fingerprints.betterAuthSecretSha256,
    parentBetterAuthSecretSha256:
      parsed.fingerprints.parentBetterAuthSecretSha256,
  };
}

function assertMode0600(filePath: string): void {
  const stats = statSync(filePath);
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
    throw new Error(`${filePath} must be a regular file with mode 0600.`);
  }
}

export function isLinkedGitWorktreeCheckout(rootDir: string): boolean {
  const gitMetadataPath = path.join(rootDir, ".git");
  return (
    existsSync(gitMetadataPath) &&
    lstatSync(gitMetadataPath).isFile() &&
    readFileSync(gitMetadataPath, "utf8")
      .trimStart()
      .startsWith("gitdir:")
  );
}

export function resolveWorktreeEnvFilePath(rootDir: string): string {
  return path.resolve(rootDir, ".paperclip", ".env");
}

export function resolveWorktreeMarkerFilePath(rootDir: string): string {
  return path.resolve(
    rootDir,
    ".paperclip",
    "worktree-instance.json",
  );
}

export type WorktreeEnvBootstrapResult =
  | {
      envPath: null;
      markerPath: null;
      missingEnv: false;
    }
  | {
      envPath: string;
      markerPath: string;
      missingEnv: true;
    }
  | {
      envPath: string;
      markerPath: string;
      missingEnv: false;
    };

export type WorktreeEnvBootstrapDependencies = {
  resolveDatabaseTarget: typeof resolveDatabaseTarget;
  probeDatabaseIdentity: typeof probeDatabaseIdentity;
  assertSameDatabaseIdentity: typeof assertSameDatabaseIdentity;
  assertDistinctDatabaseIdentities:
    typeof assertDistinctDatabaseIdentities;
};

const productionBootstrapDependencies:
  WorktreeEnvBootstrapDependencies = {
    resolveDatabaseTarget,
    probeDatabaseIdentity,
    assertSameDatabaseIdentity,
    assertDistinctDatabaseIdentities,
  };

export async function bootstrapDevRunnerWorktreeEnv(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: WorktreeEnvBootstrapDependencies =
    productionBootstrapDependencies,
): Promise<WorktreeEnvBootstrapResult> {
  if (!isLinkedGitWorktreeCheckout(rootDir)) {
    return {
      envPath: null,
      markerPath: null,
      missingEnv: false,
    };
  }
  const envPath = resolveWorktreeEnvFilePath(rootDir);
  const markerPath = resolveWorktreeMarkerFilePath(rootDir);
  const creationLockPath = path.resolve(
    rootDir,
    ".paperclip",
    "worktree-creation.lock",
  );
  if (!existsSync(envPath) && !existsSync(markerPath)) {
    return { envPath, markerPath, missingEnv: true };
  }
  if (!existsSync(envPath) || !existsSync(markerPath)) {
    throw new Error(
      "Linked worktree has a partial creation state. Discard it and provision the worktree again.",
    );
  }
  if (existsSync(creationLockPath)) {
    throw new Error(
      "Linked worktree creation did not finish. Discard it and provision the worktree again.",
    );
  }
  const configPath = path.resolve(
    rootDir,
    ".paperclip",
    "config.json",
  );
  if (!existsSync(configPath)) {
    throw new Error(
      "Linked worktree creation marker has no matching config. Discard it and provision a new worktree.",
    );
  }
  assertMode0600(envPath);
  assertMode0600(markerPath);
  assertMode0600(configPath);

  const entries = parseEnvFile(readFileSync(envPath, "utf8"));
  const keys = Object.keys(entries).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "BETTER_AUTH_SECRET" ||
    keys[1] !== "DATABASE_URL" ||
    !entries.DATABASE_URL ||
    !entries.BETTER_AUTH_SECRET
  ) {
    throw new Error(
      "Pinned worktree env must contain exactly DATABASE_URL and BETTER_AUTH_SECRET.",
    );
  }
  const marker = parseWorktreeMarker(markerPath);
  if (
    sha256(entries.DATABASE_URL) !==
      marker.targetDatabaseUrlSha256 ||
    sha256(entries.BETTER_AUTH_SECRET) !==
      marker.betterAuthSecretSha256
  ) {
    throw new Error(
      "Pinned worktree env does not match its immutable creation marker.",
    );
  }
  if (
    redactExternalPostgresConnectionString(entries.DATABASE_URL) !==
    marker.targetLocator
  ) {
    throw new Error(
      "Pinned worktree database locator does not match its immutable creation marker.",
    );
  }

  const parentTarget = dependencies.resolveDatabaseTarget({
    configPath: marker.parentConfigPath,
    environment: {},
  });
  const parentEnvPath = path.resolve(
    path.dirname(marker.parentConfigPath),
    ".env",
  );
  if (!existsSync(parentEnvPath)) {
    throw new Error(
      "Persisted parent env is unavailable. Discard this worktree and create a new one.",
    );
  }
  const parentEntries = parseEnvFile(
    readFileSync(parentEnvPath, "utf8"),
  );
  if (
    !parentEntries.BETTER_AUTH_SECRET ||
    sha256(parentEntries.BETTER_AUTH_SECRET) !==
      marker.parentBetterAuthSecretSha256 ||
    parentEntries.BETTER_AUTH_SECRET === entries.BETTER_AUTH_SECRET
  ) {
    throw new Error(
      "Worktree Better Auth secret must remain distinct from the persisted parent secret.",
    );
  }
  if (
    redactExternalPostgresConnectionString(
      parentTarget.connectionString,
    ) !== marker.parentLocator
  ) {
    throw new Error(
      "Persisted parent database locator has drifted. Discard this worktree and create a new one.",
    );
  }

  const [targetIdentity, parentIdentity] = await Promise.all([
    dependencies.probeDatabaseIdentity(entries.DATABASE_URL),
    dependencies.probeDatabaseIdentity(
      parentTarget.connectionString,
    ),
  ]);
  dependencies.assertSameDatabaseIdentity(
    marker.targetIdentity,
    targetIdentity,
    "Pinned worktree PostgreSQL target",
  );
  dependencies.assertSameDatabaseIdentity(
    marker.parentIdentity,
    parentIdentity,
    "Persisted parent PostgreSQL target",
  );
  dependencies.assertDistinctDatabaseIdentities(
    parentIdentity,
    targetIdentity,
    "Parent and worktree PostgreSQL targets",
  );

  delete env.DATABASE_MIGRATION_URL;
  env.DATABASE_URL = entries.DATABASE_URL;
  env.BETTER_AUTH_SECRET = entries.BETTER_AUTH_SECRET;
  env.PAPERCLIP_CONFIG = configPath;
  env.PAPERCLIP_IN_WORKTREE = "true";
  env.PAPERCLIP_INSTANCE_ID = marker.worktreeInstanceId;
  return { envPath, markerPath, missingEnv: false };
}
