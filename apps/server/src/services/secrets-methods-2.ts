import { and, desc, eq, ne, notInArray, sql } from "drizzle-orm";
import {
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  secretAccessEvents,
  userSecretDefinitions,
} from "@paperclipai/db";
import type { SecretProvider, SecretProviderConfigStatus } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import {
  isUniqueConstraintViolation,
  requireSecretMutationActor,
  type SecretMutationActor,
  USER_SECRET_DEFINITION_KEY_UNIQUE_CONSTRAINT,
} from "./secret-mutation-foundation.js";
import { requireExactSecretKey } from "./secrets.js";
import type { SecretsServiceScope } from "./secrets.js";

export function createSecretsMethods2(scope: SecretsServiceScope) {
  return {
    setDefaultProviderConfig: async (id: string, actor: SecretMutationActor) => {
      requireSecretMutationActor(actor);
      const existing = await scope.getProviderConfigById(id);
      if (!existing) return null;
      if (existing.status === "coming_soon" || existing.status === "disabled") {
        throw unprocessable("Only ready or warning provider vaults can be default");
      }
      return scope.db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(companySecretProviderConfigs)
          .where(eq(companySecretProviderConfigs.id, id))
          .then((rows) => rows[0] ?? null);
        if (!current) return null;
        if (current.status === "coming_soon" || current.status === "disabled") {
          throw unprocessable("Only ready or warning provider vaults can be default");
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
              notInArray(companySecretProviderConfigs.status, ["coming_soon", "disabled"]),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) throw unprocessable("Only ready or warning provider vaults can be default");
        return updated;
      });
    },

    checkProviderConfigHealth: async (id: string, actor: SecretMutationActor) => {
      requireSecretMutationActor(actor);
      const existing = await scope.getProviderConfigById(id);
      if (!existing) return null;
      const checkedAt = new Date();
      const staticHealth = scope.providerConfigHealth({
        id: existing.id,
        provider: existing.provider as SecretProvider,
        status: existing.status as SecretProviderConfigStatus,
        config: existing.config ?? {},
      });
      const provider = scope.getSecretProvider(existing.provider as SecretProvider);
      const health =
        staticHealth ??
        scope.mapProviderModuleHealth({
          configId: existing.id,
          provider: existing.provider as SecretProvider,
          providerStatus: existing.status as SecretProviderConfigStatus,
          health: await provider.healthCheck({
            providerConfig: scope.toProviderVaultRuntimeConfig(existing),
          }),
        });
      await scope.db
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
        scope.db
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
        scope.db
          .select({
            secretId: companySecretBindings.secretId,
            count: sql<number>`count(*)::int`,
          })
          .from(companySecretBindings)
          .where(eq(companySecretBindings.companyId, companyId))
          .groupBy(companySecretBindings.secretId),
      ]);
      const countsBySecretId = new Map(referenceCounts.map((row) => [row.secretId, row.count]));
      return secrets.map((secret) => ({
        ...secret,
        referenceCount: countsBySecretId.get(secret.id) ?? 0,
      }));
    },

    listBindings: (companyId: string, secretId?: string) =>
      scope.db
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
      const bindings = await scope.db
        .select()
        .from(companySecretBindings)
        .where(
          and(eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.secretId, secretId)),
        )
        .orderBy(desc(companySecretBindings.createdAt));
      const targetMap = await scope.buildBindingTargetMap(companyId, bindings);
      return bindings.flatMap((binding) => {
        const target = targetMap.get(`${binding.targetType}:${binding.targetId}`);
        return target ? [{ ...binding, target }] : [];
      });
    },

    listAccessEvents: (companyId: string, secretId: string) =>
      scope.db
        .select()
        .from(secretAccessEvents)
        .where(and(eq(secretAccessEvents.companyId, companyId), eq(secretAccessEvents.secretId, secretId)))
        .orderBy(desc(secretAccessEvents.createdAt)),

    listUserSecretDefinitions: (companyId: string) =>
      scope.db
        .select()
        .from(userSecretDefinitions)
        .where(
          and(eq(userSecretDefinitions.companyId, companyId), ne(userSecretDefinitions.status, "deleted")),
        )
        .orderBy(desc(userSecretDefinitions.createdAt)),

    getUserSecretDefinitionById: (companyId: string, definitionId: string) =>
      scope.getUserSecretDefinitionById(companyId, definitionId),

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
      const duplicate = await scope.getUserSecretDefinitionByKey(companyId, key);
      if (duplicate) throw conflict(`User secret definition already exists: ${key}`);
      await scope.assertProviderConfigForSecret(companyId, input.provider, input.providerConfigId);
      try {
        return await scope.db
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
        if (isUniqueConstraintViolation(error, USER_SECRET_DEFINITION_KEY_UNIQUE_CONSTRAINT)) {
          throw conflict(`User secret definition already exists: ${key}`);
        }
        throw error;
      }
    },
  };
}
