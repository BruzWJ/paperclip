import type { Db } from "@paperclipai/db";
import {
  type RemoteSecretImportCandidate,
  type RemoteSecretImportConflict,
  type EnvBinding,
  type SecretBindingTargetType,
  type SecretProjectionClass,
  type SecretProvider,
  CLASS3_STATIC_LEASE_ALLOWLIST,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { createSecretProviderRegistry } from "../secrets/provider-registry.js";
import type {
  RemoteSecretListResult,
  SecretsRuntimeConfig,
  PreparedSecretVersion,
} from "../secrets/types.js";
import { buildSecretsSecretBindingResolution } from "./secret-binding-resolution.js";
import { buildSecretsSecretMissingBindings } from "./secret-missing-bindings.js";
import {
  remoteImportRowFailureReason,
  remoteProviderHttpError,
  SECRET_KEY_RE,
  SENSITIVE_ENV_KEY_RE,
} from "./secret-mutation-foundation.js";
import { buildSecretsSecretMutations } from "./secret-mutations.js";
import { buildSecretsSecretRecordQueries } from "./secret-record-queries.js";
import { buildSecretsSecretValueResolution } from "./secret-value-resolution.js";
import { createSecretsProviderMethods } from "./secrets-methods-1.js";
import { createSecretsMethods10 } from "./secrets-methods-10.js";
import { createSecretsMethods2 } from "./secrets-methods-2.js";
import { createSecretsMethods3 } from "./secrets-methods-3.js";
import { createSecretsMethods4 } from "./secrets-methods-4.js";
import { createSecretsMethods7 } from "./secrets-methods-7.js";

export type SecretsServiceScope = SecretsContext &
  ReturnType<typeof buildSecretsSecretRecordQueries> &
  ReturnType<typeof buildSecretsSecretValueResolution> &
  ReturnType<typeof buildSecretsSecretBindingResolution> &
  ReturnType<typeof buildSecretsSecretMutations> &
  ReturnType<typeof buildSecretsSecretMissingBindings>;

export function createSecretsContext(db: Db, secretsRuntime: SecretsRuntimeConfig) {
  const providerRegistry = createSecretProviderRegistry(secretsRuntime);

  const getSecretProvider = providerRegistry.get;

  return { db, secretsRuntime, providerRegistry, getSecretProvider };
}

export type SecretsContext = ReturnType<typeof createSecretsContext>;

export function createSecretsMethods5(scope: SecretsServiceScope) {
  return {
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
      } = await scope.getRemoteImportProviderConfig(companyId, input.providerConfigId);
      const provider = scope.getSecretProvider(providerId);
      if (!provider.listRemoteSecrets) {
        throw unprocessable(`${providerId} provider does not support remote import listing`);
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
      const maps = await scope.buildRemoteImportConflictMaps(companyId, providerId);
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
        const remoteName = remote.name.trim() || deriveSecretNameFromExternalRef(externalRef);
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
            message: remoteImportRowFailureReason(error, "Provider rejected this external reference", {
              companyId,
              provider: providerId,
              providerConfigId: providerConfig.id,
              operation: "remote_import.preview.link_external_reference",
            }),
          });
        }
        conflicts.push(
          ...scope.remoteImportConflictsFor({
            providerConfigId: providerConfig.id,
            externalRef: canonicalExternalRef,
            name,
            key,
            maps,
          }),
        );
        const hasDuplicate = conflicts.some((conflict) => conflict.type === "exact_reference");
        const hasConflict = conflicts.length > 0;
        candidates.push({
          externalRef,
          remoteName,
          name,
          key,
          providerVersionRef,
          providerMetadata: scope.sanitizeRemoteProviderMetadata(providerId, remote.metadata),
          status: hasDuplicate ? "duplicate" : hasConflict ? "conflict" : "ready",
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
  };
}

export {
  requireSecretMutationActor,
  type CreateCompanySecretBindingInput,
  type CreateCompanySecretInput,
  type SecretMutationActor,
} from "./secret-mutation-foundation.js";

