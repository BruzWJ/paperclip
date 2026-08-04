import * as p from "@clack/prompts";
import { validateExternalPostgresConnectionString } from "@paperclipai/db";
import type { DatabaseConfig } from "../config/schema.js";
import {
  resolveDefaultBackupDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

export async function promptDatabase(current?: DatabaseConfig): Promise<DatabaseConfig> {
  const instanceId = resolvePaperclipInstanceId();
  const defaultBackupDir = resolveDefaultBackupDir(instanceId);
  const base: DatabaseConfig = current ?? {
    backup: {
      enabled: true,
      intervalMinutes: 60,
      retentionDays: 30,
      dir: defaultBackupDir,
    },
  };

  const value = await p.text({
    message: "External PostgreSQL connection string",
    defaultValue: base.connectionString ?? process.env.DATABASE_URL ?? "",
    placeholder: "postgresql://user:password@database.example.com:5432/paperclip",
    validate: (candidate) => {
      if (!candidate?.trim()) return "An external PostgreSQL connection string is required";
      try {
        validateExternalPostgresConnectionString(candidate, "Database URL");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return undefined;
    },
  });

  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const backupEnabled = await p.confirm({
    message: "Enable automatic database backups?",
    initialValue: base.backup.enabled,
  });
  if (p.isCancel(backupEnabled)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const backupDirInput = await p.text({
    message: "Backup directory",
    defaultValue: base.backup.dir || defaultBackupDir,
    placeholder: defaultBackupDir,
    validate: (val) => (!val || val.trim().length === 0 ? "Backup directory is required" : undefined),
  });
  if (p.isCancel(backupDirInput)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const backupIntervalInput = await p.text({
    message: "Backup interval (minutes)",
    defaultValue: String(base.backup.intervalMinutes || 60),
    placeholder: "60",
    validate: (val) => {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1) return "Interval must be a positive integer";
      if (n > 10080) return "Interval must be 10080 minutes (7 days) or less";
      return undefined;
    },
  });
  if (p.isCancel(backupIntervalInput)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const backupRetentionInput = await p.text({
    message: "Backup retention (days)",
    defaultValue: String(base.backup.retentionDays || 30),
    placeholder: "30",
    validate: (val) => {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1) return "Retention must be a positive integer";
      if (n > 3650) return "Retention must be 3650 days or less";
      return undefined;
    },
  });
  if (p.isCancel(backupRetentionInput)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    connectionString: value.trim(),
    backup: {
      enabled: backupEnabled,
      intervalMinutes: Number(backupIntervalInput || "60"),
      retentionDays: Number(backupRetentionInput || "30"),
      dir: backupDirInput || defaultBackupDir,
    },
  };
}
