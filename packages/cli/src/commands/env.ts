import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  redactExternalPostgresConnectionString,
  resolveDatabaseTarget,
} from "@paperclipai/db";
import type { PaperclipConfig } from "../config/schema.js";
import { configExists, readConfig, resolveConfigPath } from "../config/store.js";
import {
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

type EnvSource = "env" | "config" | "file" | "default" | "missing";

type EnvVarRow = {
  key: string;
  value: string;
  source: EnvSource;
  required: boolean;
  note: string;
};

const DEFAULT_TASK_EXECUTION_SCHEDULER_INTERVAL_MS = "30000";
const DEFAULT_SECRETS_PROVIDER = "local_encrypted";
const DEFAULT_STORAGE_PROVIDER = "local_disk";
function defaultSecretsKeyFilePath(): string {
  return resolveDefaultSecretsKeyFilePath(resolvePaperclipInstanceId());
}
function defaultStorageBaseDir(): string {
  return resolveDefaultStorageDir(resolvePaperclipInstanceId());
}

export async function envCommand(opts: { config?: string }): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" paperclip env ")));

  const configPath = resolveConfigPath(opts.config);
  let config: PaperclipConfig | null = null;
  let configReadError: string | null = null;

  if (configExists(opts.config)) {
    p.log.message(pc.dim(`Config file: ${configPath}`));
    try {
      config = readConfig(opts.config);
    } catch (err) {
      configReadError = err instanceof Error ? err.message : String(err);
      p.log.message(pc.yellow(`Could not parse config: ${configReadError}`));
    }
  } else {
    p.log.message(pc.dim(`Config file missing: ${configPath}`));
  }

  const rows = collectDeploymentEnvRows(config, configPath);
  const missingRequired = rows.filter((row) => row.required && row.source === "missing");
  const sortedRows = rows.sort((a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key));

  const requiredRows = sortedRows.filter((row) => row.required);
  const optionalRows = sortedRows.filter((row) => !row.required);

  const formatSection = (title: string, entries: EnvVarRow[]) => {
    if (entries.length === 0) return;

    p.log.message(pc.bold(title));
    for (const entry of entries) {
      const status = entry.source === "missing" ? pc.red("missing") : entry.source === "default" ? pc.yellow("default") : pc.green("set");
      const sourceNote = {
        env: "environment",
        config: "config",
        file: "file",
        default: "default",
        missing: "missing",
      }[entry.source];
      p.log.message(
        `${pc.cyan(entry.key)} ${status.padEnd(7)} ${pc.dim(`[${sourceNote}] ${entry.note}`)}${entry.source === "missing" ? "" : ` ${pc.dim("=>")} ${pc.white(quoteShellValue(entry.value))}`}`,
      );
    }
  };

  formatSection("Required environment variables", requiredRows);
  formatSection("Optional environment variables", optionalRows);

  const exportRows = rows.map((row) => (row.source === "missing" ? { ...row, value: "<set-this-value>" } : row));
  const uniqueRows = uniqueByKey(exportRows);
  const exportBlock = uniqueRows.map((row) => `export ${row.key}=${quoteShellValue(row.value)}`).join("\n");

  if (configReadError) {
    p.log.error(`Could not load config cleanly: ${configReadError}`);
  }

  p.note(
    exportBlock || "No values detected. Set required variables manually.",
    "Deployment export block",
  );

  if (missingRequired.length > 0) {
    p.log.message(
      pc.yellow(
        `Missing required values: ${missingRequired.map((row) => row.key).join(", ")}. Set these before deployment.`,
      ),
    );
  } else {
    p.log.message(pc.green("All required deployment variables are present."));
  }
  p.outro("Done");
}

