import pc from "picocolors";
import type { Command } from "commander";
import { isCanonicalUuid, LOOPBACK_BIND_HOST, resolveServerPort } from "@paperclipai/shared";
import { getStoredBoardCredential, loginBoardCli } from "../../client/board-auth.js";
import { buildCliCommandLabel } from "../../client/command-label.js";
import { readConfig } from "../../config/store.js";
import { readContext, resolveProfile, type ClientContextProfile } from "../../client/context.js";
import { ApiRequestError, PaperclipApiClient } from "../../client/http.js";
import { parseExactApiBase } from "../../client/api-base.js";

export interface BaseClientOptions {
  config?: string;
  dataDir?: string;
  context?: string;
  profile?: string;
  apiBase?: string;
  apiKey?: string;
  userId?: string;
  companyId?: string;
  json?: boolean;
}

export interface ResolvedClientContext {
  api: PaperclipApiClient;
  companyId?: string;
  currentUserId: string | null;
  profileName: string;
  profile: ClientContextProfile;
  json: boolean;
  authSource: "explicit" | "env" | "profile_env" | "stored_board" | "none";
}

export function addCommonClientOptions(command: Command, opts?: { includeCompany?: boolean }): Command {
  command
    .option("-c, --config <path>", "Path to Paperclip config file")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "CLI context profile name")
    .option("--api-base <url>", "Base URL for the Paperclip API")
    .option("--api-key <token>", "Board bearer token")
    .option("--user-id <id>", "Exact board user ID for user-scoped routes")
    .option("--json", "Output raw JSON");

  if (opts?.includeCompany) {
    command.option("-C, --company-id <id>", "Company ID (overrides context default)");
  }

  return command;
}

export function resolveCommandContext(
  options: BaseClientOptions,
  opts?: { requireCompany?: boolean },
): ResolvedClientContext {
  const context = readContext(options.context);
  const { name: profileName, profile } = resolveProfile(context, options.profile);

  const apiBase = resolveApiBase(options, profile);

  const resolvedApiKey = resolveApiKey(options, profile);
  const explicitApiKey = resolvedApiKey.value;
  const storedBoardCredential = explicitApiKey ? null : getStoredBoardCredential(apiBase);
  const apiKey = explicitApiKey || storedBoardCredential?.token;
  const currentUserId = options.userId === undefined
    ? storedBoardCredential?.userId ?? null
    : assertExactAuthUserId(options.userId);

  const companyId = resolveCanonicalCompanyId(options, profile);

  if (opts?.requireCompany && !companyId) {
    throw new Error(
      "Company ID is required. Pass --company-id, set PAPERCLIP_BOARD_COMPANY_ID, or set context profile companyId via `paperclipai context set`.",
    );
  }

  const api = new PaperclipApiClient({
    apiBase,
    apiKey,
    recoverAuth: explicitApiKey || !canAttemptInteractiveBoardAuth()
      ? undefined
      : async ({ error }) => {
          const requestedAccess = error.message.includes("Instance admin required")
            ? "instance_admin_required"
            : "board";
          if (!shouldRecoverBoardAuth(error)) {
            return null;
          }
          const login = await loginBoardCli({
            apiBase,
            requestedAccess,
            requestedCompanyId: companyId ?? null,
            command: buildCliCommandLabel(),
          });
          return login.token;
        },
  });
  return {
    api,
    companyId,
    currentUserId,
    profileName,
    profile,
    json: Boolean(options.json),
    authSource: explicitApiKey ? resolvedApiKey.source : storedBoardCredential ? "stored_board" : "none",
  };
}

export function assertExactAuthUserId(userId: string): string {
  if (userId.length === 0) {
    throw new Error("Expected an exact non-empty auth user ID.");
  }
  if (userId.trim() !== userId) {
    throw new Error("Auth user IDs cannot contain surrounding whitespace.");
  }
  return userId;
}

export function requireCurrentUserId(ctx: ResolvedClientContext): string {
  if (!ctx.currentUserId) {
    throw new Error(
      "This command requires an exact board user ID. Pass --user-id or run `paperclipai auth login` first.",
    );
  }
  return ctx.currentUserId;
}

function resolveCanonicalCompanyId(
  options: BaseClientOptions,
  profile: ClientContextProfile,
): string | undefined {
  const candidates = [
    { source: "--company-id", value: options.companyId },
    { source: "PAPERCLIP_BOARD_COMPANY_ID", value: process.env.PAPERCLIP_BOARD_COMPANY_ID },
    { source: "context profile companyId", value: profile.companyId },
  ];
  const selected = candidates.find((candidate) => candidate.value !== undefined);
  if (!selected) return undefined;
  if (!isCanonicalUuid(selected.value)) {
    throw new Error(`${selected.source} must be an exact canonical company UUID.`);
  }
  return selected.value;
}

