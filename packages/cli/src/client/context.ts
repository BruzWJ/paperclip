import fs from "node:fs";
import path from "node:path";
import { isCanonicalUuid } from "@paperclipai/shared";
import { parseExactApiBase } from "./api-base.js";
import { resolveDefaultContextPath } from "../config/home.js";

const DEFAULT_CONTEXT_BASENAME = "context.json";
const DEFAULT_PROFILE = "default";

export interface ClientContextProfile {
  apiBase?: string;
  companyId?: string;
  apiKeyEnvVarName?: string;
  tokenName?: string;
  tokenId?: string;
  tokenCreatedAt?: string;
}

export interface ClientContext {
  version: 2;
  currentProfile: string;
  profiles: Record<string, ClientContextProfile>;
}

function findContextFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(
      currentDir,
      ".paperclip",
      DEFAULT_CONTEXT_BASENAME,
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

export function resolveContextPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.PAPERCLIP_CONTEXT)
    return path.resolve(process.env.PAPERCLIP_CONTEXT);
  return (
    findContextFileFromAncestors(process.cwd()) ?? resolveDefaultContextPath()
  );
}

export function defaultClientContext(): ClientContext {
  return {
    version: 2,
    currentProfile: DEFAULT_PROFILE,
    profiles: {
      [DEFAULT_PROFILE]: {},
    },
  };
}

function parseJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function requirePlainRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} contains unsupported fields: ${unknown.sort().join(", ")}.`,
    );
  }
}

export function requireExactProfileName(value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error("Context profile name must be exact and non-empty.");
  }
  return value;
}

function exactStringOrUndefined(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(`${label} must be exact and non-empty.`);
  }
  return value;
}

function exactCompanyIdOrUndefined(
  value: unknown,
  profileName: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isCanonicalUuid(value)) {
    throw new Error(
      `Context profile '${profileName}' companyId must be an exact canonical company UUID.`,
    );
  }
  return value;
}

function normalizeProfile(
  value: unknown,
  profileName: string,
): ClientContextProfile {
  const profile = requirePlainRecord(value, `Context profile '${profileName}'`);
  assertExactKeys(
    profile,
    [
      "apiBase",
      "companyId",
      "apiKeyEnvVarName",
      "tokenName",
      "tokenId",
      "tokenCreatedAt",
    ],
    `Context profile '${profileName}'`,
  );
  const apiBase = exactStringOrUndefined(
    profile.apiBase,
    `Context profile '${profileName}' apiBase`,
  );
  const apiKeyEnvVarName = exactStringOrUndefined(
    profile.apiKeyEnvVarName,
    `Context profile '${profileName}' apiKeyEnvVarName`,
  );
  if (apiKeyEnvVarName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnvVarName)) {
    throw new Error(
      `Context profile '${profileName}' apiKeyEnvVarName must be an exact environment variable name.`,
    );
  }
  const tokenId = exactStringOrUndefined(
    profile.tokenId,
    `Context profile '${profileName}' tokenId`,
  );
  if (tokenId && !isCanonicalUuid(tokenId)) {
    throw new Error(
      `Context profile '${profileName}' tokenId must be an exact canonical UUID.`,
    );
  }
  const tokenCreatedAt = exactStringOrUndefined(
    profile.tokenCreatedAt,
    `Context profile '${profileName}' tokenCreatedAt`,
  );
  if (tokenCreatedAt) {
    const parsed = new Date(tokenCreatedAt);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString() !== tokenCreatedAt
    ) {
      throw new Error(
        `Context profile '${profileName}' tokenCreatedAt must be a canonical UTC ISO timestamp.`,
      );
    }
  }

  return {
    apiBase: apiBase === undefined ? undefined : parseExactApiBase(apiBase),
    companyId: exactCompanyIdOrUndefined(profile.companyId, profileName),
    apiKeyEnvVarName,
    tokenName: exactStringOrUndefined(
      profile.tokenName,
      `Context profile '${profileName}' tokenName`,
    ),
    tokenId,
    tokenCreatedAt,
  };
}

function normalizeContext(raw: unknown): ClientContext {
  const record = requirePlainRecord(raw, "CLI context");
  assertExactKeys(
    record,
    ["version", "currentProfile", "profiles"],
    "CLI context",
  );
  if (record.version !== 2) {
    throw new Error("CLI context version must be exactly 2.");
  }
  const currentProfile = requireExactProfileName(
    exactStringOrUndefined(
      record.currentProfile,
      "CLI context currentProfile",
    ) ?? "",
  );
  const rawProfiles = requirePlainRecord(
    record.profiles,
    "CLI context profiles",
  );
  const profiles: Record<string, ClientContextProfile> = {};
  for (const [name, profile] of Object.entries(rawProfiles)) {
    requireExactProfileName(name);
    profiles[name] = normalizeProfile(profile, name);
  }
  if (Object.keys(profiles).length === 0) {
    throw new Error("CLI context profiles must contain at least one profile.");
  }
  if (!profiles[currentProfile]) {
    throw new Error(
      `CLI context currentProfile '${currentProfile}' does not exist.`,
    );
  }

  return {
    version: 2,
    currentProfile,
    profiles,
  };
}

export function readContext(contextPath?: string): ClientContext {
  const filePath = resolveContextPath(contextPath);
  if (!fs.existsSync(filePath)) {
    return defaultClientContext();
  }

  const raw = parseJson(filePath);
  return normalizeContext(raw);
}

export function writeContext(
  context: ClientContext,
  contextPath?: string,
): void {
  const filePath = resolveContextPath(contextPath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const normalized = normalizeContext(context);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function upsertProfile(
  profileName: string,
  patch: Partial<ClientContextProfile>,
  contextPath?: string,
): ClientContext {
  requireExactProfileName(profileName);
  const context = readContext(contextPath);
  const existing = context.profiles[profileName] ?? {};
  const merged: ClientContextProfile = { ...existing };

  if (patch.apiBase !== undefined)
    merged.apiBase = parseExactApiBase(patch.apiBase);
  if (patch.companyId !== undefined) {
    if (!isCanonicalUuid(patch.companyId)) {
      throw new Error(
        "Context companyId must be an exact canonical company UUID.",
      );
    }
    merged.companyId = patch.companyId;
  }
  if (patch.apiKeyEnvVarName !== undefined)
    merged.apiKeyEnvVarName = patch.apiKeyEnvVarName;
  if (patch.tokenName !== undefined) merged.tokenName = patch.tokenName;
  if (patch.tokenId !== undefined) merged.tokenId = patch.tokenId;
  if (patch.tokenCreatedAt !== undefined)
    merged.tokenCreatedAt = patch.tokenCreatedAt;

  context.profiles[profileName] = normalizeProfile(merged, profileName);
  context.currentProfile = context.currentProfile || profileName;
  writeContext(context, contextPath);
  return context;
}

export function setCurrentProfile(
  profileName: string,
  contextPath?: string,
): ClientContext {
  requireExactProfileName(profileName);
  const context = readContext(contextPath);
  if (!context.profiles[profileName]) {
    throw new Error(`Context profile '${profileName}' does not exist.`);
  }
  context.currentProfile = profileName;
  writeContext(context, contextPath);
  return context;
}

export function resolveProfile(
  context: ClientContext,
  profileName?: string,
): { name: string; profile: ClientContextProfile } {
  const name =
    profileName === undefined
      ? context.currentProfile
      : requireExactProfileName(profileName);
  const profile = context.profiles[name];
  if (!profile) throw new Error(`Context profile '${name}' does not exist.`);
  return { name, profile };
}
