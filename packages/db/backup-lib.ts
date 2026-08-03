import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  assertDistinctDatabaseIdentities,
  probeDatabaseIdentity,
  revalidateDatabaseIdentity,
  type VerifiedDatabaseIdentity,
} from "./database-identity.js";
import { validateExternalPostgresConnectionString } from "./runtime-config.js";

export const PAPERCLIP_DATABASE_BACKUP_FORMAT =
  "paperclip-postgresql-disaster-recovery";
export const PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION = 2;

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = basename(MODULE_DIRECTORY) === "dist"
  ? resolve(MODULE_DIRECTORY, "..")
  : MODULE_DIRECTORY;
const MIGRATIONS_FOLDER = resolve(PACKAGE_ROOT, "migrations");
const PAYLOAD_SUFFIX = ".dump";
const MANIFEST_SUFFIX = ".manifest.json";
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 5;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const SECRET_FINGERPRINT_ALGORITHM = "scrypt-sha256-v1";
const SECRET_FINGERPRINT_COST = 16_384;
const SECRET_FINGERPRINT_BLOCK_SIZE = 8;
const SECRET_FINGERPRINT_PARALLELIZATION = 1;
const SECRET_FINGERPRINT_KEY_LENGTH = 32;
const SECRET_FINGERPRINT_MAX_MEMORY = 64 * 1024 * 1024;
const REQUIRED_MIGRATION_JOURNAL_TABLE = "drizzle.__drizzle_migrations";

export type BackupRetentionPolicy = {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
};

export type DatabaseMigrationJournalEntry = {
  hash: string;
  createdAt: string;
};

export type DatabaseBackupSecretFingerprint = {
  algorithm: typeof SECRET_FINGERPRINT_ALGORITHM;
  saltBase64Url: string;
  digestBase64Url: string;
  cost: typeof SECRET_FINGERPRINT_COST;
  blockSize: typeof SECRET_FINGERPRINT_BLOCK_SIZE;
  parallelization: typeof SECRET_FINGERPRINT_PARALLELIZATION;
  keyLength: typeof SECRET_FINGERPRINT_KEY_LENGTH;
};

export type PaperclipDatabaseBackupManifest = {
  format: typeof PAPERCLIP_DATABASE_BACKUP_FORMAT;
  formatVersion: typeof PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION;
  createdAt: string;
  sourceDatabaseIdentity: VerifiedDatabaseIdentity;
  migrationJournal: DatabaseMigrationJournalEntry[];
  tableSet: string[];
  payload: {
    sha256: string;
    sizeBytes: number;
  };
  betterAuthSecretFingerprint: DatabaseBackupSecretFingerprint;
};

export type RunDatabaseBackupOptions = {
  connectionString: string;
  betterAuthSecret: string;
  backupDir: string;
  retention: BackupRetentionPolicy;
  filenamePrefix?: string;
};

export type RunDatabaseBackupResult = {
  backupFile: string;
  manifestFile: string;
  manifestFormat: typeof PAPERCLIP_DATABASE_BACKUP_FORMAT;
  manifestFormatVersion: typeof PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION;
  payloadChecksum: string;
  sourceDatabaseIdentity: VerifiedDatabaseIdentity;
  migrationJournal: DatabaseMigrationJournalEntry[];
  tableSet: string[];
  sizeBytes: number;
  prunedCount: number;
};

/**
 * Restore accepts explicit file paths only. It never infers sidecars, reads a
 * secret from process state, clears a target, or repairs migration history.
 */
export type RunDatabaseRestoreOptions = {
  connectionString: string;
  backupFile: string;
  manifestFile: string;
  betterAuthSecretFile: string;
};

export type RunDatabaseRestoreResult = {
  manifestFormat: typeof PAPERCLIP_DATABASE_BACKUP_FORMAT;
  manifestFormatVersion: typeof PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION;
  payloadChecksum: string;
  sourceDatabaseIdentity: VerifiedDatabaseIdentity;
  targetDatabaseIdentity: VerifiedDatabaseIdentity;
  restoredMigrationJournal: DatabaseMigrationJournalEntry[];
  appliedForwardMigrations: DatabaseMigrationJournalEntry[];
  finalMigrationJournal: DatabaseMigrationJournalEntry[];
};

