import { and, eq } from "drizzle-orm";
import { userSecretDeclarations, userSecretDefinitions } from "@paperclipai/db";
import {
  type CanonicalEnvBinding,
  type MissingRuntimeBinding,
  type SecretBindingContext,
} from "./secrets.js";
import { missingUserSecretDefinitionRuntimeBinding } from "./secret-resolution-errors.js";
import { type SecretsContext } from "./secrets.js";
import { buildSecretsSecretRecordQueries } from "./secret-record-queries.js";
import { buildSecretsSecretValueResolution } from "./secret-value-resolution.js";
import { buildSecretsSecretBindingResolution } from "./secret-binding-resolution.js";
import { buildSecretsSecretMutations } from "./secret-mutations.js";

export function buildSecretsSecretMissingBindings(
  scope: SecretsContext &
    ReturnType<typeof buildSecretsSecretRecordQueries> &
    ReturnType<typeof buildSecretsSecretValueResolution> &
    ReturnType<typeof buildSecretsSecretBindingResolution> &
    ReturnType<typeof buildSecretsSecretMutations>,
) {
  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
  };

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
        found: await scope.getBinding({
          companyId,
          secretId: entry.secretId,
          consumerType: context.consumerType,
          consumerId: context.consumerId,
          configPath: entry.configPath,
        }),
      })),
    );
    const missingEntries = bindingChecks.filter((check) => !check.found).map((check) => check.entry);

    const secretRows = await Promise.all(
      [...new Set(missingEntries.map((entry) => entry.secretId))].map(
        async (secretId) => [secretId, await scope.getById(secretId).catch(() => null)] as const,
      ),
    );
    const secretsById = new Map(secretRows);

    const missingSecretBindings: MissingRuntimeBinding[] = missingEntries.map((entry) => ({
      consumerType: context.consumerType,
      consumerId: context.consumerId,
      configPath: entry.configPath,
      envKey: entry.key,
      bindingType: "secret_ref",
      secretId: entry.secretId,
      secretName: secretsById.get(entry.secretId)?.name ?? null,
    }));

    const missingUserSecretBindings: MissingRuntimeBinding[] = [];
    for (const entry of userSecretRefs) {
      let definition: typeof userSecretDefinitions.$inferSelect | null = null;
      try {
        definition = await scope.resolveUserSecretDefinition(companyId, {
          definitionKey: entry.binding.key,
        });
      } catch {
        missingUserSecretBindings.push(
          missingUserSecretDefinitionRuntimeBinding(entry, context, null, "user_secret_definition_missing"),
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

      const declaration = await scope.db
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

      const secret = await scope.getUserSecretValue({
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

  return { collectMissingBindingsForRefs };
}
