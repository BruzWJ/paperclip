import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companySecretVersions } from "@paperclipai/db";
import {
  type SecretBindingTargetType,
  type SecretProjectionClass,
  type SecretProvider,
  type SecretVersionSelector,
  isCanonicalUuid,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  type PreparedSecretVersion,
  type SecretProviderModule,
  type SecretProviderVaultRuntimeConfig,
  type SecretProviderWriteContext,
  isSecretProviderClientError,
} from "../secrets/types.js";

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

export const REDACTED_SENTINEL = "***REDACTED***";

export const COMING_SOON_SECRET_PROVIDERS: ReadonlySet<SecretProvider> = new Set([
  "gcp_secret_manager",
  "vault",
]);

export const USER_SECRET_DEFINITION_KEY_UNIQUE_CONSTRAINT = "user_secret_definitions_company_key_uq";

export const USER_SECRET_VALUE_UNIQUE_CONSTRAINT = "company_secrets_user_definition_owner_uq";

export const SECRET_KEY_RE = /^[a-zA-Z0-9_.-]{1,120}$/;

export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type SecretBindingDb = Pick<Db | DbTransaction, "select" | "delete" | "insert">;

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

export type SecretMutationAttribution = {
  userId: string | null;
  agentId: string | null;
};

export const INVALID_SECRET_MUTATION_ACTOR_CODE = "invalid_secret_mutation_actor";

export function requireSecretMutationActor(actor: unknown): SecretMutationAttribution {
  if (typeof actor === "object" && actor !== null && !Array.isArray(actor)) {
    const prototype = Object.getPrototypeOf(actor);
    const keys = Reflect.ownKeys(actor);
    if (
      (prototype === Object.prototype || prototype === null) &&
      keys.every((key): key is string => typeof key === "string")
    ) {
      const descriptors = Object.getOwnPropertyDescriptors(actor);
      const typeDescriptor = descriptors.type;
      const type = typeDescriptor && "value" in typeDescriptor ? typeDescriptor.value : undefined;
      switch (type) {
        case "user": {
          const userIdDescriptor = descriptors.userId;
          const userId = userIdDescriptor && "value" in userIdDescriptor ? userIdDescriptor.value : undefined;
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
            agentIdDescriptor && "value" in agentIdDescriptor ? agentIdDescriptor.value : undefined;
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

export function isUniqueConstraintViolation(error: unknown, constraintName: string) {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
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

export function remoteProviderHttpError(
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
    return new HttpError(error.status, error.message, safeRemoteProviderErrorDetails(error, context));
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

export function remoteProviderWriteHttpError(
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
    providerConfigId: context.providerConfig?.id ?? context.providerConfigId ?? "deployment-default",
    operation: context.operation,
    providerConfig: context.providerConfig?.config ?? null,
  });
}

export async function throwProviderWriteOrReservedRowRollbackError(input: {
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
    const providerConfigId = input.providerConfig?.id ?? input.providerConfigId ?? "deployment-default";
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

export function providerConfigIdentifier(input: {
  providerConfigId?: string | null;
  providerConfig: SecretProviderVaultRuntimeConfig | null;
}) {
  return input.providerConfig?.id ?? input.providerConfigId ?? "deployment-default";
}

export async function deleteLocalSecretCreateReservationOrThrow(input: {
  db: Pick<Db, "delete">;
  secretId: string;
  companyId: string;
  provider: SecretProvider;
  providerConfigId?: string | null;
  providerConfig: SecretProviderVaultRuntimeConfig | null;
  operation: string;
}) {
  try {
    await input.db.delete(companySecretVersions).where(eq(companySecretVersions.secretId, input.secretId));
    await input.db.delete(companySecrets).where(eq(companySecrets.id, input.secretId));
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

export function throwProviderCleanupFailedAfterCreateRollback(input: {
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

export function safeRemoteProviderErrorDetails(
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
    details.credentialPath = "Paperclip server runtime/provider credential path";
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
    context.providerConfigId === "discovery-preview" ? "draft_config" : "provider_config";
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

export function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function remoteImportRowFailureReason(
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

export async function cleanupPreparedProviderWrite(input: {
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