type TableDefinition = {
  schemaName: string;
  tableName: string;
};

type MigrationJournalRow = {
  hash: string;
  createdAt: string;
};

type SpawnResult = {
  stdout: Buffer;
};

function timestamp(date: Date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function isoWeekKey(date: Date): string {
  const day = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatBackupSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)}K`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}M`;
}

function assertNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function validateFilenamePrefix(value: string): string {
  const prefix = value.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix) ||
    prefix.includes("..")
  ) {
    throw new Error(
      "Database backup filename prefix must contain only letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return prefix;
}

function normalizeRetentionPolicy(
  retention: BackupRetentionPolicy,
): BackupRetentionPolicy {
  const normalize = (value: number, label: string) => {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${label} must be a positive integer.`);
    }
    return value;
  };
  return {
    dailyDays: normalize(retention.dailyDays, "dailyDays"),
    weeklyWeeks: normalize(retention.weeklyWeeks, "weeklyWeeks"),
    monthlyMonths: normalize(retention.monthlyMonths, "monthlyMonths"),
  };
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function journalEntriesEqual(
  left: readonly DatabaseMigrationJournalEntry[],
  right: readonly DatabaseMigrationJournalEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return other?.hash === entry.hash && other.createdAt === entry.createdAt;
    })
  );
}

function assertRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (!arraysEqual(actual, sortedExpected)) {
    throw new Error(`${label} has an unsupported shape.`);
  }
}

function assertRuntimeOptionKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const permitted = new Set(expected);
  const unsupported = Object.keys(value)
    .filter((key) => !permitted.has(key))
    .sort();
  if (unsupported.length > 0) {
    throw new Error(
      `${label} contains unsupported option(s): ${unsupported.join(", ")}.`,
    );
  }
}

function assertSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function parseVerifiedDatabaseIdentity(
  value: unknown,
): VerifiedDatabaseIdentity {
  const record = assertRecord(value, "sourceDatabaseIdentity");
  assertExactKeys(
    record,
    ["clusterSystemIdentifier", "databaseOid", "databaseName"],
    "sourceDatabaseIdentity",
  );
  const clusterSystemIdentifier = record.clusterSystemIdentifier;
  const databaseOid = record.databaseOid;
  const databaseName = record.databaseName;
  if (
    typeof clusterSystemIdentifier !== "string" ||
    !/^[0-9]+$/.test(clusterSystemIdentifier) ||
    typeof databaseOid !== "string" ||
    !/^[0-9]+$/.test(databaseOid) ||
    typeof databaseName !== "string" ||
    databaseName.length === 0
  ) {
    throw new Error(
      "sourceDatabaseIdentity must contain a verified PostgreSQL cluster/database identity.",
    );
  }
  return Object.freeze({
    clusterSystemIdentifier,
    databaseOid,
    databaseName,
  });
}

function parseMigrationJournal(
  value: unknown,
  label: string,
): DatabaseMigrationJournalEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain at least one migration.`);
  }
  const entries = value.map((raw, index) => {
    const record = assertRecord(raw, `${label}[${index}]`);
    assertExactKeys(record, ["hash", "createdAt"], `${label}[${index}]`);
    const hash = assertSha256(record.hash, `${label}[${index}].hash`);
    if (
      typeof record.createdAt !== "string" ||
      !/^[0-9]+$/.test(record.createdAt)
    ) {
      throw new Error(`${label}[${index}].createdAt must be an integer string.`);
    }
    return { hash, createdAt: record.createdAt };
  });
  if (new Set(entries.map((entry) => entry.hash)).size !== entries.length) {
    throw new Error(`${label} must not contain duplicate migration hashes.`);
  }
  return entries;
}

function parseTableSet(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error("tableSet must be an array of nonempty strings.");
  }
  const tableSet = [...value] as string[];
  if (new Set(tableSet).size !== tableSet.length) {
    throw new Error("tableSet must not contain duplicate values.");
  }
  const sorted = [...tableSet].sort((left, right) =>
    left.localeCompare(right)
  );
  if (!arraysEqual(tableSet, sorted)) {
    throw new Error("tableSet must be sorted.");
  }
  if (
    tableSet.some((tableName) =>
      !/^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/.test(tableName)
    )
  ) {
    throw new Error("tableSet contains an invalid qualified table name.");
  }
  if (!tableSet.includes(REQUIRED_MIGRATION_JOURNAL_TABLE)) {
    throw new Error("tableSet must include the Drizzle migration journal.");
  }
  return tableSet;
}