function collectDeploymentEnvRows(config: PaperclipConfig | null, configPath: string): EnvVarRow[] {
  let dbUrl = "";
  let dbUrlSource: EnvSource = "missing";
  try {
    const target = resolveDatabaseTarget({ configPath });
    dbUrl = redactExternalPostgresConnectionString(target.connectionString);
    dbUrlSource =
      target.source === "DATABASE_URL"
        ? "env"
        : target.source === "paperclip-env"
          ? "file"
          : "config";
  } catch {
    // The missing row below is the actionable env output for an absent target.
  }
  const publicUrl =
    process.env.PAPERCLIP_PUBLIC_URL ??
    config?.auth?.publicBaseUrl ??
    "";
  const publicUrlSource: EnvSource =
    process.env.PAPERCLIP_PUBLIC_URL
      ? "env"
      : config?.auth?.publicBaseUrl
        ? "config"
        : "missing";
  const deploymentExposure =
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE ??
    config?.server?.exposure ??
    "private";

  const taskExecutionInterval =
    process.env.TASK_EXECUTION_SCHEDULER_INTERVAL_MS ??
    DEFAULT_TASK_EXECUTION_SCHEDULER_INTERVAL_MS;
  const taskExecutionEnabled =
    process.env.TASK_EXECUTION_SCHEDULER_ENABLED ?? "true";
  const secretsProvider =
    process.env.PAPERCLIP_SECRETS_PROVIDER ??
    config?.secrets?.provider ??
    DEFAULT_SECRETS_PROVIDER;
  const secretsStrictMode =
    process.env.PAPERCLIP_SECRETS_STRICT_MODE ??
    String(config?.secrets?.strictMode ?? false);
  const secretsKeyFilePath =
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ??
    config?.secrets?.localEncrypted?.keyFilePath ??
    defaultSecretsKeyFilePath();
  const storageProvider =
    process.env.PAPERCLIP_STORAGE_PROVIDER ??
    config?.storage?.provider ??
    DEFAULT_STORAGE_PROVIDER;
  const storageLocalDir =
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR ??
    config?.storage?.localDisk?.baseDir ??
    defaultStorageBaseDir();
  const storageS3Bucket =
    process.env.PAPERCLIP_STORAGE_S3_BUCKET ??
    config?.storage?.s3?.bucket ??
    "paperclip";
  const storageS3Region =
    process.env.PAPERCLIP_STORAGE_S3_REGION ??
    config?.storage?.s3?.region ??
    "us-east-1";
  const storageS3Endpoint =
    process.env.PAPERCLIP_STORAGE_S3_ENDPOINT ??
    config?.storage?.s3?.endpoint ??
    "";
  const storageS3Prefix =
    process.env.PAPERCLIP_STORAGE_S3_PREFIX ??
    config?.storage?.s3?.prefix ??
    "";
  const storageS3ForcePathStyle =
    process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE ??
    String(config?.storage?.s3?.forcePathStyle ?? false);

  const rows: EnvVarRow[] = [
    {
      key: "DATABASE_URL",
      value: dbUrl,
      source: dbUrlSource,
      required: true,
      note: "Required external PostgreSQL target (credentials redacted)",
    },
    {
      key: "PORT",
      value:
        process.env.PORT ??
        (config?.server?.port !== undefined ? String(config.server.port) : "3100"),
      source: process.env.PORT ? "env" : config?.server?.port !== undefined ? "config" : "default",
      required: false,
      note: "HTTP listen port",
    },
    {
      key: "PAPERCLIP_DEPLOYMENT_EXPOSURE",
      value: deploymentExposure,
      source: process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE
        ? "env"
        : config?.server?.exposure
          ? "config"
          : "default",
      required: false,
      note: "Exposure policy; public requires the canonical public URL",
    },
    {
      key: "PAPERCLIP_PUBLIC_URL",
      value: publicUrl,
      source: publicUrlSource,
      required: deploymentExposure === "public",
      note: deploymentExposure === "public"
        ? "Sole external HTTPS origin for public auth/callback/invite wiring"
        : "Must remain unset; private auth origins are request-derived",
    },
    {
      key: "TASK_EXECUTION_SCHEDULER_INTERVAL_MS",
      value: taskExecutionInterval,
      source: process.env.TASK_EXECUTION_SCHEDULER_INTERVAL_MS ? "env" : "default",
      required: false,
      note: "Task-execution reconciliation interval in ms",
    },
    {
      key: "TASK_EXECUTION_SCHEDULER_ENABLED",
      value: taskExecutionEnabled,
      source: process.env.TASK_EXECUTION_SCHEDULER_ENABLED ? "env" : "default",
      required: false,
      note: "Set to `false` to disable task-execution reconciliation",
    },
    {
      key: "PAPERCLIP_SECRETS_PROVIDER",
      value: secretsProvider,
      source: process.env.PAPERCLIP_SECRETS_PROVIDER
        ? "env"
        : config?.secrets?.provider
          ? "config"
          : "default",
      required: false,
      note: "Default provider for new secrets",
    },
    {
      key: "PAPERCLIP_SECRETS_STRICT_MODE",
      value: secretsStrictMode,
      source: process.env.PAPERCLIP_SECRETS_STRICT_MODE
        ? "env"
        : config?.secrets?.strictMode !== undefined
          ? "config"
          : "default",
      required: false,
      note: "Require secret refs for sensitive env keys",
    },
    {
      key: "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
      value: secretsKeyFilePath,
      source: process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE
        ? "env"
        : config?.secrets?.localEncrypted?.keyFilePath
          ? "config"
          : "default",
      required: false,
      note: "Path to local encrypted secrets key file",
    },
    {
      key: "PAPERCLIP_STORAGE_PROVIDER",
      value: storageProvider,
      source: process.env.PAPERCLIP_STORAGE_PROVIDER
        ? "env"
        : config?.storage?.provider
          ? "config"
          : "default",
      required: false,
      note: "Storage provider (local_disk or s3)",
    },
    {
      key: "PAPERCLIP_STORAGE_LOCAL_DIR",
      value: storageLocalDir,
      source: process.env.PAPERCLIP_STORAGE_LOCAL_DIR
        ? "env"
        : config?.storage?.localDisk?.baseDir
          ? "config"
          : "default",
      required: false,
      note: "Local storage base directory for local_disk provider",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_BUCKET",
      value: storageS3Bucket,
      source: process.env.PAPERCLIP_STORAGE_S3_BUCKET
        ? "env"
        : config?.storage?.s3?.bucket
          ? "config"
          : "default",
      required: false,
      note: "S3 bucket name for s3 provider",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_REGION",
      value: storageS3Region,
      source: process.env.PAPERCLIP_STORAGE_S3_REGION
        ? "env"
        : config?.storage?.s3?.region
          ? "config"
          : "default",
      required: false,
      note: "S3 region for s3 provider",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_ENDPOINT",
      value: storageS3Endpoint,
      source: process.env.PAPERCLIP_STORAGE_S3_ENDPOINT
        ? "env"
        : config?.storage?.s3?.endpoint
          ? "config"
          : "default",
      required: false,
      note: "Optional custom endpoint for S3-compatible providers",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_PREFIX",
      value: storageS3Prefix,
      source: process.env.PAPERCLIP_STORAGE_S3_PREFIX
        ? "env"
        : config?.storage?.s3?.prefix
          ? "config"
          : "default",
      required: false,
      note: "Optional object key prefix",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE",
      value: storageS3ForcePathStyle,
      source: process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE
        ? "env"
        : config?.storage?.s3?.forcePathStyle !== undefined
          ? "config"
          : "default",
      required: false,
      note: "Set true for path-style access on compatible providers",
    },
  ];

  const defaultConfigPath = resolveConfigPath();
  if (process.env.PAPERCLIP_CONFIG || configPath !== defaultConfigPath) {
    rows.push({
      key: "PAPERCLIP_CONFIG",
      value: process.env.PAPERCLIP_CONFIG ?? configPath,
      source: process.env.PAPERCLIP_CONFIG ? "env" : "default",
      required: false,
      note: "Optional path override for config file",
    });
  }

  return rows;
}

function uniqueByKey(rows: EnvVarRow[]): EnvVarRow[] {
  const seen = new Set<string>();
  const result: EnvVarRow[] = [];
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    result.push(row);
  }
  return result;
}

function quoteShellValue(value: string): string {
  if (value === "") return "\"\"";
  return `'${value.replaceAll("'", "'\\''")}'`;
}