export function resolveApiBase(options: Pick<BaseClientOptions, "apiBase" | "config">, profile: ClientContextProfile = {}): string {
  return parseExactApiBase(
    options.apiBase ||
    process.env.PAPERCLIP_BOARD_API_URL ||
    profile.apiBase ||
    inferApiBaseFromConfig(options.config),
  );
}

export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number | boolean | null | undefined>): string {
  let path = strings[0] ?? "";
  values.forEach((value, index) => {
    const segment = value === null || value === undefined ? "" : String(value);
    if (segment.length === 0 || segment.trim() !== segment) {
      throw new Error("Cannot build API path with an empty or padded path segment.");
    }
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
      && !isCanonicalUuid(segment)
    ) {
      throw new Error("Cannot build API path with a noncanonical UUID segment.");
    }
    path += `${encodeURIComponent(segment)}${strings[index + 1] ?? ""}`;
  });
  return path;
}

export function inferContentTypeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  // These MIME strings are matched against the server's task-attachment
  // allowlist (apps/server/src/attachment-types.ts DEFAULT_ALLOWED_TYPES) by EXACT
  // string, so text types must carry no "; charset=..." parameter or the upload
  // is rejected with "422 Unsupported attachment content type". Keep this set in
  // sync with that allowlist (plus svg/avif, accepted by the asset routes).
  return {
    avif: "image/avif",
    csv: "text/csv",
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    m4v: "video/x-m4v",
    md: "text/markdown",
    mov: "video/quicktime",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    qt: "video/quicktime",
    svg: "image/svg+xml",
    txt: "text/plain",
    webm: "video/webm",
    webp: "image/webp",
    zip: "application/zip",
  }[ext];
}

function resolveApiKey(
  options: Pick<BaseClientOptions, "apiKey">,
  profile: ClientContextProfile,
): { value: string | undefined; source: "explicit" | "env" | "profile_env" | "none" } {
  const exactKey = (value: string | undefined, source: string) => {
    if (value === undefined) return undefined;
    if (value.length === 0 || value.trim() !== value) {
      throw new Error(`${source} must be an exact non-empty API key`);
    }
    return value;
  };

  const optionValue = exactKey(options.apiKey, "--api-key");
  if (optionValue !== undefined) return { value: optionValue, source: "explicit" };

  const envValue = exactKey(process.env.PAPERCLIP_BOARD_API_KEY, "PAPERCLIP_BOARD_API_KEY");
  if (envValue !== undefined) return { value: envValue, source: "env" };

  const profileEnvValue = exactKey(
    readKeyFromProfileEnv(profile),
    profile.apiKeyEnvVarName ?? "profile API key variable",
  );
  if (profileEnvValue !== undefined) return { value: profileEnvValue, source: "profile_env" };

  return { value: undefined, source: "none" };
}

function shouldRecoverBoardAuth(error: ApiRequestError): boolean {
  if (error.status === 401) return true;
  if (error.status !== 403) return false;
  return error.message.includes("Board access required") || error.message.includes("Instance admin required");
}

function canAttemptInteractiveBoardAuth(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function printOutput(data: unknown, opts: { json?: boolean; label?: string } = {}): void {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (opts.label) {
    console.log(pc.bold(opts.label));
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log(pc.dim("(empty)"));
      return;
    }
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        console.log(formatInlineRecord(item as Record<string, unknown>));
      } else {
        console.log(String(item));
      }
    }
    return;
  }

  if (typeof data === "object" && data !== null) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data === undefined || data === null) {
    console.log(pc.dim("(null)"));
    return;
  }

  console.log(String(data));
}

export function formatInlineRecord(record: Record<string, unknown>): string {
  const keyOrder = ["identifier", "id", "name", "status", "priority", "title", "action"];
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const key of keyOrder) {
    if (!(key in record)) continue;
    parts.push(`${key}=${renderValue(record[key])}`);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(record)) {
    if (seen.has(key)) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}=${renderValue(value)}`);
  }

  return parts.join(" ");
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > 90 ? `${compact.slice(0, 87)}...` : compact;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "[object]";
}

export function inferApiBaseFromConfig(configPath?: string): string {
  const config = readConfig(configPath);
  const port = resolveServerPort({
    environmentValue: process.env.PORT,
    persistedValue: config?.server.port,
  });
  return `http://${LOOPBACK_BIND_HOST}:${port}`;
}

function readKeyFromProfileEnv(profile: ClientContextProfile): string | undefined {
  if (!profile.apiKeyEnvVarName) return undefined;
  return process.env[profile.apiKeyEnvVarName];
}

export function handleCommandError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    const detailSuffix = error.details !== undefined ? ` details=${JSON.stringify(error.details)}` : "";
    console.error(pc.red(`API error ${error.status}: ${error.message}${detailSuffix}`));
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(message));
  process.exit(1);
}
