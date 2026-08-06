import { readConfigFile } from "./config-file.js";
import { execFileSync } from "node:child_process";
import {
  resolveDatabaseTarget,
  resolveOptionalExternalPostgresConnectionString,
  type ExternalDatabaseTargetSource,
} from "@paperclipai/db";
import {
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  type BindMode,
  type DeploymentExposure,
  type SecretProvider,
  type StorageProvider,
  inferBindModeFromHost,
  normalizePublicOrigin,
  resolveRuntimeBind,
  validateConfiguredBindMode,
} from "@paperclipai/shared";
import {
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
} from "./home-paths.js";

const TAILSCALE_DETECT_TIMEOUT_MS = 3000;

const AMBIENT_AUTH_ORIGIN_ENV_KEYS = [
  ["BETTER", "AUTH", "URL"],
  ["BETTER", "AUTH", "BASE", "URL"],
  ["NEXT", "PUBLIC", "BETTER", "AUTH", "URL"],
  ["PUBLIC", "BETTER", "AUTH", "URL"],
  ["NUXT", "PUBLIC", "BETTER", "AUTH", "URL"],
  ["NUXT", "PUBLIC", "AUTH", "URL"],
  ["PAPERCLIP", "AUTH", "PUBLIC", "BASE", "URL"],
  ["NEXT", "PUBLIC", "URL"],
  ["BASE", "URL"],
  ["BETTER", "AUTH", "TRUSTED", "ORIGINS"],
].map((segments) => segments.join("_"));

export function assertNoAmbientAuthOriginEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const configuredKeys = AMBIENT_AUTH_ORIGIN_ENV_KEYS.filter(
    (key) => env[key]?.trim(),
  );
  if (configuredKeys.length === 0) return;

  throw new Error(
    `Unsupported ambient auth-origin environment variable(s): ${configuredKeys.join(", ")}. ` +
      "Use PAPERCLIP_PUBLIC_URL only for public exposure; private exposure derives origin from requests.",
  );
}

function resolveExternalMigrationUrl(value: string | undefined): string | undefined {
  return resolveOptionalExternalPostgresConnectionString(value, "DATABASE_MIGRATION_URL");
}

