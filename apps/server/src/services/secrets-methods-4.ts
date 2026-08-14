import { and, eq, like } from "drizzle-orm";
import { userSecretDeclarations, userSecretDefinitions } from "@paperclipai/db";
import {
  type EnvBinding,
  envBindingSchema,
  type SecretBindingTargetType,
  type SecretVersionSelector,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import {
  ENV_KEY_RE,
  requireSecretMutationActor,
  type SecretBindingDb,
  type SecretMutationActor,
} from "./secret-mutation-foundation.js";
import {
  asRecord,
  canonicalizeBinding,
  type MissingRuntimeBinding,
  type RuntimeSecretManifestEntry,
  type RuntimeSecretResolution,
  type SecretBindingContext,
  type SecretConsumerContext,
} from "./secrets.js";
import type { SecretsServiceScope } from "./secrets.js";

type NormalizeEnvOptions = {
  strictMode?: boolean;
  fieldPath?: string;
};

export function createSecretsMethods4(scope: SecretsServiceScope) {
  const resolveUserSecretValue = async (
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
    const responsibleUserId = input.responsibleUserId ?? context?.responsibleUserId ?? null;
    const optionalBinding = input.allowMissingOverride || input.required === false;
    let definition: typeof userSecretDefinitions.$inferSelect;
    try {
      definition = await scope.resolveUserSecretDefinition(companyId, input);
    } catch (error) {
      if (optionalBinding && error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
    if (definition.status !== "active") {
      if (optionalBinding) return null;
      throw unprocessable("User secret definition is not active");
    }
    if (!responsibleUserId?.trim()) {
      if (optionalBinding) return null;
      throw unprocessable("Responsible user is required for user secret resolution", {
        code: "responsible_user_missing",
      });
    }
    let declaration: typeof userSecretDeclarations.$inferSelect | null = null;
    if (context?.configPath) {
      declaration = await scope.db
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
      throw unprocessable("User secret declaration is outside the active low-trust boundary", {
        code: "binding_not_allowed",
      });
    }
    const secret = await scope.getUserSecretValue({
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
    const resolution = await scope.resolveSecretValueInternal(
      companyId,
      secret.id,
      input.version ?? "latest",
      {
        accessContext: context ? { ...context, responsibleUserId } : undefined,
        allowUserSecretScope: true,
      },
    );
    return {
      ...resolution,
      manifestEntry: {
        ...resolution.manifestEntry,
        bindingId: declaration?.id ?? resolution.manifestEntry.bindingId ?? null,
      },
    };
  };

  return {
    resolveUserSecretValue,

    removeCurrentUserSecretValue: async (
      companyId: string,
      ownerUserId: string,
      secretId: string,
      actor: SecretMutationActor,
    ) => {
      requireSecretMutationActor(actor);
      const secret = await scope.getUserSecretValueById(companyId, ownerUserId, secretId);
      return await scope.removeSecretInternal(secret.id);
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
      const targetDb = options.db ?? scope.db;
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
        const definition = await scope.resolveUserSecretDefinition(
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
        await scope.db.transaction(async (tx) => writeDeclarations(tx));
      }
      return normalizedRefs;
    },

    remove: async (secretId: string, actor: SecretMutationActor) => {
      requireSecretMutationActor(actor);
      return scope.removeSecretInternal(secretId);
    },

    normalizeEnvBindingsForPersistence: async (
      companyId: string,
      envValue: unknown,
      opts?: NormalizeEnvOptions,
    ) => scope.normalizeEnvConfig(companyId, envValue, opts),

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
          const secretResolution = await scope.resolveSecretValueInternal(
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
          const secretResolution = await resolveUserSecretValue(
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
      const userSecretRefs = Object.entries(record).flatMap(([key, rawBinding]) => {
        if (!ENV_KEY_RE.test(key)) return [];
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) return [];
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type !== "user_secret_ref") return [];
        if (!binding.required || binding.allowMissingOverride) return [];
        return [{ key, configPath: `env.${key}`, binding }];
      });
      return scope.collectMissingBindingsForRefs(companyId, context, secretRefs, userSecretRefs);
    },
  };
}
