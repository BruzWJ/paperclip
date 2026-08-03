import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedDatabaseIdentity } from "../database-identity.js";
import type { DatabaseMigrationJournalEntry } from "../backup-lib.js";

const mocks = vi.hoisted(() => ({
  assertDistinctDatabaseIdentities: vi.fn(),
  probeDatabaseIdentity: vi.fn(),
  revalidateDatabaseIdentity: vi.fn(),
  postgres: vi.fn(),
  drizzle: vi.fn(() => ({ kind: "mock-drizzle-database" })),
  migrate: vi.fn(),
  readMigrationFiles: vi.fn(),
  tableSets: [] as string[][],
  journals: [] as DatabaseMigrationJournalEntry[][],
}));

vi.mock("../database-identity.js", () => ({
  assertDistinctDatabaseIdentities: mocks.assertDistinctDatabaseIdentities,
  probeDatabaseIdentity: mocks.probeDatabaseIdentity,
  revalidateDatabaseIdentity: mocks.revalidateDatabaseIdentity,
}));

vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/migrator", () => ({
  readMigrationFiles: mocks.readMigrationFiles,
}));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzle }));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({
  migrate: mocks.migrate,
}));

import {
  PAPERCLIP_DATABASE_BACKUP_FORMAT,
  PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION,
  parseDatabaseBackupManifest,
  runDatabaseBackup,
  runDatabaseRestore,
} from "../backup-lib.js";

const FIRST_MIGRATION: DatabaseMigrationJournalEntry = {
  hash: "a".repeat(64),
  createdAt: "1785696329157",
};
const FORWARD_MIGRATION: DatabaseMigrationJournalEntry = {
  hash: "b".repeat(64),
  createdAt: "1785696429157",
};
const SOURCE_IDENTITY: VerifiedDatabaseIdentity = Object.freeze({
  clusterSystemIdentifier: "7312345678901234567",
  databaseOid: "16384",
  databaseName: "paperclip_source",
});
const TARGET_IDENTITY: VerifiedDatabaseIdentity = Object.freeze({
  clusterSystemIdentifier: "7312345678901234567",
  databaseOid: "16385",
  databaseName: "paperclip_restore",
});
const TABLE_SET = [
  "drizzle.__drizzle_migrations",
  "public.user",
];
const cleanups: Array<() => void> = [];

function createTempDir(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "paperclip-backup-contract-"),
  );
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o700 });
}

function installPostgresTools(
  directory: string,
  tableSet: readonly string[] = TABLE_SET,
): { dumpLog: string; restoreLog: string } {
  // These are inert test-owned stream fixtures. The suite never resolves or
  // invokes an installed PostgreSQL executable or database service.
  const dumpPath = path.join(directory, "paperclip-dump-fixture");
  const restorePath = path.join(directory, "paperclip-restore-fixture");
  const dumpLog = path.join(directory, "dump.log");
  const restoreLog = path.join(directory, "restore.log");
  writeExecutable(
    dumpPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$@" > "$PAPERCLIP_TEST_DUMP_LOG"',
      "printf 'paperclip-custom-archive-v2'",
      "",
    ].join("\n"),
  );
  const toc = tableSet.map((qualifiedName, index) => {
    const [schemaName, tableName] = qualifiedName.split(".");
    return `${index + 1}; 1259 ${16_384 + index} TABLE ${schemaName} ${tableName} paperclip`;
  });
  writeExecutable(
    restorePath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--list" ]]; then',
      ...toc.map((line) => `  printf '%s\\n' '${line}'`),
      "  exit 0",
      "fi",
      'printf "%s\\n" "$@" > "$PAPERCLIP_TEST_RESTORE_LOG"',
      "",
    ].join("\n"),
  );
  process.env.PAPERCLIP_PG_DUMP_PATH = dumpPath;
  process.env.PAPERCLIP_PG_RESTORE_PATH = restorePath;
  process.env.PAPERCLIP_TEST_DUMP_LOG = dumpLog;
  process.env.PAPERCLIP_TEST_RESTORE_LOG = restoreLog;
  return { dumpLog, restoreLog };
}