function parseSecretFingerprint(
  value: unknown,
): DatabaseBackupSecretFingerprint {
  const record = assertRecord(value, "betterAuthSecretFingerprint");
  assertExactKeys(
    record,
    [
      "algorithm",
      "saltBase64Url",
      "digestBase64Url",
      "cost",
      "blockSize",
      "parallelization",
      "keyLength",
    ],
    "betterAuthSecretFingerprint",
  );
  if (
    record.algorithm !== SECRET_FINGERPRINT_ALGORITHM ||
    record.cost !== SECRET_FINGERPRINT_COST ||
    record.blockSize !== SECRET_FINGERPRINT_BLOCK_SIZE ||
    record.parallelization !== SECRET_FINGERPRINT_PARALLELIZATION ||
    record.keyLength !== SECRET_FINGERPRINT_KEY_LENGTH ||
    typeof record.saltBase64Url !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(record.saltBase64Url) ||
    typeof record.digestBase64Url !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(record.digestBase64Url)
  ) {
    throw new Error(
      "betterAuthSecretFingerprint uses an unsupported fingerprint contract.",
    );
  }
  const salt = Buffer.from(record.saltBase64Url, "base64url");
  const digest = Buffer.from(record.digestBase64Url, "base64url");
  if (salt.length !== 32 || digest.length !== SECRET_FINGERPRINT_KEY_LENGTH) {
    throw new Error(
      "betterAuthSecretFingerprint contains an invalid salt or digest.",
    );
  }
  return {
    algorithm: SECRET_FINGERPRINT_ALGORITHM,
    saltBase64Url: record.saltBase64Url,
    digestBase64Url: record.digestBase64Url,
    cost: SECRET_FINGERPRINT_COST,
    blockSize: SECRET_FINGERPRINT_BLOCK_SIZE,
    parallelization: SECRET_FINGERPRINT_PARALLELIZATION,
    keyLength: SECRET_FINGERPRINT_KEY_LENGTH,
  };
}

/** Strict decoder for the only supported backup manifest format. */
export function parseDatabaseBackupManifest(
  value: unknown,
): PaperclipDatabaseBackupManifest {
  const record = assertRecord(value, "Database backup manifest");
  assertExactKeys(
    record,
    [
      "format",
      "formatVersion",
      "createdAt",
      "sourceDatabaseIdentity",
      "migrationJournal",
      "tableSet",
      "payload",
      "betterAuthSecretFingerprint",
    ],
    "Database backup manifest",
  );
  if (
    record.format !== PAPERCLIP_DATABASE_BACKUP_FORMAT ||
    record.formatVersion !== PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION
  ) {
    throw new Error("Database backup manifest format is unsupported.");
  }
  if (
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    new Date(record.createdAt).toISOString() !== record.createdAt
  ) {
    throw new Error("Database backup manifest createdAt is invalid.");
  }
  const payload = assertRecord(record.payload, "payload");
  assertExactKeys(payload, ["sha256", "sizeBytes"], "payload");
  if (
    !Number.isSafeInteger(payload.sizeBytes) ||
    (payload.sizeBytes as number) < 1
  ) {
    throw new Error("payload.sizeBytes must be a positive integer.");
  }
  return {
    format: PAPERCLIP_DATABASE_BACKUP_FORMAT,
    formatVersion: PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION,
    createdAt: record.createdAt,
    sourceDatabaseIdentity: parseVerifiedDatabaseIdentity(
      record.sourceDatabaseIdentity,
    ),
    migrationJournal: parseMigrationJournal(
      record.migrationJournal,
      "migrationJournal",
    ),
    tableSet: parseTableSet(record.tableSet),
    payload: {
      sha256: assertSha256(payload.sha256, "payload.sha256"),
      sizeBytes: payload.sizeBytes as number,
    },
    betterAuthSecretFingerprint: parseSecretFingerprint(
      record.betterAuthSecretFingerprint,
    ),
  };
}

