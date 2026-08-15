import * as p from "@clack/prompts";
import path from "node:path";
import pc from "picocolors";
import {
  redactExternalPostgresConnectionString,
  validateExternalPostgresConnectionString,
} from "@paperclipai/db";
import {
  ALL_INTERFACES_BIND_HOST,
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  LOOPBACK_BIND_HOST,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  parseExactNonEmptyHostnameCsv,
  parseExactStorageEndpoint,
  parseExactStorageName,
  parseExactStoragePrefix,
  parseExactPublicOrigin,
  parseOptionalBooleanEnvironmentValue,
  parseOptionalExactNonEmptyEnvironmentValue,
  parseOptionalEnumEnvironmentValue,
  resolveRuntimeBind,
  resolveServerPort,
  type BindMode,
} from "@paperclipai/shared";
import {
  configExists,
  readConfig,
  resolveConfigPath,
  writeConfig,
} from "../config/store.js";
import {
  paperclipConfigSchema,
  type PaperclipConfig,
} from "../config/schema.js";
import { ensureLocalSecretsKeyFile } from "../config/secrets-key.js";
import { provisionPrimaryBetterAuthSecret } from "../config/auth-secret.js";
import { promptDatabase } from "../prompts/database.js";
import { defaultSecretsConfig } from "../prompts/secrets.js";
import { defaultStorageConfig } from "../prompts/storage.js";
import {
  buildPresetServerConfig,
  detectTailnetBindHost,
} from "../config/server-bind.js";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveDefaultLogsDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import { getTelemetryClient, trackInstallStarted } from "../telemetry.js";

type OnboardOptions = {
  config?: string;
  run?: boolean;
  yes?: boolean;
  invokedByRun?: boolean;
  bind?: BindMode;
};

type OnboardDefaults = Pick<
  PaperclipConfig,
  "database" | "logging" | "server" | "auth" | "storage" | "secrets"
>;

