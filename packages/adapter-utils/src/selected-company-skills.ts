import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  runAdapterExecutionTargetProcess,
  type AdapterExecutionTarget,
} from "./execution-target.js";

export const MATERIALIZED_COMPANY_SKILL_SENTINEL =
  ".paperclip-materialized-skill.json" as const;

const MATERIALIZATION_FORMAT_VERSION = 1 as const;
const MATERIALIZATION_ROOT_NAME = "paperclip-company-skills-v1";
const DEFAULT_TARGET_OPERATION_TIMEOUT_SEC = 30;
const DEFAULT_STALE_LOCK_MS = 60_000;
const DEFAULT_LOCK_WAIT_MS = 15_000;
const RUNTIME_NAME_RE = /^[A-Za-z0-9._-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SELECTED_COMPANY_SKILL_FILE_KINDS = new Set<
  SelectedCompanySkillFileKind
>([
  "skill",
  "markdown",
  "reference",
  "script",
  "asset",
  "other",
]);

export class InvalidSelectedCompanySkillSet extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSelectedCompanySkillSet";
  }
}

export type SelectedCompanySkillFileKind =
  | "skill"
  | "markdown"
  | "reference"
  | "script"
  | "asset"
  | "other";

export interface ImmutableSelectedCompanySkillFile {
  readonly path: string;
  readonly kind: SelectedCompanySkillFileKind;
  readonly content: string;
}

export interface ImmutableSelectedCompanySkillVersion {
  readonly key: string;
  /** Exact provider-visible name; Paperclip never adds an attempt suffix. */
  readonly runtimeName: string;
  readonly versionId: string;
  readonly files: readonly ImmutableSelectedCompanySkillFile[];
}

export interface SelectedCompanySkillMaterializationIdentity {
  readonly companyId: string;
  readonly agentId: string;
  /** Immutable physical execution-target digest from the admitted revision. */
  readonly executionTargetIdentity: string;
  readonly adapterConfigRevisionId: string;
}

export type SelectedCompanySkillLaunchChannel =
  | { readonly channel: "operator_native" }
  | {
      readonly channel: "isolated_skills_home";
      readonly identity: SelectedCompanySkillMaterializationIdentity;
      readonly entries: readonly ImmutableSelectedCompanySkillVersion[];
    };

export interface PreparedSelectedCompanySkillTargetHome {
  readonly materializationKey: string;
  readonly selectedSetDigest: string;
  readonly sourceFingerprint: string;
  readonly contentDigest: string;
  /** Target-private source path. The child receives only discoveryRoot. */
  readonly storeRoot: string;
  /** Target-private immutable tree. */
  readonly homeDir: string;
  /** Target-private provider-native skills directory. */
  readonly skillsDir: string;
  /** Target-visible read-only bind destination supplied to the ACP frontend. */
  readonly discoveryRoot: string;
  readonly preparationLockToken: string;
  readonly reused: boolean;
  releasePreparationLock(): Promise<void>;
  verifyAfterReap(): Promise<void>;
  collectExact(
    expectedMaterializationKey: string,
  ): Promise<CollectedSelectedCompanySkillTargetHome>;
}

export interface CollectedSelectedCompanySkillTargetHome {
  readonly materializationKey: string;
  readonly outcome: "collected" | "absent";
}

interface CanonicalSelectedCompanySkillFile {
  readonly path: string;
  readonly kind: SelectedCompanySkillFileKind;
  readonly content: string;
  readonly sha256: string;
}

interface CanonicalSelectedCompanySkillVersion {
  readonly key: string;
  readonly runtimeName: string;
  readonly versionId: string;
  readonly files: readonly CanonicalSelectedCompanySkillFile[];
}

interface CanonicalSelectedCompanySkillSet {
  readonly entries: readonly CanonicalSelectedCompanySkillVersion[];
  readonly selectedSetDigest: string;
  readonly sourceFingerprint: string;
  readonly contentDigest: string;
}

interface TargetMaterializerResponse {
  readonly operation: "prepared" | "released" | "verified" | "collected";
  readonly materializationKey?: string;
  readonly selectedSetDigest?: string;
  readonly sourceFingerprint?: string;
  readonly contentDigest?: string;
  readonly homeDir?: string;
  readonly skillsDir?: string;
  readonly lockToken?: string;
  readonly reused?: boolean;
  readonly collected?: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new InvalidSelectedCompanySkillSet(
      `${label} must be exact and non-empty.`,
    );
  }
  return value;
}

