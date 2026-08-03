import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const MAX_PERSISTED_DEV_SERVER_STATUS_BYTES = 64 * 1024;
const MAX_DEV_SERVER_RESTART_REQUEST_BYTES = 4 * 1024;

export type PersistedDevServerStatus = {
  dirty: boolean;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  lastRestartAt: string | null;
};

export type DevServerHealthStatus = {
  enabled: true;
  restartRequired: boolean;
  reason: "backend_changes" | null;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  autoRestartEnabled: boolean;
  activeRunCount: number;
  waitingForIdle: boolean;
  lastRestartAt: string | null;
};

export type DevServerRestartRequest = {
  requestedAt: string;
  reason: "manual_restart_now" | "auto_restart_when_idle";
};

export function getDevServerRestartRequestFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const statusFilePath = env.PAPERCLIP_DEV_SERVER_STATUS_FILE?.trim();
  if (!statusFilePath) return null;
  return path.join(path.dirname(statusFilePath), "dev-server-restart-request.json");
}

export function writeDevServerRestartRequest(
  request: DevServerRestartRequest,
  env: NodeJS.ProcessEnv = process.env,
  opts: { preserveExisting?: boolean } = {},
): boolean {
  const filePath = getDevServerRestartRequestFilePath(env);
  if (!filePath) return false;
  if (
    !isCanonicalTimestamp(request.requestedAt) ||
    (request.reason !== "manual_restart_now" &&
      request.reason !== "auto_restart_when_idle")
  ) {
    return false;
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(request, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (opts.preserveExisting) {
      try {
        linkSync(tempPath, filePath);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          return false;
        }
        throw error;
      }
    } else {
      renameSync(tempPath, filePath);
    }
    return true;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function readDevServerRestartRequest(
  env: NodeJS.ProcessEnv = process.env,
): DevServerRestartRequest | null {
  const filePath = getDevServerRestartRequestFilePath(env);
  if (!filePath || !existsSync(filePath)) return null;

  try {
    if (statSync(filePath).size > MAX_DEV_SERVER_RESTART_REQUEST_BYTES) {
      return null;
    }
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "requestedAt") {
      return null;
    }
    if (!isCanonicalTimestamp(record.requestedAt)) {
      return null;
    }
    if (
      record.reason !== "manual_restart_now" &&
      record.reason !== "auto_restart_when_idle"
    ) {
      return null;
    }
    return {
      requestedAt: record.requestedAt,
      reason: record.reason,
    };
  } catch {
    return null;
  }
}

export function consumeDevServerRestartRequest(
  env: NodeJS.ProcessEnv = process.env,
): DevServerRestartRequest | null {
  const filePath = getDevServerRestartRequestFilePath(env);
  if (!filePath) return null;
  const request = readDevServerRestartRequest(env);
  if (!request) return null;
  rmSync(filePath, { force: true });
  return request;
}

export function readPersistedDevServerStatus(
  env: NodeJS.ProcessEnv = process.env,
): PersistedDevServerStatus | null {
  const filePath = env.PAPERCLIP_DEV_SERVER_STATUS_FILE?.trim();
  if (!filePath || !existsSync(filePath)) return null;

  try {
    if (statSync(filePath).size > MAX_PERSISTED_DEV_SERVER_STATUS_BYTES) {
      return null;
    }
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const changedPathsSample = normalizeStringArray(raw.changedPathsSample).slice(0, 5);
    const changedPathCountRaw = raw.changedPathCount;
    const changedPathCount =
      typeof changedPathCountRaw === "number" && Number.isFinite(changedPathCountRaw)
        ? Math.max(0, Math.trunc(changedPathCountRaw))
        : changedPathsSample.length;
    const dirtyRaw = raw.dirty;
    const dirty =
      typeof dirtyRaw === "boolean"
        ? dirtyRaw
        : changedPathCount > 0;

    return {
      dirty,
      lastChangedAt: normalizeTimestamp(raw.lastChangedAt),
      changedPathCount,
      changedPathsSample,
      lastRestartAt: normalizeTimestamp(raw.lastRestartAt),
    };
  } catch {
    return null;
  }
}

export function toDevServerHealthStatus(
  persisted: PersistedDevServerStatus,
  opts: { autoRestartEnabled: boolean; activeRunCount: number },
): DevServerHealthStatus {
  const hasPathChanges = persisted.changedPathCount > 0;
  const reason = hasPathChanges ? "backend_changes" : null;
  const restartRequired = persisted.dirty || reason !== null;

  return {
    enabled: true,
    restartRequired,
    reason,
    lastChangedAt: persisted.lastChangedAt,
    changedPathCount: persisted.changedPathCount,
    changedPathsSample: persisted.changedPathsSample,
    autoRestartEnabled: opts.autoRestartEnabled,
    activeRunCount: opts.activeRunCount,
    waitingForIdle: restartRequired && opts.autoRestartEnabled && opts.activeRunCount > 0,
    lastRestartAt: persisted.lastRestartAt,
  };
}