function fingerprintSecret(
  secret: string,
  salt: Buffer = randomBytes(32),
): DatabaseBackupSecretFingerprint {
  assertNonEmpty(secret, "Better Auth secret");
  const digest = scryptSync(secret, salt, SECRET_FINGERPRINT_KEY_LENGTH, {
    N: SECRET_FINGERPRINT_COST,
    r: SECRET_FINGERPRINT_BLOCK_SIZE,
    p: SECRET_FINGERPRINT_PARALLELIZATION,
    maxmem: SECRET_FINGERPRINT_MAX_MEMORY,
  });
  return {
    algorithm: SECRET_FINGERPRINT_ALGORITHM,
    saltBase64Url: salt.toString("base64url"),
    digestBase64Url: digest.toString("base64url"),
    cost: SECRET_FINGERPRINT_COST,
    blockSize: SECRET_FINGERPRINT_BLOCK_SIZE,
    parallelization: SECRET_FINGERPRINT_PARALLELIZATION,
    keyLength: SECRET_FINGERPRINT_KEY_LENGTH,
  };
}

function verifySecretFingerprint(
  secret: string,
  fingerprint: DatabaseBackupSecretFingerprint,
): void {
  assertNonEmpty(secret, "Better Auth secret file");
  const salt = Buffer.from(fingerprint.saltBase64Url, "base64url");
  const expected = Buffer.from(fingerprint.digestBase64Url, "base64url");
  const actual = scryptSync(secret, salt, fingerprint.keyLength, {
    N: fingerprint.cost,
    r: fingerprint.blockSize,
    p: fingerprint.parallelization,
    maxmem: SECRET_FINGERPRINT_MAX_MEMORY,
  });
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error(
      "The Better Auth secret does not match this database backup.",
    );
  }
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

async function waitForSpawn(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdoutFile?: string;
    captureStdout?: boolean;
  } = {},
): Promise<SpawnResult> {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stdoutTooLarge = false;
  let stderrBytes = 0;

  child.stderr?.on("data", (raw: Buffer | string) => {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (stderrBytes >= MAX_COMMAND_OUTPUT_BYTES) return;
    stderrBytes += chunk.subarray(
      0,
      MAX_COMMAND_OUTPUT_BYTES - stderrBytes,
    ).length;
  });

  let outputPromise: Promise<void> = Promise.resolve();
  if (options.stdoutFile) {
    if (!child.stdout) {
      child.kill();
      throw new Error(`${basename(command)} did not expose backup output.`);
    }
    outputPromise = pipeline(
      child.stdout,
      createWriteStream(options.stdoutFile, {
        flags: "wx",
        mode: 0o600,
      }),
    );
  } else if (options.captureStdout) {
    child.stdout?.on("data", (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (stdoutBytes + chunk.length > MAX_COMMAND_OUTPUT_BYTES) {
        stdoutTooLarge = true;
        child.kill();
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
  } else {
    child.stdout?.resume();
  }

  const exitPromise = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rejectExit(
          new Error(
            `${basename(command)} is required for Paperclip database disaster recovery.`,
          ),
        );
        return;
      }
      rejectExit(
        new Error(`${basename(command)} could not be started.`, {
          cause: error,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      if (stdoutTooLarge) {
        rejectExit(
          new Error("PostgreSQL archive metadata exceeds the supported size."),
        );
        return;
      }
      if (signal || code !== 0) {
        rejectExit(
          new Error(
            `${basename(command)} failed${signal ? ` via ${signal}` : ` with exit code ${code ?? "unknown"}`}.`,
          ),
        );
        return;
      }
      resolveExit();
    });
  });

  try {
    await Promise.all([outputPromise, exitPromise]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  }
  return { stdout: Buffer.concat(stdoutChunks) };
}

function postgresClientEnvironment(connectionString: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGDATABASE: connectionString,
    PGCONNECT_TIMEOUT: String(DEFAULT_CONNECT_TIMEOUT_SECONDS),
  };
}

function postgresRestoreInvocation(connectionString: string): {
  connectionString: string;
  environment: NodeJS.ProcessEnv;
} {
  const parsed = new URL(connectionString);
  const environment = postgresClientEnvironment(connectionString);
  const password = parsed.searchParams.get("password") ??
    (parsed.password ? decodeURIComponent(parsed.password) : "");
  const sslPassword = parsed.searchParams.get("sslpassword");
  parsed.password = "";
  parsed.searchParams.delete("password");
  parsed.searchParams.delete("sslpassword");
  const sanitizedConnectionString = parsed.toString();
  environment.PGDATABASE = sanitizedConnectionString;
  if (password) environment.PGPASSWORD = password;
  if (sslPassword) environment.PGSSLPASSWORD = sslPassword;
  return { connectionString: sanitizedConnectionString, environment };
}

function pgDumpPath(): string {
  return process.env.PAPERCLIP_PG_DUMP_PATH?.trim() || "pg_dump";
}

function pgRestorePath(): string {
  return process.env.PAPERCLIP_PG_RESTORE_PATH?.trim() || "pg_restore";
}

async function createCompleteArchive(
  connectionString: string,
  outputFile: string,
): Promise<void> {
  await waitForSpawn(
    pgDumpPath(),
    ["--format=custom", "--no-owner", "--no-privileges", "--file=-"],
    {
      env: postgresClientEnvironment(connectionString),
      stdoutFile: outputFile,
    },
  );
}

async function readArchiveTableSet(backupFile: string): Promise<string[]> {
  const result = await waitForSpawn(
    pgRestorePath(),
    ["--list", backupFile],
    { captureStdout: true },
  );
  const tables = new Set<string>();
  for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
    const toc = line.match(/^\d+;\s+\d+\s+\d+\s+(.+)$/)?.[1];
    if (!toc || toc.startsWith("TABLE DATA ") || toc.startsWith("TABLE ATTACH ")) {
      continue;
    }
    const table = toc.match(/^TABLE\s+(\S+)\s+(\S+)\s+\S+(?:\s.*)?$/);
    if (table) tables.add(`${table[1]}.${table[2]}`);
  }
  return [...tables].sort((left, right) => left.localeCompare(right));
}

