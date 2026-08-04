import { Command } from "commander";
import pc from "picocolors";
import type {
  CompanyPortabilityEnvInput,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityInclude,
  CompanySecret,
  SecretProvider,
  SecretProviderDescriptor,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SecretListOptions extends BaseClientOptions {
  companyId?: string;
}

interface SecretDeclarationsOptions extends BaseClientOptions {
  companyId?: string;
  include?: string;
  kind?: "all" | "secret" | "plain";
}

interface SecretCreateOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  key?: string;
  provider?: SecretProvider;
  value?: string;
  valueEnv?: string;
  description?: string;
}

interface SecretUpdateOptions extends BaseClientOptions {
  payloadJson?: string;
}

interface SecretRotateOptions extends BaseClientOptions {
  value?: string;
  valueEnv?: string;
}

interface SecretDeleteOptions extends BaseClientOptions {
  yes?: boolean;
  confirm?: string;
}

interface SecretLinkOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  key?: string;
  provider?: SecretProvider;
  externalRef?: string;
  providerVersionRef?: string;
  description?: string;
}

interface SecretDoctorOptions extends BaseClientOptions {
  companyId?: string;
}

interface SecretJsonOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson?: string;
}

interface SecretProviderHealth {
  provider: SecretProvider;
  status: "ok" | "warn" | "error";
  message: string;
  warnings?: string[];
  backupGuidance?: string[];
  details?: Record<string, unknown>;
}

interface SecretProviderHealthResponse {
  providers: SecretProviderHealth[];
}

const DEFAULT_DECLARATION_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: false,
  projects: true,
  issues: false,
  skills: false,
};

export function parseSecretsInclude(input: string | undefined): CompanyPortabilityInclude {
  if (!input?.trim()) return { ...DEFAULT_DECLARATION_INCLUDE };
  const values = input.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const unsupported = values.filter(
    (value) => value !== "company" && value !== "projects",
  );
  if (unsupported.length > 0) {
    throw new Error(
      "Invalid --include value. Use one or more of: company,projects",
    );
  }
  const include = {
    company: values.includes("company"),
    agents: false,
    projects: values.includes("projects"),
    issues: false,
    skills: false,
  };
  if (!Object.values(include).some(Boolean)) {
    throw new Error(
      "Invalid --include value. Use one or more of: company,projects",
    );
  }
  return include;
}

function readValueFromOptions(opts: { value?: string; valueEnv?: string }): string {
  if (opts.value !== undefined && opts.valueEnv !== undefined) {
    throw new Error("Use only one of --value or --value-env.");
  }
  if (opts.valueEnv !== undefined) {
    const value = process.env[opts.valueEnv];
    if (!value) throw new Error(`Environment variable ${opts.valueEnv} is empty or unset.`);
    return value;
  }
  if (opts.value !== undefined) return opts.value;
  throw new Error("Secret value is required. Pass --value or --value-env.");
}

function renderDeclaration(input: CompanyPortabilityEnvInput): Record<string, unknown> {
  const scope = input.projectSlug
    ? `project:${input.projectSlug}`
    : "company";
  return {
    key: input.key,
    scope,
    kind: input.kind,
    requirement: input.requirement,
    portability: input.portability,
    hasDefault: input.defaultValue !== null && input.defaultValue.length > 0,
    description: input.description,
  };
}

function renderSecret(secret: CompanySecret): Record<string, unknown> {
  return {
    id: secret.id,
    name: secret.name,
    key: secret.key,
    provider: secret.provider,
    status: secret.status,
    managedMode: secret.managedMode,
    latestVersion: secret.latestVersion,
    externalRef: secret.externalRef ? "yes" : "no",
  };
}