function exactRuntimeName(value: string, key: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value !== value.trim() ||
    !RUNTIME_NAME_RE.test(value) ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new InvalidSelectedCompanySkillSet(
      `Selected company skill '${key}' has an unsafe runtime name.`,
    );
  }
  return value;
}

export function selectedCompanySkillRuntimeName(
  keyValue: string,
  slugValue: string,
): string {
  const key = exactIdentity(keyValue, "company skill key");
  // The key is part of the immutable revision pin; the mutable display slug
  // is validated but cannot alter an already-admitted provider-visible name.
  exactRuntimeName(
    exactIdentity(slugValue, `company skill '${key}' slug`),
    key,
  );
  const pinnedName = exactRuntimeName(key.split("/").at(-1) ?? "", key);
  return exactRuntimeName(
    key.startsWith("paperclipai/paperclip/")
      ? pinnedName
      : `${pinnedName}--${sha256(key).slice(0, 10)}`,
    key,
  );
}

function exactRelativeFilePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value)
  ) {
    throw new InvalidSelectedCompanySkillSet(`${label} is unsafe.`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) => segment.length === 0)
  ) {
    throw new InvalidSelectedCompanySkillSet(`${label} is unsafe.`);
  }
  return normalized;
}

function canonicalizeSelectedSet(
  entries: readonly ImmutableSelectedCompanySkillVersion[],
): CanonicalSelectedCompanySkillSet {
  const selectedEntries: readonly ImmutableSelectedCompanySkillVersion[] =
    entries;
  if (!Array.isArray(selectedEntries)) {
    throw new InvalidSelectedCompanySkillSet(
      "Selected company skill inventory must be an array.",
    );
  }
  const keys = new Set<string>();
  const runtimeNames = new Set<string>();
  const canonicalEntries: CanonicalSelectedCompanySkillVersion[] = [];

  for (const entry of selectedEntries) {
    const key = exactIdentity(entry.key, "company skill key");
    const versionId = exactIdentity(entry.versionId, "company skill version id");
    const runtimeName = exactRuntimeName(entry.runtimeName, key);
    if (keys.has(key)) {
      throw new InvalidSelectedCompanySkillSet(
        `Selected company skill '${key}' appears more than once.`,
      );
    }
    if (runtimeNames.has(runtimeName)) {
      throw new InvalidSelectedCompanySkillSet(
        `Selected company skills resolve to duplicate runtime name '${runtimeName}'.`,
      );
    }
    keys.add(key);
    runtimeNames.add(runtimeName);

    const fileInventory: readonly ImmutableSelectedCompanySkillFile[] =
      entry.files;
    if (!Array.isArray(fileInventory)) {
      throw new InvalidSelectedCompanySkillSet(
        `Selected company skill '${key}' file inventory must be an array.`,
      );
    }
    const paths = new Set<string>();
    const files = fileInventory.map((file) => {
      const filePath = exactRelativeFilePath(
        file.path,
        `Selected company skill '${key}' inventory path`,
      );
      if (paths.has(filePath)) {
        throw new InvalidSelectedCompanySkillSet(
          `Selected company skill '${key}' repeats inventory path '${filePath}'.`,
        );
      }
      paths.add(filePath);
      for (const existing of paths) {
        if (
          existing !== filePath &&
          (existing.startsWith(`${filePath}/`) ||
            filePath.startsWith(`${existing}/`))
        ) {
          throw new InvalidSelectedCompanySkillSet(
            `Selected company skill '${key}' has a file/directory inventory collision.`,
          );
        }
      }
      if (typeof file.content !== "string") {
        throw new InvalidSelectedCompanySkillSet(
          `Selected company skill '${key}' inventory content must be text.`,
        );
      }
      if (!SELECTED_COMPANY_SKILL_FILE_KINDS.has(file.kind)) {
        throw new InvalidSelectedCompanySkillSet(
          `Selected company skill '${key}' has an invalid inventory kind.`,
        );
      }
      return Object.freeze({
        path: filePath,
        kind: file.kind,
        content: file.content,
        sha256: sha256(Buffer.from(file.content, "utf8")),
      });
    }).sort((left, right) => left.path.localeCompare(right.path));
    if (!paths.has("SKILL.md")) {
      throw new InvalidSelectedCompanySkillSet(
        `Selected company skill '${key}' has no immutable SKILL.md.`,
      );
    }
    canonicalEntries.push(Object.freeze({
      key,
      runtimeName,
      versionId,
      files: Object.freeze(files),
    }));
  }

  canonicalEntries.sort((left, right) =>
    left.key.localeCompare(right.key) ||
    left.runtimeName.localeCompare(right.runtimeName) ||
    left.versionId.localeCompare(right.versionId),
  );
  const selectedSetDigest = sha256(JSON.stringify(
    canonicalEntries.map(({ key, runtimeName, versionId }) => ({
      key,
      runtimeName,
      versionId,
    })),
  ));
  const sourceFingerprint = sha256(JSON.stringify(
    canonicalEntries.map(({ key, runtimeName, versionId, files }) => ({
      key,
      runtimeName,
      versionId,
      files: files.map(({ path: filePath, kind, sha256: fileDigest }) => ({
        path: filePath,
        kind,
        sha256: fileDigest,
      })),
    })),
  ));
  const contentDigest = sha256(JSON.stringify(
    canonicalEntries.flatMap(({ runtimeName, files }) =>
      files.map(({ path: filePath, sha256: fileDigest }) => ({
        path: `${runtimeName}/${filePath}`,
        sha256: fileDigest,
      })),
    ),
  ));
  return Object.freeze({
    entries: Object.freeze(canonicalEntries),
    selectedSetDigest,
    sourceFingerprint,
    contentDigest,
  });
}

