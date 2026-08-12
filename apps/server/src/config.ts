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
  parseExactHostnameList,
  parseExactNonEmptyHostnameCsv,
  parseExactStorageEndpoint,
  parseExactStorageName,
  parseExactStoragePrefix,
  parseExactPublicOrigin,
  parseOptionalBooleanEnvironmentValue,
  parseOptionalExactNonEmptyEnvironmentValue,
  parseOptionalEnumEnvironmentValue,
  parseOptionalIntegerEnvironmentValue,
  resolveRuntimeBind,
  resolveServerPort,
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
    (key) => env[key] !== undefined,
  );
  if (configuredKeys.length === 0) return;

  throw new Error(
    `Unsupported ambient auth-origin environment variable(s): ${configuredKeys.join(", ")}. ` +
      "Use PAPERCLIP_PUBLIC_URL only for public exposure; private exposure derives origin from requests.",
  );
}

function resolveExternalMigrationUrl(
  value: string | undefined,
): string | undefined {
  return resolveOptionalExternalPostgresConnectionString(
    value,
    "DATABASE_MIGRATION_URL",
  );
}

function resolveConfiguredPublicOrigin(
  rawValue: string | undefined,
  source: string,
): string | undefined {
  if (rawValue === undefined) return undefined;
  try {
    return parseExactPublicOrigin(rawValue);
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
  taskExecutionSchedulerEnabled: boolean;
  taskExecutionSchedulerIntervalMs: number;
  companyDeletionEnabled: boolean;
  telemetryEnabled: boolean;
  openOnListen: boolean;
}

function detectTailnetBindHost(): string | undefined {
  const explicit = parseOptionalExactNonEmptyEnvironmentValue(
    process.env.PAPERCLIP_TAILNET_BIND_HOST,
    "PAPERCLIP_TAILNET_BIND_HOST",
  );
  if (explicit !== undefined) return explicit;

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

  const providerFromEnv = parseOptionalEnumEnvironmentValue(
    process.env.PAPERCLIP_SECRETS_PROVIDER,
    "PAPERCLIP_SECRETS_PROVIDER",
    SECRET_PROVIDERS,
  );
  const providerFromFile = fileSecrets?.provider;
  const secretsProvider: SecretProvider =
    providerFromEnv ?? providerFromFile ?? "local_encrypted";

  const storageProviderFromEnv = parseOptionalEnumEnvironmentValue(
    process.env.PAPERCLIP_STORAGE_PROVIDER,
    "PAPERCLIP_STORAGE_PROVIDER",
    STORAGE_PROVIDERS,
  );
  const storageProvider: StorageProvider =
    storageProviderFromEnv ?? fileStorage?.provider ?? "local_disk";
  const storageLocalDiskBaseDir = resolveHomeAwarePath(
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR ??
      fileStorage?.localDisk?.baseDir ??
      resolveDefaultStorageDir(),
  );
  const storageS3Bucket =
    (process.env.PAPERCLIP_STORAGE_S3_BUCKET === undefined
      ? undefined
      : parseExactStorageName(
          process.env.PAPERCLIP_STORAGE_S3_BUCKET,
          "PAPERCLIP_STORAGE_S3_BUCKET",
        )) ??
    fileStorage?.s3?.bucket ??
    "paperclip";
  const storageS3Region =
    (process.env.PAPERCLIP_STORAGE_S3_REGION === undefined
      ? undefined
      : parseExactStorageName(
          process.env.PAPERCLIP_STORAGE_S3_REGION,
          "PAPERCLIP_STORAGE_S3_REGION",
        )) ??
    fileStorage?.s3?.region ??
    "us-east-1";
  const storageS3Endpoint =
    (process.env.PAPERCLIP_STORAGE_S3_ENDPOINT === undefined
      ? undefined
      : parseExactStorageEndpoint(process.env.PAPERCLIP_STORAGE_S3_ENDPOINT)) ??
    fileStorage?.s3?.endpoint ??
    undefined;
  const storageS3Prefix =
    process.env.PAPERCLIP_STORAGE_S3_PREFIX === undefined
      ? parseExactStoragePrefix(fileStorage?.s3?.prefix ?? "")
      : parseExactStoragePrefix(process.env.PAPERCLIP_STORAGE_S3_PREFIX);
  const storageS3ForcePathStyle =
    parseOptionalBooleanEnvironmentValue(
      process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE,
      "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE",
    ) ??
    fileStorage?.s3?.forcePathStyle ??
    false;
  const secretsStrictMode =
    parseOptionalBooleanEnvironmentValue(
      process.env.PAPERCLIP_SECRETS_STRICT_MODE,
      "PAPERCLIP_SECRETS_STRICT_MODE",
    ) ??
    fileSecrets?.strictMode ??
    false;
  const deploymentExposureFromEnv = parseOptionalEnumEnvironmentValue(
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE,
    "PAPERCLIP_DEPLOYMENT_EXPOSURE",
    DEPLOYMENT_EXPOSURES,
  );
  const deploymentExposure: DeploymentExposure =
    deploymentExposureFromEnv ?? fileConfig?.server.exposure ?? "private";
  const bindFromEnv = parseOptionalEnumEnvironmentValue(
    process.env.PAPERCLIP_BIND,
    "PAPERCLIP_BIND",
    BIND_MODES,
  );
  const bind = bindFromEnv ?? fileConfig?.server.bind ?? "loopback";
  const customBindHost =
    parseOptionalExactNonEmptyEnvironmentValue(
      process.env.PAPERCLIP_BIND_HOST,
      "PAPERCLIP_BIND_HOST",
    ) ?? fileConfig?.server.customBindHost;
  const authPublicBaseUrl = resolveCanonicalPublicOrigin({
    deploymentExposure,
    environmentValue: process.env.PAPERCLIP_PUBLIC_URL,
    persistedValue: fileConfig?.auth?.publicBaseUrl,
  });
  const authDisableSignUp =
    parseOptionalBooleanEnvironmentValue(
      process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP,
      "PAPERCLIP_AUTH_DISABLE_SIGN_UP",
    ) ??
    fileConfig?.auth?.disableSignUp ??
    false;
  const allowedHostnamesFromEnvRaw = process.env.PAPERCLIP_ALLOWED_HOSTNAMES;
  const allowedHostnamesFromEnv =
    allowedHostnamesFromEnvRaw === undefined
      ? null
      : parseExactNonEmptyHostnameCsv(allowedHostnamesFromEnvRaw);
  const allowedHostnames = parseExactHostnameList(
    allowedHostnamesFromEnv ?? fileConfig?.server.allowedHostnames ?? [],
  );
  const companyDeletionEnabled =
    parseOptionalBooleanEnvironmentValue(
      process.env.PAPERCLIP_ENABLE_COMPANY_DELETION,
      "PAPERCLIP_ENABLE_COMPANY_DELETION",
    ) ?? false;
  const resolvedBind = resolveRuntimeBind({
    exposure: deploymentExposure,
    bind,
    customBindHost,
    tailnetBindHost: bind === "tailnet" ? detectTailnetBindHost() : undefined,
  });

  return {
    deploymentExposure,
    bind: resolvedBind.bind,
    customBindHost: resolvedBind.customBindHost,
    host: resolvedBind.host,
    port: resolveServerPort({
      environmentValue: process.env.PORT,
      persistedValue: fileConfig?.server.port,
    }),
    allowedHostnames,
    authPublicBaseUrl,
    authDisableSignUp,
    databaseUrl: databaseTarget.connectionString,
    databaseTargetSource: databaseTarget.source,
    databaseMigrationUrl: resolveExternalMigrationUrl(
      process.env.DATABASE_MIGRATION_URL,
    ),
    serveUi:
      parseOptionalBooleanEnvironmentValue(process.env.SERVE_UI, "SERVE_UI") ??
      fileConfig?.server.serveUi ??
      true,
    uiDevMiddleware:
      parseOptionalBooleanEnvironmentValue(
        process.env.PAPERCLIP_UI_DEV_MIDDLEWARE,
        "PAPERCLIP_UI_DEV_MIDDLEWARE",
      ) ?? false,
    secretsProvider,
    secretsStrictMode,
    secretsMasterKeyFilePath: resolveHomeAwarePath(
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
    taskExecutionSchedulerEnabled:
      parseOptionalBooleanEnvironmentValue(
        process.env.TASK_EXECUTION_SCHEDULER_ENABLED,
        "TASK_EXECUTION_SCHEDULER_ENABLED",
      ) ?? true,
    taskExecutionSchedulerIntervalMs:
      parseOptionalIntegerEnvironmentValue(
        process.env.TASK_EXECUTION_SCHEDULER_INTERVAL_MS,
        "TASK_EXECUTION_SCHEDULER_INTERVAL_MS",
        { min: 10_000 },
      ) ?? 30_000,
    companyDeletionEnabled,
    telemetryEnabled: fileConfig?.telemetry?.enabled ?? true,
    openOnListen:
      parseOptionalBooleanEnvironmentValue(
        process.env.PAPERCLIP_OPEN_ON_LISTEN,
        "PAPERCLIP_OPEN_ON_LISTEN",
      ) ?? false,
  };
}