export function secretService(db: Db, secretsRuntime: SecretsRuntimeConfig) {
  const scope = createSecretsContext(db, secretsRuntime) as SecretsServiceScope;
  Object.assign(scope, buildSecretsSecretRecordQueries(scope));
  Object.assign(scope, buildSecretsSecretValueResolution(scope));
  Object.assign(scope, buildSecretsSecretBindingResolution(scope));
  Object.assign(scope, buildSecretsSecretMutations(scope));
  Object.assign(scope, buildSecretsSecretMissingBindings(scope));
  return {
    getById: scope.getById,
    getByName: scope.getByName,
    getByKey: scope.getByKey,
    resolveSecretValue: scope.resolveSecretValue,
    resolveSecretVersion: scope.resolveSecretVersion,
    ...createSecretsProviderMethods(scope),
    ...createSecretsMethods2(scope),
    ...createSecretsMethods3(scope),
    ...createSecretsMethods4(scope),
    ...createSecretsMethods5(scope),
    ...createSecretsMethods7(scope),
    ...createSecretsMethods10(scope),
  };
}

export type CanonicalEnvBinding =
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

export type SecretAccessConsumerType = SecretBindingTargetType;

export type SecretConsumerContext = {
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

export type SecretBindingContext = Omit<SecretConsumerContext, "consumerType"> & {
  consumerType: SecretBindingTargetType;
};

export type SecretResolutionOptions = {
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

export function missingRuntimeConsumerType(consumerType: SecretAccessConsumerType): SecretBindingTargetType {
  return consumerType;
}

export type RuntimeSecretResolution = {
  value: string;
  manifestEntry: RuntimeSecretManifestEntry;
};

export type SecretResolutionErrorCode =
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

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isSensitiveEnvKey(key: string) {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

export function normalizeSecretKey(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function requireExactSecretKey(input: string) {
  if (!SECRET_KEY_RE.test(input)) {
    throw unprocessable("Secret key must use exact letters, numbers, dot, underscore, or hyphen");
  }
  return input;
}

export function requireExactOpaqueSecretReference(input: string, label: string) {
  if (input.length === 0 || input.trim() !== input) {
    throw unprocessable(`${label} must be a non-empty exact value without surrounding whitespace`);
  }
  return input;
}

export function requireOptionalExactOpaqueSecretReference(input: string | null | undefined, label: string) {
  return input == null ? null : requireExactOpaqueSecretReference(input, label);
}

export function assertExactPreparedSecretReferences(prepared: PreparedSecretVersion): PreparedSecretVersion {
  requireOptionalExactOpaqueSecretReference(prepared.externalRef, "Provider secret reference");
  requireOptionalExactOpaqueSecretReference(prepared.providerVersionRef, "Provider secret version reference");
  return prepared;
}

export function deriveSecretNameFromExternalRef(externalRef: string) {
  const exactRef = requireExactOpaqueSecretReference(externalRef, "Provider secret reference");
  const arnMatch = /^arn:[^:]+:secretsmanager:[^:]*:[^:]*:secret:(.+)$/i.exec(exactRef);
  const name = arnMatch?.[1] ?? exactRef;
  return name.split("/").filter(Boolean).at(-1) ?? name;
}

export function canonicalizeBinding(binding: EnvBinding): CanonicalEnvBinding {
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

export function assertClass3StaticLeaseAllowed(input: {
  targetType: SecretBindingTargetType;
  configPath: string;
  projectionClass?: string | null;
  projectionAllowlistKey?: string | null;
}) {
  const projectionClass = input.projectionClass ?? "unclassified";
  if (projectionClass !== "class_3_static_lease") return;
  if (!input.projectionAllowlistKey?.trim()) {
    throw unprocessable("Class-3 static lease bindings require an allowlist key", {
      code: "class_3_static_lease_allowlist_required",
      targetType: input.targetType,
      configPath: input.configPath,
    });
  }
  const allowed = CLASS3_STATIC_LEASE_ALLOWLIST.some(
    (entry) =>
      entry.key === input.projectionAllowlistKey &&
      entry.targetType === input.targetType &&
      entry.configPath === input.configPath,
  );
  if (!allowed) {
    throw unprocessable("Class-3 static lease binding is outside the approved allowlist", {
      code: "class_3_static_lease_not_allowed",
      allowlistKey: input.projectionAllowlistKey,
      targetType: input.targetType,
      configPath: input.configPath,
    });
  }
}
