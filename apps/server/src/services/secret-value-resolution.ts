import { eq } from "drizzle-orm";
import { companySecrets } from "@paperclipai/db";
import {
  type AgentEnvConfig,
  type EnvBinding,
  type SecretProvider,
  envBindingSchema,
} from "@paperclipai/shared";
import { HttpError, notFound, unprocessable } from "../errors.js";
import { ENV_KEY_RE, REDACTED_SENTINEL } from "./secret-mutation-foundation.js";
import {
  asRecord,
  canonicalizeBinding,
  isSensitiveEnvKey,
  requireOptionalExactOpaqueSecretReference,
  type RuntimeSecretResolution,
  type SecretBindingContext,
  type SecretResolutionOptions,
} from "./secrets.js";
import { secretResolutionErrorCode } from "./secret-resolution-errors.js";
import { type SecretsContext } from "./secrets.js";
import { buildSecretsSecretRecordQueries } from "./secret-record-queries.js";

export function buildSecretsSecretValueResolution(
  scope: SecretsContext & ReturnType<typeof buildSecretsSecretRecordQueries>,
) {
  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
  };

  async function resolveSecretValueInternal(
    companyId: string,
    secretId: string,
    version: number | "latest",
    options?: SecretResolutionOptions,
  ): Promise<RuntimeSecretResolution> {
    const bindingContext = options?.bindingContext;
    const accessContext = options?.accessContext ?? bindingContext;
    const secret = await scope.getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.companyId !== companyId) throw unprocessable("Secret must belong to same company");
    if (secret.scope !== "company" && !options?.allowUserSecretScope) {
      throw unprocessable("User-scoped secrets must be resolved through user secret declarations", {
        code: "secret_scope_invalid",
      });
    }
    const resolvedVersion = version === "latest" ? secret.latestVersion : version;
    const providerId = secret.provider as SecretProvider;
    const configPath = accessContext?.configPath ?? null;
    try {
      if (secret.status === "deleted") {
        throw new HttpError(404, "Secret not found", {
          code: "secret_deleted",
        });
      }
      if (secret.status !== "active") {
        throw unprocessable("Secret is not active", {
          code: "secret_inactive",
        });
      }
      const binding = await scope.assertBindingContext(companyId, secret.id, bindingContext);
      const versionRow = await scope.getSecretVersion(secret.id, resolvedVersion);
      if (!versionRow)
        throw new HttpError(404, "Secret version not found", {
          code: "version_missing",
        });
      if (versionRow.status === "disabled" || versionRow.status === "destroyed" || versionRow.revokedAt) {
        throw unprocessable("Secret version is not active", {
          code: "version_inactive",
        });
      }
      const provider = scope.getSecretProvider(providerId);
      const providerConfig = await scope.getSelectableRuntimeProviderConfig({
        companyId,
        provider: providerId,
        providerConfigId: secret.providerConfigId,
      });
      requireOptionalExactOpaqueSecretReference(secret.externalRef, "Stored provider secret reference");
      requireOptionalExactOpaqueSecretReference(
        versionRow.providerVersionRef,
        "Stored provider secret version reference",
      );
      const value = await provider.resolveVersion({
        material: versionRow.material as Record<string, unknown>,
        externalRef: secret.externalRef,
        providerVersionRef: versionRow.providerVersionRef,
        providerConfig,
        context: {
          companyId,
          secretId: secret.id,
          secretKey: secret.key,
          version: resolvedVersion,
        },
      });
      await Promise.all([
        scope.db
          .update(companySecrets)
          .set({ lastResolvedAt: new Date(), updatedAt: new Date() })
          .where(eq(companySecrets.id, secret.id))
          .catch(() => undefined),
        scope
          .recordAccessEvent({
            companyId,
            secretId: secret.id,
            userSecretDefinitionId: secret.userSecretDefinitionId ?? null,
            secretScope: secret.scope,
            version: resolvedVersion,
            provider: providerId,
            context: accessContext,
            credentialOwnerUserId: secret.ownerUserId ?? null,
            credentialSubjectType: secret.scope === "user" ? "user" : null,
            credentialSubjectId: secret.ownerUserId ?? null,
            outcome: "success",
          })
          .catch(() => undefined),
      ]);
      return {
        value,
        manifestEntry: {
          configPath: configPath ?? "",
          envKey: configPath?.startsWith("env.") ? configPath.slice("env.".length) : null,
          secretId: secret.id,
          bindingId: binding?.id ?? null,
          secretKey: secret.key,
          version: resolvedVersion,
          provider: providerId,
          providerVersionRef: versionRow.providerVersionRef,
          outcome: "success",
        },
      };
    } catch (err) {
      const errorCode = secretResolutionErrorCode(err);
      await scope
        .recordAccessEvent({
          companyId,
          secretId: secret.id,
          userSecretDefinitionId: secret.userSecretDefinitionId ?? null,
          secretScope: secret.scope,
          version: resolvedVersion,
          provider: providerId,
          context: accessContext,
          credentialOwnerUserId: secret.ownerUserId ?? null,
          credentialSubjectType: secret.scope === "user" ? "user" : null,
          credentialSubjectId: secret.ownerUserId ?? null,
          outcome: "failure",
          errorCode,
        })
        .catch(() => undefined);
      throw err;
    }
  }

  function isSecretResolutionOptions(
    value: SecretBindingContext | SecretResolutionOptions | undefined,
  ): value is SecretResolutionOptions {
    return Boolean(value && ("bindingContext" in value || "accessContext" in value));
  }

  async function resolveSecretValue(
    companyId: string,
    secretId: string,
    version: number | "latest",
    contextOrOptions?: SecretBindingContext | SecretResolutionOptions,
  ): Promise<string> {
    const options = isSecretResolutionOptions(contextOrOptions)
      ? contextOrOptions
      : { bindingContext: contextOrOptions, accessContext: contextOrOptions };
    return (await resolveSecretValueInternal(companyId, secretId, version, options)).value;
  }

  async function resolveSecretVersion(
    companyId: string,
    secretId: string,
    version: number | "latest",
    context?: SecretBindingContext,
  ): Promise<number> {
    const secret = await scope.getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.companyId !== companyId) throw unprocessable("Secret must belong to same company");
    const resolvedVersion = version === "latest" ? secret.latestVersion : version;
    if (secret.status === "deleted") {
      throw new HttpError(404, "Secret not found", { code: "secret_deleted" });
    }
    if (secret.status !== "active") {
      throw unprocessable("Secret is not active", { code: "secret_inactive" });
    }
    await scope.assertBindingContext(companyId, secret.id, context);
    const versionRow = await scope.getSecretVersion(secret.id, resolvedVersion);
    if (!versionRow)
      throw new HttpError(404, "Secret version not found", {
        code: "version_missing",
      });
    if (versionRow.status === "disabled" || versionRow.status === "destroyed" || versionRow.revokedAt) {
      throw unprocessable("Secret version is not active", {
        code: "version_inactive",
      });
    }
    return resolvedVersion;
  }

  async function normalizeEnvConfig(
    companyId: string,
    envValue: unknown,
    opts?: NormalizeEnvOptions,
  ): Promise<AgentEnvConfig> {
    const record = asRecord(envValue);
    if (!record) throw unprocessable(`${opts?.fieldPath ?? "env"} must be an object`);

    const normalized: AgentEnvConfig = {};
    for (const [key, rawBinding] of Object.entries(record)) {
      if (!ENV_KEY_RE.test(key)) {
        throw unprocessable(`Invalid environment variable name: ${key}`);
      }

      const parsed = envBindingSchema.safeParse(rawBinding);
      if (!parsed.success) {
        throw unprocessable(`Invalid environment binding for key: ${key}`);
      }

      const binding = canonicalizeBinding(parsed.data as EnvBinding);
      if (binding.type === "plain") {
        if (opts?.strictMode && isSensitiveEnvKey(key) && binding.value.trim().length > 0) {
          throw unprocessable(`Strict secret mode requires secret references for sensitive key: ${key}`);
        }
        if (binding.value === REDACTED_SENTINEL) {
          throw unprocessable(`Refusing to persist redacted placeholder for key: ${key}`);
        }
        normalized[key] = binding;
        continue;
      }
      if (binding.type === "user_secret_ref") {
        normalized[key] = binding;
        continue;
      }

      await scope.assertSecretInCompany(companyId, binding.secretId);
      normalized[key] = {
        type: "secret_ref",
        secretId: binding.secretId,
        version: binding.version,
        projectionClass: binding.projectionClass,
        projectionAllowlistKey: binding.projectionAllowlistKey,
      };
    }
    return normalized;
  }

  return {
    resolveSecretValueInternal,
    isSecretResolutionOptions,
    resolveSecretValue,
    resolveSecretVersion,
    normalizeEnvConfig,
  };
}