async function restoreCompleteArchive(
  connectionString: string,
  backupFile: string,
): Promise<void> {
  const invocation = postgresRestoreInvocation(connectionString);
  await waitForSpawn(
    pgRestorePath(),
    [
      "--dbname",
      invocation.connectionString,
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      backupFile,
    ],
    { env: invocation.environment },
  );
}

async function withUtilitySql<T>(
  connectionString: string,
  callback: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(connectionString, {
    max: 1,
    connect_timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS,
    onnotice: () => {},
  });
  try {
    return await callback(sql);
  } finally {
    await sql.end();
  }
}

async function readCanonicalTableSet(
  connectionString: string,
): Promise<string[]> {
  return withUtilitySql(connectionString, async (sql) => {
    const rows = await sql<TableDefinition[]>`
      SELECT
        table_schema AS "schemaName",
        table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema <> 'information_schema'
        AND table_schema NOT LIKE 'pg\_%' ESCAPE '\'
      ORDER BY table_schema, table_name
    `;
    return rows
      .map(({ schemaName, tableName }) => `${schemaName}.${tableName}`)
      .sort((left, right) => left.localeCompare(right));
  });
}

async function readDatabaseMigrationJournal(
  connectionString: string,
): Promise<DatabaseMigrationJournalEntry[]> {
  return withUtilitySql(connectionString, async (sql) => {
    let rows: MigrationJournalRow[];
    try {
      rows = await sql<MigrationJournalRow[]>`
        SELECT hash, created_at::text AS "createdAt"
        FROM "drizzle"."__drizzle_migrations"
        ORDER BY created_at, id
      `;
    } catch (error) {
      throw new Error("Database does not contain a readable Drizzle migration journal.", {
        cause: error,
      });
    }
    return parseMigrationJournal(rows, "Database migration journal");
  });
}

function readAvailableMigrationJournal(): DatabaseMigrationJournalEntry[] {
  const entries = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
    .map((migration) => ({
      hash: migration.hash,
      createdAt: String(migration.folderMillis),
    }));
  return parseMigrationJournal(entries, "Packaged migration journal");
}