function migrationMeta(entry: DatabaseMigrationJournalEntry) {
  return {
    sql: ["select 1"],
    folderMillis: Number(entry.createdAt),
    hash: entry.hash,
    bps: true,
  };
}

function installPostgresMock(): void {
  mocks.postgres.mockImplementation(() => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("information_schema.tables")) {
        const tableSet = mocks.tableSets.shift();
        if (!tableSet) throw new Error("Missing table-set fixture");
        return tableSet.map((qualifiedName) => {
          const [schemaName, tableName] = qualifiedName.split(".");
          return { schemaName, tableName };
        });
      }
      if (query.includes("__drizzle_migrations")) {
        const journal = mocks.journals.shift();
        if (!journal) throw new Error("Missing migration-journal fixture");
        return journal.map((entry) => ({ ...entry }));
      }
      throw new Error(`Unexpected mocked database query: ${query}`);
    }) as unknown as {
      (strings: TemplateStringsArray): Promise<unknown[]>;
      end: () => Promise<void>;
    };
    sql.end = vi.fn(async () => {});
    return sql;
  });
}

function queueBackupDatabaseState(
  journal: readonly DatabaseMigrationJournalEntry[] = [FIRST_MIGRATION],
): void {
  mocks.journals.push([...journal], [...journal]);
  mocks.tableSets.push([...TABLE_SET], [...TABLE_SET]);
}

function queueRestoreDatabaseState(input: {
  restored?: readonly DatabaseMigrationJournalEntry[];
  final?: readonly DatabaseMigrationJournalEntry[];
  firstTargetTables?: readonly string[];
} = {}): void {
  const restored = input.restored ?? [FIRST_MIGRATION];
  const final = input.final ?? [FIRST_MIGRATION, FORWARD_MIGRATION];
  mocks.tableSets.push(
    [...(input.firstTargetTables ?? [])],
    [],
    [...TABLE_SET],
  );
  mocks.journals.push([...restored], [...final]);
}

async function createBackupFixture(directory: string) {
  const tools = installPostgresTools(directory);
  mocks.probeDatabaseIdentity.mockResolvedValue(SOURCE_IDENTITY);
  mocks.revalidateDatabaseIdentity.mockResolvedValue(SOURCE_IDENTITY);
  queueBackupDatabaseState();
  const result = await runDatabaseBackup({
    connectionString: "postgres://source.example/paperclip",
    betterAuthSecret: "durable-deployment-secret",
    backupDir: directory,
    retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 12 },
    filenamePrefix: "paperclip-test",
  });
  return {
    ...tools,
    result,
    manifest: JSON.parse(
      fs.readFileSync(result.manifestFile, "utf8"),
    ) as Record<string, unknown>,
  };
}

function resetCallsAfterBackup(): void {
  mocks.probeDatabaseIdentity.mockReset();
  mocks.revalidateDatabaseIdentity.mockReset();
  mocks.assertDistinctDatabaseIdentities.mockClear();
  mocks.postgres.mockClear();
  mocks.drizzle.mockClear();
  mocks.migrate.mockClear();
  mocks.tableSets.length = 0;
  mocks.journals.length = 0;
  installPostgresMock();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tableSets.length = 0;
  mocks.journals.length = 0;
  mocks.readMigrationFiles.mockReturnValue([
    migrationMeta(FIRST_MIGRATION),
    migrationMeta(FORWARD_MIGRATION),
  ]);
  mocks.assertDistinctDatabaseIdentities.mockImplementation(
    (left: VerifiedDatabaseIdentity, right: VerifiedDatabaseIdentity) => {
      if (
        left.clusterSystemIdentifier === right.clusterSystemIdentifier &&
        left.databaseOid === right.databaseOid &&
        left.databaseName === right.databaseName
      ) {
        throw new Error("Database targets resolve to the same physical database.");
      }
    },
  );
  installPostgresMock();
});

