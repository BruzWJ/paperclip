import * as p from "@clack/prompts";
import path from "node:path";
import pc from "picocolors";
import {
  redactExternalPostgresConnectionString,
  validateExternalPostgresConnectionString,
} from "@paperclipai/db";
import {
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  inferBindModeFromHost,
  normalizePublicOrigin,
  resolveRuntimeBind,
  type BindMode,
  type DeploymentExposure,
  type SecretProvider,
  type StorageProvider,
} from "@paperclipai/shared";
import { configExists, readConfig, resolveConfigPath, writeConfig } from "../config/store.js";
import {
  paperclipConfigSchema,
  type PaperclipConfig,
} from "../config/schema.js";
import { ensureLocalSecretsKeyFile } from "../config/secrets-key.js";
import { provisionPrimaryBetterAuthSecret } from "../config/auth-secret.js";
import { promptDatabase } from "../prompts/database.js";
import { promptLogging } from "../prompts/logging.js";
import { defaultSecretsConfig } from "../prompts/secrets.js";
import { defaultStorageConfig, promptStorage } from "../prompts/storage.js";
import { promptServer } from "../prompts/server.js";
import { buildPresetServerConfig } from "../config/server-bind.js";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolveDefaultLogsDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import {
  getTelemetryClient,
  trackInstallStarted,
  trackInstallCompleted,
} from "../telemetry.js";

type SetupMode = "quickstart" | "advanced";

type OnboardOptions = {
  config?: string;
  run?: boolean;
  yes?: boolean;
  invokedByRun?: boolean;
  bind?: BindMode;
};

type OnboardDefaults = Pick<PaperclipConfig, "database" | "logging" | "server" | "auth" | "storage" | "secrets">;

const TAILNET_BIND_WARNING =
  "No Tailscale address was detected during setup. The saved config will stay on loopback until Tailscale is available or PAPERCLIP_TAILNET_BIND_HOST is set.";

const ONBOARD_ENV_KEYS = [
  "PAPERCLIP_PUBLIC_URL",
  "DATABASE_URL",
  "PAPERCLIP_DB_BACKUP_ENABLED",
  "PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES",
  "PAPERCLIP_DB_BACKUP_RETENTION_DAYS",
  "PAPERCLIP_DB_BACKUP_DIR",
  "PAPERCLIP_DEPLOYMENT_EXPOSURE",
  "PAPERCLIP_BIND",
  "PAPERCLIP_BIND_HOST",
  "PAPERCLIP_TAILNET_BIND_HOST",
  "HOST",
  "PORT",
  "SERVE_UI",
  "PAPERCLIP_ALLOWED_HOSTNAMES",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_STORAGE_PROVIDER",
  "PAPERCLIP_STORAGE_LOCAL_DIR",
  "PAPERCLIP_STORAGE_S3_BUCKET",
  "PAPERCLIP_STORAGE_S3_REGION",
  "PAPERCLIP_STORAGE_S3_ENDPOINT",
  "PAPERCLIP_STORAGE_S3_PREFIX",
  "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE",
  "PAPERCLIP_SECRETS_PROVIDER",
  "PAPERCLIP_SECRETS_STRICT_MODE",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
] as const;

function parseBooleanFromEnv(rawValue: string | undefined): boolean | null {
  if (rawValue === undefined) return null;
  const lower = rawValue.trim().toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return null;
}

