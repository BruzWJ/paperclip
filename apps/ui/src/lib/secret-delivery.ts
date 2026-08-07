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
/** Valid env-var name (matches the server's `ENV_KEY_RE`). */
export const SECRET_ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function deliveryModeForConfigPath(configPath: string | null | undefined): SecretDeliveryMode {
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

/** One-line explanation of a delivery mode, for tooltips/hints. */
export function deliveryModeDescription(mode: SecretDeliveryMode): string {
  switch (mode) {
    case "env":
      return "Injected as an environment variable at run start.";
    default:
      return "Provided through adapter configuration.";
  }
}

/** The env key carried by a config path (the part after the prefix). */
export function aliasFromConfigPath(configPath: string | null | undefined): string {
  if (!configPath) return "";
  if (configPath.startsWith(ENV_CONFIG_PATH_PREFIX)) {
    return configPath.slice(ENV_CONFIG_PATH_PREFIX.length);
  }
  return configPath;
}

/**
 * Human label for a secret access-event `consumerType`. Runtime consumers are
 * emitted as raw enum values (e.g. `agent_api`) which read
 * poorly when merely capitalized; map the ones that need help explicitly.
 */
export function consumerTypeLabel(consumerType: SecretAccessEvent["consumerType"]): string {
  switch (consumerType) {
    case "agent_api":
      return "Agent API";
    default:
      return consumerType.charAt(0).toUpperCase() + consumerType.slice(1);
  }
}
