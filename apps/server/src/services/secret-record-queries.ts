import { and, eq, ne } from "drizzle-orm";
import {
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  secretAccessEvents,
  userSecretDefinitions,
  type Db,
} from "@paperclipai/db";
import {
  isCanonicalUuid,
  secretProviderConfigPayloadSchema,
  type SecretBindingTargetType,
  type SecretProvider,
  type SecretProviderConfigHealthResponse,
  type SecretProviderConfigHealthStatus,
  type SecretProviderConfigStatus,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import type { SecretProviderHealthCheck, SecretProviderVaultRuntimeConfig } from "../secrets/types.js";
import {
  COMING_SOON_SECRET_PROVIDERS,
  type DbTransaction,
  SECRET_KEY_RE,
} from "./secret-mutation-foundation.js";
import {
  assertClass3StaticLeaseAllowed,
  type SecretBindingContext,
  type SecretConsumerContext,
} from "./secrets.js";
import { assertSelectableProviderConfig } from "./secret-resolution-errors.js";
import { type SecretsContext } from "./secrets.js";

export function buildSecretsSecretRecordQueries(scope: SecretsContext) {
  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
  };

  async function getById(id: string, source: Pick<Db | DbTransaction, "select"> = scope.db) {
    if (!isCanonicalUuid(id)) return null;
    return source
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByName(companyId: string, name: string) {
    return scope.db
      .select()
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, companyId),
          eq(companySecrets.scope, "company"),
          eq(companySecrets.name, name),
          ne(companySecrets.status, "deleted"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getByKey(companyId: string, key: string) {
    if (!SECRET_KEY_RE.test(key)) return null;
    return scope.db
      .select()
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, companyId),
          eq(companySecrets.key, key),
          eq(companySecrets.scope, "company"),
          ne(companySecrets.status, "deleted"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getUserSecretDefinitionById(
    companyId: string,
    definitionId: string,
    source: Pick<Db | DbTransaction, "select"> = scope.db,
  ) {
    if (!isCanonicalUuid(companyId) || !isCanonicalUuid(definitionId)) {
      return null;
    }
    return source
      .select()
      .from(userSecretDefinitions)
      .where(and(eq(userSecretDefinitions.companyId, companyId), eq(userSecretDefinitions.id, definitionId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getUserSecretDefinitionByKey(
    companyId: string,
    key: string,
    source: Pick<Db | DbTransaction, "select"> = scope.db,
  ) {
    if (!isCanonicalUuid(companyId) || !SECRET_KEY_RE.test(key)) return null;
    return source
      .select()
      .from(userSecretDefinitions)
      .where(
        and(
          eq(userSecretDefinitions.companyId, companyId),
          eq(userSecretDefinitions.key, key),
          ne(userSecretDefinitions.status, "deleted"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function resolveUserSecretDefinition(
    companyId: string,
    input: { definitionId?: string | null; definitionKey?: string | null },
    source: Pick<Db | DbTransaction, "select"> = scope.db,
  ) {
    const definition = input.definitionId
      ? await getUserSecretDefinitionById(companyId, input.definitionId, source)
      : input.definitionKey
        ? await getUserSecretDefinitionByKey(companyId, input.definitionKey, source)
        : null;
    if (!definition || definition.deletedAt || definition.status === "deleted") {
      throw notFound("User secret definition not found");
    }
    if (definition.companyId !== companyId) {
      throw unprocessable("User secret definition must belong to same company");
    }
    return definition;
  }

  async function getUserSecretValue(input: { companyId: string; ownerUserId: string; definitionId: string }) {
    return scope.db
      .select()
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, input.companyId),
          eq(companySecrets.scope, "user"),
          eq(companySecrets.ownerUserId, input.ownerUserId),
          eq(companySecrets.userSecretDefinitionId, input.definitionId),
          ne(companySecrets.status, "deleted"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getUserSecretValueById(companyId: string, ownerUserId: string, secretId: string) {
    const secret = await getById(secretId);
    if (!secret || secret.status === "deleted" || secret.scope !== "user") {
      throw notFound("User secret value not found");
    }
    if (secret.companyId !== companyId || secret.ownerUserId !== ownerUserId) {
      throw notFound("User secret value not found");
    }
    return secret;
  }

  async function getSecretVersion(secretId: string, version: number) {
    return scope.db
      .select()
      .from(companySecretVersions)
      .where(and(eq(companySecretVersions.secretId, secretId), eq(companySecretVersions.version, version)))
      .then((rows) => rows[0] ?? null);
  }

  async function getBinding(input: {
    companyId: string;
    secretId: string;
    consumerType: SecretBindingTargetType;
    consumerId: string;
    configPath: string;
  }) {
    return scope.db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, input.companyId),
          eq(companySecretBindings.secretId, input.secretId),
          eq(companySecretBindings.targetType, input.consumerType),
          eq(companySecretBindings.targetId, input.consumerId),
          eq(companySecretBindings.configPath, input.configPath),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function assertBindingContext(
    companyId: string,
    secretId: string,
    context: SecretBindingContext | undefined,
  ) {
    if (!context) return null;
    if (!context.configPath) {
      throw unprocessable("Secret resolution requires a binding config path", {
        code: "binding_missing",
      });
    }
    const binding = await getBinding({
      companyId,
      secretId,
      consumerType: context.consumerType,
      consumerId: context.consumerId,
      configPath: context.configPath,
    });
    if (!binding) {
      throw unprocessable(
        `Secret is not bound to ${context.consumerType}:${context.consumerId} at ${context.configPath}`,
        { code: "binding_missing" },
      );
    }
    if (Array.isArray(context.allowedBindingIds) && !context.allowedBindingIds.includes(binding.id)) {
      throw unprocessable("Secret binding is outside the active low-trust boundary", {
        code: "binding_not_allowed",
      });
    }
    assertClass3StaticLeaseAllowed({
      targetType: binding.targetType as SecretBindingTargetType,
      configPath: binding.configPath,
      projectionClass: binding.projectionClass,
      projectionAllowlistKey: binding.projectionAllowlistKey,
    });
    return binding;
  }

  async function recordAccessEvent(input: {
    companyId: string;
    secretId: string;
    userSecretDefinitionId?: string | null;
    secretScope?: string | null;
    version: number | null;
    provider: SecretProvider;
    context: SecretConsumerContext | undefined;
    credentialOwnerUserId?: string | null;
    credentialSubjectType?: string | null;
    credentialSubjectId?: string | null;
    outcome: "success" | "failure";
    errorCode?: string | null;
  }) {
    if (!input.context) return;
    await scope.db.insert(secretAccessEvents).values({
      companyId: input.companyId,
      secretId: input.secretId,
      userSecretDefinitionId: input.userSecretDefinitionId ?? null,
      secretScope: input.secretScope ?? "company",
      version: input.version,
      provider: input.provider,
      responsibleUserId: input.context.responsibleUserId ?? null,
      credentialOwnerUserId: input.credentialOwnerUserId ?? null,
      credentialSubjectType: input.credentialSubjectType ?? null,
      credentialSubjectId: input.credentialSubjectId ?? null,
      actorType: input.context.actorType ?? "system",
      actorId: input.context.actorId ?? null,
      consumerType: input.context.consumerType,
      consumerId: input.context.consumerId,
      configPath: input.context.configPath ?? null,
      taskId: input.context.taskId ?? null,
      runId: input.context.runId ?? null,
      pluginId: input.context.pluginId ?? null,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
    });
  }

  async function assertSecretInCompany(
    companyId: string,
    secretId: string,
    source: Pick<Db | DbTransaction, "select"> = scope.db,
  ) {
    const secret = await getById(secretId, source);
    if (!secret) throw notFound("Secret not found");
    if (secret.status === "deleted") throw notFound("Secret not found");
    if (secret.companyId !== companyId) throw unprocessable("Secret must belong to same company");
    if (secret.scope !== "company") throw unprocessable("Secret references require company-scoped secrets");
    return secret;
  }

  async function getProviderConfigById(id: string) {
    if (!isCanonicalUuid(id)) return null;
    return scope.db
      .select()
      .from(companySecretProviderConfigs)
      .where(eq(companySecretProviderConfigs.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function assertProviderConfigForSecret(
    companyId: string,
    provider: SecretProvider,
    providerConfigId: string | null | undefined,
  ) {
    if (!providerConfigId) return null;
    const providerConfig = await getProviderConfigById(providerConfigId);
    if (!providerConfig) throw notFound("Provider vault not found");
    assertSelectableProviderConfig(providerConfig, companyId, provider);
    return providerConfig;
  }

  function toProviderVaultRuntimeConfig(
    providerConfig: Awaited<ReturnType<typeof getProviderConfigById>> | null,
  ): SecretProviderVaultRuntimeConfig | null {
    if (!providerConfig) return null;
    return {
      id: providerConfig.id,
      provider: providerConfig.provider as SecretProvider,
      status: providerConfig.status,
      config: providerConfig.config ?? {},
    };
  }

  async function getSelectableRuntimeProviderConfig(input: {
    companyId: string;
    provider: SecretProvider;
    providerConfigId: string | null | undefined;
  }) {
    const providerConfig = await assertProviderConfigForSecret(
      input.companyId,
      input.provider,
      input.providerConfigId,
    );
    return toProviderVaultRuntimeConfig(providerConfig);
  }

  function validateProviderConfigPayload(
    provider: SecretProvider,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const parsed = secretProviderConfigPayloadSchema.safeParse({
      provider,
      config,
    });
    if (!parsed.success) {
      throw unprocessable("Invalid provider vault config", parsed.error.flatten());
    }
    return parsed.data.config;
  }

  function toDraftProviderVaultRuntimeConfig(input: {
    companyId: string;
    provider: SecretProvider;
    config: Record<string, unknown>;
  }): SecretProviderVaultRuntimeConfig {
    return {
      id: `discovery-preview-${input.companyId}`,
      provider: input.provider,
      status: "ready",
      config: validateProviderConfigPayload(input.provider, input.config),
    };
  }

  function providerConfigHealth(input: {
    id: string;
    provider: SecretProvider;
    status: SecretProviderConfigStatus;
    config: Record<string, unknown>;
  }): Omit<SecretProviderConfigHealthResponse, "checkedAt"> | null {
    if (input.status === "disabled") {
      return {
        configId: input.id,
        provider: input.provider,
        status: "disabled",
        message: "Provider vault is disabled.",
        details: { code: "disabled", message: "Provider vault is disabled." },
      };
    }
    if (input.status === "coming_soon" || COMING_SOON_SECRET_PROVIDERS.has(input.provider)) {
      return {
        configId: input.id,
        provider: input.provider,
        status: "coming_soon",
        message: "Provider vault runtime is locked while coming soon.",
        details: {
          code: "runtime_locked",
          message: "Provider vault runtime is locked while coming soon.",
          guidance: ["Draft metadata may be saved, but create, rotate, and resolve stay unavailable."],
        },
      };
    }
    return null;
  }

  function mapProviderModuleHealth(input: {
    configId: string;
    provider: SecretProvider;
    providerStatus: SecretProviderConfigStatus;
    health: SecretProviderHealthCheck;
  }): Omit<SecretProviderConfigHealthResponse, "checkedAt"> {
    const status: SecretProviderConfigHealthStatus =
      input.health.status === "ok"
        ? input.providerStatus === "warning"
          ? "warning"
          : "ready"
        : input.health.status === "error"
          ? "error"
          : "warning";
    const guidance = [...(input.health.warnings ?? []), ...(input.health.backupGuidance ?? [])];
    return {
      configId: input.configId,
      provider: input.provider,
      status,
      message: input.health.message,
      details: {
        code: input.health.status === "ok" ? "provider_ready" : "provider_needs_attention",
        message: input.health.message,
        guidance: guidance.length > 0 ? guidance : undefined,
      },
    };
  }

  return {
    getById,
    getByName,
    getByKey,
    getUserSecretDefinitionById,
    getUserSecretDefinitionByKey,
    resolveUserSecretDefinition,
    getUserSecretValue,
    getUserSecretValueById,
    getSecretVersion,
    getBinding,
    assertBindingContext,
    recordAccessEvent,
    assertSecretInCompany,
    getProviderConfigById,
    assertProviderConfigForSecret,
    toProviderVaultRuntimeConfig,
    getSelectableRuntimeProviderConfig,
    validateProviderConfigPayload,
    toDraftProviderVaultRuntimeConfig,
    providerConfigHealth,
    mapProviderModuleHealth,
  };
}
