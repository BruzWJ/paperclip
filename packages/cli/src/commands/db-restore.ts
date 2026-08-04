import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  runDatabaseRestore,
  validateExternalPostgresConnectionString,
  type RunDatabaseRestoreResult,
  type VerifiedDatabaseIdentity,
  type DatabaseMigrationJournalEntry,
} from "@paperclipai/db";
import { printPaperclipCliBanner } from "../utils/banner.js";

export type DbRestoreOptions = {
  databaseUrl: string;
  backupFile: string;
  manifestFile: string;
  betterAuthSecretFile: string;
  json?: boolean;
};

function identityLabel(identity: VerifiedDatabaseIdentity): string {
  return `${JSON.stringify(identity.databaseName)} (cluster ${identity.clusterSystemIdentifier}, database OID ${identity.databaseOid})`;
}

function explicitFilePath(value: string, option: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${option} requires an explicit file path.`);
  }
  return path.resolve(value);
}

function migrationJournalLabel(
  entries: DatabaseMigrationJournalEntry[],
): string {
  if (entries.length === 0) return "none";
  return entries
    .map((entry) => `${entry.hash} (${entry.createdAt})`)
    .join(", ");
}

function printHumanResult(result: RunDatabaseRestoreResult): void {
  p.log.success("Database disaster-recovery restore completed.");
  p.log.message(
    `Manifest: ${result.manifestFormat} v${result.manifestFormatVersion}`,
  );
  p.log.message(`Payload SHA-256: ${result.payloadChecksum}`);
  p.log.message(
    `Verified source: ${identityLabel(result.sourceDatabaseIdentity)}`,
  );
  p.log.message(
    `Verified target: ${identityLabel(result.targetDatabaseIdentity)}`,
  );
  p.log.message(
    `Restored migration journal: ${migrationJournalLabel(result.restoredMigrationJournal)}`,
  );
  p.log.message(
    result.appliedForwardMigrations.length > 0
      ? `Applied forward migrations: ${migrationJournalLabel(result.appliedForwardMigrations)}`
      : "Applied forward migrations: none",
  );
  p.outro(
    pc.green(
      `Final migration journal: ${migrationJournalLabel(result.finalMigrationJournal)}`,
    ),
  );
}

export async function dbRestoreCommand(
  opts: DbRestoreOptions,
): Promise<void> {
  const connectionString = validateExternalPostgresConnectionString(
    opts.databaseUrl,
    "--database-url",
  );
  const backupFile = explicitFilePath(opts.backupFile, "--backup-file");
  const manifestFile = explicitFilePath(
    opts.manifestFile,
    "--manifest-file",
  );
  const betterAuthSecretFile = explicitFilePath(
    opts.betterAuthSecretFile,
    "--better-auth-secret-file",
  );

  if (!opts.json) {
    printPaperclipCliBanner();
    p.intro(pc.bgCyan(pc.black(" paperclip db:restore ")));
    p.log.message(
      "Validating the complete backup and the physically distinct empty target...",
    );
  }

  const result = await runDatabaseRestore({
    connectionString,
    backupFile,
    manifestFile,
    betterAuthSecretFile,
  });

  if (opts.json) {
    // The library result is intentionally the whole JSON contract: no URL,
    // credential, secret bytes, config provenance, or incidental CLI fields.
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHumanResult(result);
}
