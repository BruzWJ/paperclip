import { and, eq, ne } from "drizzle-orm";
import { companySecretBindings, companySecrets, companySecretVersions } from "@paperclipai/db";
import type {
  SecretBindingTargetType,
  SecretProjectionClass,
  SecretProvider,
  SecretVersionSelector,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { PreparedSecretVersion } from "../secrets/types.js";
import * as secretMutations from "./secret-mutation-foundation.js";
import {
  assertClass3StaticLeaseAllowed,
  assertExactPreparedSecretReferences,
  normalizeSecretKey,
  requireExactSecretKey,
  requireOptionalExactOpaqueSecretReference,
} from "./secrets.js";
import type { SecretsServiceScope } from "./secrets.js";

export function createSecretsMethods7(scope: SecretsServiceScope) {
  const update = async (
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
    actor: secretMutations.SecretMutationActor,
  ) => {
    secretMutations.requireSecretMutationActor(actor);
    const secret = await scope.getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.status === "deleted") throw notFound("Secret not found");

    if (patch.name && patch.name !== secret.name) {
      const duplicate = await scope.getByName(secret.companyId, patch.name);
      if (duplicate && duplicate.id !== secret.id) {
        throw conflict(`Secret already exists: ${patch.name}`);
      }
    }
    const nextKey = patch.key === undefined ? secret.key : requireExactSecretKey(patch.key);
    if (!nextKey) throw unprocessable("Secret key is required");
    if (nextKey !== secret.key) {
      const duplicateKey = await scope.db
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
      throw unprocessable("Managed secrets must be deleted through DELETE /secrets/:id");
    }
    if (secret.managedMode !== "external_reference" && patch.externalRef !== undefined) {
      throw unprocessable("Managed secrets cannot override externalRef");
    }
    if (
      secret.managedMode === "external_reference" &&
      patch.externalRef !== undefined &&
      patch.externalRef !== secret.externalRef
    ) {
      throw unprocessable("External reference secrets cannot be retargeted through generic update");
    }
    if (
      secret.managedMode === "external_reference" &&
      patch.providerConfigId !== undefined &&
      patch.providerConfigId !== secret.providerConfigId
    ) {
      throw unprocessable("External reference secrets cannot change provider vault through generic update");
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
      await scope.assertProviderConfigForSecret(
        secret.companyId,
        secret.provider as SecretProvider,
        patch.providerConfigId,
      );
    }

    return scope.db
      .update(companySecrets)
      .set({
        key: deleting ? `${secret.key}__deleted__${secret.id}` : nextKey,
        name: deleting ? `${secret.name}__deleted__${secret.id}` : (patch.name ?? secret.name),
        status: patch.status ?? secret.status,
        providerConfigId:
          patch.providerConfigId === undefined ? secret.providerConfigId : patch.providerConfigId,
        description: patch.description === undefined ? secret.description : patch.description,
        externalRef: patch.externalRef === undefined ? secret.externalRef : patch.externalRef,
        providerMetadata:
          patch.providerMetadata === undefined ? secret.providerMetadata : patch.providerMetadata,
        deletedAt: deleting ? new Date() : secret.deletedAt,
        updatedAt: new Date(),
      })
      .where(eq(companySecrets.id, secret.id))
      .returning()
      .then((rows) => rows[0] ?? null);
  };

  const createBinding = async (
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
    actor: secretMutations.SecretMutationActor,
  ) => {
    secretMutations.requireSecretMutationActor(actor);
    await scope.assertSecretInCompany(input.companyId, input.secretId);
    assertClass3StaticLeaseAllowed({
      targetType: input.targetType,
      configPath: input.configPath,
      projectionClass: input.projectionClass,
      projectionAllowlistKey: input.projectionAllowlistKey,
    });
    const existing = await scope.db
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
    if (existing) throw conflict(`Secret binding already exists at ${input.configPath}`);
    return scope.db
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
  };

  async function create(
    companyId: string,
    input: secretMutations.CreateCompanySecretInput,
    actor: secretMutations.SecretMutationActor,
  ) {
    const attribution = secretMutations.requireSecretMutationActor(actor);
    requireOptionalExactOpaqueSecretReference(input.externalRef, "Provider secret reference");
    requireOptionalExactOpaqueSecretReference(input.providerVersionRef, "Provider secret version reference");
    const existing = await scope.getByName(companyId, input.name);
    if (existing) throw conflict(`Secret already exists: ${input.name}`);
    const key = requireExactSecretKey(input.key == null ? normalizeSecretKey(input.name) : input.key);
    const duplicateKey = await scope.db
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
    const provider = scope.getSecretProvider(input.provider);
    const providerConfig = await scope.getSelectableRuntimeProviderConfig({
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
    const reservedSecret = await scope.db
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
      throw await secretMutations.throwProviderWriteOrReservedRowRollbackError({
        error,
        rollbackReservedRow: () =>
          scope.db.delete(companySecrets).where(eq(companySecrets.id, reservedSecret.id)),
        companyId,
        provider: provider.id,
        providerConfigId: input.providerConfigId ?? null,
        providerConfig,
        operation: "secret.create",
      });
    }

    try {
      await scope.db
        .update(companySecrets)
        .set({
          externalRef: prepared.externalRef,
          latestVersion: 1,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, reservedSecret.id));
      await scope.db.insert(companySecretVersions).values({
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
        const cleaned = await secretMutations.cleanupPreparedProviderWrite({
          provider,
          prepared,
          providerConfig,
          context: providerWriteContext,
          mode: "delete",
          operation: "create.prepare_rollback",
        });
        if (!cleaned) {
          secretMutations.throwProviderCleanupFailedAfterCreateRollback({
            companyId,
            provider: provider.id,
            providerConfigId: input.providerConfigId ?? null,
            providerConfig,
            operation: "create.prepare_rollback",
          });
        }
      }
      await secretMutations.deleteLocalSecretCreateReservationOrThrow({
        db: scope.db,
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
      return await scope.db.transaction(async (tx) => {
        await tx
          .update(companySecretVersions)
          .set({ status: "current" })
          .where(
            and(eq(companySecretVersions.secretId, reservedSecret.id), eq(companySecretVersions.version, 1)),
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
        const cleaned = await secretMutations.cleanupPreparedProviderWrite({
          provider,
          prepared,
          providerConfig,
          context: providerWriteContext,
          mode: "delete",
          operation: "create.rollback",
        });
        if (!cleaned) {
          secretMutations.throwProviderCleanupFailedAfterCreateRollback({
            companyId,
            provider: provider.id,
            providerConfigId: input.providerConfigId ?? null,
            providerConfig,
            operation: "create.rollback",
          });
        }
      }
      await secretMutations.deleteLocalSecretCreateReservationOrThrow({
        db: scope.db,
        secretId: reservedSecret.id,
        companyId,
        provider: provider.id,
        providerConfigId: input.providerConfigId ?? null,
        providerConfig,
        operation: "create.rollback",
      });
      throw error;
    }
  }

  return {
    update,
    createBinding,
    create,
    createBound: async (
      companyId: string,
      input: secretMutations.CreateCompanySecretInput,
      binding: secretMutations.CreateCompanySecretBindingInput,
      actor: secretMutations.SecretMutationActor,
    ) => {
      secretMutations.requireSecretMutationActor(actor);
      const secret = await create(companyId, input, actor);
      try {
        await createBinding(
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
          await scope.removeSecretInternal(secret.id);
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
  };
}
