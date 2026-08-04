import { randomInt } from "node:crypto";
import path from "node:path";
import type { PaperclipConfig } from "../config/schema.js";
import { expandHomePrefix } from "../config/home.js";

export const DEFAULT_WORKTREE_HOME = "~/.paperclip-worktrees";
export const WORKTREE_MARKER_FORMAT_VERSION = 1;
export const WORKTREE_MARKER_BASENAME = "worktree-instance.json";
export const WORKTREE_CREATION_LOCK_BASENAME = "worktree-creation.lock";

export type WorktreeLocalPaths = {
  cwd: string;
  repoConfigDir: string;
  configPath: string;
  envPath: string;
  markerPath: string;
  creationLockPath: string;
  homeDir: string;
  instanceId: string;
  instanceRoot: string;
  backupDir: string;
  logDir: string;
  secretsKeyFilePath: string;
  storageDir: string;
};

export type WorktreeUiBranding = {
  name: string;
  color: string;
};

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function sanitizeWorktreeInstanceId(rawValue: string): string {
  const normalized = rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized || "worktree";
}

export function resolveSuggestedWorktreeName(
  cwd: string,
  explicitName?: string,
): string {
  return nonEmpty(explicitName) ?? path.basename(path.resolve(cwd));
}

function componentToHex(value: number): string {
  return Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, "0");
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs((2 * l) - 1)) * s;
  const h = ((hue % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return `#${componentToHex((r + m) * 255)}${componentToHex((g + m) * 255)}${componentToHex((b + m) * 255)}`;
}

export function generateWorktreeColor(): string {
  return hslToHex(randomInt(0, 360), 68, 56);
}

export function resolveWorktreeLocalPaths(input: {
  cwd: string;
  homeDir?: string;
  instanceId: string;
}): WorktreeLocalPaths {
  const cwd = path.resolve(input.cwd);
  const homeDir = path.resolve(
    expandHomePrefix(input.homeDir ?? DEFAULT_WORKTREE_HOME),
  );
  const repoConfigDir = path.resolve(cwd, ".paperclip");
  const instanceRoot = path.resolve(
    homeDir,
    "instances",
    input.instanceId,
  );
  return {
    cwd,
    repoConfigDir,
    configPath: path.resolve(repoConfigDir, "config.json"),
    envPath: path.resolve(repoConfigDir, ".env"),
    markerPath: path.resolve(repoConfigDir, WORKTREE_MARKER_BASENAME),
    creationLockPath: path.resolve(
      repoConfigDir,
      WORKTREE_CREATION_LOCK_BASENAME,
    ),
    homeDir,
    instanceId: input.instanceId,
    instanceRoot,
    backupDir: path.resolve(instanceRoot, "data", "backups"),
    logDir: path.resolve(instanceRoot, "logs"),
    secretsKeyFilePath: path.resolve(
      instanceRoot,
      "secrets",
      "master.key",
    ),
    storageDir: path.resolve(instanceRoot, "data", "storage"),
  };
}

export function buildWorktreeConfig(input: {
  paths: WorktreeLocalPaths;
  serverPort: number;
  now?: Date;
}): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: (input.now ?? new Date()).toISOString(),
      source: "configure",
    },
    database: {
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: input.paths.backupDir,
      },
    },
    logging: {
      mode: "file",
      logDir: input.paths.logDir,
    },
    server: {
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port: input.serverPort,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      disableSignUp: false,
    },
    telemetry: { enabled: true },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: input.paths.storageDir },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: true,
      localEncrypted: {
        keyFilePath: input.paths.secretsKeyFilePath,
      },
    },
  };
}

function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

export function renderPinnedWorktreeEnv(input: {
  databaseUrl: string;
  betterAuthSecret: string;
}): string {
  return [
    `DATABASE_URL=${formatEnvValue(input.databaseUrl)}`,
    `BETTER_AUTH_SECRET=${formatEnvValue(input.betterAuthSecret)}`,
    "",
  ].join("\n");
}
