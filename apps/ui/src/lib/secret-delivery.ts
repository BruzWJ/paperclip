import type { SecretAccessEvent } from "@paperclipai/shared";

/**
 * Delivery mode for an agent secret binding, derived from its `configPath`.
 *
 * A binding's config path is the source of truth for how a secret reaches
 * the runtime:
 *  - `env.<KEY>`    — injected as an environment variable at run start.
 *  - anything else  — a generic adapter config path (rendered as "Config").
 */
export type SecretDeliveryMode = "env" | "config";

/** Prefix for env-var delivery config paths. Mirrors the server convention. */
export const ENV_CONFIG_PATH_PREFIX = "env.";
export function deliveryModeForConfigPath(
  configPath: string | null | undefined,
): SecretDeliveryMode {
  if (!configPath) return "config";
  if (configPath.startsWith(ENV_CONFIG_PATH_PREFIX)) return "env";
  return "config";
}

/** Short human label for a delivery mode. */
export function deliveryModeLabel(mode: SecretDeliveryMode): string {
  switch (mode) {
    case "env":
      return "Env var";
    default:
      return "Config";
  }
}

/** The env key carried by a config path (the part after the prefix). */
export function aliasFromConfigPath(
  configPath: string | null | undefined,
): string {
  if (!configPath) return "";
  if (configPath.startsWith(ENV_CONFIG_PATH_PREFIX)) {
    return configPath.slice(ENV_CONFIG_PATH_PREFIX.length);
  }
  return configPath;
}

export function consumerTypeLabel(
  consumerType: SecretAccessEvent["consumerType"],
): string {
  return consumerType.charAt(0).toUpperCase() + consumerType.slice(1);
}
