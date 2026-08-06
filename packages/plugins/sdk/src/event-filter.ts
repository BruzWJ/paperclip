import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import type {
  EventFilter,
  PluginEvent,
  PluginEventPattern,
} from "./types.js";

const CORE_EVENT_TYPES = new Set<string>(PLUGIN_EVENT_TYPES);
const AGENT_FILTER_CORE_EVENT_TYPES = new Set<string>([
  "agent.run.finished",
  "agent.run.failed",
  "agent.run.cancelled",
]);
const EVENT_FILTER_KEYS = new Set(["companyId", "agentId"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validate one subscription exactly as the host and test harness admit it. */
export function assertPluginEventSubscription(
  pattern: PluginEventPattern,
  filter: EventFilter | null | undefined,
): void {
  if (!CORE_EVENT_TYPES.has(pattern)) {
    if (!pattern.startsWith("plugin.") || pattern.length === "plugin.".length) {
      throw new Error(`Unsupported plugin event subscription pattern: ${pattern}`);
    }
    const wildcardIndex = pattern.indexOf("*");
    if (
      wildcardIndex !== -1
      && !(pattern.endsWith(".*") && wildcardIndex === pattern.length - 1)
    ) {
      throw new Error(
        `Plugin event wildcards are supported only as a trailing ".*": ${pattern}`,
      );
    }
  }

  if (filter === null || filter === undefined) return;
  const value = record(filter);
  if (!value) throw new Error("Plugin event filter must be an object");
  for (const key of Object.keys(value)) {
    if (!EVENT_FILTER_KEYS.has(key)) {
      throw new Error(`Unsupported plugin event filter field: ${key}`);
    }
    const field = value[key];
    if (typeof field !== "string" || field.length === 0 || field !== field.trim()) {
      throw new Error(`Plugin event filter ${key} must be exact and non-empty`);
    }
  }
  if (
    value.agentId !== undefined
    && CORE_EVENT_TYPES.has(pattern)
    && !AGENT_FILTER_CORE_EVENT_TYPES.has(pattern)
  ) {
    throw new Error(`Plugin event filter agentId is not supported for ${pattern}`);
  }
}

/** Apply the one canonical server/worker/test-harness plugin event filter. */
export function pluginEventMatchesFilter(
  event: PluginEvent,
  filter: EventFilter | null | undefined,
): boolean {
  if (!filter) return true;
  const payload = record(event.payload);

  if (filter.companyId !== undefined && event.companyId !== filter.companyId) {
    return false;
  }

  if (filter.agentId !== undefined) {
    const agentId = typeof payload?.agentId === "string"
      ? payload.agentId
      : undefined;
    if (agentId !== filter.agentId) return false;
  }

  return true;
}