function assertMigrationPrefix(
  prefix: readonly DatabaseMigrationJournalEntry[],
  available: readonly DatabaseMigrationJournalEntry[],
  label: string,
): void {
  if (
    prefix.length > available.length ||
    !prefix.every((entry, index) => {
      const expected = available[index];
      return expected?.hash === entry.hash && expected.createdAt === entry.createdAt;
    })
  ) {
    throw new Error(`${label} is not compatible with the packaged Drizzle migrations.`);
  }
}

async function applyStandardForwardMigrations(
  connectionString: string,
): Promise<void> {
  const sql = postgres(connectionString, {
    max: 1,
    connect_timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS,
    onnotice: () => {},
  });
  try {
    await migratePg(drizzlePg(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end();
  }
}

async function readBetterAuthSecretFile(filePath: string): Promise<string> {
  assertNonEmpty(filePath, "Better Auth secret file path");
  let secret: string;
  try {
    secret = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error("Unable to read the Better Auth secret file.", {
      cause: error,
    });
  }
  secret = secret.replace(/\r?\n$/, "");
  assertNonEmpty(secret, "Better Auth secret file");
  return secret;
}

async function readBackupManifest(
  manifestFile: string,
): Promise<PaperclipDatabaseBackupManifest> {
  assertNonEmpty(manifestFile, "Database backup manifest file path");
  let raw: string;
  try {
    raw = await readFile(manifestFile, "utf8");
  } catch (error) {
    throw new Error("Unable to read the database backup manifest.", {
      cause: error,
    });
  }
  try {
    return parseDatabaseBackupManifest(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Database backup manifest is not valid JSON.", {
        cause: error,
      });
    }
    throw error;
  }
}

async function assertBackupPayload(
  backupFile: string,
  manifest: PaperclipDatabaseBackupManifest,
): Promise<void> {
  assertNonEmpty(backupFile, "Database backup payload file path");
  let payloadStat: Awaited<ReturnType<typeof stat>>;
  try {
    payloadStat = await stat(backupFile);
  } catch (error) {
    throw new Error("Unable to read the database backup payload.", {
      cause: error,
    });
  }
  if (!payloadStat.isFile() || payloadStat.size !== manifest.payload.sizeBytes) {
    throw new Error("Database backup payload size does not match its manifest.");
  }
  if (await sha256File(backupFile) !== manifest.payload.sha256) {
    throw new Error("Database backup payload checksum does not match its manifest.");
  }
  if (!arraysEqual(await readArchiveTableSet(backupFile), manifest.tableSet)) {
    throw new Error("Database backup archive table set does not match its manifest.");
  }
}

type BackupEntry = {
  payloadFile: string;
  manifestFile: string;
  mtimeMs: number;
};

async function listCompleteBackups(
  backupDir: string,
  filenamePrefix: string,
): Promise<BackupEntry[]> {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch {
    return [];
  }
  const nameSet = new Set(names);
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(`${filenamePrefix}-`) || !name.endsWith(PAYLOAD_SUFFIX)) {
      continue;
    }
    const manifestName = `${name}${MANIFEST_SUFFIX}`;
    if (!nameSet.has(manifestName)) continue;
    const payloadFile = resolve(backupDir, name);
    const payloadStat = await stat(payloadFile);
    if (!payloadStat.isFile()) continue;
    entries.push({
      payloadFile,
      manifestFile: resolve(backupDir, manifestName),
      mtimeMs: payloadStat.mtimeMs,
    });
  }
  return entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function pruneOldBackups(
  backupDir: string,
  retention: BackupRetentionPolicy,
  filenamePrefix: string,
): Promise<number> {
  const now = Date.now();
  const dailyCutoff = now - retention.dailyDays * 24 * 60 * 60 * 1000;
  const weeklyCutoff = now - retention.weeklyWeeks * 7 * 24 * 60 * 60 * 1000;
  const monthlyCutoff = now - retention.monthlyMonths * 30 * 24 * 60 * 60 * 1000;
  const keepWeeks = new Set<string>();
  const keepMonths = new Set<string>();
  const toDelete: BackupEntry[] = [];

  for (const entry of await listCompleteBackups(backupDir, filenamePrefix)) {
    if (entry.mtimeMs >= dailyCutoff) continue;
    const date = new Date(entry.mtimeMs);
    const week = isoWeekKey(date);
    const month = monthKey(date);
    if (entry.mtimeMs >= weeklyCutoff) {
      if (keepWeeks.has(week)) toDelete.push(entry);
      else keepWeeks.add(week);
      continue;
    }
    if (entry.mtimeMs >= monthlyCutoff) {
      if (keepMonths.has(month)) toDelete.push(entry);
      else keepMonths.add(month);
      continue;
    }
    toDelete.push(entry);
  }

  for (const entry of toDelete) {
    await Promise.all([
      rm(entry.payloadFile, { force: true }),
      rm(entry.manifestFile, { force: true }),
    ]);
  }
  return toDelete.length;
}

