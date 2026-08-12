import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  assertDistinctDatabaseIdentities,
  probeDatabaseIdentity,
  redactExternalPostgresConnectionString,
  resolveDatabaseTarget,
  revalidateDatabaseIdentity,
  validateExternalPostgresConnectionString,
  type VerifiedDatabaseIdentity,
} from "@paperclipai/db";
import type { Command } from "commander";
import {
  readPaperclipEnvEntries,
  resolvePaperclipEnvFile,
} from "../config/env.js";
import { expandHomePrefix } from "../config/home.js";
import { resolveConfigPath } from "../config/store.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import {
  buildWorktreeConfig,
  DEFAULT_WORKTREE_HOME,
  generateWorktreeColor,
  renderPinnedWorktreeEnv,
  resolveSuggestedWorktreeName,
  resolveWorktreeLocalPaths,
  sanitizeWorktreeInstanceId,
  WORKTREE_MARKER_FORMAT_VERSION,
  type WorktreeLocalPaths,
} from "./worktree-lib.js";

export type WorktreeCreationMarker = {
  formatVersion: typeof WORKTREE_MARKER_FORMAT_VERSION;
  worktreeInstanceId: string;
  createdAt: string;
  branding: {
    name: string;
    color: string;
  };
  target: {
    locator: string;
    identity: VerifiedDatabaseIdentity;
  };
  parent: {
    configPath: string;
    locator: string;
    identity: VerifiedDatabaseIdentity;
  };
  fingerprints: {
    targetDatabaseUrlSha256: string;
    betterAuthSecretSha256: string;
    parentBetterAuthSecretSha256: string;
  };
};

type WorktreeInitOptions = {
  name?: string;
  instance?: string;
  home?: string;
  serverPort?: number;
  databaseUrl?: string;
  color?: string;
  parentConfigPath?: string;
};

type WorktreeMakeOptions = WorktreeInitOptions & {
  startPoint?: string;
};

type WorktreeCleanupOptions = {
  instance?: string;
  home?: string;
  force?: boolean;
};

type WorktreeListOptions = {
  json?: boolean;
};

type GitWorktreeListEntry = {
  worktree: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
};

export type WorktreeProvisioningDependencies = {
  probeDatabaseIdentity: (
    connectionString: string,
  ) => Promise<VerifiedDatabaseIdentity>;
  assertDistinctDatabaseIdentities: (
    parent: VerifiedDatabaseIdentity,
    target: VerifiedDatabaseIdentity,
    context?: string,
  ) => void;
  revalidateDatabaseIdentity: (
    connectionString: string,
    expectedIdentity: VerifiedDatabaseIdentity,
    context?: string,
  ) => Promise<VerifiedDatabaseIdentity>;
  generateSecret: () => string;
  generateInstanceNonce: () => string;
  now: () => Date;
};

const productionProvisioningDependencies: WorktreeProvisioningDependencies = {
  probeDatabaseIdentity,
  assertDistinctDatabaseIdentities,
  revalidateDatabaseIdentity,
  generateSecret: () => randomBytes(48).toString("base64url"),
  generateInstanceNonce: () => randomUUID(),
  now: () => new Date(),
};

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resolveWorktreeMakeName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Worktree name is required.");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("Worktree name must be a single directory name.");
  }
  return trimmed.startsWith("paperclip-") ? trimmed : `paperclip-${trimmed}`;
}

function resolveWorktreeHome(explicit?: string): string {
  return (
    nonEmpty(explicit) ??
    nonEmpty(process.env.PAPERCLIP_WORKTREES_DIR) ??
    DEFAULT_WORKTREE_HOME
  );
}

function resolveWorktreeStartPoint(explicit?: string): string | undefined {
  return (
    nonEmpty(explicit) ??
    nonEmpty(process.env.PAPERCLIP_WORKTREE_START_POINT) ??
    undefined
  );
}

export function resolveWorktreeMakeTargetPath(name: string): string {
  return path.resolve(os.homedir(), resolveWorktreeMakeName(name));
}

