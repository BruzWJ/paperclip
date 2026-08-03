import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(url: string) {
  const sql = postgres(url);
  return drizzlePg(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;

export {
  assertDistinctDatabaseIdentities,
  assertSameDatabaseIdentity,
  databaseIdentitiesEqual,
  probeDatabaseIdentity,
  revalidateDatabaseIdentity,
  type VerifiedDatabaseIdentity,
} from "./database-identity.js";
export {
  parseExternalPostgresDatabaseTarget,
  redactExternalPostgresConnectionString,
  resolveDatabaseTarget,
  resolveOptionalExternalPostgresConnectionString,
  validateExternalPostgresConnectionString,
  type ExternalDatabaseTargetSource,
  type ParsedExternalPostgresDatabaseTarget,
  type ResolvedDatabaseTarget,
  type ResolveDatabaseTargetOptions,
} from "./runtime-config.js";
export {
  PAPERCLIP_DATABASE_BACKUP_FORMAT,
  PAPERCLIP_DATABASE_BACKUP_FORMAT_VERSION,
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  parseDatabaseBackupManifest,
  type BackupRetentionPolicy,
  type DatabaseMigrationJournalEntry,
  type DatabaseBackupSecretFingerprint,
  type PaperclipDatabaseBackupManifest,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
  type RunDatabaseRestoreResult,
} from "./backup-lib.js";
export * from "./schema.js";
