import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { companySecrets, companySecretVersions, userSecretDefinitions } from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { type PreparedSecretVersion, isSecretProviderClientError } from "../secrets/types.js";
import * as secretMutations from "./secret-mutation-foundation.js";
import {
  assertExactPreparedSecretReferences,
  normalizeSecretKey,
  requireOptionalExactOpaqueSecretReference,
} from "./secrets.js";
import { type SecretsContext } from "./secrets.js";
import { buildSecretsSecretRecordQueries } from "./secret-record-queries.js";
import { buildSecretsSecretValueResolution } from "./secret-value-resolution.js";
import { buildSecretsSecretBindingResolution } from "./secret-binding-resolution.js";

export function buildSecretsSecretMutations(
  scope: SecretsContext &
    ReturnType<typeof buildSecretsSecretRecordQueries> &
    ReturnType<typeof buildSecretsSecretValueResolution> &
    ReturnType<typeof buildSecretsSecretBindingResolution>,
) {
  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
  };

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
    actor: secretMutations.SecretMutationActor,
  ) {
    const attribution = secretMutations.requireSecretMutationActor(actor);
    requireOptionalExactOpaqueSecretReference(input.externalRef, "Provider secret reference");
    requireOptionalExactOpaqueSecretReference(input.providerVersionRef, "Provider secret version reference");
    const definition = await scope.resolveUserSecretDefinition(companyId, {
      definitionId: input.definitionId,
    });
    if (definition.status !== "active") {
      throw unprocessable("User secret definition is not active");
    }
    const existing = await scope.getUserSecretValue({
      companyId,
      ownerUserId,
      definitionId: definition.id,
    });
    if (existing) throw conflict("User secret value already exists");

    const providerId = definition.provider as SecretProvider;
    const managedMode = definition.managedMode as "paperclip_managed" | "external_reference";
    if (managedMode === "external_reference" && input.externalRef == null) {
      throw unprocessable("External reference user secrets require externalRef");
    }
    if (managedMode === "paperclip_managed" && input.externalRef != null) {
      throw unprocessable("Managed user secrets cannot override externalRef");
    }
    if (managedMode === "paperclip_managed" && !input.value?.trim()) {
      throw unprocessable("Managed user secrets require value");
    }

    const providerConfigId =
      input.providerConfigId === undefined ? definition.providerConfigId : input.providerConfigId;
    const provider = scope.getSecretProvider(providerId);
    const providerConfig = await scope.getSelectableRuntimeProviderConfig({
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
      reservedSecret = await scope.db
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
        secretMutations.isUniqueConstraintViolation(
          error,
          secretMutations.USER_SECRET_VALUE_UNIQUE_CONSTRAINT,
        )
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
      throw await secretMutations.throwProviderWriteOrReservedRowRollbackError({
        error,
        rollbackReservedRow: () =>
          scope.db.delete(companySecrets).where(eq(companySecrets.id, reservedSecret.id)),
        companyId,
        provider: provider.id,
        providerConfigId,
        providerConfig,
        operation: "secret.create",
      });
    }

    try {
      return await scope.db.transaction(async (tx) => {
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
        const cleaned = await secretMutations.cleanupPreparedProviderWrite({
          provider,
          prepared,
          providerConfig,
          context: providerWriteContext,
          mode: "delete",
          operation: "user_secret_value.create_rollback",
        });
        if (!cleaned) {
          secretMutations.throwProviderCleanupFailedAfterCreateRollback({
            companyId,
            provider: provider.id,
            providerConfigId,
            providerConfig,
            operation: "user_secret_value.create_rollback",
          });
        }
      }
      await secretMutations.deleteLocalSecretCreateReservationOrThrow({
        db: scope.db,
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
    const secret = await scope.getById(secretId);
    if (!secret) return null;
    const versionRow = await scope.getSecretVersion(secret.id, secret.latestVersion);
    const providerId = secret.provider as SecretProvider;
    const provider = scope.getSecretProvider(providerId);
    requireOptionalExactOpaqueSecretReference(secret.externalRef, "Stored provider secret reference");
    requireOptionalExactOpaqueSecretReference(
      versionRow?.providerVersionRef,
      "Stored provider secret version reference",
    );
    if (secret.status !== "deleted") {
      await scope.db
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
      ? await scope.getProviderConfigById(secret.providerConfigId)
      : null;
    const providerRuntimeConfig =
      providerConfig && providerConfig.status !== "disabled" && providerConfig.status !== "coming_soon"
        ? scope.toProviderVaultRuntimeConfig(providerConfig)
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
    await scope.db.delete(companySecrets).where(eq(companySecrets.id, secretId));
    return secret;
  }

  async function removeUserSecretDefinitionInternal(
    companyId: string,
    definitionId: string,
    actor: secretMutations.SecretMutationActor,
  ) {
    const attribution = secretMutations.requireSecretMutationActor(actor);
    const existing = await scope.resolveUserSecretDefinition(companyId, {
      definitionId,
    });
    const values = await scope.db
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
    return scope.db
      .update(userSecretDefinitions)
      .set({
        key: `${existing.key}__deleted__${existing.id}`,
        status: "deleted",
        deletedAt: existing.deletedAt ?? new Date(),
        updatedByAgentId: attribution.agentId,
        updatedByUserId: attribution.userId,
        updatedAt: new Date(),
      })
      .where(and(eq(userSecretDefinitions.companyId, companyId), eq(userSecretDefinitions.id, definitionId)))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  return {
    createUserSecretValueInternal,
    removeSecretInternal,
    removeUserSecretDefinitionInternal,
  };
}