function parseNumberFromEnv(rawValue: string | undefined): number | null {
  if (!rawValue) return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseEnumFromEnv<T extends string>(rawValue: string | undefined, allowedValues: readonly T[]): T | null {
  if (!rawValue) return null;
  return allowedValues.includes(rawValue as T) ? (rawValue as T) : null;
}

function resolvePathFromEnv(rawValue: string | undefined): string | null {
  if (!rawValue || rawValue.trim().length === 0) return null;
  return path.resolve(expandHomePrefix(rawValue.trim()));
}

function describeServerBinding(server: Pick<PaperclipConfig["server"], "bind" | "customBindHost" | "host" | "port">): string {
  const bind = server.bind ?? inferBindModeFromHost(server.host);
  const detail =
    bind === "custom"
      ? server.customBindHost ?? server.host
      : bind === "tailnet"
        ? "detected tailscale address"
        : server.host;
  return `${bind}${detail ? ` (${detail})` : ""}:${server.port}`;
}

function quickstartDefaultsFromEnv(opts?: { preferLoopback?: boolean }): {
  defaults: OnboardDefaults;
  usedEnvKeys: string[];
  ignoredEnvKeys: Array<{ key: string; reason: string }>;
} {
  const preferLoopback = opts?.preferLoopback ?? false;
  if (process.env.PAPERCLIP_DEPLOYMENT_MODE !== undefined) {
    throw new Error(
      "PAPERCLIP_DEPLOYMENT_MODE is unsupported. Configure PAPERCLIP_BIND and PAPERCLIP_DEPLOYMENT_EXPOSURE instead.",
    );
  }
  const instanceId = resolvePaperclipInstanceId();
  const defaultStorage = defaultStorageConfig();
  const defaultSecrets = defaultSecretsConfig();
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  const configuredPublicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim()
    ? normalizePublicOrigin(process.env.PAPERCLIP_PUBLIC_URL)
    : undefined;
  const deploymentExposureFromEnv = parseEnumFromEnv<DeploymentExposure>(
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE,
    DEPLOYMENT_EXPOSURES,
  );
  const deploymentExposure = preferLoopback ? "private" : (deploymentExposureFromEnv ?? "private");
  if (!preferLoopback && deploymentExposure === "private" && configuredPublicUrl) {
    throw new Error(
      "PAPERCLIP_PUBLIC_URL is only valid when PAPERCLIP_DEPLOYMENT_EXPOSURE=public",
    );
  }
  const publicUrl = deploymentExposure === "public" ? configuredPublicUrl : undefined;
  const bindFromEnv = parseEnumFromEnv<BindMode>(process.env.PAPERCLIP_BIND, BIND_MODES);
  const customBindHostFromEnv = process.env.PAPERCLIP_BIND_HOST?.trim() || undefined;
  const hostFromEnv = process.env.HOST?.trim() || undefined;
  const configuredBindHost = customBindHostFromEnv ?? hostFromEnv;
  const bind = preferLoopback
    ? "loopback"
    : (
      bindFromEnv ??
      (configuredBindHost
        ? inferBindModeFromHost(configuredBindHost)
        : deploymentExposure === "public"
          ? "lan"
          : "loopback")
    );
  const resolvedBind = resolveRuntimeBind({
    bind,
    host: hostFromEnv ?? (bind === "loopback" ? "127.0.0.1" : "0.0.0.0"),
    customBindHost: customBindHostFromEnv,
    tailnetBindHost: process.env.PAPERCLIP_TAILNET_BIND_HOST?.trim(),
  });
  const authPublicBaseUrl = publicUrl;
  const allowedHostnamesFromEnv = process.env.PAPERCLIP_ALLOWED_HOSTNAMES
    ? process.env.PAPERCLIP_ALLOWED_HOSTNAMES
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : [];
  const storageProvider =
    parseEnumFromEnv<StorageProvider>(process.env.PAPERCLIP_STORAGE_PROVIDER, STORAGE_PROVIDERS) ??
    defaultStorage.provider;
  const secretsProvider =
    parseEnumFromEnv<SecretProvider>(process.env.PAPERCLIP_SECRETS_PROVIDER, SECRET_PROVIDERS) ??
    defaultSecrets.provider;
  const databaseBackupEnabled = parseBooleanFromEnv(process.env.PAPERCLIP_DB_BACKUP_ENABLED) ?? true;
  const databaseBackupIntervalMinutes = Math.max(
    1,
    parseNumberFromEnv(process.env.PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES) ?? 60,
  );
  const databaseBackupRetentionDays = Math.max(
    1,
    parseNumberFromEnv(process.env.PAPERCLIP_DB_BACKUP_RETENTION_DAYS) ?? 30,
  );
  const defaults: OnboardDefaults = {
    database: {
      backup: {
        enabled: databaseBackupEnabled,
        intervalMinutes: databaseBackupIntervalMinutes,
        retentionDays: databaseBackupRetentionDays,
        dir: resolvePathFromEnv(process.env.PAPERCLIP_DB_BACKUP_DIR) ?? resolveDefaultBackupDir(instanceId),
      },
    },
    logging: {
      mode: "file",
      logDir: resolveDefaultLogsDir(instanceId),
    },
    server: {
      exposure: deploymentExposure,
      bind: resolvedBind.bind,
      ...(resolvedBind.customBindHost ? { customBindHost: resolvedBind.customBindHost } : {}),
      host: resolvedBind.host,
      port: Number(process.env.PORT) || 3100,
      allowedHostnames: Array.from(new Set(allowedHostnamesFromEnv)),
      serveUi: parseBooleanFromEnv(process.env.SERVE_UI) ?? true,
    },
    auth: {
      disableSignUp: false,
      ...(authPublicBaseUrl ? { publicBaseUrl: authPublicBaseUrl } : {}),
    },
    storage: {
      provider: storageProvider,
      localDisk: {
        baseDir:
          resolvePathFromEnv(process.env.PAPERCLIP_STORAGE_LOCAL_DIR) ?? defaultStorage.localDisk.baseDir,
      },
      s3: {
        bucket: process.env.PAPERCLIP_STORAGE_S3_BUCKET ?? defaultStorage.s3.bucket,
        region: process.env.PAPERCLIP_STORAGE_S3_REGION ?? defaultStorage.s3.region,
        endpoint: process.env.PAPERCLIP_STORAGE_S3_ENDPOINT ?? defaultStorage.s3.endpoint,
        prefix: process.env.PAPERCLIP_STORAGE_S3_PREFIX ?? defaultStorage.s3.prefix,
        forcePathStyle:
          parseBooleanFromEnv(process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE) ??
          defaultStorage.s3.forcePathStyle,
      },
    },
    secrets: {
      provider: secretsProvider,
      strictMode: parseBooleanFromEnv(process.env.PAPERCLIP_SECRETS_STRICT_MODE) ?? defaultSecrets.strictMode,
      localEncrypted: {
        keyFilePath:
          resolvePathFromEnv(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE) ??
          defaultSecrets.localEncrypted.keyFilePath,
      },
    },
  };
  const ignoredEnvKeys: Array<{ key: string; reason: string }> = [];
  if (preferLoopback) {
    const forcedLocalReason = "Ignored because --yes quickstart uses private loopback defaults";
    for (const key of [
      "PAPERCLIP_DEPLOYMENT_EXPOSURE",
      "PAPERCLIP_BIND",
      "PAPERCLIP_BIND_HOST",
      "HOST",
      "PAPERCLIP_PUBLIC_URL",
    ] as const) {
      if (process.env[key] !== undefined) {
        ignoredEnvKeys.push({ key, reason: forcedLocalReason });
      }
    }
  }

  const ignoredKeySet = new Set(ignoredEnvKeys.map((entry) => entry.key));
  const usedEnvKeys = ONBOARD_ENV_KEYS.filter(
    (key) => process.env[key] !== undefined && !ignoredKeySet.has(key),
  );
  return { defaults, usedEnvKeys, ignoredEnvKeys };
}

export async function onboard(opts: OnboardOptions): Promise<void> {
  if (opts.bind && !["loopback", "lan", "tailnet"].includes(opts.bind)) {
    throw new Error(`Unsupported bind preset for onboard: ${opts.bind}. Use loopback, lan, or tailnet.`);
  }

  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclipai onboard ")));
  const configPath = resolveConfigPath(opts.config);
  const instance = describeLocalInstancePaths(resolvePaperclipInstanceId());
  p.log.message(
    pc.dim(
      `Local home: ${instance.homeDir} | instance: ${instance.instanceId} | config: ${configPath}`,
    ),
  );

  let existingConfig: PaperclipConfig | null = null;
  if (configExists(opts.config)) {
    p.log.message(pc.dim(`${configPath} exists`));

    try {
      existingConfig = readConfig(opts.config);
    } catch (err) {
      p.log.error(
        `Existing config is invalid and cannot be upgraded in place.\n${err instanceof Error ? err.message : String(err)}`,
      );
      p.log.message("Remove or replace the retired configuration, then run onboarding again.");
      p.outro("");
      process.exitCode = 1;
      return;
    }
  }

  if (existingConfig) {
    p.log.message(
      pc.dim("Existing Paperclip install detected; keeping the current configuration unchanged."),
    );
    p.log.message(pc.dim(`Use ${pc.cyan("paperclipai configure")} if you want to change settings.`));

    const keyResult = ensureLocalSecretsKeyFile(existingConfig, configPath);
    if (keyResult.status === "created") {
      p.log.success(`Created local secrets key file at ${pc.dim(keyResult.path)}`);
    } else if (keyResult.status === "existing") {
      p.log.message(pc.dim(`Using existing local secrets key file at ${keyResult.path}`));
    }

    p.note(
      [
        "Existing config preserved",
        `Database: ${
          existingConfig.database.connectionString
            ? redactExternalPostgresConnectionString(existingConfig.database.connectionString)
            : "DATABASE_URL / adjacent environment"
        }`,
        `Logging: ${existingConfig.logging.mode} -> ${existingConfig.logging.logDir}`,
        `Server: ${existingConfig.server.exposure} @ ${describeServerBinding(existingConfig.server)}`,
        `Allowed hosts: ${existingConfig.server.allowedHostnames.length > 0 ? existingConfig.server.allowedHostnames.join(", ") : "(loopback only)"}`,
        `Auth origin: ${existingConfig.server.exposure === "public" ? existingConfig.auth.publicBaseUrl : "request-derived"}`,
        "Account flow: sign up or sign in at /auth, then claim first-admin access or redeem an invite",
        `Storage: ${existingConfig.storage.provider}`,
        `Secrets: ${existingConfig.secrets.provider} (strict mode ${existingConfig.secrets.strictMode ? "on" : "off"})`,
      ].join("\n"),
      "Configuration ready",
    );

    p.note(
      [
        `Run: ${pc.cyan("paperclipai run")}`,
        `Reconfigure later: ${pc.cyan("paperclipai configure")}`,
        `Diagnose setup: ${pc.cyan("paperclipai doctor")}`,
      ].join("\n"),
      "Next commands",
    );

    let shouldRunNow = opts.run === true || opts.yes === true;
    if (!shouldRunNow && !opts.invokedByRun && process.stdin.isTTY && process.stdout.isTTY) {
      const answer = await p.confirm({
        message: "Start Paperclip now?",
        initialValue: true,
      });
      if (!p.isCancel(answer)) {
        shouldRunNow = answer;
      }
    }

    if (shouldRunNow && !opts.invokedByRun) {
      process.env.PAPERCLIP_OPEN_ON_LISTEN = "true";
      const { runCommand } = await import("./run.js");
      await runCommand({ config: configPath });
      return;
    }

    p.outro("Existing Paperclip setup is ready.");
    return;
  }

  let setupMode: SetupMode = "quickstart";
  if (opts.yes) {
    p.log.message(
      pc.dim(
        opts.bind
          ? `\`--yes\` enabled: using Quickstart defaults with bind=${opts.bind}.`
          : "`--yes` enabled: using Quickstart defaults.",
      ),
    );
  } else {
    const setupModeChoice = await p.select({
      message: "Choose setup path",
      options: [
        {
          value: "quickstart" as const,
          label: "Quickstart",
          hint: "Recommended: local defaults + ready to run",
        },
        {
          value: "advanced" as const,
          label: "Advanced setup",
          hint: "Customize database, server, storage, and more",
        },
      ],
      initialValue: "quickstart",
    });
    if (p.isCancel(setupModeChoice)) {
      p.cancel("Setup cancelled.");
      return;
    }
    setupMode = setupModeChoice as SetupMode;
  }

  const tc = getTelemetryClient();
  if (tc) trackInstallStarted(tc);

  const { defaults: derivedDefaults, usedEnvKeys, ignoredEnvKeys } = quickstartDefaultsFromEnv({
    preferLoopback: opts.yes === true && !opts.bind,
  });
  const explicitDatabaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  let {
    database,
    logging,
    server,
    auth,
    storage,
    secrets,
  } = derivedDefaults;

  if (opts.bind === "loopback" || opts.bind === "lan" || opts.bind === "tailnet") {
    const preset = buildPresetServerConfig(opts.bind, {
      port: server.port,
      allowedHostnames: server.allowedHostnames,
      serveUi: server.serveUi,
    });
    server = preset.server;
    auth = preset.auth;
    if (opts.bind === "tailnet" && server.host === "127.0.0.1") {
      p.log.warn(TAILNET_BIND_WARNING);
    }
  }

  if (setupMode === "advanced") {
    p.log.step(pc.bold("Database"));
    database = await promptDatabase(database);

    p.log.step(pc.bold("Logging"));
    logging = await promptLogging();

    p.log.step(pc.bold("Server"));
    ({ server, auth } = await promptServer({ currentServer: server, currentAuth: auth }));

    p.log.step(pc.bold("Storage"));
    storage = await promptStorage(storage);

    p.log.step(pc.bold("Secrets"));
    const secretsDefaults = defaultSecretsConfig();
    secrets = {
      provider: secrets.provider ?? secretsDefaults.provider,
      strictMode: secrets.strictMode ?? secretsDefaults.strictMode,
      localEncrypted: {
        keyFilePath: secrets.localEncrypted?.keyFilePath ?? secretsDefaults.localEncrypted.keyFilePath,
      },
    };
    p.log.message(
      pc.dim(
        `Using defaults: provider=${secrets.provider}, strictMode=${secrets.strictMode}, keyFile=${secrets.localEncrypted.keyFilePath}`,
      ),
    );
  } else {
    p.log.step(pc.bold("Quickstart"));
    p.log.message(
      pc.dim(
        opts.bind
          ? `Using quickstart defaults with bind=${opts.bind}.`
          : `Using quickstart defaults: ${server.exposure} @ ${describeServerBinding(server)}.`,
      ),
    );
    if (!database.connectionString && !explicitDatabaseUrl) {
      if (opts.yes) {
        throw new Error(
          "An external PostgreSQL URL is required. Set DATABASE_URL or run interactive onboarding.",
        );
      }
      database = await promptDatabase(database);
    }
    if (usedEnvKeys.length > 0) {
      p.log.message(pc.dim(`Environment-aware defaults active (${usedEnvKeys.length} env var(s) detected).`));
    } else {
      p.log.message(
        pc.dim("No optional environment overrides detected: using file storage and local encrypted secrets."),
      );
    }
    for (const ignored of ignoredEnvKeys) {
      p.log.message(pc.dim(`Ignored ${ignored.key}: ${ignored.reason}`));
    }
  }

  const selectedDatabaseUrl = database.connectionString ?? explicitDatabaseUrl;
  if (!selectedDatabaseUrl) {
    throw new Error(
      "An external PostgreSQL URL is required. Set DATABASE_URL or configure database.connectionString.",
    );
  }
  const validatedDatabaseUrl = validateExternalPostgresConnectionString(
    selectedDatabaseUrl,
    database.connectionString ? "database.connectionString" : "DATABASE_URL",
  );

  const databaseSpinner = p.spinner();
  databaseSpinner.start("Testing external PostgreSQL connection...");
  try {
    const { createDb } = await import("@paperclipai/db");
    const db = createDb(validatedDatabaseUrl);
    try {
      await db.execute("SELECT 1");
    } finally {
      await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
    }
    databaseSpinner.stop("External PostgreSQL connection successful");
  } catch (error) {
    databaseSpinner.stop(pc.red("External PostgreSQL connection failed"));
    throw new Error(
      `Cannot connect to the configured external PostgreSQL database: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const config: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "onboard",
    },
    database,
    logging,
    server,
    auth,
    telemetry: {
      enabled: true,
    },
    storage,
    secrets,
  };
  paperclipConfigSchema.parse(config);

  const authSecretProvision = provisionPrimaryBetterAuthSecret(configPath);

  const keyResult = ensureLocalSecretsKeyFile(config, configPath);
  if (keyResult.status === "created") {
    p.log.success(`Created local secrets key file at ${pc.dim(keyResult.path)}`);
  } else if (keyResult.status === "existing") {
    p.log.message(pc.dim(`Using existing local secrets key file at ${keyResult.path}`));
  }

  writeConfig(config, opts.config);

  if (tc) trackInstallCompleted(tc, { adapterType: "other" });

  p.note(
    [
      `Database: ${
        database.connectionString
          ? redactExternalPostgresConnectionString(database.connectionString)
          : redactExternalPostgresConnectionString(explicitDatabaseUrl!)
      }`,
      `Logging: ${logging.mode} -> ${logging.logDir}`,
      `Server: ${server.exposure} @ ${describeServerBinding(server)}`,
      `Allowed hosts: ${server.allowedHostnames.length > 0 ? server.allowedHostnames.join(", ") : "(loopback only)"}`,
      `Auth origin: ${server.exposure === "public" ? auth.publicBaseUrl : "request-derived"}`,
      "Account flow: sign up or sign in at /auth, then claim first-admin access or redeem an invite",
      `Better Auth secret: persisted in ${authSecretProvision.path}`,
      `Storage: ${storage.provider}`,
      `Secrets: ${secrets.provider} (strict mode ${secrets.strictMode ? "on" : "off"})`,
    ].join("\n"),
    "Configuration saved",
  );

  p.note(
    [
      `Run: ${pc.cyan("paperclipai run")}`,
      `Reconfigure later: ${pc.cyan("paperclipai configure")}`,
      `Diagnose setup: ${pc.cyan("paperclipai doctor")}`,
    ].join("\n"),
    "Next commands",
  );

  let shouldRunNow = opts.run === true || opts.yes === true;
  if (!shouldRunNow && !opts.invokedByRun && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await p.confirm({
      message: "Start Paperclip now?",
      initialValue: true,
    });
    if (!p.isCancel(answer)) {
      shouldRunNow = answer;
    }
  }

  if (shouldRunNow && !opts.invokedByRun) {
    process.env.PAPERCLIP_OPEN_ON_LISTEN = "true";
    const { runCommand } = await import("./run.js");
    await runCommand({ config: configPath });
    return;
  }

  p.outro("You're all set!");
}
