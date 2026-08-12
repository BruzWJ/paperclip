import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  like,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  companyMemberships,
  tasks,
  projects,
  routines,
  secretAccessEvents,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import type {
  AgentEnvConfig,
  CompanySecretBindingTarget,
  EnvBinding,
  RemoteSecretImportCandidate,
  RemoteSecretImportConflict,
  RemoteSecretImportRowResult,
  SecretProviderConfigDiscoveryPreviewResult,
  SecretBindingTargetType,
  SecretProjectionClass,
  SecretProvider,
  SecretProviderConfigHealthResponse,
  SecretProviderConfigHealthStatus,
  SecretProviderConfigStatus,
  SecretVersionSelector,
} from "@paperclipai/shared";
import {
  CLASS3_STATIC_LEASE_ALLOWLIST,
  createSecretProviderConfigSchema,
  envBindingSchema,
  isCanonicalUuid,
  secretProviderConfigPayloadSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  updateSecretProviderConfigSchema,
} from "@paperclipai/shared";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { createSecretProviderRegistry } from "../secrets/provider-registry.js";
import type {
  PreparedSecretVersion,
  RemoteSecretListResult,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretsRuntimeConfig,
  SecretProviderVaultRuntimeConfig,
  SecretProviderWriteContext,
} from "../secrets/types.js";
import { isSecretProviderClientError } from "../secrets/types.js";
import {
  readTaskExecutionRun,
  resolveTaskExecutionRunIdentityById,
} from "./task-execution-run-service.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const REDACTED_SENTINEL = "***REDACTED***";
const COMING_SOON_SECRET_PROVIDERS: ReadonlySet<SecretProvider> = new Set([
  "gcp_secret_manager",
  "vault",
]);
const USER_SECRET_DEFINITION_KEY_UNIQUE_CONSTRAINT =
  "user_secret_definitions_company_key_uq";
const USER_SECRET_VALUE_UNIQUE_CONSTRAINT =
  "company_secrets_user_definition_owner_uq";
const SECRET_KEY_RE = /^[a-zA-Z0-9_.-]{1,120}$/;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SecretBindingDb = Pick<Db | DbTransaction, "select" | "delete" | "insert">;

export type SecretMutationActor =
  | { type: "user"; userId: string; agentId?: never }
  | { type: "agent"; agentId: string; userId?: never }
  | { type: "system"; userId?: never; agentId?: never };

export interface CreateCompanySecretInput {
  name: string;
  provider: SecretProvider;
  providerConfigId?: string | null;
  value?: string | null;
  key?: string | null;
  managedMode?: "paperclip_managed" | "external_reference";
  description?: string | null;
  externalRef?: string | null;
  providerVersionRef?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}

export interface CreateCompanySecretBindingInput {
  targetType: SecretBindingTargetType;
  targetId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
  required?: boolean;
  label?: string | null;
  projectionClass?: SecretProjectionClass;
  projectionAllowlistKey?: string | null;
}

type SecretMutationAttribution = {
  userId: string | null;
  agentId: string | null;
};

const INVALID_SECRET_MUTATION_ACTOR_CODE = "invalid_secret_mutation_actor";

export function requireSecretMutationActor(
  actor: unknown,
): SecretMutationAttribution {
  if (typeof actor === "object" && actor !== null && !Array.isArray(actor)) {
    const prototype = Object.getPrototypeOf(actor);
    const keys = Reflect.ownKeys(actor);
    if (
      (prototype === Object.prototype || prototype === null) &&
      keys.every((key): key is string => typeof key === "string")
    ) {
      const descriptors = Object.getOwnPropertyDescriptors(actor);
      const typeDescriptor = descriptors.type;
      const type =
        typeDescriptor && "value" in typeDescriptor
          ? typeDescriptor.value
          : undefined;
      switch (type) {
        case "user": {
          const userIdDescriptor = descriptors.userId;
          const userId =
            userIdDescriptor && "value" in userIdDescriptor
              ? userIdDescriptor.value
              : undefined;
          if (
            keys.length === 2 &&
            keys.includes("type") &&
            keys.includes("userId") &&
            typeof userId === "string" &&
            userId.length > 0 &&
            userId.trim() === userId
          ) {
            return { userId, agentId: null };
          }
          break;
        }
        case "agent": {
          const agentIdDescriptor = descriptors.agentId;
          const agentId =
            agentIdDescriptor && "value" in agentIdDescriptor
              ? agentIdDescriptor.value
              : undefined;
          if (
            keys.length === 2 &&
            keys.includes("type") &&
            keys.includes("agentId") &&
            typeof agentId === "string" &&
            isCanonicalUuid(agentId)
          ) {
            return { userId: null, agentId };
          }
          break;
        }
        case "system": {
          if (keys.length === 1 && keys[0] === "type") {
            return { userId: null, agentId: null };
          }
          break;
        }
      }
    }
  }

  throw unprocessable("A canonical secret mutation actor is required", {
    code: INVALID_SECRET_MUTATION_ACTOR_CODE,
  });
}

function isUniqueConstraintViolation(error: unknown, constraintName: string) {
  const seen = new Set<unknown>();
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const maybe = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    const constraint = maybe.constraint ?? maybe.constraint_name;
    if (maybe.code === "23505" && constraint === constraintName) return true;
    current = maybe.cause;
  }
  return false;
}

function remoteProviderHttpError(
  error: unknown,
  context: {
    companyId: string;
    provider: SecretProvider;
    providerConfigId: string;
    operation: string;
    providerConfig?: Record<string, unknown> | null;
  },
): HttpError {
  if (isSecretProviderClientError(error)) {
    logger.warn(
      {
        err: error,
        companyId: context.companyId,
        provider: context.provider,
        providerConfigId: context.providerConfigId,
        operation: context.operation,
        providerErrorCode: error.code,
      },
      "remote secret provider request failed",
    );
    return new HttpError(
      error.status,
      error.message,
      safeRemoteProviderErrorDetails(error, context),
    );
  }
  if (error instanceof HttpError) return error;
  logger.warn(
    {
      err: error,
      companyId: context.companyId,
      provider: context.provider,
      providerConfigId: context.providerConfigId,
      operation: context.operation,
      providerErrorCode: "provider_error",
    },
    "remote secret provider request failed",
  );
  return new HttpError(
    502,
    "Remote secret provider request failed.",
    safeRemoteProviderErrorDetails(null, context),
  );
}

function remoteProviderWriteHttpError(
  error: unknown,
  context: {
    companyId: string;
    provider: SecretProvider;
    providerConfigId?: string | null;
    providerConfig: SecretProviderVaultRuntimeConfig | null;
    operation: string;
  },
): HttpError {
  return remoteProviderHttpError(error, {
    companyId: context.companyId,
    provider: context.provider,
    providerConfigId:
      context.providerConfig?.id ??
      context.providerConfigId ??
      "deployment-default",
    operation: context.operation,
    providerConfig: context.providerConfig?.config ?? null,
  });
}

async function throwProviderWriteOrReservedRowRollbackError(input: {
  error: unknown;
  rollbackReservedRow: () => Promise<unknown>;
  companyId: string;
  provider: SecretProvider;
  providerConfigId?: string | null;
  providerConfig: SecretProviderVaultRuntimeConfig | null;
  operation: string;
}): Promise<never> {
  const providerError = remoteProviderWriteHttpError(input.error, input);
  try {
    await input.rollbackReservedRow();
  } catch (rollbackError) {
    const providerConfigId =
      input.providerConfig?.id ??
      input.providerConfigId ??
      "deployment-default";
    logger.warn(
      {
        err: rollbackError,
        providerErr: providerError,
        companyId: input.companyId,
        provider: input.provider,
        providerConfigId,
        operation: input.operation,
      },
      "remote secret provider write failed and reserved secret rollback failed",
    );
    throw new HttpError(
      500,
      "Secret create failed and Paperclip could not roll back the local secret reservation.",
      {
        code: "secret_create_rollback_failed",
        provider: input.provider,
        operation: input.operation,
        providerConfigId,
        providerError: {
          status: providerError.status,
          message: providerError.message,
          details: providerError.details ?? null,
        },
      },
    );
  }
  throw providerError;
}

function providerConfigIdentifier(input: {
  providerConfigId?: string | null;
  providerConfig: SecretProviderVaultRuntimeConfig | null;
}) {
  return (
    input.providerConfig?.id ?? input.providerConfigId ?? "deployment-default"
  );
}

async function deleteLocalSecretCreateReservationOrThrow(input: {
  db: Pick<Db, "delete">;
  secretId: string;
  companyId: string;
  provider: SecretProvider;
  providerConfigId?: string | null;
  providerConfig: SecretProviderVaultRuntimeConfig | null;
  operation: string;
}) {
  try {
    await input.db
      .delete(companySecretVersions)
      .where(eq(companySecretVersions.secretId, input.secretId));
    await input.db
      .delete(companySecrets)
      .where(eq(companySecrets.id, input.secretId));
  } catch (rollbackError) {
    const providerConfigId = providerConfigIdentifier(input);
    logger.warn(
      {
        err: rollbackError,
        companyId: input.companyId,
        provider: input.provider,
        providerConfigId,
        operation: input.operation,
      },
      "secret create failed and local reserved secret rollback failed",
    );
    throw new HttpError(
      500,
      "Secret create failed and Paperclip could not roll back the local secret reservation.",
      {
        code: "secret_create_rollback_failed",
        provider: input.provider,
        operation: input.operation,
        providerConfigId,
      },
    );
  }
}

function throwProviderCleanupFailedAfterCreateRollback(input: {
  companyId: string;
  provider: SecretProvider;
  providerConfigId?: string | null;
  providerConfig: SecretProviderVaultRuntimeConfig | null;
  operation: string;
}): never {
  const providerConfigId = providerConfigIdentifier(input);
  throw new HttpError(
    500,
    "Secret create failed and Paperclip could not clean up the remote provider secret.",
    {
      code: "secret_create_provider_cleanup_failed",
      provider: input.provider,
      operation: input.operation,
      providerConfigId,
      localCleanupHandle: true,
    },
  );
}