function localBranchExists(cwd: string, branchName: string): boolean {
  try {
    execFileSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      { cwd, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

export function resolveGitWorktreeAddArgs(input: {
  branchName: string;
  targetPath: string;
  branchExists: boolean;
  startPoint?: string;
}): string[] {
  if (input.branchExists) {
    return ["worktree", "add", input.targetPath, input.branchName];
  }
  return [
    "worktree",
    "add",
    "-b",
    input.branchName,
    input.targetPath,
    input.startPoint ?? "HEAD",
  ];
}

function parseGitWorktreeList(cwd: string): GitWorktreeListEntry[] {
  const raw = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> = {};
  const flush = () => {
    if (!current.worktree) return;
    entries.push({
      worktree: current.worktree,
      branch: current.branch ?? null,
      bare: current.bare ?? false,
      detached: current.detached ?? false,
    });
    current = {};
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.worktree = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (!line) {
      flush();
    }
  }
  flush();
  return entries;
}

function primaryGitWorktreeRoot(cwd: string): string {
  const primary = parseGitWorktreeList(cwd).find((entry) => !entry.bare);
  if (!primary) {
    throw new Error(
      "Cannot resolve the primary git worktree for parent-instance verification.",
    );
  }
  return path.resolve(primary.worktree);
}

export function resolveParentWorktreeConfigPath(
  cwd: string,
  explicit?: string,
): string {
  const configured =
    nonEmpty(explicit) ?? nonEmpty(process.env.PAPERCLIP_CONFIG);
  if (configured) return path.resolve(configured);
  return path.resolve(primaryGitWorktreeRoot(cwd), ".paperclip", "config.json");
}

function readPersistedParent(input: { parentConfigPath: string }): {
  connectionString: string;
  betterAuthSecret: string;
} {
  const parentConfigPath = path.resolve(input.parentConfigPath);
  const parentEnvPath = resolvePaperclipEnvFile(parentConfigPath);
  if (!existsSync(parentConfigPath) || !existsSync(parentEnvPath)) {
    throw new Error(
      `The parent Paperclip config and adjacent env must already exist at ${parentConfigPath} and ${parentEnvPath}.`,
    );
  }
  const parentTarget = resolveDatabaseTarget({
    configPath: parentConfigPath,
    environment: {},
  });
  const parentEnv = readPaperclipEnvEntries(parentEnvPath);
  const betterAuthSecret = nonEmpty(parentEnv.BETTER_AUTH_SECRET);
  if (!betterAuthSecret) {
    throw new Error(
      `The persisted parent env ${parentEnvPath} must contain BETTER_AUTH_SECRET.`,
    );
  }
  return {
    connectionString: parentTarget.connectionString,
    betterAuthSecret,
  };
}

function assertCreationPathsAbsent(paths: WorktreeLocalPaths): void {
  const existing = [
    paths.configPath,
    paths.envPath,
    paths.markerPath,
    paths.creationLockPath,
    paths.instanceRoot,
  ].filter(existsSync);
  if (existing.length > 0) {
    throw new Error(
      `Worktree creation requires unused local paths; already present: ${existing.join(", ")}. Provision a clean worktree target.`,
    );
  }
}

function atomicWriteMode0600(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.creating-${randomUUID()}`;
  const fd = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, filePath);
}

function claimLocalCreation(paths: WorktreeLocalPaths): void {
  mkdirSync(paths.repoConfigDir, { recursive: true });
  const fd = openSync(paths.creationLockPath, "wx", 0o600);
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({
        state: "creation_in_progress",
        instanceId: paths.instanceId,
      })}\n`,
      "utf8",
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertMode0600(filePath: string): void {
  const mode = statSync(filePath).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`${filePath} must have mode 0600.`);
  }
}

export async function provisionWorktreeInstance(
  input: {
    cwd: string;
    parentConfigPath: string;
    targetDatabaseUrl: string;
    instanceId: string;
    homeDir?: string;
    serverPort: number;
    branding: { name: string; color: string };
  },
  dependencies: WorktreeProvisioningDependencies = productionProvisioningDependencies,
): Promise<{
  paths: WorktreeLocalPaths;
  marker: WorktreeCreationMarker;
}> {
  const targetDatabaseUrl = validateExternalPostgresConnectionString(
    input.targetDatabaseUrl,
    "--database-url",
  );
  const worktreeInstanceId = sanitizeWorktreeInstanceId(
    `${input.instanceId}-${dependencies.generateInstanceNonce()}`,
  );
  const paths = resolveWorktreeLocalPaths({
    cwd: input.cwd,
    homeDir: input.homeDir,
    instanceId: worktreeInstanceId,
  });
  assertCreationPathsAbsent(paths);

  const parent = readPersistedParent({
    parentConfigPath: input.parentConfigPath,
  });
  const [parentIdentity, targetIdentity] = await Promise.all([
    dependencies.probeDatabaseIdentity(parent.connectionString),
    dependencies.probeDatabaseIdentity(targetDatabaseUrl),
  ]);
  dependencies.assertDistinctDatabaseIdentities(
    parentIdentity,
    targetIdentity,
    "Parent and worktree PostgreSQL targets",
  );

  const betterAuthSecret = dependencies.generateSecret();
  if (!betterAuthSecret || betterAuthSecret === parent.betterAuthSecret) {
    throw new Error(
      "Generated worktree authentication secret must be nonempty and distinct from the parent.",
    );
  }
  claimLocalCreation(paths);
  await dependencies.revalidateDatabaseIdentity(
    parent.connectionString,
    parentIdentity,
    "Parent PostgreSQL target",
  );
  await dependencies.revalidateDatabaseIdentity(
    targetDatabaseUrl,
    targetIdentity,
    "Worktree PostgreSQL target",
  );

  const now = dependencies.now();
  const marker: WorktreeCreationMarker = {
    formatVersion: WORKTREE_MARKER_FORMAT_VERSION,
    worktreeInstanceId,
    createdAt: now.toISOString(),
    branding: input.branding,
    target: {
      locator: redactExternalPostgresConnectionString(targetDatabaseUrl),
      identity: targetIdentity,
    },
    parent: {
      configPath: path.resolve(input.parentConfigPath),
      locator: redactExternalPostgresConnectionString(parent.connectionString),
      identity: parentIdentity,
    },
    fingerprints: {
      targetDatabaseUrlSha256: sha256(targetDatabaseUrl),
      betterAuthSecretSha256: sha256(betterAuthSecret),
      parentBetterAuthSecretSha256: sha256(parent.betterAuthSecret),
    },
  };
  const config = buildWorktreeConfig({
    paths,
    serverPort: input.serverPort,
    now,
  });

  mkdirSync(path.dirname(paths.instanceRoot), { recursive: true });
  mkdirSync(paths.instanceRoot, { recursive: false });
  atomicWriteMode0600(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
  atomicWriteMode0600(
    paths.envPath,
    renderPinnedWorktreeEnv({
      databaseUrl: targetDatabaseUrl,
      betterAuthSecret,
    }),
  );
  atomicWriteMode0600(paths.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  assertMode0600(paths.configPath);
  assertMode0600(paths.envPath);
  assertMode0600(paths.markerPath);
  unlinkSync(paths.creationLockPath);

  return { paths, marker };
}

async function runWorktreeInit(options: WorktreeInitOptions): Promise<void> {
  const targetDatabaseUrl = nonEmpty(options.databaseUrl);
  if (!targetDatabaseUrl) {
    throw new Error(
      "Worktree creation requires an explicit --database-url for its external PostgreSQL database.",
    );
  }
  const cwd = process.cwd();
  const worktreeName = resolveSuggestedWorktreeName(cwd, options.name);
  const instanceId = sanitizeWorktreeInstanceId(
    options.instance ?? worktreeName,
  );
  const parentConfigPath = resolveParentWorktreeConfigPath(
    cwd,
    options.parentConfigPath,
  );
  const result = await provisionWorktreeInstance({
    cwd,
    parentConfigPath,
    targetDatabaseUrl,
    instanceId,
    homeDir: resolveWorktreeHome(options.home),
    serverPort: options.serverPort ?? 3101,
    branding: {
      name: options.name ?? worktreeName,
      color: options.color ?? generateWorktreeColor(),
    },
  });
  p.log.message(pc.dim(`Config: ${result.paths.configPath}`));
  p.log.message(pc.dim(`Pinned env: ${result.paths.envPath}`));
  p.log.message(pc.dim(`Creation marker: ${result.paths.markerPath}`));
  p.log.message(pc.dim(`Database: ${result.marker.target.locator}`));
  p.outro(
    pc.green(
      "Worktree created with its own external database target and Better Auth secret.",
    ),
  );
}

export async function worktreeInitCommand(
  options: WorktreeInitOptions,
): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclipai worktree init ")));
  await runWorktreeInit(options);
}

export async function worktreeMakeCommand(
  nameArgument: string,
  options: WorktreeMakeOptions,
): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclipai worktree:make ")));
  const targetDatabaseUrl = nonEmpty(options.databaseUrl);
  if (!targetDatabaseUrl) {
    throw new Error(
      "worktree:make requires an explicit --database-url before creating the checkout.",
    );
  }
  const sourceCwd = process.cwd();
  const parentConfigPath = resolveConfigPath();
  const persistedParent = readPersistedParent({ parentConfigPath });
  const [parentIdentity, targetIdentity] = await Promise.all([
    probeDatabaseIdentity(persistedParent.connectionString),
    probeDatabaseIdentity(targetDatabaseUrl),
  ]);
  assertDistinctDatabaseIdentities(
    parentIdentity,
    targetIdentity,
    "Parent and worktree PostgreSQL targets",
  );

  const name = resolveWorktreeMakeName(nameArgument);
  const targetPath = resolveWorktreeMakeTargetPath(name);
  if (existsSync(targetPath)) {
    throw new Error(`Target path already exists: ${targetPath}`);
  }
  const startPoint = resolveWorktreeStartPoint(options.startPoint);
  if (startPoint) {
    const remote = startPoint.split("/", 1)[0]!;
    execFileSync("git", ["fetch", remote], {
      cwd: sourceCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  execFileSync(
    "git",
    resolveGitWorktreeAddArgs({
      branchName: name,
      targetPath,
      branchExists: !startPoint && localBranchExists(sourceCwd, name),
      startPoint,
    }),
    {
      cwd: sourceCwd,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const originalCwd = process.cwd();
  try {
    process.chdir(targetPath);
    await runWorktreeInit({
      ...options,
      name,
      parentConfigPath,
    });
  } finally {
    process.chdir(originalCwd);
  }
}

function branchHasUniqueCommits(cwd: string, branchName: string): boolean {
  try {
    return (
      execFileSync(
        "git",
        [
          "log",
          "--oneline",
          branchName,
          "--not",
          "--remotes",
          "--exclude",
          `refs/heads/${branchName}`,
          "--branches",
        ],
        {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim().length > 0
    );
  } catch {
    return false;
  }
}

function worktreeHasChanges(worktreePath: string): boolean {
  try {
    return (
      execFileSync("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim().length > 0
    );
  } catch {
    return false;
  }
}

function readCleanupWorktreeInstanceId(
  checkoutPath: string,
  expectedBaseId: string,
): string | null {
  const markerPath = path.resolve(
    checkoutPath,
    ".paperclip",
    "worktree-instance.json",
  );
  if (!existsSync(markerPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error(
      `Cannot read the immutable creation marker at ${markerPath}; local instance files were not removed.`,
    );
  }
  const instanceId =
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof (parsed as { worktreeInstanceId?: unknown }).worktreeInstanceId ===
      "string"
      ? (parsed as { worktreeInstanceId: string }).worktreeInstanceId
      : null;
  if (
    !instanceId ||
    instanceId !== sanitizeWorktreeInstanceId(instanceId) ||
    !instanceId.startsWith(`${expectedBaseId}-`)
  ) {
    throw new Error(
      `Immutable creation marker ${markerPath} has an invalid worktree instance id; local instance files were not removed.`,
    );
  }
  return instanceId;
}

export async function worktreeCleanupCommand(
  nameArgument: string,
  options: WorktreeCleanupOptions,
): Promise<void> {
  printPaperclipCliBanner();
  const name = resolveWorktreeMakeName(nameArgument);
  const sourceCwd = process.cwd();
  const targetPath = resolveWorktreeMakeTargetPath(name);
  const worktree = parseGitWorktreeList(sourceCwd).find(
    (entry) =>
      path.resolve(entry.worktree) === targetPath ||
      entry.branch === `refs/heads/${name}`,
  );
  const expectedBaseId = sanitizeWorktreeInstanceId(options.instance ?? name);
  const createdInstanceId = readCleanupWorktreeInstanceId(
    worktree?.worktree ?? targetPath,
    expectedBaseId,
  );
  const hazards = [
    ...(localBranchExists(sourceCwd, name) &&
    branchHasUniqueCommits(sourceCwd, name)
      ? [`Branch ${name} has unique commits.`]
      : []),
    ...(existsSync(targetPath) && worktreeHasChanges(targetPath)
      ? [`Worktree ${targetPath} has uncommitted changes.`]
      : []),
  ];
  if (hazards.length > 0 && !options.force) {
    throw new Error(
      `${hazards.join(" ")} Commit or push the work, or use cleanup --force.`,
    );
  }
  if (worktree) {
    const args = ["worktree", "remove", worktree.worktree];
    if (options.force) args.push("--force");
    execFileSync("git", args, { cwd: sourceCwd, stdio: "ignore" });
  } else {
    execFileSync("git", ["worktree", "prune"], {
      cwd: sourceCwd,
      stdio: "ignore",
    });
  }
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }
  if (localBranchExists(sourceCwd, name)) {
    execFileSync("git", ["branch", options.force ? "-D" : "-d", name], {
      cwd: sourceCwd,
      stdio: "ignore",
    });
  }
  if (createdInstanceId) {
    const instanceRoot = path.resolve(
      expandHomePrefix(resolveWorktreeHome(options.home)),
      "instances",
      createdInstanceId,
    );
    if (existsSync(instanceRoot)) {
      rmSync(instanceRoot, { recursive: true, force: true });
    }
  }
  p.outro(
    pc.green(
      "Checkout cleanup complete. Its external database remains unchanged.",
    ),
  );
}

export async function worktreeListCommand(
  options: WorktreeListOptions,
): Promise<void> {
  const cwd = process.cwd();
  const current = path.resolve(cwd);
  const rows = parseGitWorktreeList(cwd).map((entry) => ({
    path: path.resolve(entry.worktree),
    branch:
      entry.branch?.replace(/^refs\/heads\//, "") ??
      (entry.detached ? "(detached)" : null),
    current: path.resolve(entry.worktree) === current,
    paperclipCreated: existsSync(
      path.resolve(entry.worktree, ".paperclip", "worktree-instance.json"),
    ),
  }));
  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.current ? "*" : " "} ${row.path} ${row.branch ?? ""}${row.paperclipCreated ? " [paperclip]" : ""}\n`,
    );
  }
}

export function registerWorktreeCommands(program: Command): void {
  const worktree = program
    .command("worktree")
    .description("Creation-only worktree Paperclip instances");

  program
    .command("worktree:make")
    .description(
      "Create a git worktree backed by a distinct external PostgreSQL database",
    )
    .argument("<name>", "Worktree name")
    .requiredOption(
      "--database-url <url>",
      "Distinct external PostgreSQL database URL",
    )
    .option("--start-point <ref>", "Git ref for the new branch")
    .option("--instance <id>", "Explicit worktree instance id")
    .option(
      "--home <path>",
      `Worktree instance root (default: ${DEFAULT_WORKTREE_HOME})`,
    )
    .option("--server-port <port>", "Server port", Number)
    .action(worktreeMakeCommand);

  worktree
    .command("init")
    .description(
      "Pin a distinct external PostgreSQL database to this linked worktree",
    )
    .requiredOption(
      "--database-url <url>",
      "Distinct external PostgreSQL database URL",
    )
    .option("--name <name>", "Worktree display name")
    .option("--instance <id>", "Explicit worktree instance id")
    .option(
      "--home <path>",
      `Worktree instance root (default: ${DEFAULT_WORKTREE_HOME})`,
    )
    .option("--server-port <port>", "Server port", Number)
    .action(worktreeInitCommand);

  program
    .command("worktree:list")
    .description("List git worktree checkouts")
    .option("--json", "Print JSON")
    .action(worktreeListCommand);

  program
    .command("worktree:cleanup")
    .description(
      "Remove a checkout and local worktree files without touching its database",
    )
    .argument("<name>", "Worktree name")
    .option("--instance <id>", "Explicit worktree instance id")
    .option(
      "--home <path>",
      `Worktree instance root (default: ${DEFAULT_WORKTREE_HOME})`,
    )
    .option("--force", "Bypass git checkout safety checks", false)
    .action(worktreeCleanupCommand);
}