export function selectedCompanySkillMaterializationKey(input: {
  readonly identity: SelectedCompanySkillMaterializationIdentity;
  readonly entries: readonly ImmutableSelectedCompanySkillVersion[];
}): {
  readonly materializationKey: string;
  readonly selectedSetDigest: string;
  readonly sourceFingerprint: string;
  readonly contentDigest: string;
} {
  const identity = {
    companyId: exactIdentity(input.identity.companyId, "company id"),
    agentId: exactIdentity(input.identity.agentId, "agent id"),
    executionTargetIdentity: exactIdentity(
      input.identity.executionTargetIdentity,
      "execution target identity",
    ),
    adapterConfigRevisionId: exactIdentity(
      input.identity.adapterConfigRevisionId,
      "adapter configuration revision id",
    ),
  };
  if (!SHA256_RE.test(identity.executionTargetIdentity)) {
    throw new InvalidSelectedCompanySkillSet(
      "Execution target identity must be a SHA-256 digest.",
    );
  }
  const selected = canonicalizeSelectedSet(input.entries);
  return Object.freeze({
    materializationKey: sha256(JSON.stringify({
      ...identity,
      selectedSetDigest: selected.selectedSetDigest,
    })),
    selectedSetDigest: selected.selectedSetDigest,
    sourceFingerprint: selected.sourceFingerprint,
    contentDigest: selected.contentDigest,
  });
}

/**
 * This function is deliberately self-contained. Its emitted source is run by
 * the already-verified local Node executable, keeping preparation and
 * post-run verification on the same physical host.
 */