function safeRemoteProviderErrorDetails(
  error: { code: string } | null,
  context: {
    provider: SecretProvider;
    providerConfigId: string;
    operation: string;
    providerConfig?: Record<string, unknown> | null;
  },
): Record<string, unknown> {
  if (
    context.provider !== "aws_secrets_manager" ||
    context.operation !== "secret_provider_config.discovery.preview"
  ) {
    if (context.provider !== "aws_secrets_manager") {
      return { code: error?.code ?? "provider_error" };
    }
    const details: Record<string, unknown> = {
      code: error?.code ?? "provider_error",
      provider: context.provider,
      operation: context.operation,
      providerConfigId: context.providerConfigId,
    };
    const region = safeString(context.providerConfig?.region);
    if (region) details.region = region;
    details.credentialPath =
      "Paperclip server runtime/provider credential path";
    if (error?.code === "access_denied") {
      if (context.operation === "secret.create") {
        details.requiredCapability = "secretsmanager:CreateSecret";
        details.actionableMessage =
          "AWS managed secret creation needs secretsmanager:CreateSecret in the selected region for this provider vault. If the vault config uses a KMS key, the runtime credentials also need KMS write permissions for that key.";
        details.safeAlternative =
          "If the secret already exists in AWS, link it as an external reference instead of creating a Paperclip-managed value.";
      } else if (context.operation === "secret.rotate") {
        details.requiredCapability = "secretsmanager:PutSecretValue";
        details.actionableMessage =
          "AWS managed secret rotation needs secretsmanager:PutSecretValue for the selected provider vault and managed secret path.";
      }
    }
    return details;
  }
  const details: Record<string, unknown> = {
    code: error?.code ?? "provider_error",
    provider: context.provider,
    operation: context.operation,
    providerConfigId: context.providerConfigId,
  };
  const region = safeString(context.providerConfig?.region);
  if (region) details.region = region;
  details.providerVaultContext =
    context.providerConfigId === "discovery-preview"
      ? "draft_config"
      : "provider_config";
  details.credentialPath = "Paperclip server runtime/provider credential path";
  if (error?.code === "access_denied") {
    details.requiredCapability = "secretsmanager:ListSecrets";
    details.actionableMessage =
      "AWS discovery preview needs secretsmanager:ListSecrets in the selected region for the Paperclip server runtime/provider credential path.";
    details.safeAlternative =
      "If the operator already knows the exact AWS Secrets Manager ARN, paste/link that ARN instead of using discovery. Exact-resource DescribeSecret and runtime read permissions are still required.";
  }
  return details;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function remoteImportRowFailureReason(
  error: unknown,
  fallback: string,
  context: {
    companyId: string;
    provider: SecretProvider;
    providerConfigId: string;
    operation: string;
  },
): string {
  if (isSecretProviderClientError(error)) {
    logger.warn(
      {
        err: error,
        companyId: context.companyId,
        provider: context.provider,
        providerConfigId: context.providerConfigId,
        operation: context.operation,
        providerErrorCode: error.code,
      },
      "remote secret import row provider failure",
    );
    return error.message;
  }
  if (error instanceof HttpError && error.status < 500) return error.message;
  logger.warn(
    {
      err: error,
      companyId: context.companyId,
      provider: context.provider,
      providerConfigId: context.providerConfigId,
      operation: context.operation,
      providerErrorCode: "provider_error",
    },
    "remote secret import row failed",
  );
  return fallback;
}

async function cleanupPreparedProviderWrite(input: {
  provider: SecretProviderModule;
  prepared: PreparedSecretVersion;
  providerConfig: SecretProviderVaultRuntimeConfig | null;
  context: SecretProviderWriteContext;
  mode: "archive" | "delete";
  operation: string;
}): Promise<boolean> {
  try {
    await input.provider.deleteOrArchive({
      material: input.prepared.material,
      externalRef: input.prepared.externalRef,
      providerConfig: input.providerConfig,
      context: input.context,
      mode: input.mode,
    });
    return true;
  } catch (cleanupError) {
    logger.warn(
      {
        err: cleanupError,
        companyId: input.context.companyId,
        provider: input.provider.id,
        providerConfigId: input.providerConfig?.id ?? null,
        operation: input.operation,
      },
      "remote secret provider cleanup failed after db write failure",
    );
    return false;
  }
}

type CanonicalEnvBinding =
  | { type: "plain"; value: string }
  | {
      type: "secret_ref";
      secretId: string;
      version: number | "latest";
      projectionClass: SecretProjectionClass;
      projectionAllowlistKey: string | null;
    }
  | {
      type: "user_secret_ref";
      key: string;
      version: number | "latest";
      required: boolean;
      allowMissingOverride: boolean;
    };

type SecretAccessConsumerType = SecretBindingTargetType;

type SecretConsumerContext = {
  consumerType: SecretAccessConsumerType;
  consumerId: string;
  configPath?: string | null;
  responsibleUserId?: string | null;
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  actorSource?: "session" | "board_key" | "internal";
  taskId?: string | null;
  runId?: string | null;
  pluginId?: string | null;
  allowedBindingIds?: string[] | null;
};

type SecretBindingContext = Omit<SecretConsumerContext, "consumerType"> & {
  consumerType: SecretBindingTargetType;
};

type SecretResolutionOptions = {
  bindingContext?: SecretBindingContext;
  accessContext?: SecretConsumerContext;
  allowUserSecretScope?: boolean;
};

export type RuntimeSecretManifestEntry = {
  configPath: string;
  envKey: string | null;
  secretId: string;
  bindingId?: string | null;
  secretKey: string;
  version: number;
  provider: SecretProvider;
  providerVersionRef?: string | null;
  outcome: "success" | "failure";
  errorCode?: string | null;
};

export type MissingRuntimeBinding = {
  consumerType: SecretBindingTargetType;
  consumerId: string;
  configPath: string;
  envKey: string;
  bindingType?: "secret_ref" | "user_secret_ref";
  secretId: string | null;
  secretName: string | null;
  userSecretDefinitionId?: string | null;
  userSecretDefinitionKey?: string | null;
  userSecretDefinitionName?: string | null;
  responsibleUserId?: string | null;
  errorCode?: SecretResolutionErrorCode;
};

function missingRuntimeConsumerType(
  consumerType: SecretAccessConsumerType,
): SecretBindingTargetType {
  return consumerType;
}

type RuntimeSecretResolution = {
  value: string;
  manifestEntry: RuntimeSecretManifestEntry;
};

type SecretResolutionErrorCode =
  | "binding_missing"
  | "secret_deleted"
  | "secret_inactive"
  | "secret_scope_invalid"
  | "responsible_user_missing"
  | "user_secret_definition_missing"
  | "user_secret_definition_inactive"
  | "user_secret_missing"
  | "version_missing"
  | "version_inactive"
  | "provider_error";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function isSensitiveEnvKey(key: string) {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

function normalizeSecretKey(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function requireExactSecretKey(input: string) {
  if (!SECRET_KEY_RE.test(input)) {
    throw unprocessable(
      "Secret key must use exact letters, numbers, dot, underscore, or hyphen",
    );
  }
  return input;
}

function requireExactOpaqueSecretReference(input: string, label: string) {
  if (input.length === 0 || input.trim() !== input) {
    throw unprocessable(
      `${label} must be a non-empty exact value without surrounding whitespace`,
    );
  }
  return input;
}

function requireOptionalExactOpaqueSecretReference(
  input: string | null | undefined,
  label: string,
) {
  return input == null ? null : requireExactOpaqueSecretReference(input, label);
}

function assertExactPreparedSecretReferences(
  prepared: PreparedSecretVersion,
): PreparedSecretVersion {
  requireOptionalExactOpaqueSecretReference(
    prepared.externalRef,
    "Provider secret reference",
  );
  requireOptionalExactOpaqueSecretReference(
    prepared.providerVersionRef,
    "Provider secret version reference",
  );
  return prepared;
}

function deriveSecretNameFromExternalRef(externalRef: string) {
  const exactRef = requireExactOpaqueSecretReference(
    externalRef,
    "Provider secret reference",
  );
  const arnMatch = /^arn:[^:]+:secretsmanager:[^:]*:[^:]*:secret:(.+)$/i.exec(
    exactRef,
  );
  const name = arnMatch?.[1] ?? exactRef;
  return name.split("/").filter(Boolean).at(-1) ?? name;
}

function canonicalizeBinding(binding: EnvBinding): CanonicalEnvBinding {
  if (binding.type === "plain") {
    return { type: "plain", value: String(binding.value) };
  }
  if (binding.type === "user_secret_ref") {
    return {
      type: "user_secret_ref",
      key: binding.key,
      version: binding.version ?? "latest",
      required: binding.required ?? true,
      allowMissingOverride: binding.allowMissingOverride ?? false,
    };
  }
  return {
    type: "secret_ref",
    secretId: binding.secretId,
    version: binding.version ?? "latest",
    projectionClass: binding.projectionClass ?? "unclassified",
    projectionAllowlistKey: binding.projectionAllowlistKey ?? null,
  };
}

function assertClass3StaticLeaseAllowed(input: {
  targetType: SecretBindingTargetType;
  configPath: string;
  projectionClass?: string | null;
  projectionAllowlistKey?: string | null;
}) {
  const projectionClass = input.projectionClass ?? "unclassified";
  if (projectionClass !== "class_3_static_lease") return;
  if (!input.projectionAllowlistKey?.trim()) {
    throw unprocessable(
      "Class-3 static lease bindings require an allowlist key",
      {
        code: "class_3_static_lease_allowlist_required",
        targetType: input.targetType,
        configPath: input.configPath,
      },
    );
  }
  const allowed = CLASS3_STATIC_LEASE_ALLOWLIST.some(
    (entry) =>
      entry.key === input.projectionAllowlistKey &&
      entry.targetType === input.targetType &&
      entry.configPath === input.configPath,
  );
  if (!allowed) {
    throw unprocessable(
      "Class-3 static lease binding is outside the approved allowlist",
      {
        code: "class_3_static_lease_not_allowed",
        allowlistKey: input.projectionAllowlistKey,
        targetType: input.targetType,
        configPath: input.configPath,
      },
    );
  }
}

function defaultProviderConfigStatus(
  provider: SecretProvider,
): SecretProviderConfigStatus {
  return COMING_SOON_SECRET_PROVIDERS.has(provider) ? "coming_soon" : "ready";
}

function secretResolutionErrorCode(error: unknown): SecretResolutionErrorCode {
  if (isSecretProviderClientError(error)) return "provider_error";
  if (error instanceof HttpError) {
    const details = asRecord(error.details);
    switch (details?.code) {
      case "binding_missing":
      case "secret_deleted":
      case "secret_inactive":
      case "version_missing":
      case "version_inactive":
      case "provider_error":
        return details.code;
    }
    if (error.message === "Secret is not active") return "secret_inactive";
    if (error.message === "User secret value is not configured")
      return "user_secret_missing";
    if (
      error.message ===
      "Responsible user is required for user secret resolution"
    ) {
      return "responsible_user_missing";
    }
    if (error.message === "User secret definition not found")
      return "user_secret_definition_missing";
    if (error.message === "User secret definition is not active")
      return "user_secret_definition_inactive";
    if (
      error.message ===
      "User-scoped secrets must be resolved through user secret declarations"
    ) {
      return "secret_scope_invalid";
    }
    if (error.message === "Secret version not found") return "version_missing";
    if (error.message === "Secret version is not active")
      return "version_inactive";
    if (
      error.message === "Secret resolution requires a binding config path" ||
      error.message.startsWith("Secret is not bound to ")
    ) {
      return "binding_missing";
    }
    if (error.status >= 500) return "provider_error";
  }
  return "provider_error";
}

function missingUserSecretDefinitionRuntimeBinding(
  entry: {
    key: string;
    configPath: string;
    binding: Extract<CanonicalEnvBinding, { type: "user_secret_ref" }>;
  },
  context: Omit<SecretConsumerContext, "configPath">,
  definition: typeof userSecretDefinitions.$inferSelect | null,
  errorCode:
    "user_secret_definition_missing" | "user_secret_definition_inactive",
): MissingRuntimeBinding {
  return {
    consumerType: missingRuntimeConsumerType(context.consumerType),
    consumerId: context.consumerId,
    configPath: entry.configPath,
    envKey: entry.key,
    bindingType: "user_secret_ref",
    secretId: null,
    secretName: null,
    userSecretDefinitionId: definition?.id ?? null,
    userSecretDefinitionKey: definition?.key ?? entry.binding.key,
    userSecretDefinitionName: definition?.name ?? null,
    responsibleUserId: context.responsibleUserId ?? null,
    errorCode,
  };
}

function assertSelectableProviderConfig(
  config: {
    provider: string;
    status: string;
    companyId: string;
  },
  companyId: string,
  provider: SecretProvider,
) {
  if (config.companyId !== companyId)
    throw unprocessable("Provider vault must belong to same company");
  if (config.provider !== provider)
    throw unprocessable("Provider vault must match the secret provider");
  if (config.status === "coming_soon") {
    throw unprocessable("Provider vault is locked while coming soon");
  }
  if (config.status === "disabled") {
    throw unprocessable("Provider vault is disabled");
  }
}

export function secretService(db: Db, secretsRuntime: SecretsRuntimeConfig) {
  const providerRegistry = createSecretProviderRegistry(secretsRuntime);
  const getSecretProvider = providerRegistry.get;

  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
  };
  async function getById(
    id: string,
    source: Pick<Db | DbTransaction, "select"> = db,
  ) {
    if (!isCanonicalUuid(id)) return null;
    return source
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByName(companyId: string, name: string) {
    return db
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
    return db
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
    source: Pick<Db | DbTransaction, "select"> = db,
  ) {
    if (!isCanonicalUuid(companyId) || !isCanonicalUuid(definitionId)) {
      return null;
    }
    return source
      .select()
      .from(userSecretDefinitions)
      .where(
        and(
          eq(userSecretDefinitions.companyId, companyId),
          eq(userSecretDefinitions.id, definitionId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getUserSecretDefinitionByKey(
    companyId: string,
    key: string,
    source: Pick<Db | DbTransaction, "select"> = db,
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
    source: Pick<Db | DbTransaction, "select"> = db,
  ) {
    const definition = input.definitionId
      ? await getUserSecretDefinitionById(companyId, input.definitionId, source)
      : input.definitionKey
        ? await getUserSecretDefinitionByKey(
            companyId,
            input.definitionKey,
            source,
          )
        : null;
    if (
      !definition ||
      definition.deletedAt ||
      definition.status === "deleted"
    ) {
      throw notFound("User secret definition not found");
    }
    if (definition.companyId !== companyId) {
      throw unprocessable("User secret definition must belong to same company");
    }
    return definition;
  }

  async function getUserSecretValue(input: {
    companyId: string;
    ownerUserId: string;
    definitionId: string;
  }) {
    return db
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

  async function getUserSecretValueById(
    companyId: string,
    ownerUserId: string,
    secretId: string,
  ) {
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
    return db
      .select()
      .from(companySecretVersions)
      .where(
        and(
          eq(companySecretVersions.secretId, secretId),
          eq(companySecretVersions.version, version),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getBinding(input: {
    companyId: string;
    secretId: string;
    consumerType: SecretBindingTargetType;
    consumerId: string;
    configPath: string;
  }) {
    return db
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
    if (
      Array.isArray(context.allowedBindingIds) &&
      !context.allowedBindingIds.includes(binding.id)
    ) {
      throw unprocessable(
        "Secret binding is outside the active low-trust boundary",
        { code: "binding_not_allowed" },
      );
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
    await db.insert(secretAccessEvents).values({
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
    source: Pick<Db | DbTransaction, "select"> = db,
  ) {
    const secret = await getById(secretId, source);
    if (!secret) throw notFound("Secret not found");
    if (secret.status === "deleted") throw notFound("Secret not found");
    if (secret.companyId !== companyId)
      throw unprocessable("Secret must belong to same company");
    if (secret.scope !== "company")
      throw unprocessable("Secret references require company-scoped secrets");
    return secret;
  }

  async function getProviderConfigById(id: string) {
    if (!isCanonicalUuid(id)) return null;
    return db
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
      throw unprocessable(
        "Invalid provider vault config",
        parsed.error.flatten(),
      );
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
    if (
      input.status === "coming_soon" ||
      COMING_SOON_SECRET_PROVIDERS.has(input.provider)
    ) {
      return {
        configId: input.id,
        provider: input.provider,
        status: "coming_soon",
        message: "Provider vault runtime is locked while coming soon.",
        details: {
          code: "runtime_locked",
          message: "Provider vault runtime is locked while coming soon.",
          guidance: [
            "Draft metadata may be saved, but create, rotate, and resolve stay unavailable.",
          ],
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
    const guidance = [
      ...(input.health.warnings ?? []),
      ...(input.health.backupGuidance ?? []),
    ];
    return {
      configId: input.configId,
      provider: input.provider,
      status,
      message: input.health.message,
      details: {
        code:
          input.health.status === "ok"
            ? "provider_ready"
            : "provider_needs_attention",
        message: input.health.message,
        guidance: guidance.length > 0 ? guidance : undefined,
      },
    };
  }

  async function resolveSecretValueInternal(
    companyId: string,
    secretId: string,
    version: number | "latest",
    options?: SecretResolutionOptions,
  ): Promise<RuntimeSecretResolution> {
    const bindingContext = options?.bindingContext;
    const accessContext = options?.accessContext ?? bindingContext;
    const secret = await getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.companyId !== companyId)
      throw unprocessable("Secret must belong to same company");
    if (secret.scope !== "company" && !options?.allowUserSecretScope) {
      throw unprocessable(
        "User-scoped secrets must be resolved through user secret declarations",
        {
          code: "secret_scope_invalid",
        },
      );
    }
    const resolvedVersion =
      version === "latest" ? secret.latestVersion : version;
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
      const binding = await assertBindingContext(
        companyId,
        secret.id,
        bindingContext,
      );
      const versionRow = await getSecretVersion(secret.id, resolvedVersion);
      if (!versionRow)
        throw new HttpError(404, "Secret version not found", {
          code: "version_missing",
        });
      if (
        versionRow.status === "disabled" ||
        versionRow.status === "destroyed" ||
        versionRow.revokedAt
      ) {
        throw unprocessable("Secret version is not active", {
          code: "version_inactive",
        });
      }
      const provider = getSecretProvider(providerId);
      const providerConfig = await getSelectableRuntimeProviderConfig({
        companyId,
        provider: providerId,
        providerConfigId: secret.providerConfigId,
      });
      requireOptionalExactOpaqueSecretReference(
        secret.externalRef,
        "Stored provider secret reference",
      );
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
        db
          .update(companySecrets)
          .set({ lastResolvedAt: new Date(), updatedAt: new Date() })
          .where(eq(companySecrets.id, secret.id))
          .catch(() => undefined),
        recordAccessEvent({
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
        }).catch(() => undefined),
      ]);
      return {
        value,
        manifestEntry: {
          configPath: configPath ?? "",
          envKey: configPath?.startsWith("env.")
            ? configPath.slice("env.".length)
            : null,
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
      await recordAccessEvent({
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
      }).catch(() => undefined);
      throw err;
    }
  }

  function isSecretResolutionOptions(
    value: SecretBindingContext | SecretResolutionOptions | undefined,
  ): value is SecretResolutionOptions {
    return Boolean(
      value && ("bindingContext" in value || "accessContext" in value),
    );
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
    return (
      await resolveSecretValueInternal(companyId, secretId, version, options)
    ).value;
  }

  async function resolveSecretVersion(
    companyId: string,
    secretId: string,
    version: number | "latest",
    context?: SecretBindingContext,
  ): Promise<number> {
    const secret = await getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.companyId !== companyId)
      throw unprocessable("Secret must belong to same company");
    const resolvedVersion =
      version === "latest" ? secret.latestVersion : version;
    if (secret.status === "deleted") {
      throw new HttpError(404, "Secret not found", { code: "secret_deleted" });
    }
    if (secret.status !== "active") {
      throw unprocessable("Secret is not active", { code: "secret_inactive" });
    }
    await assertBindingContext(companyId, secret.id, context);
    const versionRow = await getSecretVersion(secret.id, resolvedVersion);
    if (!versionRow)
      throw new HttpError(404, "Secret version not found", {
        code: "version_missing",
      });
    if (
      versionRow.status === "disabled" ||
      versionRow.status === "destroyed" ||
      versionRow.revokedAt
    ) {
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
    if (!record)
      throw unprocessable(`${opts?.fieldPath ?? "env"} must be an object`);

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
        if (
          opts?.strictMode &&
          isSensitiveEnvKey(key) &&
          binding.value.trim().length > 0
        ) {
          throw unprocessable(
            `Strict secret mode requires secret references for sensitive key: ${key}`,
          );
        }
        if (binding.value === REDACTED_SENTINEL) {
          throw unprocessable(
            `Refusing to persist redacted placeholder for key: ${key}`,
          );
        }
        normalized[key] = binding;
        continue;
      }
      if (binding.type === "user_secret_ref") {
        normalized[key] = binding;
        continue;
      }

      await assertSecretInCompany(companyId, binding.secretId);
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

  function collectTargetIds(
    bindings: Array<typeof companySecretBindings.$inferSelect>,
    targetType: SecretBindingTargetType,
  ) {
    return [
      ...new Set(
        bindings
          .filter((binding) => binding.targetType === targetType)
          .map((binding) => binding.targetId)
          .filter(isCanonicalUuid),
      ),
    ];
  }

  async function buildBindingTargetMap(
    companyId: string,
    bindings: Array<typeof companySecretBindings.$inferSelect>,
  ) {
    const targetMap = new Map<string, CompanySecretBindingTarget>();
    const setTarget = (target: CompanySecretBindingTarget) => {
      targetMap.set(`${target.type}:${target.id}`, target);
    };
    const agentIds = collectTargetIds(bindings, "agent");
    if (agentIds.length > 0) {
      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          title: agents.title,
          status: agents.status,
        })
        .from(agents)
        .where(
          and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)),
        );
      for (const row of rows) {
        setTarget({
          type: "agent",
          id: row.id,
          label: row.title ? `${row.name} (${row.title})` : row.name,
          routeTarget: { kind: "agent", id: row.id },
          status: row.status,
        });
      }
    }

    const projectIds = collectTargetIds(bindings, "project");
    if (projectIds.length > 0) {
      const rows = await db
        .select({
          id: projects.id,
          name: projects.name,
          status: projects.status,
        })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, companyId),
            inArray(projects.id, projectIds),
          ),
        );
      for (const row of rows) {
        setTarget({
          type: "project",
          id: row.id,
          label: row.name,
          routeTarget: { kind: "project", id: row.id },
          status: row.status,
        });
      }
    }

    const routineIds = collectTargetIds(bindings, "routine");
    if (routineIds.length > 0) {
      const rows = await db
        .select({
          id: routines.id,
          title: routines.title,
          status: routines.status,
        })
        .from(routines)
        .where(
          and(
            eq(routines.companyId, companyId),
            inArray(routines.id, routineIds),
          ),
        );
      for (const row of rows) {
        setTarget({
          type: "routine",
          id: row.id,
          label: row.title,
          routeTarget: { kind: "routine", id: row.id },
          status: row.status,
        });
      }
    }

    const taskIds = collectTargetIds(bindings, "task");
    const taskTargetIds = new Set(taskIds);
    const runIds = collectTargetIds(bindings, "run");
    const runTargets = await Promise.all(
      runIds.map(async (runId) => {
        const identity = await resolveTaskExecutionRunIdentityById(db, runId);
        if (!identity || identity.companyId !== companyId) return null;
        const run = await readTaskExecutionRun(db, identity);
        if (!run) return null;
        return { run, taskId: identity.taskId };
      }),
    );
    const linkedTaskIds = [
      ...new Set([
        ...taskIds,
        ...runTargets.flatMap((target) => (target ? [target.taskId] : [])),
      ]),
    ];
    const taskRows =
      linkedTaskIds.length > 0
        ? await db
            .select({
              id: tasks.id,
              taskNumber: tasks.taskNumber,
              identifier: tasks.identifier,
              title: tasks.title,
              boardPresentationStatus: tasks.boardPresentationStatus,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.companyId, companyId),
                inArray(tasks.id, linkedTaskIds),
              ),
            )
        : [];
    const taskById = new Map(taskRows.map((row) => [row.id, row]));
    for (const row of taskRows) {
      if (taskTargetIds.has(row.id)) {
        setTarget({
          type: "task",
          id: row.id,
          label: row.title ?? row.identifier,
          routeTarget: { kind: "task", taskNumber: row.taskNumber, hash: null },
          status: row.boardPresentationStatus,
        });
      }
    }

    for (const target of runTargets) {
      if (target) {
        const task = taskById.get(target.taskId);
        setTarget({
          type: "run",
          id: target.run.runId,
          label: `Run ${target.run.runId.slice(0, 8)}`,
          routeTarget: task
            ? { kind: "task", taskNumber: task.taskNumber, hash: null }
            : null,
          status: target.run.status,
        });
      }
    }

    return targetMap;
  }

  async function buildRemoteImportConflictMaps(
    companyId: string,
    provider: SecretProvider,
  ) {
    const activeSecrets = await db
      .select({
        id: companySecrets.id,
        name: companySecrets.name,
        key: companySecrets.key,
        provider: companySecrets.provider,
        providerConfigId: companySecrets.providerConfigId,
        externalRef: companySecrets.externalRef,
        status: companySecrets.status,
      })
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, companyId),
          ne(companySecrets.status, "deleted"),
        ),
      );
    const externalReferenceSecrets = activeSecrets.filter(
      (secret) =>
        secret.provider === provider && typeof secret.externalRef === "string",
    );
    return {
      byProviderConfigExternalRef: new Map(
        externalReferenceSecrets.map((secret) => [
          remoteImportExternalRefKey(
            secret.providerConfigId,
            requireExactOpaqueSecretReference(
              secret.externalRef!,
              "Stored provider secret reference",
            ),
          ),
          secret,
        ]),
      ),
      byName: new Map(activeSecrets.map((secret) => [secret.name, secret])),
      byKey: new Map(activeSecrets.map((secret) => [secret.key, secret])),
    };
  }

  function remoteImportExternalRefKey(
    providerConfigId: string | null | undefined,
    externalRef: string,
  ) {
    return `${providerConfigId ?? "default"}\0${requireExactOpaqueSecretReference(
      externalRef,
      "Provider secret reference",
    )}`;
  }

  function sanitizeRemoteProviderMetadata(
    provider: SecretProvider,
    metadata: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!metadata || provider !== "aws_secrets_manager") return null;
    const safe: Record<string, unknown> = {};
    for (const key of [
      "createdDate",
      "lastAccessedDate",
      "lastChangedDate",
      "deletedDate",
    ]) {
      const value = metadata[key];
      if (typeof value === "string" || value === null) safe[key] = value;
    }
    for (const key of ["hasDescription", "hasKmsKey", "tagCount"]) {
      const value = metadata[key];
      if (typeof value === "boolean" || typeof value === "number")
        safe[key] = value;
    }
    return Object.keys(safe).length > 0 ? safe : null;
  }

  function remoteImportConflictsFor(input: {
    providerConfigId: string | null;
    externalRef: string;
    name: string;
    key: string;
    maps: Awaited<ReturnType<typeof buildRemoteImportConflictMaps>>;
  }): RemoteSecretImportConflict[] {
    const conflicts: RemoteSecretImportConflict[] = [];
    const duplicate = input.maps.byProviderConfigExternalRef.get(
      remoteImportExternalRefKey(input.providerConfigId, input.externalRef),
    );
    if (duplicate) {
      conflicts.push({
        type: "exact_reference",
        existingSecretId: duplicate.id,
        message:
          "An existing secret already links this exact provider reference.",
      });
      return conflicts;
    }
    const nameConflict = input.maps.byName.get(input.name);
    if (nameConflict) {
      conflicts.push({
        type: "name",
        existingSecretId: nameConflict.id,
        message: `Secret name already exists: ${input.name}`,
      });
    }
    const keyConflict = input.maps.byKey.get(input.key);
    if (keyConflict) {
      conflicts.push({
        type: "key",
        existingSecretId: keyConflict.id,
        message: `Secret key already exists: ${input.key}`,
      });
    }
    return conflicts;
  }

  async function getRemoteImportProviderConfig(
    companyId: string,
    providerConfigId: string,
  ) {
    const providerConfig = await getProviderConfigById(providerConfigId);
    if (!providerConfig) throw notFound("Provider vault not found");
    const provider = providerConfig.provider as SecretProvider;
    assertSelectableProviderConfig(providerConfig, companyId, provider);
    return {
      providerConfig,
      provider,
      runtimeConfig: toProviderVaultRuntimeConfig(providerConfig),
    };
  }

  async function createUserSecretValueInternal(
    companyId: string,
    ownerUserId: string,
    input: {
      definitionId: string;
      value?: string | null;
      externalRef?: string | null;
      providerVersionRef?: string | null;
      providerConfigId?: string | null;
    },
    actor: SecretMutationActor,
  ) {
    const attribution = requireSecretMutationActor(actor);
    requireOptionalExactOpaqueSecretReference(
      input.externalRef,
      "Provider secret reference",
    );
    requireOptionalExactOpaqueSecretReference(
      input.providerVersionRef,
      "Provider secret version reference",
    );
    const definition = await resolveUserSecretDefinition(companyId, {
      definitionId: input.definitionId,
    });
    if (definition.status !== "active") {
      throw unprocessable("User secret definition is not active");
    }
    const existing = await getUserSecretValue({
      companyId,
      ownerUserId,
      definitionId: definition.id,
    });
    if (existing) throw conflict("User secret value already exists");

    const providerId = definition.provider as SecretProvider;
    const managedMode = definition.managedMode as
      "paperclip_managed" | "external_reference";
    if (managedMode === "external_reference" && input.externalRef == null) {
      throw unprocessable(
        "External reference user secrets require externalRef",
      );
    }
    if (managedMode === "paperclip_managed" && input.externalRef != null) {
      throw unprocessable("Managed user secrets cannot override externalRef");
    }
    if (managedMode === "paperclip_managed" && !input.value?.trim()) {
      throw unprocessable("Managed user secrets require value");
    }

    const providerConfigId =
      input.providerConfigId === undefined
        ? definition.providerConfigId
        : input.providerConfigId;
    const provider = getSecretProvider(providerId);
    const providerConfig = await getSelectableRuntimeProviderConfig({
      companyId,
      provider: providerId,
      providerConfigId,
    });
    const idSuffix = randomUUID();
    const key = normalizeSecretKey(`user.${definition.key}.${idSuffix}`);
    const name = `${definition.name} (${ownerUserId})`;
    const providerWriteContext = {
      companyId,
      secretKey: key,
      secretName: definition.name,
      version: 1,
    };
    let reservedSecret: typeof companySecrets.$inferSelect;
    try {
      reservedSecret = await db
        .insert(companySecrets)
        .values({
          companyId,
          scope: "user",
          ownerUserId,
          userSecretDefinitionId: definition.id,
          key,
          name,
          provider: providerId,
          providerConfigId: providerConfigId ?? null,
          status: "archived",
          managedMode,
          externalRef: null,
          providerMetadata: definition.providerMetadata ?? null,
          latestVersion: 0,
          description: definition.description ?? null,
          createdByAgentId: attribution.agentId,
          createdByUserId: attribution.userId,
        })
        .returning()
        .then((rows) => rows[0]);
    } catch (error) {
      if (
        isUniqueConstraintViolation(error, USER_SECRET_VALUE_UNIQUE_CONSTRAINT)
      ) {
        throw conflict("User secret value already exists");
      }
      throw error;
    }

    let prepared: PreparedSecretVersion;
    try {
      prepared = assertExactPreparedSecretReferences(
        managedMode === "external_reference"
          ? await provider.linkExternalSecret({
              externalRef: input.externalRef ?? "",
              providerVersionRef: input.providerVersionRef ?? null,
              providerConfig,
              context: providerWriteContext,
            })
          : await provider.createSecret({
              value: input.value ?? "",
              externalRef: null,
              providerConfig,
              context: providerWriteContext,
            }),
      );
    } catch (error) {
      throw await throwProviderWriteOrReservedRowRollbackError({
        error,
        rollbackReservedRow: () =>
          db
            .delete(companySecrets)
            .where(eq(companySecrets.id, reservedSecret.id)),
        companyId,
        provider: provider.id,
        providerConfigId,
        providerConfig,
        operation: "secret.create",
      });
    }

    try {
      return await db.transaction(async (tx) => {
        await tx.insert(companySecretVersions).values({
          secretId: reservedSecret.id,
          version: 1,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
          providerVersionRef: prepared.providerVersionRef ?? null,
          status: "current",
          createdByAgentId: attribution.agentId,
          createdByUserId: attribution.userId,
        });
        const secret = await tx
          .update(companySecrets)
          .set({
            status: "active",
            externalRef: prepared.externalRef,
            latestVersion: 1,
            lastRotatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, reservedSecret.id))
          .returning()
          .then((rows) => rows[0]);
        if (!secret) throw notFound("User secret value not found");
        return secret;
      });
    } catch (error) {
      if (managedMode === "paperclip_managed") {
        const cleaned = await cleanupPreparedProviderWrite({
          provider,
          prepared,
          providerConfig,
          context: providerWriteContext,
          mode: "delete",
          operation: "user_secret_value.create_rollback",
        });
        if (!cleaned) {
          throwProviderCleanupFailedAfterCreateRollback({
            companyId,
            provider: provider.id,
            providerConfigId,
            providerConfig,
            operation: "user_secret_value.create_rollback",
          });
        }
      }
      await deleteLocalSecretCreateReservationOrThrow({
        db,
        secretId: reservedSecret.id,
        companyId,
        provider: provider.id,
        providerConfigId,
        providerConfig,
        operation: "user_secret_value.create_rollback",
      });
      throw error;
    }
  }

  async function removeSecretInternal(secretId: string) {
    const secret = await getById(secretId);
    if (!secret) return null;
    const versionRow = await getSecretVersion(secret.id, secret.latestVersion);
    const providerId = secret.provider as SecretProvider;
    const provider = getSecretProvider(providerId);
    requireOptionalExactOpaqueSecretReference(
      secret.externalRef,
      "Stored provider secret reference",
    );
    requireOptionalExactOpaqueSecretReference(
      versionRow?.providerVersionRef,
      "Stored provider secret version reference",
    );
    if (secret.status !== "deleted") {
      await db
        .update(companySecrets)
        .set({
          key: `${secret.key}__deleted__${secret.id}`,
          name: `${secret.name}__deleted__${secret.id}`,
          status: "deleted",
          deletedAt: secret.deletedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, secretId));
    }
    const providerConfig = secret.providerConfigId
      ? await getProviderConfigById(secret.providerConfigId)
      : null;
    const providerRuntimeConfig =
      providerConfig &&
      providerConfig.status !== "disabled" &&
      providerConfig.status !== "coming_soon"
        ? toProviderVaultRuntimeConfig(providerConfig)
        : null;
    if (!secret.providerConfigId || providerRuntimeConfig) {
      try {
        await provider.deleteOrArchive({
          material: versionRow?.material as Record<string, unknown> | undefined,
          externalRef: secret.externalRef,
          providerConfig: providerRuntimeConfig,
          context: {
            companyId: secret.companyId,
            secretKey: secret.key,
            secretName: secret.name,
            version: secret.latestVersion,
          },
          mode: "delete",
        });
      } catch (error) {
        if (!isSecretProviderClientError(error) || error.code !== "not_found") {
          throw error;
        }
      }
    }
    await db.delete(companySecrets).where(eq(companySecrets.id, secretId));
    return secret;
  }

  async function removeUserSecretDefinitionInternal(
    companyId: string,
    definitionId: string,
    actor: SecretMutationActor,
  ) {
    const attribution = requireSecretMutationActor(actor);
    const existing = await resolveUserSecretDefinition(companyId, {
      definitionId,
    });
    const values = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, companyId),
          eq(companySecrets.scope, "user"),
          eq(companySecrets.userSecretDefinitionId, definitionId),
        ),
      );
    for (const value of values) {
      await removeSecretInternal(value.id);
    }
    return db
      .update(userSecretDefinitions)
      .set({
        key: `${existing.key}__deleted__${existing.id}`,
        status: "deleted",
        deletedAt: existing.deletedAt ?? new Date(),
        updatedByAgentId: attribution.agentId,
        updatedByUserId: attribution.userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userSecretDefinitions.companyId, companyId),
          eq(userSecretDefinitions.id, definitionId),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  // Shared resolution tail for the env binding collector: given pre-collected
  // secret_ref and user_secret_ref entries,
  // report every binding a consumer still lacks WITHOUT resolving any values.
  async function collectMissingBindingsForRefs(
    companyId: string,
    context: Omit<SecretBindingContext, "configPath">,
    secretRefs: Array<{ key: string; configPath: string; secretId: string }>,
    userSecretRefs: Array<{
      key: string;
      configPath: string;
      binding: Extract<CanonicalEnvBinding, { type: "user_secret_ref" }>;
    }>,
  ): Promise<MissingRuntimeBinding[]> {
    if (secretRefs.length === 0 && userSecretRefs.length === 0) return [];

    const bindingChecks = await Promise.all(
      secretRefs.map(async (entry) => ({
        entry,
        found: await getBinding({
          companyId,
          secretId: entry.secretId,
          consumerType: context.consumerType,
          consumerId: context.consumerId,
          configPath: entry.configPath,
        }),
      })),
    );
    const missingEntries = bindingChecks
      .filter((check) => !check.found)
      .map((check) => check.entry);

    const secretRows = await Promise.all(
      [...new Set(missingEntries.map((entry) => entry.secretId))].map(
        async (secretId) =>
          [secretId, await getById(secretId).catch(() => null)] as const,
      ),
    );
    const secretsById = new Map(secretRows);

    const missingSecretBindings: MissingRuntimeBinding[] = missingEntries.map(
      (entry) => ({
        consumerType: context.consumerType,
        consumerId: context.consumerId,
        configPath: entry.configPath,
        envKey: entry.key,
        bindingType: "secret_ref",
        secretId: entry.secretId,
        secretName: secretsById.get(entry.secretId)?.name ?? null,
      }),
    );

    const missingUserSecretBindings: MissingRuntimeBinding[] = [];
    for (const entry of userSecretRefs) {
      let definition: typeof userSecretDefinitions.$inferSelect | null = null;
      try {
        definition = await resolveUserSecretDefinition(companyId, {
          definitionKey: entry.binding.key,
        });
      } catch {
        missingUserSecretBindings.push(
          missingUserSecretDefinitionRuntimeBinding(
            entry,
            context,
            null,
            "user_secret_definition_missing",
          ),
        );
        continue;
      }
      if (definition.status !== "active") {
        missingUserSecretBindings.push(
          missingUserSecretDefinitionRuntimeBinding(
            entry,
            context,
            definition,
            "user_secret_definition_inactive",
          ),
        );
        continue;
      }

      const declaration = await db
        .select()
        .from(userSecretDeclarations)
        .where(
          and(
            eq(userSecretDeclarations.companyId, companyId),
            eq(userSecretDeclarations.userSecretDefinitionId, definition.id),
            eq(userSecretDeclarations.targetType, context.consumerType),
            eq(userSecretDeclarations.targetId, context.consumerId),
            eq(userSecretDeclarations.configPath, entry.configPath),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!declaration) {
        missingUserSecretBindings.push({
          consumerType: context.consumerType,
          consumerId: context.consumerId,
          configPath: entry.configPath,
          envKey: entry.key,
          bindingType: "user_secret_ref",
          secretId: null,
          secretName: null,
          userSecretDefinitionId: definition.id,
          userSecretDefinitionKey: definition.key,
          userSecretDefinitionName: definition.name,
          responsibleUserId: context.responsibleUserId ?? null,
          errorCode: "binding_missing",
        });
        continue;
      }

      if (!context.responsibleUserId?.trim()) {
        missingUserSecretBindings.push({
          consumerType: context.consumerType,
          consumerId: context.consumerId,
          configPath: entry.configPath,
          envKey: entry.key,
          bindingType: "user_secret_ref",
          secretId: null,
          secretName: null,
          userSecretDefinitionId: definition.id,
          userSecretDefinitionKey: definition.key,
          userSecretDefinitionName: definition.name,
          responsibleUserId: null,
          errorCode: "responsible_user_missing",
        });
        continue;
      }

      const secret = await getUserSecretValue({
        companyId,
        ownerUserId: context.responsibleUserId,
        definitionId: definition.id,
      });
      if (!secret || secret.status !== "active") {
        missingUserSecretBindings.push({
          consumerType: context.consumerType,
          consumerId: context.consumerId,
          configPath: entry.configPath,
          envKey: entry.key,
          bindingType: "user_secret_ref",
          secretId: secret?.id ?? null,
          secretName: null,
          userSecretDefinitionId: definition.id,
          userSecretDefinitionKey: definition.key,
          userSecretDefinitionName: definition.name,
          responsibleUserId: context.responsibleUserId,
          errorCode: secret ? "secret_inactive" : "user_secret_missing",
        });
      }
    }

    return [...missingSecretBindings, ...missingUserSecretBindings];
  }

  return {
    listProviders: () => providerRegistry.list(),

    checkProviders: () => providerRegistry.check(),

    previewProviderConfigDiscovery: async (
      companyId: string,
      input: {
        provider: SecretProvider;
        config?: Record<string, unknown>;
        query?: string | null;
        nextToken?: string | null;
        pageSize?: number;
      },
    ): Promise<SecretProviderConfigDiscoveryPreviewResult> => {
      const parsed = secretProviderConfigDiscoveryPreviewSchema.safeParse({
        provider: input.provider,
        config: input.config ?? {},
        query: input.query,
        nextToken: input.nextToken,
        pageSize: input.pageSize,
      });
      if (!parsed.success) {
        throw unprocessable(
          "Invalid provider vault discovery config",
          parsed.error.flatten(),
        );
      }
      const providerId = parsed.data.provider as SecretProvider;
      const provider = getSecretProvider(providerId);
      if (!provider.discoverProviderConfigs) {
        throw unprocessable(
          `${providerId} provider does not support provider vault discovery`,
        );
      }
      const runtimeConfig = toDraftProviderVaultRuntimeConfig({
        companyId,
        provider: providerId,
        config: parsed.data.config,
      });
      try {
        return await provider.discoverProviderConfigs({
          companyId,
          providerConfig: runtimeConfig,
          query: parsed.data.query,
          nextToken: parsed.data.nextToken,
          pageSize: parsed.data.pageSize,
        });
      } catch (error) {
        throw remoteProviderHttpError(error, {
          companyId,
          provider: providerId,
          providerConfigId: "discovery-preview",
          operation: "secret_provider_config.discovery.preview",
          providerConfig: parsed.data.config,
        });
      }
    },

    listProviderConfigs: (companyId: string) =>
      db
        .select()
        .from(companySecretProviderConfigs)
        .where(eq(companySecretProviderConfigs.companyId, companyId))
        .orderBy(desc(companySecretProviderConfigs.createdAt)),

    getProviderConfigById,

    createProviderConfig: async (
      companyId: string,
      input: {
        provider: SecretProvider;
        displayName: string;
        status?: SecretProviderConfigStatus;
        isDefault?: boolean;
        config?: Record<string, unknown>;
      },
      actor: SecretMutationActor,
    ) => {
      const attribution = requireSecretMutationActor(actor);
      const parsed = createSecretProviderConfigSchema.safeParse(input);
      if (!parsed.success)
        throw unprocessable(
          "Invalid provider vault config",
          parsed.error.flatten(),
        );
      const status =
        input.status ?? defaultProviderConfigStatus(input.provider);
      if (
        (status === "coming_soon" || status === "disabled") &&
        input.isDefault
      ) {
        throw unprocessable(
          "Only ready or warning provider vaults can be default",
        );
      }
      const normalizedConfig = validateProviderConfigPayload(
        input.provider,
        input.config ?? {},
      );
      return db.transaction(async (tx) => {
        if (input.isDefault) {
          await tx
            .update(companySecretProviderConfigs)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(
              and(
                eq(companySecretProviderConfigs.companyId, companyId),
                eq(companySecretProviderConfigs.provider, input.provider),
              ),
            );
        }
        return tx
          .insert(companySecretProviderConfigs)
          .values({
            companyId,
            provider: input.provider,
            displayName: input.displayName.trim(),
            status,
            isDefault: input.isDefault ?? false,
            config: normalizedConfig,
            disabledAt: status === "disabled" ? new Date() : null,
            createdByAgentId: attribution.agentId,
            createdByUserId: attribution.userId,
          })
          .returning()
          .then((rows) => rows[0]);
      });
    },

    updateProviderConfig: async (
      id: string,
      patch: {
        displayName?: string;
        status?: SecretProviderConfigStatus;
        isDefault?: boolean;
        config?: Record<string, unknown>;
      },
      actor: SecretMutationActor,
    ) => {
      requireSecretMutationActor(actor);
      const existing = await getProviderConfigById(id);
      if (!existing) return null;
      const parsed = updateSecretProviderConfigSchema.safeParse(patch);
      if (!parsed.success)
        throw unprocessable(
          "Invalid provider vault config",
          parsed.error.flatten(),
        );
      const provider = existing.provider as SecretProvider;
      const status =
        patch.status ?? (existing.status as SecretProviderConfigStatus);
      if (
        COMING_SOON_SECRET_PROVIDERS.has(provider) &&
        status !== "coming_soon" &&
        status !== "disabled"
      ) {
        throw unprocessable(
          `${provider} provider vaults are locked while coming soon`,
        );
      }
      if (
        (status === "coming_soon" || status === "disabled") &&
        patch.isDefault
      ) {
        throw unprocessable(
          "Only ready or warning provider vaults can be default",
        );
      }
      const normalizedConfig =
        patch.config === undefined
          ? existing.config
          : validateProviderConfigPayload(provider, patch.config);
      return db.transaction(async (tx) => {
        if (patch.isDefault) {
          await tx
            .update(companySecretProviderConfigs)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(
              and(
                eq(companySecretProviderConfigs.companyId, existing.companyId),
                eq(companySecretProviderConfigs.provider, existing.provider),
              ),
            );
        }
        return tx
          .update(companySecretProviderConfigs)
          .set({
            displayName: patch.displayName?.trim() ?? existing.displayName,
            status,
            isDefault:
              status === "disabled" || status === "coming_soon"
                ? false
                : (patch.isDefault ?? existing.isDefault),
            config: normalizedConfig,
            disabledAt:
              status === "disabled"
                ? (existing.disabledAt ?? new Date())
                : null,
            updatedAt: new Date(),
          })
          .where(eq(companySecretProviderConfigs.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
    },

    disableProviderConfig: async (id: string, actor: SecretMutationActor) => {
      requireSecretMutationActor(actor);
      const existing = await getProviderConfigById(id);
      if (!existing) return null;
      return db
        .update(companySecretProviderConfigs)
        .set({
          status: "disabled",
          isDefault: false,
          disabledAt: existing.disabledAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companySecretProviderConfigs.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    removeProviderConfig: async (id: string, actor: SecretMutationActor) => {
      requireSecretMutationActor(actor);
      return db
        .delete(companySecretProviderConfigs)
        .where(eq(companySecretProviderConfigs.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    setDefaultProviderConfig: async (
      id: string,
      actor: SecretMutationActor,
    ) => {
      requireSecretMutationActor(actor);
      const existing = await getProviderConfigById(id);
      if (!existing) return null;
      if (existing.status === "coming_soon" || existing.status === "disabled") {
        throw unprocessable(
          "Only ready or warning provider vaults can be default",
        );
      }
      return db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(companySecretProviderConfigs)
          .where(eq(companySecretProviderConfigs.id, id))
          .then((rows) => rows[0] ?? null);
        if (!current) return null;
        if (current.status === "coming_soon" || current.status === "disabled") {
          throw unprocessable(
            "Only ready or warning provider vaults can be default",
          );
        }
        await tx
          .update(companySecretProviderConfigs)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(companySecretProviderConfigs.companyId, current.companyId),
              eq(companySecretProviderConfigs.provider, current.provider),
            ),
          );
        const updated = await tx
          .update(companySecretProviderConfigs)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(
            and(
              eq(companySecretProviderConfigs.id, id),
              notInArray(companySecretProviderConfigs.status, [
                "coming_soon",
                "disabled",
              ]),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated)
          throw unprocessable(
            "Only ready or warning provider vaults can be default",
          );
        return updated;
      });
    },

    checkProviderConfigHealth: async (
      id: string,
      actor: SecretMutationActor,
    ) => {
      requireSecretMutationActor(actor);
      const existing = await getProviderConfigById(id);
      if (!existing) return null;
      const checkedAt = new Date();
      const staticHealth = providerConfigHealth({
        id: existing.id,
        provider: existing.provider as SecretProvider,
        status: existing.status as SecretProviderConfigStatus,
        config: existing.config ?? {},
      });
      const provider = getSecretProvider(existing.provider as SecretProvider);
      const health =
        staticHealth ??
        mapProviderModuleHealth({
          configId: existing.id,
          provider: existing.provider as SecretProvider,
          providerStatus: existing.status as SecretProviderConfigStatus,
          health: await provider.healthCheck({
            providerConfig: toProviderVaultRuntimeConfig(existing),
          }),
        });
      await db
        .update(companySecretProviderConfigs)
        .set({
          healthStatus: health.status,
          healthCheckedAt: checkedAt,
          healthMessage: health.message,
          healthDetails: health.details as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(companySecretProviderConfigs.id, id));
      return { ...health, checkedAt };
    },

    list: async (companyId: string) => {
      const [secrets, referenceCounts] = await Promise.all([
        db
          .select()
          .from(companySecrets)
          .where(
            and(
              eq(companySecrets.companyId, companyId),
              eq(companySecrets.scope, "company"),
              ne(companySecrets.status, "deleted"),
            ),
          )
          .orderBy(desc(companySecrets.createdAt)),
        db
          .select({
            secretId: companySecretBindings.secretId,
            count: sql<number>`count(*)::int`,
          })
          .from(companySecretBindings)
          .where(eq(companySecretBindings.companyId, companyId))
          .groupBy(companySecretBindings.secretId),
      ]);
      const countsBySecretId = new Map(
        referenceCounts.map((row) => [row.secretId, row.count]),
      );
      return secrets.map((secret) => ({
        ...secret,
        referenceCount: countsBySecretId.get(secret.id) ?? 0,
      }));
    },

    listBindings: (companyId: string, secretId?: string) =>
      db
        .select()
        .from(companySecretBindings)
        .where(
          secretId
            ? and(
                eq(companySecretBindings.companyId, companyId),
                eq(companySecretBindings.secretId, secretId),
              )
            : eq(companySecretBindings.companyId, companyId),
        )
        .orderBy(desc(companySecretBindings.createdAt)),

    listBindingReferences: async (companyId: string, secretId: string) => {
      const bindings = await db
        .select()
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.companyId, companyId),
            eq(companySecretBindings.secretId, secretId),
          ),
        )
        .orderBy(desc(companySecretBindings.createdAt));
      const targetMap = await buildBindingTargetMap(companyId, bindings);
      return bindings.flatMap((binding) => {
        const target = targetMap.get(
          `${binding.targetType}:${binding.targetId}`,
        );
        return target ? [{ ...binding, target }] : [];
      });
    },

    listAccessEvents: (companyId: string, secretId: string) =>
      db
        .select()
        .from(secretAccessEvents)
        .where(
          and(
            eq(secretAccessEvents.companyId, companyId),
            eq(secretAccessEvents.secretId, secretId),
          ),
        )
        .orderBy(desc(secretAccessEvents.createdAt)),

    listUserSecretDefinitions: (companyId: string) =>
      db
        .select()
        .from(userSecretDefinitions)
        .where(
          and(
            eq(userSecretDefinitions.companyId, companyId),
            ne(userSecretDefinitions.status, "deleted"),
          ),
        )
        .orderBy(desc(userSecretDefinitions.createdAt)),

    getUserSecretDefinitionById: (companyId: string, definitionId: string) =>
      getUserSecretDefinitionById(companyId, definitionId),

    createUserSecretDefinition: async (
      companyId: string,
      input: {
        key: string;
        name: string;
        description?: string | null;
        status?: string;
        provider: SecretProvider;
        providerConfigId?: string | null;
        managedMode?: "paperclip_managed" | "external_reference";
        providerMetadata?: Record<string, unknown> | null;
        usageGuidance?: string | null;
      },
      actor: SecretMutationActor,
    ) => {
      const attribution = requireSecretMutationActor(actor);
      const key = requireExactSecretKey(input.key);
      const duplicate = await getUserSecretDefinitionByKey(companyId, key);
      if (duplicate)
        throw conflict(`User secret definition already exists: ${key}`);
      await assertProviderConfigForSecret(
        companyId,
        input.provider,
        input.providerConfigId,
      );
      try {
        return await db
          .insert(userSecretDefinitions)
          .values({
            companyId,
            key,
            name: input.name.trim(),
            description: input.description ?? null,
            status: input.status ?? "active",
            provider: input.provider,
            providerConfigId: input.providerConfigId ?? null,
            managedMode: input.managedMode ?? "paperclip_managed",
            providerMetadata: input.providerMetadata ?? null,
            usageGuidance: input.usageGuidance ?? null,
            createdByAgentId: attribution.agentId,
            createdByUserId: attribution.userId,
            updatedByAgentId: attribution.agentId,
            updatedByUserId: attribution.userId,
          })
          .returning()
          .then((rows) => rows[0]);
      } catch (error) {
        if (
          isUniqueConstraintViolation(
            error,
            USER_SECRET_DEFINITION_KEY_UNIQUE_CONSTRAINT,
          )
        ) {
          throw conflict(`User secret definition already exists: ${key}`);
        }
        throw error;
      }
    },

    updateUserSecretDefinition: async (
      companyId: string,
      definitionId: string,
      patch: {
        key?: string;
        name?: string;
        description?: string | null;
        status?: string;
        providerConfigId?: string | null;
        providerMetadata?: Record<string, unknown> | null;
        usageGuidance?: string | null;
      },
      actor: SecretMutationActor,
    ) => {
      const attribution = requireSecretMutationActor(actor);
      const existing = await resolveUserSecretDefinition(companyId, {
        definitionId,
      });
      if (patch.status === "deleted") {
        return removeUserSecretDefinitionInternal(
          companyId,
          existing.id,
          actor,
        );
      }
      const nextKey =
        patch.key === undefined
          ? existing.key
          : requireExactSecretKey(patch.key);
      if (nextKey !== existing.key) {
        const duplicate = await getUserSecretDefinitionByKey(
          companyId,
          nextKey,
        );
        if (duplicate && duplicate.id !== existing.id) {
          throw conflict(`User secret definition already exists: ${nextKey}`);
        }
      }
      if (patch.providerConfigId !== undefined) {
        await assertProviderConfigForSecret(
          companyId,
          existing.provider as SecretProvider,
          patch.providerConfigId,
        );
      }
      return db
        .update(userSecretDefinitions)
        .set({
          key: nextKey,
          name: patch.name?.trim() ?? existing.name,
          description:
            patch.description === undefined
              ? existing.description
              : patch.description,
          status: patch.status ?? existing.status,
          providerConfigId:
            patch.providerConfigId === undefined
              ? existing.providerConfigId
              : patch.providerConfigId,
          providerMetadata:
            patch.providerMetadata === undefined
              ? existing.providerMetadata
              : patch.providerMetadata,
          usageGuidance:
            patch.usageGuidance === undefined
              ? existing.usageGuidance
              : patch.usageGuidance,
          updatedByAgentId: attribution.agentId,
          updatedByUserId: attribution.userId,
          deletedAt: existing.deletedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(userSecretDefinitions.companyId, companyId),
            eq(userSecretDefinitions.id, definitionId),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    removeUserSecretDefinition: async (
      companyId: string,
      definitionId: string,
      actor: SecretMutationActor,
    ) => removeUserSecretDefinitionInternal(companyId, definitionId, actor),

    getUserSecretDefinitionCoverage: async (
      companyId: string,
      definitionId: string,
    ) => {
      await resolveUserSecretDefinition(companyId, { definitionId });
      const [members, values] = await Promise.all([
        db
          .select({ principalId: companyMemberships.principalUserId })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
            ),
          ),
        db
          .select({
            status: companySecrets.status,
            ownerUserId: companySecrets.ownerUserId,
          })
          .from(companySecrets)
          .where(
            and(
              eq(companySecrets.companyId, companyId),
              eq(companySecrets.scope, "user"),
              eq(companySecrets.userSecretDefinitionId, definitionId),
              ne(companySecrets.status, "deleted"),
            ),
          ),
      ]);
      const memberIds = new Set(
        members.flatMap((member) =>
          member.principalId ? [member.principalId] : [],
        ),
      );
      const configuredCount = values.filter(
        (value) =>
          value.status === "active" &&
          value.ownerUserId &&
          memberIds.has(value.ownerUserId),
      ).length;
      const inactiveCount = values.filter(
        (value) =>
          value.status !== "active" &&
          value.ownerUserId &&
          memberIds.has(value.ownerUserId),
      ).length;
      return {
        definitionId,
        configuredCount,
        inactiveCount,
        missingCount: Math.max(
          0,
          memberIds.size - configuredCount - inactiveCount,
        ),
      };
    },

    listCurrentUserSecretValues: async (
      companyId: string,
      ownerUserId: string,
    ) => {
      const definitions = await db
        .select()
        .from(userSecretDefinitions)
        .where(
          and(
            eq(userSecretDefinitions.companyId, companyId),
            ne(userSecretDefinitions.status, "deleted"),
          ),
        )
        .orderBy(desc(userSecretDefinitions.createdAt));
      const values = await db
        .select()
        .from(companySecrets)
        .where(
          and(
            eq(companySecrets.companyId, companyId),
            eq(companySecrets.scope, "user"),
            eq(companySecrets.ownerUserId, ownerUserId),
            ne(companySecrets.status, "deleted"),
          ),
        );
      const valuesByDefinitionId = new Map(
        values.map((value) => [value.userSecretDefinitionId, value]),
      );
      return definitions.map((definition) => ({
        definition,
        secret: valuesByDefinitionId.get(definition.id) ?? null,
      }));
    },

    createCurrentUserSecretValue: createUserSecretValueInternal,

    rotateCurrentUserSecretValue: async (
      companyId: string,
      ownerUserId: string,
      secretId: string,
      input: {
        value?: string | null;
        externalRef?: string | null;
        providerVersionRef?: string | null;
        providerConfigId?: string | null;
      },
      actor: SecretMutationActor,
    ) => {
      requireSecretMutationActor(actor);
      const secret = await getUserSecretValueById(
        companyId,
        ownerUserId,
        secretId,
      );
      return await (async () => {
        await resolveUserSecretDefinition(companyId, {
          definitionId: secret.userSecretDefinitionId,
        });
        return await secretService(db, secretsRuntime).rotate(
          secret.id,
          input,
          actor,
        );
      })();
    },

    updateCurrentUserSecretValue: async (
      companyId: string,
      ownerUserId: string,
      secretId: string,
      patch: {
        status?: "active" | "disabled" | "archived" | "deleted";
        value?: string | null;
        externalRef?: string | null;
        providerVersionRef?: string | null;
        providerConfigId?: string | null;
      },
      actor: SecretMutationActor,
    ) => {
      requireSecretMutationActor(actor);
      const secret = await getUserSecretValueById(
        companyId,
        ownerUserId,
        secretId,
      );
      if (
        patch.value != null ||
        patch.externalRef != null ||
        patch.providerVersionRef != null ||
        patch.providerConfigId != null
      ) {
        return await secretService(
          db,
          secretsRuntime,
        ).rotateCurrentUserSecretValue(
          companyId,
          ownerUserId,
          secret.id,
          patch,
          actor,
        );
      }
      if (patch.status === "deleted") {
        return await secretService(
          db,
          secretsRuntime,
        ).removeCurrentUserSecretValue(
          companyId,
          ownerUserId,
          secret.id,
          actor,
        );
      }
      return db
        .update(companySecrets)
        .set({
          status: patch.status ?? secret.status,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, secret.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    removeCurrentUserSecretValue: async (
      companyId: string,
      ownerUserId: string,
      secretId: string,
      actor: SecretMutationActor,
    ) => {
      requireSecretMutationActor(actor);
      const secret = await getUserSecretValueById(
        companyId,
        ownerUserId,
        secretId,
      );
      return await secretService(db, secretsRuntime).remove(secret.id, actor);
    },

    syncUserSecretDeclarationsForTarget: async (
      companyId: string,
      target: {
        targetType: SecretBindingTargetType;
        targetId: string;
        pathPrefix?: string;
      },
      refs: Array<{
        definitionKey: string;
        configPath: string;
        envKey: string;
        versionSelector?: SecretVersionSelector;
        required?: boolean;
        allowMissingOverride?: boolean;
        label?: string | null;
      }>,
      options: {
        actor: SecretMutationActor;
        db?: SecretBindingDb;
        replaceAll?: boolean;
      },
    ) => {
      requireSecretMutationActor(options?.actor);
      const targetDb = options.db ?? db;
      const normalizedRefs: Array<{
        definitionId: string;
        configPath: string;
        envKey: string;
        versionSelector: SecretVersionSelector;
        required: boolean;
        allowMissingOverride: boolean;
        label: string | null;
      }> = [];
      for (const ref of refs) {
        const definition = await resolveUserSecretDefinition(
          companyId,
          { definitionKey: ref.definitionKey },
          targetDb,
        );
        normalizedRefs.push({
          definitionId: definition.id,
          configPath: ref.configPath,
          envKey: ref.envKey,
          versionSelector: ref.versionSelector ?? "latest",
          required: ref.required ?? true,
          allowMissingOverride: ref.allowMissingOverride ?? false,
          label: ref.label ?? null,
        });
      }

      const pathPrefix = target.pathPrefix ?? "env";
      const writeDeclarations = async (executor: SecretBindingDb) => {
        if (options.replaceAll) {
          await executor
            .delete(userSecretDeclarations)
            .where(
              and(
                eq(userSecretDeclarations.companyId, companyId),
                eq(userSecretDeclarations.targetType, target.targetType),
                eq(userSecretDeclarations.targetId, target.targetId),
              ),
            );
        } else {
          await executor
            .delete(userSecretDeclarations)
            .where(
              and(
                eq(userSecretDeclarations.companyId, companyId),
                eq(userSecretDeclarations.targetType, target.targetType),
                eq(userSecretDeclarations.targetId, target.targetId),
                like(userSecretDeclarations.configPath, `${pathPrefix}.%`),
              ),
            );
        }
        if (normalizedRefs.length === 0) return;
        await executor.insert(userSecretDeclarations).values(
          normalizedRefs.map((ref) => ({
            companyId,
            userSecretDefinitionId: ref.definitionId,
            targetType: target.targetType,
            targetId: target.targetId,
            configPath: ref.configPath,
            envKey: ref.envKey,
            versionSelector: String(ref.versionSelector),
            required: ref.required,
            allowMissingOverride: ref.allowMissingOverride,
            label: ref.label,
          })),
        );
      };

      if (options.db) {
        await writeDeclarations(targetDb);
      } else {
        await db.transaction(async (tx) => writeDeclarations(tx));
      }
      return normalizedRefs;
    },

    resolveUserSecretValue: async (
      companyId: string,
      input: {
        definitionKey?: string | null;
        definitionId?: string | null;
        responsibleUserId?: string | null;
        version?: SecretVersionSelector;
        required?: boolean;
        allowMissingOverride?: boolean;
      },
      context?: SecretConsumerContext,
    ): Promise<RuntimeSecretResolution | null> => {
      const responsibleUserId =
        input.responsibleUserId ?? context?.responsibleUserId ?? null;
      const optionalBinding =
        input.allowMissingOverride || input.required === false;
      let definition: typeof userSecretDefinitions.$inferSelect;
      try {
        definition = await resolveUserSecretDefinition(companyId, input);
      } catch (error) {
        if (
          optionalBinding &&
          error instanceof HttpError &&
          error.status === 404
        )
          return null;
        throw error;
      }
      if (definition.status !== "active") {
        if (optionalBinding) return null;
        throw unprocessable("User secret definition is not active");
      }
      if (!responsibleUserId?.trim()) {
        if (optionalBinding) return null;
        throw unprocessable(
          "Responsible user is required for user secret resolution",
          {
            code: "responsible_user_missing",
          },
        );
      }
      let declaration: typeof userSecretDeclarations.$inferSelect | null = null;
      if (context?.configPath) {
        declaration = await db
          .select()
          .from(userSecretDeclarations)
          .where(
            and(
              eq(userSecretDeclarations.companyId, companyId),
              eq(userSecretDeclarations.userSecretDefinitionId, definition.id),
              eq(userSecretDeclarations.targetType, context.consumerType),
              eq(userSecretDeclarations.targetId, context.consumerId),
              eq(userSecretDeclarations.configPath, context.configPath),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!declaration) {
          if (optionalBinding) return null;
          throw unprocessable(
            `User secret is not declared for ${context.consumerType}:${context.consumerId} at ${context.configPath}`,
            { code: "binding_missing" },
          );
        }
      }
      if (
        Array.isArray(context?.allowedBindingIds) &&
        (!declaration || !context.allowedBindingIds.includes(declaration.id))
      ) {
        throw unprocessable(
          "User secret declaration is outside the active low-trust boundary",
          { code: "binding_not_allowed" },
        );
      }
      const secret = await getUserSecretValue({
        companyId,
        ownerUserId: responsibleUserId,
        definitionId: definition.id,
      });
      if (!secret) {
        if (optionalBinding) return null;
        throw unprocessable("User secret value is not configured", {
          code: "user_secret_missing",
          definitionId: definition.id,
          responsibleUserId,
        });
      }
      const resolution = await resolveSecretValueInternal(
        companyId,
        secret.id,
        input.version ?? "latest",
        {
          accessContext: context
            ? { ...context, responsibleUserId }
            : undefined,
          allowUserSecretScope: true,
        },
      );
      return {
        ...resolution,
        manifestEntry: {
          ...resolution.manifestEntry,
          bindingId:
            declaration?.id ?? resolution.manifestEntry.bindingId ?? null,
        },
      };
    },

    previewRemoteImport: async (
      companyId: string,
      input: {
        providerConfigId: string;
        query?: string | null;
        nextToken?: string | null;
        pageSize?: number;
      },
    ) => {
      const {
        providerConfig,
        provider: providerId,
        runtimeConfig,
      } = await getRemoteImportProviderConfig(
        companyId,
        input.providerConfigId,
      );
      const provider = getSecretProvider(providerId);
      if (!provider.listRemoteSecrets) {
        throw unprocessable(
          `${providerId} provider does not support remote import listing`,
        );
      }
      let listed: RemoteSecretListResult;
      try {
        listed = await provider.listRemoteSecrets({
          providerConfig: runtimeConfig,
          query: input.query,
          nextToken: input.nextToken,
          pageSize: input.pageSize,
        });
      } catch (error) {
        throw remoteProviderHttpError(error, {
          companyId,
          provider: providerId,
          providerConfigId: providerConfig.id,
          operation: "remote_import.preview",
        });
      }
      const maps = await buildRemoteImportConflictMaps(companyId, providerId);
      const candidates: RemoteSecretImportCandidate[] = [];
      for (const remote of listed.secrets) {
        const externalRef = requireExactOpaqueSecretReference(
          remote.externalRef,
          "Remote provider secret reference",
        );
        const providerVersionRef = requireOptionalExactOpaqueSecretReference(
          remote.providerVersionRef,
          "Remote provider secret version reference",
        );
        const remoteName =
          remote.name.trim() || deriveSecretNameFromExternalRef(externalRef);
        const name = remoteName || deriveSecretNameFromExternalRef(externalRef);
        const key = normalizeSecretKey(name);
        let canonicalExternalRef = externalRef;
        const conflicts: RemoteSecretImportConflict[] = [];
        try {
          const prepared = assertExactPreparedSecretReferences(
            await provider.linkExternalSecret({
              externalRef,
              providerVersionRef,
              providerConfig: runtimeConfig,
              context: {
                companyId,
                secretKey: key || "remote-import-preview",
                secretName: name,
                version: 1,
              },
            }),
          );
          canonicalExternalRef = prepared.externalRef ?? externalRef;
        } catch (error) {
          conflicts.push({
            type: "provider_guardrail",
            message: remoteImportRowFailureReason(
              error,
              "Provider rejected this external reference",
              {
                companyId,
                provider: providerId,
                providerConfigId: providerConfig.id,
                operation: "remote_import.preview.link_external_reference",
              },
            ),
          });
        }
        conflicts.push(
          ...remoteImportConflictsFor({
            providerConfigId: providerConfig.id,
            externalRef: canonicalExternalRef,
            name,
            key,
            maps,
          }),
        );
        const hasDuplicate = conflicts.some(
          (conflict) => conflict.type === "exact_reference",
        );
        const hasConflict = conflicts.length > 0;
        candidates.push({
          externalRef,
          remoteName,
          name,
          key,
          providerVersionRef,
          providerMetadata: sanitizeRemoteProviderMetadata(
            providerId,
            remote.metadata,
          ),
          status: hasDuplicate
            ? "duplicate"
            : hasConflict
              ? "conflict"
              : "ready",
          importable: !hasConflict,
          conflicts,
        });
      }
      return {
        providerConfigId: providerConfig.id,
        provider: providerId,
        nextToken: listed.nextToken ?? null,
        candidates,
      };
    },

    importRemoteSecrets: async (
      companyId: string,
      input: {
        providerConfigId: string;
        secrets: Array<{
          externalRef: string;
          name?: string | null;
          key?: string | null;
          description?: string | null;
          providerVersionRef?: string | null;
          providerMetadata?: Record<string, unknown> | null;
        }>;
      },
      actor: SecretMutationActor,
    ) => {
      const attribution = requireSecretMutationActor(actor);
      for (const selection of input.secrets) {
        requireExactOpaqueSecretReference(
          selection.externalRef,
          "Provider secret reference",
        );
        requireOptionalExactOpaqueSecretReference(
          selection.providerVersionRef,
          "Provider secret version reference",
        );
      }
      const {
        providerConfig,
        provider: providerId,
        runtimeConfig,
      } = await getRemoteImportProviderConfig(
        companyId,
        input.providerConfigId,
      );
      const provider = getSecretProvider(providerId);
      if (provider.descriptor().supportsExternalReferences === false) {
        throw unprocessable(
          `${providerId} provider does not support linked external references`,
        );
      }
      const maps = await buildRemoteImportConflictMaps(companyId, providerId);
      const results: RemoteSecretImportRowResult[] = [];

      for (const selection of input.secrets) {
        const externalRef = selection.externalRef;
        const name =
          selection.name?.trim() ||
          deriveSecretNameFromExternalRef(externalRef);
        const key = requireExactSecretKey(
          selection.key == null ? normalizeSecretKey(name) : selection.key,
        );
        const description = selection.description?.trim() || null;
        let prepared: PreparedSecretVersion | undefined;
        const conflicts = remoteImportConflictsFor({
          providerConfigId: providerConfig.id,
          externalRef,
          name,
          key,
          maps,
        });
        if (conflicts.length === 0) {
          try {
            prepared = assertExactPreparedSecretReferences(
              await provider.linkExternalSecret({
                externalRef,
                providerVersionRef: selection.providerVersionRef ?? null,
                providerConfig: runtimeConfig,
                context: {
                  companyId,
                  secretKey: key,
                  secretName: name,
                  version: 1,
                },
              }),
            );
            const canonicalDuplicate = maps.byProviderConfigExternalRef.get(
              remoteImportExternalRefKey(
                providerConfig.id,
                prepared.externalRef ?? externalRef,
              ),
            );
            if (canonicalDuplicate) {
              conflicts.push({
                type: "exact_reference",
                existingSecretId: canonicalDuplicate.id,
                message:
                  "An existing secret already links this exact provider reference.",
              });
            }
          } catch (error) {
            results.push({
              externalRef,
              name,
              key,
              status: "error",
              reason: remoteImportRowFailureReason(
                error,
                "Provider rejected this external reference",
                {
                  companyId,
                  provider: providerId,
                  providerConfigId: providerConfig.id,
                  operation: "remote_import.prepare_external_reference",
                },
              ),
              secretId: null,
              conflicts: [],
            });
            continue;
          }
        }
        if (conflicts.length > 0) {
          results.push({
            externalRef,
            name,
            key,
            status: "skipped",
            reason: conflicts.some(
              (conflict) => conflict.type === "exact_reference",
            )
              ? "exact_reference_duplicate"
              : "name_or_key_conflict",
            secretId: null,
            conflicts,
          });
          continue;
        }

        try {
          if (!prepared) {
            prepared = assertExactPreparedSecretReferences(
              await provider.linkExternalSecret({
                externalRef,
                providerVersionRef: selection.providerVersionRef ?? null,
                providerConfig: runtimeConfig,
                context: {
                  companyId,
                  secretKey: key,
                  secretName: name,
                  version: 1,
                },
              }),
            );
          }
          if (!prepared) {
            throw unprocessable("Provider rejected this external reference");
          }
          const preparedSecret = prepared;
          const secret = await db.transaction(async (tx) => {
            const inserted = await tx
              .insert(companySecrets)
              .values({
                companyId,
                key,
                name,
                provider: providerId,
                providerConfigId: providerConfig.id,
                status: "active",
                managedMode: "external_reference",
                externalRef: preparedSecret.externalRef,
                providerMetadata: null,
                latestVersion: 1,
                description,
                lastRotatedAt: new Date(),
                createdByAgentId: attribution.agentId,
                createdByUserId: attribution.userId,
              })
              .returning()
              .then((rows) => rows[0]);
            await tx.insert(companySecretVersions).values({
              secretId: inserted.id,
              version: 1,
              material: preparedSecret.material,
              valueSha256: preparedSecret.valueSha256,
              fingerprintSha256:
                preparedSecret.fingerprintSha256 ?? preparedSecret.valueSha256,
              providerVersionRef: preparedSecret.providerVersionRef ?? null,
              status: "current",
              createdByAgentId: attribution.agentId,
              createdByUserId: attribution.userId,
            });
            return inserted;
          });
          maps.byProviderConfigExternalRef.set(
            remoteImportExternalRefKey(
              providerConfig.id,
              preparedSecret.externalRef ?? externalRef,
            ),
            secret,
          );
          maps.byName.set(name, secret);
          maps.byKey.set(key, secret);
          results.push({
            externalRef,
            name,
            key,
            status: "imported",
            reason: null,
            secretId: secret.id,
            conflicts: [],
          });
        } catch (error) {
          results.push({
            externalRef,
            name,
            key,
            status: "error",
            reason: remoteImportRowFailureReason(error, "Import failed", {
              companyId,
              provider: providerId,
              providerConfigId: providerConfig.id,
              operation: "remote_import.commit",
            }),
            secretId: null,
            conflicts: [],
          });
        }
      }

      return {
        providerConfigId: providerConfig.id,
        provider: providerId,
        importedCount: results.filter((result) => result.status === "imported")
          .length,
        skippedCount: results.filter((result) => result.status === "skipped")
          .length,
        errorCount: results.filter((result) => result.status === "error")
          .length,
        results,
      };
    },

    getById,
    getByName,
    getByKey,
    resolveSecretValue,
    resolveSecretVersion,

    create: async (
      companyId: string,
      input: CreateCompanySecretInput,
      actor: SecretMutationActor,
    ) => {
      const attribution = requireSecretMutationActor(actor);
      requireOptionalExactOpaqueSecretReference(
        input.externalRef,
        "Provider secret reference",
      );
      requireOptionalExactOpaqueSecretReference(
        input.providerVersionRef,
        "Provider secret version reference",
      );
      const existing = await getByName(companyId, input.name);
      if (existing) throw conflict(`Secret already exists: ${input.name}`);
      const key = requireExactSecretKey(
        input.key == null ? normalizeSecretKey(input.name) : input.key,
      );
      const duplicateKey = await db
        .select()
        .from(companySecrets)
        .where(
          and(
            eq(companySecrets.companyId, companyId),
            eq(companySecrets.scope, "company"),
            eq(companySecrets.key, key),
            ne(companySecrets.status, "deleted"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (duplicateKey) throw conflict(`Secret key already exists: ${key}`);

      const managedMode = input.managedMode ?? "paperclip_managed";
      const provider = getSecretProvider(input.provider);
      const providerConfig = await getSelectableRuntimeProviderConfig({
        companyId,
        provider: input.provider,
        providerConfigId: input.providerConfigId,
      });
      if (managedMode === "external_reference" && input.externalRef == null) {
        throw unprocessable("External reference secrets require externalRef");
      }
      if (managedMode === "paperclip_managed" && input.externalRef != null) {
        throw unprocessable("Managed secrets cannot override externalRef");
      }
      if (managedMode === "paperclip_managed" && !input.value?.trim()) {
        throw unprocessable("Managed secrets require value");
      }
      const providerWriteContext = {
        companyId,
        secretKey: key,
        secretName: input.name,
        version: 1,
      };
      const reservedSecret = await db
        .insert(companySecrets)
        .values({
          companyId,
          key,
          name: input.name,
          provider: input.provider,
          providerConfigId: input.providerConfigId ?? null,
          status: "archived",
          managedMode,
          externalRef: null,
          providerMetadata: input.providerMetadata ?? null,
          latestVersion: 0,
          description: input.description ?? null,
          createdByAgentId: attribution.agentId,
          createdByUserId: attribution.userId,
        })
        .returning()
        .then((rows) => rows[0]);

      let prepared: PreparedSecretVersion;
      try {
        prepared = assertExactPreparedSecretReferences(
          managedMode === "external_reference"
            ? await provider.linkExternalSecret({
                externalRef: input.externalRef ?? "",
                providerVersionRef: input.providerVersionRef ?? null,
                providerConfig,
                context: providerWriteContext,
              })
            : await provider.createSecret({
                value: input.value ?? "",
                externalRef: null,
                providerConfig,
                context: providerWriteContext,
              }),
        );
      } catch (error) {
        throw await throwProviderWriteOrReservedRowRollbackError({
          error,
          rollbackReservedRow: () =>
            db
              .delete(companySecrets)
              .where(eq(companySecrets.id, reservedSecret.id)),
          companyId,
          provider: provider.id,
          providerConfigId: input.providerConfigId ?? null,
          providerConfig,
          operation: "secret.create",
        });
      }

      try {
        await db
          .update(companySecrets)
          .set({
            externalRef: prepared.externalRef,
            latestVersion: 1,
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, reservedSecret.id));
        await db.insert(companySecretVersions).values({
          secretId: reservedSecret.id,
          version: 1,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
          providerVersionRef: prepared.providerVersionRef ?? null,
          status: "disabled",
          createdByAgentId: attribution.agentId,
          createdByUserId: attribution.userId,
        });
      } catch (error) {
        if (managedMode === "paperclip_managed") {
          const cleaned = await cleanupPreparedProviderWrite({
            provider,
            prepared,
            providerConfig,
            context: providerWriteContext,
            mode: "delete",
            operation: "create.prepare_rollback",
          });
          if (!cleaned) {
            throwProviderCleanupFailedAfterCreateRollback({
              companyId,
              provider: provider.id,
              providerConfigId: input.providerConfigId ?? null,
              providerConfig,
              operation: "create.prepare_rollback",
            });
          }
        }
        await deleteLocalSecretCreateReservationOrThrow({
          db,
          secretId: reservedSecret.id,
          companyId,
          provider: provider.id,
          providerConfigId: input.providerConfigId ?? null,
          providerConfig,
          operation: "create.prepare_rollback",
        });
        throw error;
      }

      try {
        return await db.transaction(async (tx) => {
          await tx
            .update(companySecretVersions)
            .set({ status: "current" })
            .where(
              and(
                eq(companySecretVersions.secretId, reservedSecret.id),
                eq(companySecretVersions.version, 1),
              ),
            );

          const secret = await tx
            .update(companySecrets)
            .set({
              status: "active",
              externalRef: prepared.externalRef,
              latestVersion: 1,
              lastRotatedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(companySecrets.id, reservedSecret.id))
            .returning()
            .then((rows) => rows[0]);

          if (!secret) throw notFound("Secret not found");
          return secret;
        });
      } catch (error) {
        if (managedMode === "paperclip_managed") {
          const cleaned = await cleanupPreparedProviderWrite({
            provider,
            prepared,
            providerConfig,
            context: providerWriteContext,
            mode: "delete",
            operation: "create.rollback",
          });
          if (!cleaned) {
            throwProviderCleanupFailedAfterCreateRollback({
              companyId,
              provider: provider.id,
              providerConfigId: input.providerConfigId ?? null,
              providerConfig,
              operation: "create.rollback",
            });
          }
        }
        await deleteLocalSecretCreateReservationOrThrow({
          db,
          secretId: reservedSecret.id,
          companyId,
          provider: provider.id,
          providerConfigId: input.providerConfigId ?? null,
          providerConfig,
          operation: "create.rollback",
        });
        throw error;
      }
    },

    createBound: async (
      companyId: string,
      input: CreateCompanySecretInput,
      binding: CreateCompanySecretBindingInput,
      actor: SecretMutationActor,
    ) => {
      requireSecretMutationActor(actor);
      const service = secretService(db, secretsRuntime);
      const secret = await service.create(companyId, input, actor);
      try {
        await service.createBinding(
          {
            companyId,
            secretId: secret.id,
            ...binding,
          },
          actor,
        );
        return secret;
      } catch (error) {
        try {
          await service.remove(secret.id, actor);
        } catch (rollbackError) {
          logger.error(
            {
              err: rollbackError,
              companyId,
              secretId: secret.id,
              targetType: binding.targetType,
              targetId: binding.targetId,
              configPath: binding.configPath,
            },
            "failed to roll back secret after binding creation failed",
          );
          throw rollbackError;
        }
        throw error;
      }
    },

    rotate: async (
      secretId: string,
      input: {
        value?: string | null;
        externalRef?: string | null;
        providerVersionRef?: string | null;
        providerConfigId?: string | null;
      },
      actor: SecretMutationActor,
    ) => {
      const attribution = requireSecretMutationActor(actor);
      requireOptionalExactOpaqueSecretReference(
        input.externalRef,
        "Provider secret reference",
      );
      requireOptionalExactOpaqueSecretReference(
        input.providerVersionRef,
        "Provider secret version reference",
      );
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");
      if (secret.status !== "active")
        throw unprocessable("Cannot rotate a non-active secret");
      const providerId = secret.provider as SecretProvider;
      const provider = getSecretProvider(providerId);
      const providerConfigId =
        input.providerConfigId === undefined
          ? secret.providerConfigId
          : input.providerConfigId;
      const providerConfig = await getSelectableRuntimeProviderConfig({
        companyId: secret.companyId,
        provider: providerId,
        providerConfigId,
      });
      requireOptionalExactOpaqueSecretReference(
        secret.externalRef,
        "Stored provider secret reference",
      );
      const nextVersion = secret.latestVersion + 1;
      if (
        secret.managedMode === "external_reference" &&
        (input.externalRef ?? secret.externalRef) == null
      ) {
        throw unprocessable("External reference secrets require externalRef");
      }
      if (
        secret.managedMode !== "external_reference" &&
        input.externalRef != null
      ) {
        throw unprocessable("Managed secrets cannot override externalRef");
      }
      if (secret.managedMode !== "external_reference" && !input.value?.trim()) {
        throw unprocessable("Managed secrets require value");
      }
      const providerWriteContext = {
        companyId: secret.companyId,
        secretKey: secret.key,
        secretName: secret.name,
        version: nextVersion,
      };
      let prepared: PreparedSecretVersion;
      try {
        prepared = assertExactPreparedSecretReferences(
          secret.managedMode === "external_reference"
            ? await provider.linkExternalSecret({
                externalRef: input.externalRef ?? secret.externalRef ?? "",
                providerVersionRef: input.providerVersionRef ?? null,
                providerConfig,
                context: providerWriteContext,
              })
            : await provider.createVersion({
                value: input.value ?? "",
                externalRef: secret.externalRef ?? null,
                providerConfig,
                context: providerWriteContext,
              }),
        );
      } catch (error) {
        throw remoteProviderWriteHttpError(error, {
          companyId: secret.companyId,
          provider: provider.id,
          providerConfigId,
          providerConfig,
          operation: "secret.rotate",
        });
      }

      try {
        await db.insert(companySecretVersions).values({
          secretId: secret.id,
          version: nextVersion,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
          providerVersionRef: prepared.providerVersionRef ?? null,
          status: "disabled",
          createdByAgentId: attribution.agentId,
          createdByUserId: attribution.userId,
        });
      } catch (error) {
        if (secret.managedMode !== "external_reference") {
          await cleanupPreparedProviderWrite({
            provider,
            prepared,
            providerConfig,
            context: providerWriteContext,
            mode: "archive",
            operation: "rotate.prepare_rollback",
          });
        }
        throw error;
      }

      try {
        return await db.transaction(async (tx) => {
          await tx
            .update(companySecretVersions)
            .set({ status: "previous" })
            .where(
              and(
                eq(companySecretVersions.secretId, secret.id),
                ne(companySecretVersions.version, nextVersion),
              ),
            );
          await tx
            .update(companySecretVersions)
            .set({ status: "current" })
            .where(
              and(
                eq(companySecretVersions.secretId, secret.id),
                eq(companySecretVersions.version, nextVersion),
              ),
            );

          const updated = await tx
            .update(companySecrets)
            .set({
              latestVersion: nextVersion,
              externalRef: prepared.externalRef,
              providerConfigId,
              lastRotatedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(companySecrets.id, secret.id))
            .returning()
            .then((rows) => rows[0] ?? null);

          if (!updated) throw notFound("Secret not found");
          return updated;
        });
      } catch (error) {
        if (secret.managedMode !== "external_reference") {
          const cleaned = await cleanupPreparedProviderWrite({
            provider,
            prepared,
            providerConfig,
            context: providerWriteContext,
            mode: "archive",
            operation: "rotate.rollback",
          });
          if (cleaned) {
            await db
              .delete(companySecretVersions)
              .where(
                and(
                  eq(companySecretVersions.secretId, secret.id),
                  eq(companySecretVersions.version, nextVersion),
                ),
              )
              .catch(() => undefined);
          }
        }
        throw error;
      }
    },

    update: async (
      secretId: string,
      patch: {
        name?: string;
        key?: string;
        status?: "active" | "disabled" | "archived" | "deleted";
        providerConfigId?: string | null;
        description?: string | null;
        externalRef?: string | null;
        providerMetadata?: Record<string, unknown> | null;
      },
      actor: SecretMutationActor,
    ) => {
      requireSecretMutationActor(actor);
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");
      if (secret.status === "deleted") throw notFound("Secret not found");

      if (patch.name && patch.name !== secret.name) {
        const duplicate = await getByName(secret.companyId, patch.name);
        if (duplicate && duplicate.id !== secret.id) {
          throw conflict(`Secret already exists: ${patch.name}`);
        }
      }
      const nextKey =
        patch.key === undefined ? secret.key : requireExactSecretKey(patch.key);
      if (!nextKey) throw unprocessable("Secret key is required");
      if (nextKey !== secret.key) {
        const duplicateKey = await db
          .select()
          .from(companySecrets)
          .where(
            and(
              eq(companySecrets.companyId, secret.companyId),
              eq(companySecrets.scope, "company"),
              eq(companySecrets.key, nextKey),
              ne(companySecrets.status, "deleted"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (duplicateKey && duplicateKey.id !== secret.id) {
          throw conflict(`Secret key already exists: ${nextKey}`);
        }
      }
      const deleting = patch.status === "deleted";
      if (deleting && secret.managedMode === "paperclip_managed") {
        throw unprocessable(
          "Managed secrets must be deleted through DELETE /secrets/:id",
        );
      }
      if (
        secret.managedMode !== "external_reference" &&
        patch.externalRef !== undefined
      ) {
        throw unprocessable("Managed secrets cannot override externalRef");
      }
      if (
        secret.managedMode === "external_reference" &&
        patch.externalRef !== undefined &&
        patch.externalRef !== secret.externalRef
      ) {
        throw unprocessable(
          "External reference secrets cannot be retargeted through generic update",
        );
      }
      if (
        secret.managedMode === "external_reference" &&
        patch.providerConfigId !== undefined &&
        patch.providerConfigId !== secret.providerConfigId
      ) {
        throw unprocessable(
          "External reference secrets cannot change provider vault through generic update",
        );
      }
      if (
        secret.managedMode === "paperclip_managed" &&
        patch.providerConfigId !== undefined &&
        patch.providerConfigId !== secret.providerConfigId
      ) {
        throw unprocessable(
          "Managed secrets cannot change provider vault through PATCH; use rotate() to migrate to a new vault",
        );
      }
      if (patch.providerConfigId !== undefined) {
        await assertProviderConfigForSecret(
          secret.companyId,
          secret.provider as SecretProvider,
          patch.providerConfigId,
        );
      }

      return db
        .update(companySecrets)
        .set({
          key: deleting ? `${secret.key}__deleted__${secret.id}` : nextKey,
          name: deleting
            ? `${secret.name}__deleted__${secret.id}`
            : (patch.name ?? secret.name),
          status: patch.status ?? secret.status,
          providerConfigId:
            patch.providerConfigId === undefined
              ? secret.providerConfigId
              : patch.providerConfigId,
          description:
            patch.description === undefined
              ? secret.description
              : patch.description,
          externalRef:
            patch.externalRef === undefined
              ? secret.externalRef
              : patch.externalRef,
          providerMetadata:
            patch.providerMetadata === undefined
              ? secret.providerMetadata
              : patch.providerMetadata,
          deletedAt: deleting ? new Date() : secret.deletedAt,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, secret.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    createBinding: async (
      input: {
        companyId: string;
        secretId: string;
        targetType: SecretBindingTargetType;
        targetId: string;
        configPath: string;
        versionSelector?: SecretVersionSelector;
        required?: boolean;
        label?: string | null;
        projectionClass?: SecretProjectionClass;
        projectionAllowlistKey?: string | null;
      },
      actor: SecretMutationActor,
    ) => {
      requireSecretMutationActor(actor);
      await assertSecretInCompany(input.companyId, input.secretId);
      assertClass3StaticLeaseAllowed({
        targetType: input.targetType,
        configPath: input.configPath,
        projectionClass: input.projectionClass,
        projectionAllowlistKey: input.projectionAllowlistKey,
      });
      const existing = await db
        .select()
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.companyId, input.companyId),
            eq(companySecretBindings.targetType, input.targetType),
            eq(companySecretBindings.targetId, input.targetId),
            eq(companySecretBindings.configPath, input.configPath),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing)
        throw conflict(`Secret binding already exists at ${input.configPath}`);
      return db
        .insert(companySecretBindings)
        .values({
          companyId: input.companyId,
          secretId: input.secretId,
          targetType: input.targetType,
          targetId: input.targetId,
          configPath: input.configPath,
          versionSelector: String(input.versionSelector ?? "latest"),
          required: input.required ?? true,
          label: input.label ?? null,
          projectionClass: input.projectionClass ?? "unclassified",
          projectionAllowlistKey: input.projectionAllowlistKey ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    syncSecretRefsForTarget: async (
      companyId: string,
      target: { targetType: SecretBindingTargetType; targetId: string },
      refs: Array<{
        secretId: string;
        configPath: string;
        versionSelector?: SecretVersionSelector;
        required?: boolean;
        label?: string | null;
        projectionClass?: SecretProjectionClass;
        projectionAllowlistKey?: string | null;
      }>,
      options: {
        actor: SecretMutationActor;
        db?: SecretBindingDb;
        replaceAll?: boolean;
      },
    ) => {
      requireSecretMutationActor(options?.actor);
      const bindingDb = options.db ?? db;
      const normalizedRefs: Array<{
        secretId: string;
        configPath: string;
        versionSelector: SecretVersionSelector;
        required: boolean;
        label: string | null;
        projectionClass: SecretProjectionClass;
        projectionAllowlistKey: string | null;
      }> = [];
      for (const ref of refs) {
        await assertSecretInCompany(companyId, ref.secretId, bindingDb);
        const projectionClass = ref.projectionClass ?? "unclassified";
        const projectionAllowlistKey = ref.projectionAllowlistKey ?? null;
        assertClass3StaticLeaseAllowed({
          targetType: target.targetType,
          configPath: ref.configPath,
          projectionClass,
          projectionAllowlistKey,
        });
        normalizedRefs.push({
          secretId: ref.secretId,
          configPath: ref.configPath,
          versionSelector: ref.versionSelector ?? "latest",
          required: ref.required ?? true,
          label: ref.label ?? null,
          projectionClass,
          projectionAllowlistKey,
        });
      }

      const pathPrefixes = [
        ...new Set(normalizedRefs.map((ref) => ref.configPath.split(".")[0])),
      ];

      const writeBindings = async (executor: SecretBindingDb) => {
        if (options.replaceAll) {
          await executor
            .delete(companySecretBindings)
            .where(
              and(
                eq(companySecretBindings.companyId, companyId),
                eq(companySecretBindings.targetType, target.targetType),
                eq(companySecretBindings.targetId, target.targetId),
              ),
            );
        } else if (pathPrefixes.length > 0) {
          for (const pathPrefix of pathPrefixes) {
            await executor
              .delete(companySecretBindings)
              .where(
                and(
                  eq(companySecretBindings.companyId, companyId),
                  eq(companySecretBindings.targetType, target.targetType),
                  eq(companySecretBindings.targetId, target.targetId),
                  or(
                    eq(companySecretBindings.configPath, pathPrefix),
                    like(companySecretBindings.configPath, `${pathPrefix}.%`),
                  ),
                ),
              );
          }
        } else {
          await executor
            .delete(companySecretBindings)
            .where(
              and(
                eq(companySecretBindings.companyId, companyId),
                eq(companySecretBindings.targetType, target.targetType),
                eq(companySecretBindings.targetId, target.targetId),
              ),
            );
        }
        if (normalizedRefs.length === 0) return;
        await executor.insert(companySecretBindings).values(
          normalizedRefs.map((ref) => ({
            companyId,
            secretId: ref.secretId,
            targetType: target.targetType,
            targetId: target.targetId,
            configPath: ref.configPath,
            versionSelector: String(ref.versionSelector),
            required: ref.required,
            label: ref.label,
            projectionClass: ref.projectionClass,
            projectionAllowlistKey: ref.projectionAllowlistKey,
          })),
        );
      };
      if (options.db) {
        await writeBindings(options.db);
      } else {
        await db.transaction(async (tx) => writeBindings(tx));
      }
      return normalizedRefs;
    },

    listBindingCompanyIdsForTarget: async (target: {
      targetType: SecretBindingTargetType;
      targetId: string;
    }): Promise<string[]> =>
      db
        .select({ companyId: companySecretBindings.companyId })
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.targetType, target.targetType),
            eq(companySecretBindings.targetId, target.targetId),
          ),
        )
        .then((rows) => [...new Set(rows.map((row) => row.companyId))]),

    syncEnvBindingsForTarget: async (
      companyId: string,
      target: {
        targetType: SecretBindingTargetType;
        targetId: string;
        pathPrefix?: string;
      },
      envValue: unknown,
      options: {
        actor: SecretMutationActor;
        db?: SecretBindingDb;
      },
    ) => {
      requireSecretMutationActor(options?.actor);
      const record = asRecord(envValue) ?? {};
      const refs: Array<{
        secretId: string;
        configPath: string;
        versionSelector: SecretVersionSelector;
        projectionClass: SecretProjectionClass;
        projectionAllowlistKey: string | null;
      }> = [];
      const userRefs: Array<{
        definitionKey: string;
        configPath: string;
        envKey: string;
        versionSelector: SecretVersionSelector;
        required: boolean;
        allowMissingOverride: boolean;
      }> = [];
      const pathPrefix = target.pathPrefix ?? "env";
      const bindingDb = options.db ?? db;
      for (const [key, rawBinding] of Object.entries(record)) {
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) continue;
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "user_secret_ref") {
          await resolveUserSecretDefinition(
            companyId,
            { definitionKey: binding.key },
            bindingDb,
          );
          userRefs.push({
            definitionKey: binding.key,
            configPath: `${pathPrefix}.${key}`,
            envKey: key,
            versionSelector: binding.version,
            required: binding.required,
            allowMissingOverride: binding.allowMissingOverride,
          });
          continue;
        }
        if (binding.type !== "secret_ref") continue;
        await assertSecretInCompany(companyId, binding.secretId, bindingDb);
        const configPath = `${pathPrefix}.${key}`;
        assertClass3StaticLeaseAllowed({
          targetType: target.targetType,
          configPath,
          projectionClass: binding.projectionClass,
          projectionAllowlistKey: binding.projectionAllowlistKey,
        });
        refs.push({
          secretId: binding.secretId,
          configPath,
          versionSelector: binding.version,
          projectionClass: binding.projectionClass,
          projectionAllowlistKey: binding.projectionAllowlistKey,
        });
      }

      const writeBindings = async (targetDb: SecretBindingDb) => {
        await targetDb
          .delete(companySecretBindings)
          .where(
            and(
              eq(companySecretBindings.companyId, companyId),
              eq(companySecretBindings.targetType, target.targetType),
              eq(companySecretBindings.targetId, target.targetId),
              like(companySecretBindings.configPath, `${pathPrefix}.%`),
            ),
          );
        if (refs.length === 0) return;
        await targetDb.insert(companySecretBindings).values(
          refs.map((ref) => ({
            companyId,
            secretId: ref.secretId,
            targetType: target.targetType,
            targetId: target.targetId,
            configPath: ref.configPath,
            versionSelector: String(ref.versionSelector),
            required: true,
            projectionClass: ref.projectionClass,
            projectionAllowlistKey: ref.projectionAllowlistKey,
          })),
        );
      };

      const writeUserDeclarations = async (targetDb: SecretBindingDb) => {
        await targetDb
          .delete(userSecretDeclarations)
          .where(
            and(
              eq(userSecretDeclarations.companyId, companyId),
              eq(userSecretDeclarations.targetType, target.targetType),
              eq(userSecretDeclarations.targetId, target.targetId),
              like(userSecretDeclarations.configPath, `${pathPrefix}.%`),
            ),
          );
        if (userRefs.length === 0) return;
        const definitions = new Map<string, string>();
        for (const ref of userRefs) {
          const definition = await resolveUserSecretDefinition(
            companyId,
            { definitionKey: ref.definitionKey },
            targetDb,
          );
          definitions.set(ref.definitionKey, definition.id);
        }
        await targetDb.insert(userSecretDeclarations).values(
          userRefs.map((ref) => ({
            companyId,
            userSecretDefinitionId: definitions.get(ref.definitionKey)!,
            targetType: target.targetType,
            targetId: target.targetId,
            configPath: ref.configPath,
            envKey: ref.envKey,
            versionSelector: String(ref.versionSelector),
            required: ref.required,
            allowMissingOverride: ref.allowMissingOverride,
          })),
        );
      };

      if (options.db) {
        await writeBindings(options.db);
        await writeUserDeclarations(options.db);
      } else {
        await db.transaction(async (tx) => {
          await writeBindings(tx);
          await writeUserDeclarations(tx);
        });
      }
      return refs;
    },

    remove: async (secretId: string, actor: SecretMutationActor) => {
      requireSecretMutationActor(actor);
      return removeSecretInternal(secretId);
    },

    normalizeEnvBindingsForPersistence: async (
      companyId: string,
      envValue: unknown,
      opts?: NormalizeEnvOptions,
    ) => normalizeEnvConfig(companyId, envValue, opts),

    resolveEnvBindings: async (
      companyId: string,
      envValue: unknown,
      context?: Omit<SecretBindingContext, "configPath">,
    ): Promise<{
      env: Record<string, string>;
      secretKeys: Set<string>;
      manifest: RuntimeSecretManifestEntry[];
    }> => {
      const record = asRecord(envValue);
      if (!record)
        return {
          env: {} as Record<string, string>,
          secretKeys: new Set<string>(),
          manifest: [],
        };
      const resolved: Record<string, string> = {};
      const secretKeys = new Set<string>();
      const manifest: RuntimeSecretManifestEntry[] = [];

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
          resolved[key] = binding.value;
        } else if (binding.type === "secret_ref") {
          const secretResolution = await resolveSecretValueInternal(
            companyId,
            binding.secretId,
            binding.version,
            context
              ? {
                  bindingContext: { ...context, configPath: `env.${key}` },
                  accessContext: { ...context, configPath: `env.${key}` },
                }
              : undefined,
          );
          resolved[key] = secretResolution.value;
          manifest.push(secretResolution.manifestEntry);
          secretKeys.add(key);
        } else {
          const secretResolution = await secretService(
            db,
            secretsRuntime,
          ).resolveUserSecretValue(
            companyId,
            {
              definitionKey: binding.key,
              version: binding.version,
              required: binding.required,
              allowMissingOverride: binding.allowMissingOverride,
            },
            context
              ? {
                  ...context,
                  configPath: `env.${key}`,
                  responsibleUserId: context.responsibleUserId ?? null,
                }
              : undefined,
          );
          if (secretResolution) {
            resolved[key] = secretResolution.value;
            manifest.push(secretResolution.manifestEntry);
            secretKeys.add(key);
          }
        }
      }
      return { env: resolved, secretKeys, manifest };
    },

    // Pre-dispatch validation: list declared secret refs in an env-like config
    // that have no binding for the given consumer, WITHOUT resolving any secret
    // values. Callers use this to surface a configuration-incomplete blocker
    // before a run is dispatched instead of letting resolution throw mid-setup.
    collectMissingRuntimeBindings: async (
      companyId: string,
      envValue: unknown,
      context: Omit<SecretBindingContext, "configPath">,
    ): Promise<MissingRuntimeBinding[]> => {
      const record = asRecord(envValue);
      if (!record) return [];
      const secretRefs = Object.entries(record).flatMap(([key, rawBinding]) => {
        if (!ENV_KEY_RE.test(key)) return [];
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) return [];
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type !== "secret_ref") return [];
        return [{ key, configPath: `env.${key}`, secretId: binding.secretId }];
      });
      const userSecretRefs = Object.entries(record).flatMap(
        ([key, rawBinding]) => {
          if (!ENV_KEY_RE.test(key)) return [];
          const parsed = envBindingSchema.safeParse(rawBinding);
          if (!parsed.success) return [];
          const binding = canonicalizeBinding(parsed.data as EnvBinding);
          if (binding.type !== "user_secret_ref") return [];
          if (!binding.required || binding.allowMissingOverride) return [];
          return [{ key, configPath: `env.${key}`, binding }];
        },
      );
      return collectMissingBindingsForRefs(
        companyId,
        context,
        secretRefs,
        userSecretRefs,
      );
    },
  };
}