export async function runDatabaseBackup(
  opts: RunDatabaseBackupOptions,
): Promise<RunDatabaseBackupResult> {
  assertRuntimeOptionKeys(
    opts,
    ["connectionString", "betterAuthSecret", "backupDir", "retention", "filenamePrefix"],
    "RunDatabaseBackupOptions",
  );
  const connectionString = validateExternalPostgresConnectionString(
    opts.connectionString,
    "Database backup connection string",
  );
  assertNonEmpty(opts.betterAuthSecret, "Better Auth secret");
  assertNonEmpty(opts.backupDir, "Database backup directory");
  const retention = normalizeRetentionPolicy(opts.retention);
  const filenamePrefix = validateFilenamePrefix(opts.filenamePrefix ?? "paperclip");
  await mkdir(opts.backupDir, { recursive: true, mode: 0o700 });

  const sourceIdentity = await probeDatabaseIdentity(connectionString);
  const availableMigrations = readAvailableMigrationJournal();
  const beforeJournal = await readDatabaseMigrationJournal(connectionString);
  assertMigrationPrefix(beforeJournal, availableMigrations, "Database backup source migration journal");
  const beforeTables = await readCanonicalTableSet(connectionString);
  if (!beforeTables.includes(REQUIRED_MIGRATION_JOURNAL_TABLE)) {
    throw new Error("Database backup source is missing the Drizzle migration journal.");
  }

  const uniqueName = `${filenamePrefix}-${timestamp()}-${randomBytes(4).toString("hex")}`;
  const backupFile = resolve(opts.backupDir, `${uniqueName}${PAYLOAD_SUFFIX}`);
  const manifestFile = `${backupFile}${MANIFEST_SUFFIX}`;
  const temporaryBackupFile = `${backupFile}.partial`;
  const temporaryManifestFile = `${manifestFile}.partial`;
  let payloadPublished = false;
  let manifestPublished = false;

  try {
    await revalidateDatabaseIdentity(connectionString, sourceIdentity, "Database backup source");
    await createCompleteArchive(connectionString, temporaryBackupFile);

    const afterJournal = await readDatabaseMigrationJournal(connectionString);
    const afterTables = await readCanonicalTableSet(connectionString);
    const archiveTables = await readArchiveTableSet(temporaryBackupFile);
    if (!journalEntriesEqual(beforeJournal, afterJournal)) {
      throw new Error("Database migration journal changed while the backup snapshot was being created.");
    }
    if (
      !arraysEqual(beforeTables, afterTables) ||
      !arraysEqual(afterTables, archiveTables)
    ) {
      throw new Error("Database schema changed while the backup snapshot was being created.");
    }

    const payloadStat = await stat(temporaryBackupFile);
    const payloadChecksum = await sha256File(temporaryBackupFile);
    const manifest: PaperclipDatabaseBackupManifest = {
      format: PAPERCLIP_DATABASE_BACKUP_FORMAT,
      formatVersion: PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      sourceDatabaseIdentity: sourceIdentity,
      migrationJournal: [...afterJournal],
      tableSet: archiveTables,
      payload: { sha256: payloadChecksum, sizeBytes: payloadStat.size },
      betterAuthSecretFingerprint: fingerprintSecret(opts.betterAuthSecret),
    };
    await writeFile(
      temporaryManifestFile,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    await rename(temporaryBackupFile, backupFile);
    payloadPublished = true;
    await rename(temporaryManifestFile, manifestFile);
    manifestPublished = true;
    const prunedCount = await pruneOldBackups(opts.backupDir, retention, filenamePrefix);

    return {
      backupFile,
      manifestFile,
      manifestFormat: PAPERCLIP_DATABASE_BACKUP_FORMAT,
      manifestFormatVersion: PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION,
      payloadChecksum,
      sourceDatabaseIdentity: sourceIdentity,
      migrationJournal: [...afterJournal],
      tableSet: archiveTables,
      sizeBytes: payloadStat.size,
      prunedCount,
    };
  } catch (error) {
    await Promise.all([
      rm(temporaryBackupFile, { force: true }),
      rm(temporaryManifestFile, { force: true }),
      payloadPublished && !manifestPublished
        ? rm(backupFile, { force: true })
        : Promise.resolve(),
    ]);
    throw error;
  }
}

export async function runDatabaseRestore(
  opts: RunDatabaseRestoreOptions,
): Promise<RunDatabaseRestoreResult> {
  assertRuntimeOptionKeys(
    opts,
    ["connectionString", "backupFile", "manifestFile", "betterAuthSecretFile"],
    "RunDatabaseRestoreOptions",
  );
  const connectionString = validateExternalPostgresConnectionString(
    opts.connectionString,
    "Restore database connection string",
  );
  assertNonEmpty(opts.backupFile, "Database backup payload file path");
  assertNonEmpty(opts.manifestFile, "Database backup manifest file path");
  assertNonEmpty(opts.betterAuthSecretFile, "Better Auth secret file path");

  // Validate the immutable inputs before the first target query.
  const manifest = await readBackupManifest(opts.manifestFile);
  const availableMigrations = readAvailableMigrationJournal();
  assertMigrationPrefix(manifest.migrationJournal, availableMigrations, "Database backup migration journal");
  await assertBackupPayload(opts.backupFile, manifest);
  verifySecretFingerprint(
    await readBetterAuthSecretFile(opts.betterAuthSecretFile),
    manifest.betterAuthSecretFingerprint,
  );

  const targetIdentity = await probeDatabaseIdentity(connectionString);
  assertDistinctDatabaseIdentities(
    manifest.sourceDatabaseIdentity,
    targetIdentity,
    "Database backup source and restore target",
  );
  if ((await readCanonicalTableSet(connectionString)).length !== 0) {
    throw new Error("Database restore target must be a physically distinct empty database.");
  }

  await revalidateDatabaseIdentity(connectionString, targetIdentity, "Database restore target");
  if ((await readCanonicalTableSet(connectionString)).length !== 0) {
    throw new Error("Database restore target changed before restore and is no longer empty.");
  }

  await restoreCompleteArchive(connectionString, opts.backupFile);
  await revalidateDatabaseIdentity(connectionString, targetIdentity, "Database restore target");
  const restoredTables = await readCanonicalTableSet(connectionString);
  if (!arraysEqual(restoredTables, manifest.tableSet)) {
    throw new Error("Restored database table set does not match the verified backup manifest.");
  }
  const restoredJournal = await readDatabaseMigrationJournal(connectionString);
  if (!journalEntriesEqual(restoredJournal, manifest.migrationJournal)) {
    throw new Error("Restored database migration journal does not match the verified backup manifest.");
  }

  if (availableMigrations.length > restoredJournal.length) {
    await applyStandardForwardMigrations(connectionString);
  }
  const finalJournal = await readDatabaseMigrationJournal(connectionString);
  if (!journalEntriesEqual(finalJournal, availableMigrations)) {
    throw new Error("Restored database failed final Drizzle migration verification.");
  }

  return {
    manifestFormat: PAPERCLIP_DATABASE_BACKUP_FORMAT,
    manifestFormatVersion: PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION,
    payloadChecksum: manifest.payload.sha256,
    sourceDatabaseIdentity: manifest.sourceDatabaseIdentity,
    targetDatabaseIdentity: targetIdentity,
    restoredMigrationJournal: [...restoredJournal],
    appliedForwardMigrations: finalJournal.slice(restoredJournal.length),
    finalMigrationJournal: [...finalJournal],
  };
}

export function formatDatabaseBackupResult(
  result: RunDatabaseBackupResult,
): string {
  const size = formatBackupSize(result.sizeBytes);
  const pruned = result.prunedCount > 0
    ? `; pruned ${result.prunedCount} old complete backup(s)`
    : "";
  return `${result.backupFile} + ${result.manifestFile} (${size}${pruned})`;
}
