import { and, desc, eq, ne } from "drizzle-orm";
import {
  companyMemberships,
  companySecrets,
  companySecretVersions,
  userSecretDefinitions,
} from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { PreparedSecretVersion } from "../secrets/types.js";
import {
  cleanupPreparedProviderWrite,
  remoteProviderWriteHttpError,
  requireSecretMutationActor,
  type SecretMutationActor,
} from "./secret-mutation-foundation.js";
import {
  assertExactPreparedSecretReferences,
  requireExactSecretKey,
  requireOptionalExactOpaqueSecretReference,
} from "./secrets.js";
import type { SecretsServiceScope } from "./secrets.js";

export function createSecretsMethods3(scope: SecretsServiceScope) {
  const rotate = async (
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
    requireOptionalExactOpaqueSecretReference(input.externalRef, "Provider secret reference");
    requireOptionalExactOpaqueSecretReference(input.providerVersionRef, "Provider secret version reference");
    const secret = await scope.getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.status !== "active") throw unprocessable("Cannot rotate a non-active secret");
    const providerId = secret.provider as SecretProvider;
    const provider = scope.getSecretProvider(providerId);
    const providerConfigId =
      input.providerConfigId === undefined ? secret.providerConfigId : input.providerConfigId;
    const providerConfig = await scope.getSelectableRuntimeProviderConfig({
      companyId: secret.companyId,
      provider: providerId,
      providerConfigId,
    });
    requireOptionalExactOpaqueSecretReference(secret.externalRef, "Stored provider secret reference");
    const nextVersion = secret.latestVersion + 1;
    if (secret.managedMode === "external_reference" && (input.externalRef ?? secret.externalRef) == null) {
      throw unprocessable("External reference secrets require externalRef");
    }
    if (secret.managedMode !== "external_reference" && input.externalRef != null) {
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
      await scope.db.insert(companySecretVersions).values({
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
      return await scope.db.transaction(async (tx) => {
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
          await scope.db
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
  };

  return {
    rotate,

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
      const existing = await scope.resolveUserSecretDefinition(companyId, {
        definitionId,
      });
      if (patch.status === "deleted") {
        return scope.removeUserSecretDefinitionInternal(companyId, existing.id, actor);
      }
      const nextKey = patch.key === undefined ? existing.key : requireExactSecretKey(patch.key);
      if (nextKey !== existing.key) {
        const duplicate = await scope.getUserSecretDefinitionByKey(companyId, nextKey);
        if (duplicate && duplicate.id !== existing.id) {
          throw conflict(`User secret definition already exists: ${nextKey}`);
        }
      }
      if (patch.providerConfigId !== undefined) {
        await scope.assertProviderConfigForSecret(
          companyId,
          existing.provider as SecretProvider,
          patch.providerConfigId,
        );
      }
      return scope.db
        .update(userSecretDefinitions)
        .set({
          key: nextKey,
          name: patch.name?.trim() ?? existing.name,
          description: patch.description === undefined ? existing.description : patch.description,
          status: patch.status ?? existing.status,
          providerConfigId:
            patch.providerConfigId === undefined ? existing.providerConfigId : patch.providerConfigId,
          providerMetadata:
            patch.providerMetadata === undefined ? existing.providerMetadata : patch.providerMetadata,
          usageGuidance: patch.usageGuidance === undefined ? existing.usageGuidance : patch.usageGuidance,
          updatedByAgentId: attribution.agentId,
          updatedByUserId: attribution.userId,
          deletedAt: existing.deletedAt,
          updatedAt: new Date(),
        })
        .where(
          and(eq(userSecretDefinitions.companyId, companyId), eq(userSecretDefinitions.id, definitionId)),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    removeUserSecretDefinition: async (companyId: string, definitionId: string, actor: SecretMutationActor) =>
      scope.removeUserSecretDefinitionInternal(companyId, definitionId, actor),

    getUserSecretDefinitionCoverage: async (companyId: string, definitionId: string) => {
      await scope.resolveUserSecretDefinition(companyId, { definitionId });
      const [members, values] = await Promise.all([
        scope.db
          .select({ principalId: companyMemberships.principalUserId })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
            ),
          ),
        scope.db
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
        members.flatMap((member) => (member.principalId ? [member.principalId] : [])),
      );
      const configuredCount = values.filter(
        (value) => value.status === "active" && value.ownerUserId && memberIds.has(value.ownerUserId),
      ).length;
      const inactiveCount = values.filter(
        (value) => value.status !== "active" && value.ownerUserId && memberIds.has(value.ownerUserId),
      ).length;
      return {
        definitionId,
        configuredCount,
        inactiveCount,
        missingCount: Math.max(0, memberIds.size - configuredCount - inactiveCount),
      };
    },

    listCurrentUserSecretValues: async (companyId: string, ownerUserId: string) => {
      const definitions = await scope.db
        .select()
        .from(userSecretDefinitions)
        .where(
          and(eq(userSecretDefinitions.companyId, companyId), ne(userSecretDefinitions.status, "deleted")),
        )
        .orderBy(desc(userSecretDefinitions.createdAt));
      const values = await scope.db
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
      const valuesByDefinitionId = new Map(values.map((value) => [value.userSecretDefinitionId, value]));
      return definitions.map((definition) => ({
        definition,
        secret: valuesByDefinitionId.get(definition.id) ?? null,
      }));
    },

    createCurrentUserSecretValue: scope.createUserSecretValueInternal,

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
      const secret = await scope.getUserSecretValueById(companyId, ownerUserId, secretId);
      return await (async () => {
        await scope.resolveUserSecretDefinition(companyId, {
          definitionId: secret.userSecretDefinitionId,
        });
        return await rotate(secret.id, input, actor);
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
      const secret = await scope.getUserSecretValueById(companyId, ownerUserId, secretId);
      if (
        patch.value != null ||
        patch.externalRef != null ||
        patch.providerVersionRef != null ||
        patch.providerConfigId != null
      ) {
        await scope.resolveUserSecretDefinition(companyId, {
          definitionId: secret.userSecretDefinitionId,
        });
        return await rotate(secret.id, patch, actor);
      }
      if (patch.status === "deleted") {
        return await scope.removeSecretInternal(secret.id);
      }
      return scope.db
        .update(companySecrets)
        .set({
          status: patch.status ?? secret.status,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, secret.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