function printProviderHealth(rows: SecretProviderHealth[], json: boolean): void {
  if (json) {
    printOutput(rows, { json: true });
    return;
  }
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        id: row.provider,
        status: row.status,
        message: row.message,
      }),
    );
    for (const warning of row.warnings ?? []) {
      console.log(pc.yellow(`warning=${warning}`));
    }
    const missingConfig = asStringArray(row.details?.missingConfig);
    if (missingConfig.length > 0) {
      console.log(pc.dim(`missingConfig=${missingConfig.join(",")}`));
    }
    const credentialSource = typeof row.details?.credentialSource === "string"
      ? row.details.credentialSource
      : null;
    if (credentialSource) {
      console.log(pc.dim(`credentialSource=${credentialSource}`));
    }
    const detectedCredentialSources = asStringArray(row.details?.detectedCredentialSources);
    if (detectedCredentialSources.length > 0) {
      console.log(pc.dim(`detectedCredentialSources=${detectedCredentialSources.join(",")}`));
    }
    for (const guidance of row.backupGuidance ?? []) {
      console.log(pc.dim(`backup=${guidance}`));
    }
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

export function registerSecretCommands(program: Command): void {
  const secrets = program.command("secrets").description("Secret declaration and provider operations");

  addCommonClientOptions(
    secrets
      .command("list")
      .description("List secret metadata for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: SecretListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<CompanySecret[]>(apiPath`/api/companies/${ctx.companyId}/secrets`)) ?? [];
          printOutput(ctx.json ? rows : rows.map(renderSecret), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("declarations")
      .description("List portable env declarations emitted by company export")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--include <values>", "Comma-separated include set: company,projects", "company,projects")
      .option("--kind <kind>", "Filter declarations: all | secret | plain", "all")
      .action(async (opts: SecretDeclarationsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const kind = opts.kind ?? "all";
          if (!["all", "secret", "plain"].includes(kind)) {
            throw new Error("Invalid --kind value. Use: all, secret, plain");
          }
          const preview = await ctx.api.post<CompanyPortabilityExportPreviewResult>(
            apiPath`/api/companies/${ctx.companyId}/exports/preview`,
            { include: parseSecretsInclude(opts.include) },
          );
          const declarations = (preview?.manifest.envInputs ?? [])
            .filter((entry) => kind === "all" || entry.kind === kind);
          printOutput(ctx.json ? declarations : declarations.map(renderDeclaration), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("create")
      .description("Create a Paperclip-managed secret")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Secret display name")
      .option("--key <key>", "Portable secret key")
      .option("--provider <provider>", "Secret provider id")
      .option("--value <value>", "Secret value")
      .option("--value-env <name>", "Read secret value from an environment variable")
      .option("--description <text>", "Description")
      .action(async (opts: SecretCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const created = await ctx.api.post<CompanySecret>(apiPath`/api/companies/${ctx.companyId}/secrets`, {
            name: opts.name,
            key: opts.key,
            provider: opts.provider,
            value: readValueFromOptions(opts),
            description: opts.description,
          });
          printOutput(ctx.json ? created : renderSecret(created!), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("link")
      .description("Link an external provider-owned secret without storing its value in Paperclip")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Secret display name")
      .requiredOption("--provider <provider>", "Secret provider id")
      .requiredOption("--external-ref <ref>", "Provider secret ARN/name/path/reference")
      .option("--key <key>", "Portable secret key")
      .option("--provider-version-ref <ref>", "Provider version id or label")
      .option("--description <text>", "Description")
      .action(async (opts: SecretLinkOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const created = await ctx.api.post<CompanySecret>(apiPath`/api/companies/${ctx.companyId}/secrets`, {
            name: opts.name,
            key: opts.key,
            provider: opts.provider,
            managedMode: "external_reference",
            externalRef: opts.externalRef,
            providerVersionRef: opts.providerVersionRef,
            description: opts.description,
          });
          printOutput(ctx.json ? created : renderSecret(created!), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("update")
      .description("Update secret metadata")
      .argument("<secretId>", "Secret ID")
      .requiredOption("--payload-json <json>", "UpdateSecret JSON payload")
      .action(async (secretId: string, opts: SecretUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.patch(apiPath`/api/secrets/${secretId}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("rotate")
      .description("Rotate a Paperclip-managed secret value")
      .argument("<secretId>", "Secret ID")
      .option("--value <value>", "New secret value")
      .option("--value-env <name>", "Read new secret value from an environment variable")
      .action(async (secretId: string, opts: SecretRotateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/secrets/${secretId}/rotate`, { value: readValueFromOptions(opts) }), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("usage")
      .description("Show where a secret is referenced")
      .argument("<secretId>", "Secret ID")
      .action(async (secretId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/secrets/${secretId}/usage`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("access-events")
      .description("List secret access events")
      .argument("<secretId>", "Secret ID")
      .action(async (secretId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/secrets/${secretId}/access-events`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("delete")
      .description("Delete a secret")
      .argument("<secretId>", "Secret ID")
      .option("--yes", "Required safety flag to confirm destructive action", false)
      .option("--confirm <secretId>", "Repeat the secret ID to confirm deletion")
      .action(async (secretId: string, opts: SecretDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("Deletion requires --yes.");
          if (opts.confirm !== secretId) {
            throw new Error("Deletion requires --confirm <secretId> matching the secret ID.");
          }
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.delete(apiPath`/api/secrets/${secretId}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("doctor")
      .description("Run secret provider health checks through the Paperclip API")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: SecretDoctorOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const health = await ctx.api.get<SecretProviderHealthResponse>(
            apiPath`/api/companies/${ctx.companyId}/secret-providers/health`,
          );
          printProviderHealth(health?.providers ?? [], ctx.json);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("providers")
      .description("List configured secret provider descriptors")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: SecretDoctorOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<SecretProviderDescriptor[]>(
            apiPath`/api/companies/${ctx.companyId}/secret-providers`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("provider-configs")
      .description("List company secret provider vault configs")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: SecretDoctorOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/secret-provider-configs`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCompanySecretJsonPost(secrets, "provider-config:create", "Create a secret provider vault config", "secret-provider-configs");
  addCompanySecretJsonPost(
    secrets,
    "provider-config:discovery-preview",
    "Preview provider vault secret discovery",
    "secret-provider-configs/discovery/preview",
  );
  addSecretProviderConfigGet(secrets, "provider-config:get", "Get a secret provider vault config", "");
  addSecretProviderConfigPatch(secrets, "provider-config:update", "Update a secret provider vault config", "");
  addSecretProviderConfigPost(secrets, "provider-config:default", "Set the default provider vault config", "default");
  addSecretProviderConfigPost(secrets, "provider-config:health", "Check provider vault health", "health");
  addSecretProviderConfigDelete(secrets, "provider-config:delete", "Delete a secret provider vault config");
  addCompanySecretJsonPost(secrets, "remote-import:preview", "Preview remote secret import", "secrets/remote-import/preview");
  addCompanySecretJsonPost(secrets, "remote-import", "Import selected remote secrets", "secrets/remote-import");

}

function addCompanySecretJsonPost(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (opts: SecretJsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addSecretProviderConfigGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<configId>", "Provider config ID")
      .action(async (configId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(`${apiPath`/api/secret-provider-configs/${configId}`}${suffix ? `/${suffix}` : ""}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addSecretProviderConfigPatch(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<configId>", "Provider config ID")
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (configId: string, opts: SecretJsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.patch(`${apiPath`/api/secret-provider-configs/${configId}`}${suffix ? `/${suffix}` : ""}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addSecretProviderConfigPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<configId>", "Provider config ID")
      .action(async (configId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(`${apiPath`/api/secret-provider-configs/${configId}`}/${suffix}`, {}), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addSecretProviderConfigDelete(parent: Command, name: string, description: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<configId>", "Provider config ID")
      .action(async (configId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.delete(apiPath`/api/secret-provider-configs/${configId}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