afterEach(() => {
  delete process.env.PAPERCLIP_PG_DUMP_PATH;
  delete process.env.PAPERCLIP_PG_RESTORE_PATH;
  delete process.env.PAPERCLIP_TEST_DUMP_LOG;
  delete process.env.PAPERCLIP_TEST_RESTORE_LOG;
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("runDatabaseBackup", () => {
  it("writes one complete payload and one strict journal-backed manifest", async () => {
    const directory = createTempDir();
    const { dumpLog, result, manifest } = await createBackupFixture(directory);

    expect(result.backupFile).toMatch(/\.dump$/);
    expect(result.manifestFile).toBe(`${result.backupFile}.manifest.json`);
    expect(fs.statSync(result.backupFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(result.manifestFile).mode & 0o777).toBe(0o600);
    expect(manifest).toMatchObject({
      format: PAPERCLIP_DATABASE_BACKUP_FORMAT,
      formatVersion: PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION,
      sourceDatabaseIdentity: SOURCE_IDENTITY,
      migrationJournal: [FIRST_MIGRATION],
      tableSet: TABLE_SET,
      payload: {
        sha256: result.payloadChecksum,
        sizeBytes: result.sizeBytes,
      },
      betterAuthSecretFingerprint: { algorithm: "scrypt-sha256-v1" },
    });
    expect(JSON.stringify(manifest)).not.toContain("durable-deployment-secret");
    expect(fs.readFileSync(dumpLog, "utf8").trim().split("\n")).toEqual([
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--file=-",
    ]);
  });

  it("rejects a migration journal that is not a packaged prefix", async () => {
    const directory = createTempDir();
    const { dumpLog } = installPostgresTools(directory);
    mocks.probeDatabaseIdentity.mockResolvedValue(SOURCE_IDENTITY);
    mocks.journals.push([{ hash: "f".repeat(64), createdAt: "1" }]);

    await expect(
      runDatabaseBackup({
        connectionString: "postgres://source.example/paperclip",
        betterAuthSecret: "durable-deployment-secret",
        backupDir: directory,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 12 },
      }),
    ).rejects.toThrow("not compatible");
    expect(fs.existsSync(dumpLog)).toBe(false);
  });

  it("rejects a migration that lands while the snapshot is created", async () => {
    const directory = createTempDir();
    installPostgresTools(directory);
    mocks.probeDatabaseIdentity.mockResolvedValue(SOURCE_IDENTITY);
    mocks.revalidateDatabaseIdentity.mockResolvedValue(SOURCE_IDENTITY);
    mocks.journals.push(
      [FIRST_MIGRATION],
      [FIRST_MIGRATION, FORWARD_MIGRATION],
    );
    mocks.tableSets.push([...TABLE_SET], [...TABLE_SET]);

    await expect(
      runDatabaseBackup({
        connectionString: "postgres://source.example/paperclip",
        betterAuthSecret: "durable-deployment-secret",
        backupDir: directory,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 12 },
      }),
    ).rejects.toThrow("journal changed");
  });
});

describe("database backup manifest", () => {
  it("rejects unknown manifest fields", async () => {
    const directory = createTempDir();
    const { manifest } = await createBackupFixture(directory);

    expect(() =>
      parseDatabaseBackupManifest({
        ...manifest,
        unexpectedField: "unsupported",
      })
    ).toThrow("unsupported shape");
  });

  it("requires the standard Drizzle migration journal in the archive", async () => {
    const directory = createTempDir();
    const { manifest } = await createBackupFixture(directory);

    expect(() =>
      parseDatabaseBackupManifest({
        ...manifest,
        tableSet: ["public.user"],
      })
    ).toThrow("Drizzle migration journal");
  });
});

describe("runDatabaseRestore", () => {
  it("rejects loose options before reading files or probing a target", async () => {
    await expect(
      runDatabaseRestore({
        connectionString: "postgres://target.example/paperclip",
        backupFile: "/tmp/backup.dump",
        manifestFile: "/tmp/backup.manifest.json",
        betterAuthSecretFile: "/tmp/better-auth-secret",
        rawSql: true,
      } as Parameters<typeof runDatabaseRestore>[0]),
    ).rejects.toThrow("unsupported option");
    expect(mocks.probeDatabaseIdentity).not.toHaveBeenCalled();
  });

  it("restores once and applies only standard forward migrations", async () => {
    const directory = createTempDir();
    const { result } = await createBackupFixture(directory);
    const { restoreLog } = installPostgresTools(directory);
    const secretFile = path.join(directory, "better-auth-secret");
    fs.writeFileSync(secretFile, "durable-deployment-secret\n", { mode: 0o600 });
    resetCallsAfterBackup();
    mocks.probeDatabaseIdentity.mockResolvedValue(TARGET_IDENTITY);
    mocks.revalidateDatabaseIdentity.mockResolvedValue(TARGET_IDENTITY);
    queueRestoreDatabaseState();

    const restored = await runDatabaseRestore({
      connectionString: "postgres://target-user:target-password@target.example/paperclip",
      backupFile: result.backupFile,
      manifestFile: result.manifestFile,
      betterAuthSecretFile: secretFile,
    });

    expect(fs.readFileSync(restoreLog, "utf8").trim().split("\n")).toEqual([
      "--dbname",
      "postgres://target-user@target.example/paperclip",
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      result.backupFile,
    ]);
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(restored).toEqual({
      manifestFormat: PAPERCLIP_DATABASE_BACKUP_FORMAT,
      manifestFormatVersion: PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION,
      payloadChecksum: result.payloadChecksum,
      sourceDatabaseIdentity: SOURCE_IDENTITY,
      targetDatabaseIdentity: TARGET_IDENTITY,
      restoredMigrationJournal: [FIRST_MIGRATION],
      appliedForwardMigrations: [FORWARD_MIGRATION],
      finalMigrationJournal: [FIRST_MIGRATION, FORWARD_MIGRATION],
    });
    const serialized = JSON.stringify(restored);
    expect(serialized).not.toContain("target-password");
    expect(serialized).not.toContain("durable-deployment-secret");
    expect(serialized).not.toContain("postgres://");
  });

  it("does not invoke the migrator when the restored journal is current", async () => {
    const directory = createTempDir();
    mocks.readMigrationFiles.mockReturnValue([migrationMeta(FIRST_MIGRATION)]);
    const { result } = await createBackupFixture(directory);
    installPostgresTools(directory);
    const secretFile = path.join(directory, "better-auth-secret");
    fs.writeFileSync(secretFile, "durable-deployment-secret\n", { mode: 0o600 });
    resetCallsAfterBackup();
    mocks.probeDatabaseIdentity.mockResolvedValue(TARGET_IDENTITY);
    mocks.revalidateDatabaseIdentity.mockResolvedValue(TARGET_IDENTITY);
    queueRestoreDatabaseState({
      restored: [FIRST_MIGRATION],
      final: [FIRST_MIGRATION],
    });

    await runDatabaseRestore({
      connectionString: "postgres://target.example/paperclip",
      backupFile: result.backupFile,
      manifestFile: result.manifestFile,
      betterAuthSecretFile: secretFile,
    });

    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret before probing or mutating the target", async () => {
    const directory = createTempDir();
    const { result } = await createBackupFixture(directory);
    const { restoreLog } = installPostgresTools(directory);
    const secretFile = path.join(directory, "wrong-secret");
    fs.writeFileSync(secretFile, "not-the-deployment-secret\n");
    resetCallsAfterBackup();

    await expect(
      runDatabaseRestore({
        connectionString: "postgres://target.example/paperclip",
        backupFile: result.backupFile,
        manifestFile: result.manifestFile,
        betterAuthSecretFile: secretFile,
      }),
    ).rejects.toThrow("does not match");
    expect(mocks.probeDatabaseIdentity).not.toHaveBeenCalled();
    expect(fs.existsSync(restoreLog)).toBe(false);
  });

  it("rejects an edited payload before probing or mutating the target", async () => {
    const directory = createTempDir();
    const { result } = await createBackupFixture(directory);
    const { restoreLog } = installPostgresTools(directory);
    const secretFile = path.join(directory, "better-auth-secret");
    fs.writeFileSync(secretFile, "durable-deployment-secret\n");
    const payload = fs.readFileSync(result.backupFile);
    payload[0] = payload[0] === 0x70 ? 0x71 : 0x70;
    fs.writeFileSync(result.backupFile, payload);
    resetCallsAfterBackup();

    await expect(
      runDatabaseRestore({
        connectionString: "postgres://target.example/paperclip",
        backupFile: result.backupFile,
        manifestFile: result.manifestFile,
        betterAuthSecretFile: secretFile,
      }),
    ).rejects.toThrow("checksum");
    expect(mocks.probeDatabaseIdentity).not.toHaveBeenCalled();
    expect(fs.existsSync(restoreLog)).toBe(false);
  });

  it("rejects an incompatible migration journal before probing the target", async () => {
    const directory = createTempDir();
    const { result, manifest } = await createBackupFixture(directory);
    const { restoreLog } = installPostgresTools(directory);
    const secretFile = path.join(directory, "better-auth-secret");
    fs.writeFileSync(secretFile, "durable-deployment-secret\n");
    fs.writeFileSync(
      result.manifestFile,
      `${JSON.stringify({
        ...manifest,
        migrationJournal: [{ hash: "f".repeat(64), createdAt: "1" }],
      })}\n`,
    );
    resetCallsAfterBackup();

    await expect(
      runDatabaseRestore({
        connectionString: "postgres://target.example/paperclip",
        backupFile: result.backupFile,
        manifestFile: result.manifestFile,
        betterAuthSecretFile: secretFile,
      }),
    ).rejects.toThrow("not compatible");
    expect(mocks.probeDatabaseIdentity).not.toHaveBeenCalled();
    expect(fs.existsSync(restoreLog)).toBe(false);
  });

  it("rejects an archive table-set mismatch before probing the target", async () => {
    const directory = createTempDir();
    const { result } = await createBackupFixture(directory);
    const { restoreLog } = installPostgresTools(directory, [
      "drizzle.__drizzle_migrations",
    ]);
    const secretFile = path.join(directory, "better-auth-secret");
    fs.writeFileSync(secretFile, "durable-deployment-secret\n");
    resetCallsAfterBackup();

    await expect(
      runDatabaseRestore({
        connectionString: "postgres://target.example/paperclip",
        backupFile: result.backupFile,
        manifestFile: result.manifestFile,
        betterAuthSecretFile: secretFile,
      }),
    ).rejects.toThrow("table set");
    expect(mocks.probeDatabaseIdentity).not.toHaveBeenCalled();
    expect(fs.existsSync(restoreLog)).toBe(false);
  });

  it("rejects the source physical database as the restore target", async () => {
    const directory = createTempDir();
    const { result } = await createBackupFixture(directory);
    const { restoreLog } = installPostgresTools(directory);
    const secretFile = path.join(directory, "better-auth-secret");
    fs.writeFileSync(secretFile, "durable-deployment-secret\n");
    resetCallsAfterBackup();
    mocks.probeDatabaseIdentity.mockResolvedValue(SOURCE_IDENTITY);

    await expect(
      runDatabaseRestore({
        connectionString: "postgres://source-alias.example/paperclip",
        backupFile: result.backupFile,
        manifestFile: result.manifestFile,
        betterAuthSecretFile: secretFile,
      }),
    ).rejects.toThrow("same physical database");
    expect(mocks.tableSets).toHaveLength(0);
    expect(fs.existsSync(restoreLog)).toBe(false);
  });

  it("rejects a nonempty target without clearing it", async () => {
    const directory = createTempDir();
    const { result } = await createBackupFixture(directory);
    const { restoreLog } = installPostgresTools(directory);
    const secretFile = path.join(directory, "better-auth-secret");
    fs.writeFileSync(secretFile, "durable-deployment-secret\n");
    resetCallsAfterBackup();
    mocks.probeDatabaseIdentity.mockResolvedValue(TARGET_IDENTITY);
    mocks.tableSets.push(["public.existing_table"]);

    await expect(
      runDatabaseRestore({
        connectionString: "postgres://target.example/paperclip",
        backupFile: result.backupFile,
        manifestFile: result.manifestFile,
        betterAuthSecretFile: secretFile,
      }),
    ).rejects.toThrow("distinct empty database");
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(fs.existsSync(restoreLog)).toBe(false);
  });
});
