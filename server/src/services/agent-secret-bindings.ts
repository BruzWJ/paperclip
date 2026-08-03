import { envBindingSchema, type SecretProjectionClass, type SecretVersionSelector } from "@paperclipai/shared";
import {
  appendAdapterConfigPathIndex,
  appendAdapterConfigPathKey,
} from "./adapter-config-path.js";
import {
  requireSecretMutationActor,
  type SecretMutationActor,
} from "./secrets.js";

interface AgentSecretBindingSyncService {
  syncSecretRefsForTarget: (
    companyId: string,
    target: { targetType: "agent"; targetId: string },
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
      replaceAll?: boolean;
    },
  ) => Promise<unknown>;
  syncUserSecretDeclarationsForTarget: (
    companyId: string,
    target: { targetType: "agent"; targetId: string; pathPrefix?: string },
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
      replaceAll?: boolean;
    },
  ) => Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function collectSecretRefs(adapterConfig: unknown): Array<{
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
  projectionClass?: SecretProjectionClass;
  projectionAllowlistKey?: string | null;
}> {
  const config = asRecord(adapterConfig);
  if (!config) return [];
  const refs: Array<{
    secretId: string;
    configPath: string;
    versionSelector?: SecretVersionSelector;
    projectionClass?: SecretProjectionClass;
    projectionAllowlistKey?: string | null;
  }> = [];

  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        visit(entry, appendAdapterConfigPathIndex(path, index)),
      );
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    if (record.type === "secret_ref") {
      const parsed = envBindingSchema.safeParse(record);
      const binding = parsed.success ? parsed.data : null;
      if (
        binding &&
        typeof binding === "object" &&
        binding.type === "secret_ref"
      ) {
        refs.push({
          secretId: binding.secretId,
          configPath: path,
          versionSelector: binding.version ?? "latest",
          projectionClass: binding.projectionClass,
          projectionAllowlistKey:
            binding.projectionAllowlistKey ?? null,
        });
        return;
      }
    }
    for (const [key, entry] of Object.entries(record)) {
      visit(entry, appendAdapterConfigPathKey(path, key));
    }
  };
  visit(config, "");

  return refs;
}

function collectUserSecretRefs(adapterConfig: unknown): Array<{
  definitionKey: string;
  configPath: string;
  envKey: string;
  versionSelector?: SecretVersionSelector;
  required?: boolean;
  allowMissingOverride?: boolean;
}> {
  const config = asRecord(adapterConfig);
  if (!config) return [];
  const refs: Array<{
    definitionKey: string;
    configPath: string;
    envKey: string;
    versionSelector?: SecretVersionSelector;
    required?: boolean;
    allowMissingOverride?: boolean;
  }> = [];

  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        visit(entry, appendAdapterConfigPathIndex(path, index)),
      );
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    if (record.type === "user_secret_ref") {
      const parsed = envBindingSchema.safeParse(record);
      const binding = parsed.success ? parsed.data : null;
      if (
        binding &&
        typeof binding === "object" &&
        binding.type === "user_secret_ref"
      ) {
        refs.push({
          definitionKey: binding.key,
          configPath: path,
          envKey: path.startsWith("env.")
            ? path.slice("env.".length)
            : path,
          versionSelector: binding.version ?? "latest",
          required: binding.required ?? true,
          allowMissingOverride:
            binding.allowMissingOverride ?? false,
        });
        return;
      }
    }
    for (const [key, entry] of Object.entries(record)) {
      visit(entry, appendAdapterConfigPathKey(path, key));
    }
  };
  visit(config, "");

  return refs;
}

export async function syncAgentAdapterEnvBindings(input: {
  secretsSvc: AgentSecretBindingSyncService;
  companyId: string;
  agentId: string;
  adapterConfig: unknown;
  actor: SecretMutationActor;
}) {
  requireSecretMutationActor(input.actor);
  await input.secretsSvc.syncSecretRefsForTarget(
    input.companyId,
    { targetType: "agent", targetId: input.agentId },
    collectSecretRefs(input.adapterConfig),
    { actor: input.actor, replaceAll: true },
  );
  await input.secretsSvc.syncUserSecretDeclarationsForTarget(
    input.companyId,
    { targetType: "agent", targetId: input.agentId },
    collectUserSecretRefs(input.adapterConfig),
    { actor: input.actor, replaceAll: true },
  );
}