async function selectedCompanySkillTargetMaterializerMain() {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const path = require("node:path") as typeof import("node:path");

  let raw = "";
  for await (const chunk of process.stdin) raw += chunk.toString("utf8");
  const input = JSON.parse(raw);
  const hash = (value: string | Buffer) =>
    crypto.createHash("sha256").update(value).digest("hex");
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  const exact = (value: unknown, label: string) => {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw new Error(label + " must be exact and non-empty");
    }
    return value;
  };
  const under = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const root = path.resolve(exact(input.storeRoot, "materialization store root"));
  if (root === path.parse(root).root) throw new Error("materialization store root is too broad");
  const materializationKey = exact(input.materializationKey, "materialization key");
  if (!/^[0-9a-f]{64}$/.test(materializationKey)) throw new Error("invalid materialization key");
  const homesRoot = path.join(root, "homes");
  const locksRoot = path.join(root, "locks");
  const quarantineRoot = path.join(root, "quarantine");
  const conformanceRoot = path.join(root, "nonconforming");
  const homeDir = path.join(homesRoot, materializationKey);
  const skillsDir = path.join(homeDir, "skills");
  const lockDir = path.join(locksRoot, materializationKey + ".lock");
  const markerPath = path.join(
    conformanceRoot,
    exact(input.conformanceKey, "conformance key") + ".json",
  );
  for (const candidate of [homesRoot, locksRoot, quarantineRoot, conformanceRoot, homeDir, lockDir, markerPath]) {
    if (!under(root, candidate)) throw new Error("materialization path escaped its store");
  }

  const ownerPath = path.join(lockDir, "owner.json");
  const staleLockMs = Number(input.staleLockMs);
  const lockWaitMs = Number(input.lockWaitMs);
  if (!Number.isSafeInteger(staleLockMs) || staleLockMs < 1 ||
      !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 1) {
    throw new Error("invalid lock policy");
  }
  const ensureExactManagedDirectory = async (directory: string) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("materialization store contains an unsafe managed root");
    }
    if (await fs.realpath(directory) !== directory) {
      throw new Error("materialization store root traverses a symbolic link");
    }
    await fs.chmod(directory, 0o700);
  };
  await ensureExactManagedDirectory(root);
  for (const directory of [
    homesRoot,
    locksRoot,
    quarantineRoot,
    conformanceRoot,
  ]) {
    await ensureExactManagedDirectory(directory);
  }

  const acquireLock = async () => {
    const token = crypto.randomUUID();
    const started = Date.now();
    while (true) {
      try {
        await fs.mkdir(lockDir, { mode: 0o700 });
        await fs.writeFile(ownerPath, JSON.stringify({ token, createdAt: Date.now() }), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        return token;
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          (error as { code?: unknown }).code !== "EEXIST"
        ) throw error;
        const stats = await fs.lstat(lockDir).catch(() => null);
        if (stats && !stats.isSymbolicLink() && stats.isDirectory() &&
            Date.now() - stats.mtimeMs > staleLockMs) {
          const stale = path.join(quarantineRoot, "stale-lock-" + materializationKey + "-" + crypto.randomUUID());
          await fs.rename(lockDir, stale).catch(() => undefined);
          await fs.rm(stale, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        if (Date.now() - started >= lockWaitMs) throw new Error("selected company skill target lock timed out");
        await sleep(25);
      }
    }
  };
  const releaseLock = async (token: string) => {
    const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    if (owner.token !== token) throw new Error("selected company skill target lock ownership changed");
    await fs.rm(lockDir, { recursive: true, force: false });
  };

  if (input.operation === "release") {
    await releaseLock(exact(input.lockToken, "lock token"));
    process.stdout.write(JSON.stringify({ operation: "released" }));
    return;
  }

  const entries = input.entries;
  if (!Array.isArray(entries)) throw new Error("selected inventory must be an array");
  const expectedManifest: Array<Record<string, unknown>> = [
    { path: "skills", type: "directory" },
  ];
  const sourceInventory: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const runtimeName = exact(entry.runtimeName, "runtime name");
    expectedManifest.push({ path: "skills/" + runtimeName, type: "directory" });
    const directories = new Set<string>();
    for (const file of entry.files) {
      const relativeFile = exact(file.path, "inventory path");
      const segments = relativeFile.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index).join("/"));
      }
      sourceInventory.push({
        key: entry.key,
        runtimeName,
        versionId: entry.versionId,
        path: relativeFile,
        kind: file.kind,
        sha256: file.sha256,
      });
    }
    for (const directory of [...directories].sort()) {
      expectedManifest.push({
        path: "skills/" + runtimeName + "/" + directory,
        type: "directory",
      });
    }
    for (const file of entry.files) {
      expectedManifest.push({
        path: "skills/" + runtimeName + "/" + file.path,
        type: "file",
        sha256: file.sha256,
      });
    }
  }
  expectedManifest.sort((left, right) => String(left.path).localeCompare(String(right.path)));
  sourceInventory.sort((left, right) =>
    String(left.key).localeCompare(String(right.key)) ||
    String(left.path).localeCompare(String(right.path)),
  );
  const sentinel = {
    version: input.formatVersion,
    materializationKey,
    selectedSetDigest: input.selectedSetDigest,
    sourceFingerprint: input.sourceFingerprint,
    contentDigest: input.contentDigest,
    versions: entries.map((entry: Record<string, unknown>) => ({
      key: entry.key,
      runtimeName: entry.runtimeName,
      versionId: entry.versionId,
    })),
    sourceInventory,
    installedInventory: expectedManifest,
  };
  const sentinelPath = path.join(homeDir, input.sentinelName);

  const installedManifest = async () => {
    const manifest: Array<Record<string, unknown>> = [];
    const walk = async (directory: string, relativeDirectory: string) => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relative = relativeDirectory ? relativeDirectory + "/" + entry.name : entry.name;
        if (relative === input.sentinelName) continue;
        const absolute = path.join(directory, entry.name);
        const stats = await fs.lstat(absolute);
        if (stats.isSymbolicLink()) throw new Error("installed company skill tree contains a symbolic link");
        if (stats.isDirectory()) {
          manifest.push({ path: relative, type: "directory" });
          await walk(absolute, relative);
        } else if (stats.isFile()) {
          manifest.push({ path: relative, type: "file", sha256: hash(await fs.readFile(absolute)) });
        } else {
          throw new Error("installed company skill tree contains an unsafe entry type");
        }
      }
    };
    await walk(homeDir, "");
    manifest.sort((left, right) => String(left.path).localeCompare(String(right.path)));
    return manifest;
  };
  const verify = async () => {
    const stats = await fs.lstat(homeDir).catch(() => null);
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return false;
    const sentinelStats = await fs.lstat(sentinelPath).catch(() => null);
    if (!sentinelStats || sentinelStats.isSymbolicLink() || !sentinelStats.isFile()) return false;
    let installedSentinel;
    try {
      installedSentinel = JSON.parse(await fs.readFile(sentinelPath, "utf8"));
    } catch {
      return false;
    }
    if (JSON.stringify(installedSentinel) !== JSON.stringify(sentinel)) return false;
    try {
      return JSON.stringify(await installedManifest()) === JSON.stringify(expectedManifest);
    } catch {
      return false;
    }
  };
  const quarantine = async (reason: string) => {
    const suspect = await fs.lstat(homeDir).catch(() => null);
    if (!suspect) return;
    const target = path.join(
      quarantineRoot,
      materializationKey + "-" + Date.now() + "-" + crypto.randomUUID(),
    );
    // Some target filesystems require write permission on the moved
    // directory itself. No child is running in either verification phase;
    // make only the suspect root movable immediately before atomic quarantine.
    await fs.chmod(homeDir, 0o700);
    await fs.rename(homeDir, target);
    await fs.writeFile(target + ".json", JSON.stringify({ reason, quarantinedAt: Date.now() }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  };
  const writeCanonicalTree = async () => {
    const temporary = path.join(homesRoot, "." + materializationKey + ".tmp-" + crypto.randomUUID());
    if (!under(homesRoot, temporary)) throw new Error("temporary materialization escaped its parent");
    try {
      await fs.mkdir(path.join(temporary, "skills"), { recursive: true, mode: 0o700 });
      for (const entry of entries) {
        const runtimeDir = path.join(temporary, "skills", entry.runtimeName);
        await fs.mkdir(runtimeDir, { recursive: false, mode: 0o700 });
        for (const file of entry.files) {
          const target = path.resolve(runtimeDir, ...String(file.path).split("/"));
          if (!under(runtimeDir, target)) throw new Error("selected company skill file escaped its runtime root");
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await fs.writeFile(target, file.content, { encoding: "utf8", flag: "wx", mode: 0o400 });
        }
      }
      await fs.writeFile(path.join(temporary, input.sentinelName), JSON.stringify(sentinel), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o400,
      });
      const makeReadOnly = async (directory: string) => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const child = path.join(directory, entry.name);
          const stats = await fs.lstat(child);
          if (stats.isSymbolicLink()) throw new Error("temporary materialization contains a symbolic link");
          if (stats.isDirectory()) {
            await makeReadOnly(child);
            await fs.chmod(child, 0o500);
          } else if (stats.isFile()) {
            await fs.chmod(child, 0o400);
          } else {
            throw new Error("temporary materialization contains an unsafe entry type");
          }
        }
      };
      await makeReadOnly(temporary);
      await fs.chmod(temporary, 0o500);
      await fs.rename(temporary, homeDir);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  };

  const removeOwnedTemporarySiblings = async () => {
    const prefix = "." + materializationKey + ".tmp-";
    const entries = await fs.readdir(homesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) continue;
      const candidate = path.join(homesRoot, entry.name);
      if (!under(homesRoot, candidate)) {
        throw new Error("temporary materialization escaped its parent");
      }
      const makeWritable = async (target: string) => {
        const stats = await fs.lstat(target);
        if (stats.isSymbolicLink() || !stats.isDirectory()) return;
        await fs.chmod(target, 0o700);
        for (const child of await fs.readdir(target)) {
          await makeWritable(path.join(target, child));
        }
      };
      await makeWritable(candidate);
      await fs.rm(candidate, { recursive: true, force: true });
    }
  };

  const collectExactHome = async () => {
    const existing = await fs.lstat(homeDir).catch(() => null);
    if (!existing) return false;
    const retired = path.join(
      quarantineRoot,
      "collected-" + materializationKey + "-" + crypto.randomUUID(),
    );
    if (!under(quarantineRoot, retired)) {
      throw new Error("collected materialization escaped its managed root");
    }
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      await fs.chmod(homeDir, 0o700);
    }
    await fs.rename(homeDir, retired);
    const makeWritableWithoutFollowingLinks = async (target: string) => {
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink()) return;
      if (stats.isDirectory()) {
        await fs.chmod(target, 0o700);
        for (const child of await fs.readdir(target)) {
          await makeWritableWithoutFollowingLinks(path.join(target, child));
        }
        return;
      }
      if (stats.isFile()) await fs.chmod(target, 0o600);
    };
    await makeWritableWithoutFollowingLinks(retired);
    await fs.rm(retired, { recursive: true, force: false });
    return true;
  };

  const token = await acquireLock();
  try {
    // This exact-key lock proves no conforming writer can still own one of
    // these temp siblings, so crash residue is removable without an age-only
    // guess or a cross-revision race.
    await removeOwnedTemporarySiblings();
  } catch (error) {
    await releaseLock(token).catch(() => undefined);
    throw error;
  }
  if (input.operation === "collect") {
    let collected = false;
    try {
      collected = await collectExactHome();
    } finally {
      await releaseLock(token);
    }
    process.stdout.write(JSON.stringify({
      operation: "collected",
      materializationKey,
      collected,
    }));
    return;
  }
  if (input.operation === "verify_after_reap") {
    try {
      if (!(await verify())) {
        await quarantine("post_reap_integrity_violation");
        await fs.writeFile(markerPath, JSON.stringify({
          targetIdentity: input.targetIdentity,
          frontendIdentity: input.frontendIdentity,
          failedAt: Date.now(),
          reason: "post_reap_integrity_violation",
        }), { encoding: "utf8", flag: "wx", mode: 0o600 }).catch(async (error) => {
          if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
        });
        throw new Error("selected company skill read-only target conformance failed");
      }
    } finally {
      await releaseLock(token);
    }
    process.stdout.write(JSON.stringify({ operation: "verified" }));
    return;
  }
  if (input.operation !== "prepare") {
    await releaseLock(token);
    throw new Error("unknown selected company skill target operation");
  }

  try {
    if (await fs.lstat(markerPath).then(() => true).catch(() => false)) {
      throw new Error("selected company skill channel is nonconforming for this frontend and target");
    }
    let reused = await verify();
    if (!reused) {
      await quarantine("pre_launch_integrity_mismatch");
      await writeCanonicalTree();
      if (!(await verify())) {
        await quarantine("fresh_materialization_verification_failed");
        throw new Error("fresh selected company skill materialization failed verification");
      }
      reused = false;
    }
    process.stdout.write(JSON.stringify({
      operation: "prepared",
      materializationKey,
      selectedSetDigest: input.selectedSetDigest,
      sourceFingerprint: input.sourceFingerprint,
      contentDigest: input.contentDigest,
      homeDir,
      skillsDir,
      lockToken: token,
      reused,
    }));
  } catch (error) {
    await releaseLock(token).catch(() => undefined);
    throw error;
  }
}