const ONBOARD_ENV_KEYS = [
  "PAPERCLIP_PUBLIC_URL",
  "DATABASE_URL",
  "PAPERCLIP_DEPLOYMENT_EXPOSURE",
  "PAPERCLIP_BIND",
  "PAPERCLIP_BIND_HOST",
  "PAPERCLIP_TAILNET_BIND_HOST",
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

function resolvePathFromEnv(
  rawValue: string | undefined,
  environmentName: string,
): string | null {
  const exact = parseOptionalExactNonEmptyEnvironmentValue(
    rawValue,
    environmentName,
  );
  return exact === undefined ? null : path.resolve(expandHomePrefix(exact));
}

function describeServerBinding(
  server: Pick<PaperclipConfig["server"], "bind" | "customBindHost" | "port">,
): string {
  const bind = server.bind;
  const detail =
    bind === "custom"
      ? server.customBindHost
      : bind === "tailnet"
        ? "detected Tailscale address"
        : bind === "lan"
          ? ALL_INTERFACES_BIND_HOST
          : LOOPBACK_BIND_HOST;
  return `${bind}${detail ? ` (${detail})` : ""}:${server.port}`;
}

function printNextCommands(): void {
  p.note(
    [
      `Run: ${pc.cyan("paperclipai run")}`,
      `Reconfigure later: ${pc.cyan("paperclipai configure")}`,
      `Diagnose setup: ${pc.cyan("paperclipai doctor")}`,
    ].join("\n"),
    "Next commands",
  );
}

async function startConfiguredServerIfRequested(
  opts: OnboardOptions,
  configPath: string,
): Promise<boolean> {
  let shouldRunNow = opts.run === true || opts.yes === true;
  if (
    !shouldRunNow &&
    !opts.invokedByRun &&
    process.stdin.isTTY &&
    process.stdout.isTTY
  ) {
    const answer = await p.confirm({
      message: "Start Paperclip now?",
      initialValue: true,
    });
    if (!p.isCancel(answer)) {
      shouldRunNow = answer;
    }
  }

  if (!shouldRunNow || opts.invokedByRun) return false;
  process.env.PAPERCLIP_OPEN_ON_LISTEN = "true";
  const { runCommand } = await import("./run.js");
  await runCommand({ config: configPath });
  return true;
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
  let configuredPublicUrl: string | undefined;
  if (process.env.PAPERCLIP_PUBLIC_URL !== undefined) {
    try {
      configuredPublicUrl = parseExactPublicOrigin(
        process.env.PAPERCLIP_PUBLIC_URL,
      );
    } catch (error) {
      throw new Error(
        `PAPERCLIP_PUBLIC_URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const deploymentExposureFromEnv = parseOptionalEnumEnvironmentValue(
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE,
    "PAPERCLIP_DEPLOYMENT_EXPOSURE",
    DEPLOYMENT_EXPOSURES,
  );
  const deploymentExposure = preferLoopback
    ? "private"
    : (deploymentExposureFromEnv ?? "private");
  if (
    !preferLoopback &&
    deploymentExposure === "private" &&
    configuredPublicUrl
  ) {
    throw new Error(
      "PAPERCLIP_PUBLIC_URL is only valid when PAPERCLIP_DEPLOYMENT_EXPOSURE=public",
    );
  }
  const publicUrl =
    deploymentExposure === "public" ? configuredPublicUrl : undefined;
  const bindFromEnv = parseOptionalEnumEnvironmentValue(
    process.env.PAPERCLIP_BIND,
    "PAPERCLIP_BIND",
    BIND_MODES,
  );
  const customBindHostFromEnv = parseOptionalExactNonEmptyEnvironmentValue(
    process.env.PAPERCLIP_BIND_HOST,
    "PAPERCLIP_BIND_HOST",
  );
  const bind = preferLoopback
    ? "loopback"
    : (bindFromEnv ?? (deploymentExposure === "public" ? "lan" : "loopback"));
  const resolvedBind = resolveRuntimeBind({
    exposure: deploymentExposure,
    bind,
    customBindHost: customBindHostFromEnv,
    tailnetBindHost: bind === "tailnet" ? detectTailnetBindHost() : undefined,
  });
  const authPublicBaseUrl = publicUrl;
  const allowedHostnamesFromEnv =
    process.env.PAPERCLIP_ALLOWED_HOSTNAMES === undefined
      ? []
      : parseExactNonEmptyHostnameCsv(process.env.PAPERCLIP_ALLOWED_HOSTNAMES);
  const storageProvider =
    parseOptionalEnumEnvironmentValue(
      process.env.PAPERCLIP_STORAGE_PROVIDER,
      "PAPERCLIP_STORAGE_PROVIDER",
      STORAGE_PROVIDERS,
    ) ?? defaultStorage.provider;
  const secretsProvider =
    parseOptionalEnumEnvironmentValue(
      process.env.PAPERCLIP_SECRETS_PROVIDER,
      "PAPERCLIP_SECRETS_PROVIDER",
      SECRET_PROVIDERS,
    ) ?? defaultSecrets.provider;
  const defaults: OnboardDefaults = {
    database: {},
    logging: {
      mode: "file",
      logDir: resolveDefaultLogsDir(instanceId),
    },
    server: {
      exposure: deploymentExposure,
      bind: resolvedBind.bind,
      ...(resolvedBind.customBindHost
        ? { customBindHost: resolvedBind.customBindHost }
        : {}),
      port: resolveServerPort({ environmentValue: process.env.PORT }),
      allowedHostnames: allowedHostnamesFromEnv,
      serveUi:
        parseOptionalBooleanEnvironmentValue(
          process.env.SERVE_UI,
          "SERVE_UI",
        ) ?? true,
    },
    auth: {
      disableSignUp: false,
      ...(authPublicBaseUrl ? { publicBaseUrl: authPublicBaseUrl } : {}),
    },
    storage: {
      provider: storageProvider,
      localDisk: {
        baseDir:
          resolvePathFromEnv(
            process.env.PAPERCLIP_STORAGE_LOCAL_DIR,
            "PAPERCLIP_STORAGE_LOCAL_DIR",
          ) ?? defaultStorage.localDisk.baseDir,
      },
      s3: {
        bucket:
          process.env.PAPERCLIP_STORAGE_S3_BUCKET === undefined
            ? defaultStorage.s3.bucket
            : parseExactStorageName(
                process.env.PAPERCLIP_STORAGE_S3_BUCKET,
                "PAPERCLIP_STORAGE_S3_BUCKET",
              ),
        region:
          process.env.PAPERCLIP_STORAGE_S3_REGION === undefined
            ? defaultStorage.s3.region
            : parseExactStorageName(
                process.env.PAPERCLIP_STORAGE_S3_REGION,
                "PAPERCLIP_STORAGE_S3_REGION",
              ),
        endpoint:
          process.env.PAPERCLIP_STORAGE_S3_ENDPOINT === undefined
            ? defaultStorage.s3.endpoint
            : parseExactStorageEndpoint(
                process.env.PAPERCLIP_STORAGE_S3_ENDPOINT,
              ),
        prefix:
          process.env.PAPERCLIP_STORAGE_S3_PREFIX === undefined
            ? defaultStorage.s3.prefix
            : parseExactStoragePrefix(process.env.PAPERCLIP_STORAGE_S3_PREFIX),
        forcePathStyle:
          parseOptionalBooleanEnvironmentValue(
            process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE,
            "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE",
          ) ?? defaultStorage.s3.forcePathStyle,
      },
    },
    secrets: {
      provider: secretsProvider,
      strictMode:
        parseOptionalBooleanEnvironmentValue(
          process.env.PAPERCLIP_SECRETS_STRICT_MODE,
          "PAPERCLIP_SECRETS_STRICT_MODE",
        ) ?? defaultSecrets.strictMode,
      localEncrypted: {
        keyFilePath:
          resolvePathFromEnv(
            process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE,
            "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
          ) ?? defaultSecrets.localEncrypted.keyFilePath,
      },
    },
  };
  const ignoredEnvKeys: Array<{ key: string; reason: string }> = [];
  if (preferLoopback) {
    const forcedLocalReason =
      "Ignored because --yes quickstart uses private loopback defaults";
    for (const key of [
      "PAPERCLIP_DEPLOYMENT_EXPOSURE",
      "PAPERCLIP_BIND",
      "PAPERCLIP_BIND_HOST",
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
    throw new Error(
      `Unsupported bind preset for onboard: ${opts.bind}. Use loopback, lan, or tailnet.`,
    );
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
      p.log.message(
        "Remove or replace the retired configuration, then run onboarding again.",
      );
      p.outro("");
      process.exitCode = 1;
      return;
    }
  }

  if (existingConfig) {
    p.log.message(
      pc.dim(
        "Existing Paperclip install detected; keeping the current configuration unchanged.",
      ),
    );
    p.log.message(
      pc.dim(
        `Use ${pc.cyan("paperclipai configure")} if you want to change settings.`,
      ),
    );

    const keyResult = ensureLocalSecretsKeyFile(existingConfig, configPath);
    if (keyResult.status === "created") {
      p.log.success(
        `Created local secrets key file at ${pc.dim(keyResult.path)}`,
      );
    } else if (keyResult.status === "existing") {
      p.log.message(
        pc.dim(`Using existing local secrets key file at ${keyResult.path}`),
      );
    }

    p.note(
      [
        "Existing config preserved",
        `Database: ${
          existingConfig.database.connectionString
            ? redactExternalPostgresConnectionString(
                existingConfig.database.connectionString,
              )
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

    printNextCommands();
    if (await startConfiguredServerIfRequested(opts, configPath)) return;

    p.outro("Existing Paperclip setup is ready.");
    return;
  }

  const tc = getTelemetryClient();
  if (tc) trackInstallStarted(tc);

  const {
    defaults: derivedDefaults,
    usedEnvKeys,
    ignoredEnvKeys,
  } = quickstartDefaultsFromEnv({
    preferLoopback: opts.yes === true && !opts.bind,
  });
  let { database, server, auth } = derivedDefaults;
  const { logging, storage, secrets } = derivedDefaults;
  let selectedDatabaseUrl =
    database.connectionString ?? process.env.DATABASE_URL;
  let selectedDatabaseSource =
    database.connectionString === undefined
      ? "DATABASE_URL"
      : "database.connectionString";

  if (
    opts.bind === "loopback" ||
    opts.bind === "lan" ||
    opts.bind === "tailnet"
  ) {
    const preset = buildPresetServerConfig(opts.bind, {
      port: server.port,
      allowedHostnames: server.allowedHostnames,
      serveUi: server.serveUi,
    });
    server = preset.server;
    auth = preset.auth;
    if (opts.bind === "tailnet" && !detectTailnetBindHost()) {
      throw new Error(
        "server.bind=tailnet requires a detected Tailscale address or PAPERCLIP_TAILNET_BIND_HOST",
      );
    }
  }

  p.log.step(pc.bold("Quickstart"));
  p.log.message(
    pc.dim(
      opts.bind
        ? `Using quickstart defaults with bind=${opts.bind}.`
        : `Using quickstart defaults: ${server.exposure} @ ${describeServerBinding(server)}.`,
    ),
  );
  if (selectedDatabaseUrl === undefined) {
    if (opts.yes) {
      throw new Error(
        "An external PostgreSQL URL is required. Set DATABASE_URL or run interactive onboarding.",
      );
    }
    const promptedDatabase = await promptDatabase(database);
    database = promptedDatabase;
    selectedDatabaseUrl = promptedDatabase.connectionString;
    selectedDatabaseSource = "database.connectionString";
  }
  if (usedEnvKeys.length > 0) {
    p.log.message(
      pc.dim(
        `Environment-aware defaults active (${usedEnvKeys.length} env var(s) detected).`,
      ),
    );
  } else {
    p.log.message(
      pc.dim(
        "No optional environment overrides detected: using file storage and local encrypted secrets.",
      ),
    );
  }
  for (const ignored of ignoredEnvKeys) {
    p.log.message(pc.dim(`Ignored ${ignored.key}: ${ignored.reason}`));
  }

  const validatedDatabaseUrl = validateExternalPostgresConnectionString(
    selectedDatabaseUrl,
    selectedDatabaseSource,
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
    p.log.success(
      `Created local secrets key file at ${pc.dim(keyResult.path)}`,
    );
  } else if (keyResult.status === "existing") {
    p.log.message(
      pc.dim(`Using existing local secrets key file at ${keyResult.path}`),
    );
  }

  writeConfig(config, opts.config);

  p.note(
    [
      `Database: ${redactExternalPostgresConnectionString(validatedDatabaseUrl)}`,
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

  printNextCommands();
  if (await startConfiguredServerIfRequested(opts, configPath)) return;

  p.outro("You're all set!");
}
