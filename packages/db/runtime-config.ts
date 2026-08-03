import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipEnvPathForConfig,
} from "@paperclipai/shared/home-paths";

const CONFIG_BASENAME = "config.json";
const retiredField = (...parts: string[]) => parts.join("");
const RETIRED_DATABASE_FIELDS = [
  "mode",
  retiredField("emb", "edded", "Postgres"),
  retiredField("emb", "edded", "Postgres", "Data", "Dir"),
  retiredField("emb", "edded", "Postgres", "Port"),
  retiredField("pg", "lite"),
  retiredField("pg", "lite", "Data", "Dir"),
  retiredField("pg", "lite", "Port"),
];

type PartialConfig = {
  database?: {
    connectionString?: string;
  };
};

export type ExternalDatabaseTargetSource =
  | "DATABASE_URL"
  | "paperclip-env"
  | "config.database.connectionString";

export type ResolvedDatabaseTarget = {
  connectionString: string;
  source: ExternalDatabaseTargetSource;
  configPath: string;
  envPath: string;
};

export type ResolveDatabaseTargetOptions = {
  configPath?: string;
  environment?: Partial<Pick<NodeJS.ProcessEnv, "DATABASE_URL">>;
};

/**
 * A parsed external database locator used only where PostgreSQL syntax needs
 * an exact database name. Physical identity must always be probed through a
 * connection; these locator fields are never compared as identity.
 */
export type ParsedExternalPostgresDatabaseTarget = {
  connectionString: string;
  adminConnectionString: string;
  databaseName: string;
};

function findConfigFileFromAncestors(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.resolve(currentDir, ".paperclip", CONFIG_BASENAME);
    if (existsSync(candidate)) return candidate;

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) return null;
    currentDir = nextDir;
  }
}

function resolvePaperclipConfigPath(): string {
  if (process.env.PAPERCLIP_CONFIG?.trim()) {
    return path.resolve(process.env.PAPERCLIP_CONFIG.trim());
  }
  return findConfigFileFromAncestors(process.cwd()) ?? resolvePaperclipConfigPathForInstance();
}

function resolvePaperclipEnvPath(configPath: string): string {
  return resolvePaperclipEnvPathForConfig(configPath);
}

function parseEnvFile(contents: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (!value) {
      entries[key] = "";
      continue;
    }

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      entries[key] = value.slice(1, -1);
      continue;
    }

    entries[key] = value.replace(/\s+#.*$/, "").trim();
  }

  return entries;
}

function readEnvEntries(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  return parseEnvFile(readFileSync(envPath, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfig(configPath: string): PartialConfig | null {
  if (!existsSync(configPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to parse config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid config at ${configPath}: expected a JSON object`);
  }

  if (parsed.database === undefined) return {};
  if (!isRecord(parsed.database)) {
    throw new Error(`Invalid config at ${configPath}: database must be a JSON object`);
  }

  for (const field of RETIRED_DATABASE_FIELDS) {
    if (Object.hasOwn(parsed.database, field)) {
      throw new Error(
        `Invalid config at ${configPath}: database.${field} is retired; configure database.connectionString or DATABASE_URL instead`,
      );
    }
  }

  const connectionString = parsed.database.connectionString;
  if (connectionString !== undefined && typeof connectionString !== "string") {
    throw new Error(`Invalid config at ${configPath}: database.connectionString must be a string`);
  }

  return {
    database: connectionString === undefined ? undefined : { connectionString },
  };
}

/**
 * Validates the only database transport Paperclip supports. Callers receive
 * the original URL (trimmed) so credentials are never rewritten or invented.
 */
export function validateExternalPostgresConnectionString(value: string, source: string): string {
  const connectionString = value.trim();
  if (!connectionString) {
    throw new Error(`${source} must be a non-empty PostgreSQL connection URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`${source} must be a valid PostgreSQL connection URL`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${source} must use the postgres:// or postgresql:// protocol`);
  }

  return connectionString;
}

/**
 * Validates an optional external-only override, such as the migration URL.
 * An absent override intentionally remains absent; it never selects a local
 * target or manufactures a replacement URL.
 */
export function resolveOptionalExternalPostgresConnectionString(
  value: string | null | undefined,
  source: string,
): string | undefined {
  const connectionString = value?.trim();
  return connectionString
    ? validateExternalPostgresConnectionString(connectionString, source)
    : undefined;
}

/**
 * Parses one externally provisioned PostgreSQL database for client-only
 * administrative operations. It does not connect, create a database server,
 * choose a port, or derive credentials.
 */
export function parseExternalPostgresDatabaseTarget(
  value: string,
  source = "Database target",
): ParsedExternalPostgresDatabaseTarget {
  const connectionString = validateExternalPostgresConnectionString(value, source);
  const parsed = new URL(connectionString);
  const pathSegments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  if (pathSegments.length !== 1 || !pathSegments[0]) {
    throw new Error(`${source} must identify exactly one database.`);
  }

  const databaseName = pathSegments[0];
  const admin = new URL(parsed);
  admin.pathname = "/postgres";
  admin.hash = "";

  return {
    connectionString,
    adminConnectionString: admin.toString(),
    databaseName,
  };
}

/**
 * Produces a display-safe form of a canonical external target. This is kept
 * beside validation so operator-facing callers cannot parse a second URL
 * dialect or accidentally log credentials.
 */
export function redactExternalPostgresConnectionString(connectionString: string): string {
  const parsed = new URL(
    validateExternalPostgresConnectionString(connectionString, "Database target"),
  );
  if (parsed.username) parsed.username = "***";
  if (parsed.password) parsed.password = "***";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/(?:pass(?:word)?|secret|token|credential|key)/i.test(key)) {
      parsed.searchParams.set(key, "***");
    }
  }
  return parsed.toString();
}

export function resolveDatabaseTarget(
  options: ResolveDatabaseTargetOptions = {},
): ResolvedDatabaseTarget {
  const configPath = options.configPath?.trim()
    ? path.resolve(options.configPath)
    : resolvePaperclipConfigPath();
  const envPath = resolvePaperclipEnvPath(configPath);
  const config = readConfig(configPath);
  const envEntries = readEnvEntries(envPath);
  const environment = options.environment ?? process.env;

  const candidates = [
    {
      connectionString: environment.DATABASE_URL,
      source: "DATABASE_URL" as const,
    },
    {
      connectionString: envEntries.DATABASE_URL,
      source: "paperclip-env" as const,
    },
    {
      connectionString: config?.database?.connectionString,
      source: "config.database.connectionString" as const,
    },
  ];

  for (const candidate of candidates) {
    const connectionString = resolveOptionalExternalPostgresConnectionString(
      candidate.connectionString,
      candidate.source,
    );
    if (connectionString) {
      return {
        connectionString,
        source: candidate.source,
        configPath,
        envPath,
      };
    }
  }

  throw new Error(
    "An external PostgreSQL connection is required. Set DATABASE_URL, add DATABASE_URL to the adjacent .paperclip/.env file, or configure database.connectionString.",
  );
}
