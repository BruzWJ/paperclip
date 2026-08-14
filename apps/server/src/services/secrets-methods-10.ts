import { and, eq, like, or } from "drizzle-orm";
import { companySecretBindings, userSecretDeclarations } from "@paperclipai/db";
import {
  type EnvBinding,
  type SecretBindingTargetType,
  type SecretProjectionClass,
  type SecretVersionSelector,
  envBindingSchema,
} from "@paperclipai/shared";
import {
  requireSecretMutationActor,
  type SecretBindingDb,
  type SecretMutationActor,
} from "./secret-mutation-foundation.js";
import { asRecord, assertClass3StaticLeaseAllowed, canonicalizeBinding } from "./secrets.js";
import type { SecretsServiceScope } from "./secrets.js";

export function createSecretsMethods10(scope: SecretsServiceScope) {
  return {
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
      const bindingDb = options.db ?? scope.db;
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
        await scope.assertSecretInCompany(companyId, ref.secretId, bindingDb);
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

      const pathPrefixes = [...new Set(normalizedRefs.map((ref) => ref.configPath.split(".")[0]))];

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
        await scope.db.transaction(async (tx) => writeBindings(tx));
      }
      return normalizedRefs;
    },

    listBindingCompanyIdsForTarget: async (target: {
      targetType: SecretBindingTargetType;
      targetId: string;
    }): Promise<string[]> =>
      scope.db
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
      const bindingDb = options.db ?? scope.db;
      for (const [key, rawBinding] of Object.entries(record)) {
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) continue;
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "user_secret_ref") {
          await scope.resolveUserSecretDefinition(companyId, { definitionKey: binding.key }, bindingDb);
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
        await scope.assertSecretInCompany(companyId, binding.secretId, bindingDb);
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
          const definition = await scope.resolveUserSecretDefinition(
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
        await scope.db.transaction(async (tx) => {
          await writeBindings(tx);
          await writeUserDeclarations(tx);
        });
      }
      return refs;
    },
  };
}
