import { and, desc, eq } from "drizzle-orm";
import { companySecretProviderConfigs, companySecrets, companySecretVersions } from "@paperclipai/db";
import {
  createSecretProviderConfigSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  updateSecretProviderConfigSchema,
  type SecretProvider,
  type SecretProviderConfigDiscoveryPreviewResult,
  type SecretProviderConfigStatus,
  type RemoteSecretImportRowResult,
} from "@paperclipai/shared";
import { unprocessable, conflict } from "../errors.js";
import {
  COMING_SOON_SECRET_PROVIDERS,
  remoteProviderHttpError,
  requireSecretMutationActor,
  type SecretMutationActor,
  remoteImportRowFailureReason,
} from "./secret-mutation-foundation.js";
import { defaultProviderConfigStatus } from "./secret-resolution-errors.js";
import * as secretBindings from "./secrets.js";
import type { SecretsServiceScope } from "./secrets.js";
import type { PreparedSecretVersion } from "../secrets/types.js";

export function createSecretsProviderMethods(scope: SecretsServiceScope) {
  return {
    listProviders: () => scope.providerRegistry.list(),

    checkProviders: () => scope.providerRegistry.check(),

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
        throw unprocessable("Invalid provider vault discovery config", parsed.error.flatten());
      }
      const providerId = parsed.data.provider as SecretProvider;
      const provider = scope.getSecretProvider(providerId);
      if (!provider.discoverProviderConfigs) {
        throw unprocessable(`${providerId} provider does not support provider vault discovery`);
      }
      const runtimeConfig = scope.toDraftProviderVaultRuntimeConfig({
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
      scope.db
        .select()
        .from(companySecretProviderConfigs)
        .where(eq(companySecretProviderConfigs.companyId, companyId))
        .orderBy(desc(companySecretProviderConfigs.createdAt)),

    getProviderConfigById: scope.getProviderConfigById,

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
      if (!parsed.success) throw unprocessable("Invalid provider vault config", parsed.error.flatten());
      const status = input.status ?? defaultProviderConfigStatus(input.provider);
      if ((status === "coming_soon" || status === "disabled") && input.isDefault) {
        throw unprocessable("Only ready or warning provider vaults can be default");
      }
      const normalizedConfig = scope.validateProviderConfigPayload(input.provider, input.config ?? {});
      return scope.db.transaction(async (tx) => {
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
      const existing = await scope.getProviderConfigById(id);
      if (!existing) return null;
      const parsed = updateSecretProviderConfigSchema.safeParse(patch);
      if (!parsed.success) throw unprocessable("Invalid provider vault config", parsed.error.flatten());
      const provider = existing.provider as SecretProvider;
      const status = patch.status ?? (existing.status as SecretProviderConfigStatus);
      if (COMING_SOON_SECRET_PROVIDERS.has(provider) && status !== "coming_soon" && status !== "disabled") {
        throw unprocessable(`${provider} provider vaults are locked while coming soon`);
      }
      if ((status === "coming_soon" || status === "disabled") && patch.isDefault) {
        throw unprocessable("Only ready or warning provider vaults can be default");
      }
      const normalizedConfig =
        patch.config === undefined
          ? existing.config
          : scope.validateProviderConfigPayload(provider, patch.config);
      return scope.db.transaction(async (tx) => {
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
            disabledAt: status === "disabled" ? (existing.disabledAt ?? new Date()) : null,
            updatedAt: new Date(),
          })
          .where(eq(companySecretProviderConfigs.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
    },

    disableProviderConfig: async (id: string, actor: SecretMutationActor) => {
      requireSecretMutationActor(actor);
      const existing = await scope.getProviderConfigById(id);
      if (!existing) return null;
      return scope.db
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
      return scope.db
        .delete(companySecretProviderConfigs)
        .where(eq(companySecretProviderConfigs.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
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
        secretBindings.requireExactOpaqueSecretReference(selection.externalRef, "Provider secret reference");
        secretBindings.requireOptionalExactOpaqueSecretReference(
          selection.providerVersionRef,
          "Provider secret version reference",
        );
      }
      const {
        providerConfig,
        provider: providerId,
        runtimeConfig,
      } = await scope.getRemoteImportProviderConfig(companyId, input.providerConfigId);
      const provider = scope.getSecretProvider(providerId);
      if (provider.descriptor().supportsExternalReferences === false) {
        throw unprocessable(`${providerId} provider does not support linked external references`);
      }
      const maps = await scope.buildRemoteImportConflictMaps(companyId, providerId);
      const results: RemoteSecretImportRowResult[] = [];

      for (const selection of input.secrets) {
        const externalRef = selection.externalRef;
        const name = selection.name?.trim() || secretBindings.deriveSecretNameFromExternalRef(externalRef);
        const key = secretBindings.requireExactSecretKey(
          selection.key == null ? secretBindings.normalizeSecretKey(name) : selection.key,
        );
        const description = selection.description?.trim() || null;
        let prepared: PreparedSecretVersion | undefined;
        const conflicts = scope.remoteImportConflictsFor({
          providerConfigId: providerConfig.id,
          externalRef,
          name,
          key,
          maps,
        });
        if (conflicts.length === 0) {
          try {
            prepared = secretBindings.assertExactPreparedSecretReferences(
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
              scope.remoteImportExternalRefKey(providerConfig.id, prepared.externalRef ?? externalRef),
            );
            if (canonicalDuplicate) {
              conflicts.push({
                type: "exact_reference",
                existingSecretId: canonicalDuplicate.id,
                message: "An existing secret already links this exact provider reference.",
              });
            }
          } catch (error) {
            results.push({
              externalRef,
              name,
              key,
              status: "error",
              reason: remoteImportRowFailureReason(error, "Provider rejected this external reference", {
                companyId,
                provider: providerId,
                providerConfigId: providerConfig.id,
                operation: "remote_import.prepare_external_reference",
              }),
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
            reason: conflicts.some((conflict) => conflict.type === "exact_reference")
              ? "exact_reference_duplicate"
              : "name_or_key_conflict",
            secretId: null,
            conflicts,
          });
          continue;
        }

        try {
          if (!prepared) {
            prepared = secretBindings.assertExactPreparedSecretReferences(
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
          const secret = await scope.db.transaction(async (tx) => {
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
              fingerprintSha256: preparedSecret.fingerprintSha256 ?? preparedSecret.valueSha256,
              providerVersionRef: preparedSecret.providerVersionRef ?? null,
              status: "current",
              createdByAgentId: attribution.agentId,
              createdByUserId: attribution.userId,
            });
            return inserted;
          });
          maps.byProviderConfigExternalRef.set(
            scope.remoteImportExternalRefKey(providerConfig.id, preparedSecret.externalRef ?? externalRef),
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
        importedCount: results.filter((result) => result.status === "imported").length,
        skippedCount: results.filter((result) => result.status === "skipped").length,
        errorCount: results.filter((result) => result.status === "error").length,
        results,
      };
    },
  };
}