function resolveConfiguredPublicOrigin(
  rawValue: string | undefined,
  source: string,
): string | undefined {
  if (!rawValue?.trim()) return undefined;
  try {
    return normalizePublicOrigin(rawValue);
  } catch (error) {
    throw new Error(
      `${source} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function resolveCanonicalPublicOrigin(input: {
  deploymentExposure: DeploymentExposure;
  environmentValue?: string;
  persistedValue?: string;
}): string | undefined {
  const environmentOrigin = resolveConfiguredPublicOrigin(
    input.environmentValue,
    "PAPERCLIP_PUBLIC_URL",
  );
  const persistedOrigin = resolveConfiguredPublicOrigin(
    input.persistedValue,
    "auth.publicBaseUrl",
  );
  if (
    environmentOrigin &&
    persistedOrigin &&
    environmentOrigin !== persistedOrigin
  ) {
    throw new Error(
      "PAPERCLIP_PUBLIC_URL must match the persisted auth.publicBaseUrl when both are configured",
    );
  }

  const canonicalOrigin = environmentOrigin ?? persistedOrigin;
  if (input.deploymentExposure === "public" && !canonicalOrigin) {
    throw new Error(
      "PAPERCLIP_PUBLIC_URL or persisted auth.publicBaseUrl is required when server.exposure=public",
    );
  }
  if (input.deploymentExposure === "private" && canonicalOrigin) {
    throw new Error(
      "PAPERCLIP_PUBLIC_URL and auth.publicBaseUrl are only valid when server.exposure=public",
    );
  }
  return canonicalOrigin;
}

export interface Config {
  deploymentExposure: DeploymentExposure;
  bind: BindMode;
  customBindHost: string | undefined;
  host: string;
  port: number;
  allowedHostnames: string[];
  authPublicBaseUrl: string | undefined;
  authDisableSignUp: boolean;
  databaseUrl: string;
  databaseTargetSource: ExternalDatabaseTargetSource;
  databaseMigrationUrl: string | undefined;
  serveUi: boolean;
  uiDevMiddleware: boolean;
  secretsProvider: SecretProvider;
  secretsStrictMode: boolean;
  secretsMasterKeyFilePath: string;
  storageProvider: StorageProvider;
  storageLocalDiskBaseDir: string;
  storageS3Bucket: string;
  storageS3Region: string;
  storageS3Endpoint: string | undefined;
  storageS3Prefix: string;
  storageS3ForcePathStyle: boolean;
  issueExecutionSchedulerEnabled: boolean;
  issueExecutionSchedulerIntervalMs: number;
  companyDeletionEnabled: boolean;
  telemetryEnabled: boolean;
}

function detectTailnetBindHost(): string | undefined {
  const explicit = process.env.PAPERCLIP_TAILNET_BIND_HOST?.trim();
  if (explicit) return explicit;

  try {
    const stdout = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TAILSCALE_DETECT_TIMEOUT_MS,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

export function loadConfig(): Config {
  assertNoAmbientAuthOriginEnvironment();
  const databaseTarget = resolveDatabaseTarget();
  const fileConfig = readConfigFile();
  const fileSecrets = fileConfig?.secrets;
  const fileStorage = fileConfig?.storage;

  const providerFromEnvRaw = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const providerFromEnv =
    providerFromEnvRaw && SECRET_PROVIDERS.includes(providerFromEnvRaw as SecretProvider)
      ? (providerFromEnvRaw as SecretProvider)
      : null;
  const providerFromFile = fileSecrets?.provider;
  const secretsProvider: SecretProvider = providerFromEnv ?? providerFromFile ?? "local_encrypted";

  const storageProviderFromEnvRaw = process.env.PAPERCLIP_STORAGE_PROVIDER;
  const storageProviderFromEnv =
    storageProviderFromEnvRaw && STORAGE_PROVIDERS.includes(storageProviderFromEnvRaw as StorageProvider)
      ? (storageProviderFromEnvRaw as StorageProvider)
      : null;
  const storageProvider: StorageProvider = storageProviderFromEnv ?? fileStorage?.provider ?? "local_disk";
  const storageLocalDiskBaseDir = resolveHomeAwarePath(
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR ??
      fileStorage?.localDisk?.baseDir ??
      resolveDefaultStorageDir(),
  );
  const storageS3Bucket = process.env.PAPERCLIP_STORAGE_S3_BUCKET ?? fileStorage?.s3?.bucket ?? "paperclip";
  const storageS3Region = process.env.PAPERCLIP_STORAGE_S3_REGION ?? fileStorage?.s3?.region ?? "us-east-1";
  const storageS3Endpoint = process.env.PAPERCLIP_STORAGE_S3_ENDPOINT ?? fileStorage?.s3?.endpoint ?? undefined;
  const storageS3Prefix = process.env.PAPERCLIP_STORAGE_S3_PREFIX ?? fileStorage?.s3?.prefix ?? "";
  const storageS3ForcePathStyle =
    process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE !== undefined
      ? process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE === "true"
      : (fileStorage?.s3?.forcePathStyle ?? false);
  const strictModeFromEnv = process.env.PAPERCLIP_SECRETS_STRICT_MODE;
  const secretsStrictMode =
    strictModeFromEnv !== undefined
      ? strictModeFromEnv === "true"
      : (fileSecrets?.strictMode ?? false);
  const deploymentExposureFromEnvRaw = process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
  const deploymentExposureFromEnv =
    deploymentExposureFromEnvRaw &&
    DEPLOYMENT_EXPOSURES.includes(deploymentExposureFromEnvRaw as DeploymentExposure)
      ? (deploymentExposureFromEnvRaw as DeploymentExposure)
      : null;
  const deploymentExposure: DeploymentExposure =
    deploymentExposureFromEnv ??
    fileConfig?.server.exposure ??
    "private";
  const bindFromEnvRaw = process.env.PAPERCLIP_BIND;
  const bindFromEnv =
    bindFromEnvRaw && BIND_MODES.includes(bindFromEnvRaw as BindMode)
      ? (bindFromEnvRaw as BindMode)
      : null;
  const configuredHost = process.env.HOST ?? fileConfig?.server.host ?? "127.0.0.1";
  const tailnetBindHost = detectTailnetBindHost();
  const bind =
    bindFromEnv ??
    fileConfig?.server.bind ??
    inferBindModeFromHost(configuredHost, { tailnetBindHost });
  const customBindHost = process.env.PAPERCLIP_BIND_HOST ?? fileConfig?.server.customBindHost;
  const authPublicBaseUrl = resolveCanonicalPublicOrigin({
    deploymentExposure,
    environmentValue: process.env.PAPERCLIP_PUBLIC_URL,
    persistedValue: fileConfig?.auth?.publicBaseUrl,
  });
  const disableSignUpFromEnv = process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP;
  const authDisableSignUp: boolean =
    disableSignUpFromEnv !== undefined
      ? disableSignUpFromEnv === "true"
      : (fileConfig?.auth?.disableSignUp ?? false);
  const allowedHostnamesFromEnvRaw = process.env.PAPERCLIP_ALLOWED_HOSTNAMES;
  const allowedHostnamesFromEnv = allowedHostnamesFromEnvRaw
    ? allowedHostnamesFromEnvRaw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : null;
  const allowedHostnames = Array.from(
    new Set(
      (allowedHostnamesFromEnv ?? fileConfig?.server.allowedHostnames ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const companyDeletionEnvRaw = process.env.PAPERCLIP_ENABLE_COMPANY_DELETION;
  const companyDeletionEnabled =
    companyDeletionEnvRaw !== undefined
      ? companyDeletionEnvRaw === "true"
      : false;
  const bindValidationErrors = validateConfiguredBindMode({
    exposure: deploymentExposure,
    bind,
    host: configuredHost,
    customBindHost,
  });
  if (bindValidationErrors.length > 0) {
    throw new Error(bindValidationErrors[0]);
  }
  const resolvedBind = resolveRuntimeBind({
    bind,
    host: configuredHost,
    customBindHost,
    tailnetBindHost,
  });
  if (resolvedBind.errors.length > 0) {
    throw new Error(resolvedBind.errors[0]);
  }

  return {
    deploymentExposure,
    bind: resolvedBind.bind,
    customBindHost: resolvedBind.customBindHost,
    host: resolvedBind.host,
    port: Number(process.env.PORT) || fileConfig?.server.port || 3100,
    allowedHostnames,
    authPublicBaseUrl,
    authDisableSignUp,
    databaseUrl: databaseTarget.connectionString,
    databaseTargetSource: databaseTarget.source,
    databaseMigrationUrl: resolveExternalMigrationUrl(process.env.DATABASE_MIGRATION_URL),
    serveUi:
      process.env.SERVE_UI !== undefined
        ? process.env.SERVE_UI === "true"
        : fileConfig?.server.serveUi ?? true,
    uiDevMiddleware: process.env.PAPERCLIP_UI_DEV_MIDDLEWARE === "true",
    secretsProvider,
    secretsStrictMode,
    secretsMasterKeyFilePath:
      resolveHomeAwarePath(
        process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ??
          fileSecrets?.localEncrypted.keyFilePath ??
          resolveDefaultSecretsKeyFilePath(),
      ),
    storageProvider,
    storageLocalDiskBaseDir,
    storageS3Bucket,
    storageS3Region,
    storageS3Endpoint,
    storageS3Prefix,
    storageS3ForcePathStyle,
    issueExecutionSchedulerEnabled: process.env.ISSUE_EXECUTION_SCHEDULER_ENABLED !== "false",
    issueExecutionSchedulerIntervalMs: Math.max(
      10000,
      Number(process.env.ISSUE_EXECUTION_SCHEDULER_INTERVAL_MS) || 30000,
    ),
    companyDeletionEnabled,
    telemetryEnabled: fileConfig?.telemetry?.enabled ?? true,
  };
}