const SELECTED_COMPANY_SKILL_TARGET_MATERIALIZER_SOURCE =
  `(${selectedCompanySkillTargetMaterializerMain.toString()})()`;

function targetStoreRoot(): string {
  return path.join(os.tmpdir(), MATERIALIZATION_ROOT_NAME);
}

function targetDiscoveryRoot(): string {
  return path.posix.join(
    "/run",
    "paperclip-company-skills",
    "selected",
  );
}

async function executeTargetMaterializer(input: {
  readonly target: AdapterExecutionTarget;
  readonly targetNodeExecutable: string;
  readonly targetCwd: string;
  readonly timeoutSec: number;
  readonly payload: Readonly<Record<string, unknown>>;
}): Promise<TargetMaterializerResponse> {
  const result = await runAdapterExecutionTargetProcess(
    randomUUID(),
    input.target,
    input.targetNodeExecutable,
    ["-e", SELECTED_COMPANY_SKILL_TARGET_MATERIALIZER_SOURCE],
    {
      cwd: input.targetCwd,
      env: {},
      stdin: JSON.stringify(input.payload),
      timeoutSec: input.timeoutSec,
      graceSec: 2,
      onLog: async () => {},
    },
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw new InvalidSelectedCompanySkillSet(
      `Selected company skill target materialization failed${
        result.timedOut
          ? " because it timed out"
          : ` with exit code ${result.exitCode ?? "null"}`
      }.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new InvalidSelectedCompanySkillSet(
      "Selected company skill target materializer returned an invalid result.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidSelectedCompanySkillSet(
      "Selected company skill target materializer returned an invalid result.",
    );
  }
  return parsed as TargetMaterializerResponse;
}

/**
 * Prepares one immutable target-scoped skills home and keeps its target lock
 * until the ACP process has been bound. The caller must release the lock after
 * spawn (or setup failure) and must run verifyAfterReap after every process.
 */
export async function prepareSelectedCompanySkillTargetHome(input: {
  readonly target: AdapterExecutionTarget;
  readonly targetNodeExecutable: string;
  readonly targetCwd: string;
  readonly frontendIdentity: string;
  readonly identity: SelectedCompanySkillMaterializationIdentity;
  readonly entries: readonly ImmutableSelectedCompanySkillVersion[];
  readonly timeoutSec?: number;
}): Promise<PreparedSelectedCompanySkillTargetHome> {
  const frontendIdentity = exactIdentity(
    input.frontendIdentity,
    "ACP frontend identity",
  );
  const identity = {
    companyId: exactIdentity(input.identity.companyId, "company id"),
    agentId: exactIdentity(input.identity.agentId, "agent id"),
    executionTargetIdentity: exactIdentity(
      input.identity.executionTargetIdentity,
      "execution target identity",
    ),
    adapterConfigRevisionId: exactIdentity(
      input.identity.adapterConfigRevisionId,
      "adapter configuration revision id",
    ),
  };
  const canonical = canonicalizeSelectedSet(input.entries);
  const key = selectedCompanySkillMaterializationKey({
    identity,
    entries: input.entries,
  });
  const storeRoot = targetStoreRoot();
  const conformanceKey = sha256(JSON.stringify({
    executionTargetIdentity: identity.executionTargetIdentity,
    frontendIdentity,
  }));
  const timeoutSec = input.timeoutSec ?? DEFAULT_TARGET_OPERATION_TIMEOUT_SEC;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new InvalidSelectedCompanySkillSet(
      "Selected company skill target timeout must be positive.",
    );
  }
  const basePayload = Object.freeze({
    formatVersion: MATERIALIZATION_FORMAT_VERSION,
    sentinelName: MATERIALIZED_COMPANY_SKILL_SENTINEL,
    storeRoot,
    conformanceKey,
    targetIdentity: identity.executionTargetIdentity,
    frontendIdentity,
    materializationKey: key.materializationKey,
    selectedSetDigest: key.selectedSetDigest,
    sourceFingerprint: key.sourceFingerprint,
    contentDigest: key.contentDigest,
    staleLockMs: DEFAULT_STALE_LOCK_MS,
    lockWaitMs: DEFAULT_LOCK_WAIT_MS,
    entries: canonical.entries,
  });
  const prepared = await executeTargetMaterializer({
    target: input.target,
    targetNodeExecutable: input.targetNodeExecutable,
    targetCwd: input.targetCwd,
    timeoutSec,
    payload: { ...basePayload, operation: "prepare" },
  });
  if (
    prepared.operation !== "prepared" ||
    prepared.materializationKey !== key.materializationKey ||
    prepared.selectedSetDigest !== key.selectedSetDigest ||
    prepared.sourceFingerprint !== key.sourceFingerprint ||
    prepared.contentDigest !== key.contentDigest ||
    typeof prepared.homeDir !== "string" ||
    typeof prepared.skillsDir !== "string" ||
    typeof prepared.lockToken !== "string" ||
    typeof prepared.reused !== "boolean"
  ) {
    throw new InvalidSelectedCompanySkillSet(
      "Selected company skill target materializer crossed its immutable input.",
    );
  }
  const expectedHomeDir = path.join(
    storeRoot,
    "homes",
    key.materializationKey,
  );
  const expectedSkillsDir = path.join(expectedHomeDir, "skills");
  if (
    prepared.homeDir !== expectedHomeDir ||
    prepared.skillsDir !== expectedSkillsDir
  ) {
    throw new InvalidSelectedCompanySkillSet(
      "Selected company skill target materializer returned a crossed target path.",
    );
  }
  let lockReleased = false;
  let lockRelease: Promise<void> | null = null;
  let exactCollection: Promise<CollectedSelectedCompanySkillTargetHome> | null = null;
  const releasePreparationLock = async () => {
    if (lockReleased) return;
    lockRelease ??= (async () => {
      const released = await executeTargetMaterializer({
        target: input.target,
        targetNodeExecutable: input.targetNodeExecutable,
        targetCwd: input.targetCwd,
        timeoutSec,
        payload: {
          ...basePayload,
          operation: "release",
          lockToken: prepared.lockToken,
        },
      });
      if (released.operation !== "released") {
        throw new InvalidSelectedCompanySkillSet(
          "Selected company skill target lock release was not acknowledged.",
        );
      }
      lockReleased = true;
    })();
    await lockRelease;
  };

  return Object.freeze({
    materializationKey: key.materializationKey,
    selectedSetDigest: key.selectedSetDigest,
    sourceFingerprint: key.sourceFingerprint,
    contentDigest: key.contentDigest,
    storeRoot,
    homeDir: prepared.homeDir,
    skillsDir: prepared.skillsDir,
    discoveryRoot: targetDiscoveryRoot(),
    preparationLockToken: prepared.lockToken,
    reused: prepared.reused,
    releasePreparationLock,
    async verifyAfterReap() {
      if (!lockReleased) {
        throw new InvalidSelectedCompanySkillSet(
          "Selected company skill target lock was not released after binding.",
        );
      }
      const verified = await executeTargetMaterializer({
        target: input.target,
        targetNodeExecutable: input.targetNodeExecutable,
        targetCwd: input.targetCwd,
        timeoutSec,
        payload: { ...basePayload, operation: "verify_after_reap" },
      });
      if (verified.operation !== "verified") {
        throw new InvalidSelectedCompanySkillSet(
          "Selected company skill post-reap verification was not acknowledged.",
        );
      }
    },
    async collectExact(expectedMaterializationKey: string) {
      if (expectedMaterializationKey !== key.materializationKey) {
        throw new InvalidSelectedCompanySkillSet(
          "Selected company skill collection crossed its complete key.",
        );
      }
      if (!lockReleased) {
        throw new InvalidSelectedCompanySkillSet(
          "Selected company skill collection requires released preparation ownership.",
        );
      }
      exactCollection ??= (async () => {
        const collected = await executeTargetMaterializer({
          target: input.target,
          targetNodeExecutable: input.targetNodeExecutable,
          targetCwd: input.targetCwd,
          timeoutSec,
          payload: { ...basePayload, operation: "collect" },
        });
        if (
          collected.operation !== "collected" ||
          collected.materializationKey !== key.materializationKey ||
          typeof collected.collected !== "boolean"
        ) {
          throw new InvalidSelectedCompanySkillSet(
            "Selected company skill target collection crossed its immutable input.",
          );
        }
        return Object.freeze({
          materializationKey: key.materializationKey,
          outcome: collected.collected ? "collected" : "absent",
        });
      })();
      return exactCollection;
    },
  });
}
