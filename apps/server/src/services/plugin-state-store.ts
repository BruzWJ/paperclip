import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plugins, pluginState } from "@paperclipai/db";
import type {
  PluginStateScopeKind,
} from "@paperclipai/shared";
import type { WorkerToHostMethods } from "@paperclipai/plugin-sdk";
import { notFound } from "../errors.js";

type SetPluginState = WorkerToHostMethods["state.set"][0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default namespace used when the plugin does not specify one. */
const DEFAULT_NAMESPACE = "default";

/**
 * Build the WHERE clause conditions for a scoped state lookup.
 *
 * The five-part composite key is:
 *   `(pluginId, scopeKind, scopeId, namespace, stateKey)`
 *
 * `scopeId` may be null (for `instance` scope) or a non-empty string.
 */
function scopeConditions(
  pluginId: string,
  scopeKind: PluginStateScopeKind,
  scopeId: string | undefined | null,
  namespace: string,
  stateKey: string,
) {
  const conditions = [
    eq(pluginState.pluginId, pluginId),
    eq(pluginState.scopeKind, scopeKind),
    eq(pluginState.namespace, namespace),
    eq(pluginState.stateKey, stateKey),
  ];

  if (scopeId != null && scopeId !== "") {
    conditions.push(eq(pluginState.scopeId, scopeId));
  } else {
    conditions.push(isNull(pluginState.scopeId));
  }

  return and(...conditions);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Plugin State Store — scoped key-value persistence for plugin workers.
 *
 * Provides `get`, `set`, and `delete` operations over the `plugin_state`
 * table. Each plugin's data is strictly namespaced by
 * `pluginId` so plugins cannot read or write each other's state.
 *
 * This service implements the server-side backing for the `ctx.state` SDK
 * client exposed to plugin workers. The host is responsible for:
 * - enforcing `plugin.state.read` capability before calling `get`
 * - enforcing `plugin.state.write` capability before calling `set` / `delete`
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface (`ctx.state`)
 * @see PLUGIN_SPEC.md §15.1 — Capabilities: Plugin State
 * @see PLUGIN_SPEC.md §21.3 — `plugin_state` table
 */
export function pluginStateStore(db: Db) {
  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function assertPluginReady(pluginId: string): Promise<void> {
    const rows = await db
      .select({ id: plugins.id, status: plugins.status })
      .from(plugins)
      .where(
        and(
          eq(plugins.id, pluginId),
          eq(plugins.status, "ready"),
        ),
      );
    if (rows.length === 0) {
      throw notFound(`Ready plugin installation not found: ${pluginId}`);
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    /**
     * Read a state value.
     *
     * Returns the stored JSON value, or `null` if no entry exists for the
     * given scope and key.
     *
     * Requires `plugin.state.read` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param scopeKind - Granularity of the scope
     * @param scopeId - Identifier for the scoped entity (null for `instance` scope)
     * @param stateKey - The key to read
     * @param namespace - Sub-namespace (defaults to `"default"`)
     */
    get: async (
      pluginId: string,
      scopeKind: PluginStateScopeKind,
      stateKey: string,
      {
        scopeId,
        namespace = DEFAULT_NAMESPACE,
      }: { scopeId?: string; namespace?: string } = {},
    ): Promise<unknown> => {
      await assertPluginReady(pluginId);
      const rows = await db
        .select()
        .from(pluginState)
        .where(scopeConditions(pluginId, scopeKind, scopeId, namespace, stateKey));

      return rows[0]?.valueJson ?? null;
    },

    /**
     * Write (create or replace) a state value.
     *
     * Uses an upsert so the caller does not need to check for prior existence.
     * On conflict (same composite key) the existing row's `value_json` and
     * `updated_at` are overwritten.
     *
     * Requires `plugin.state.write` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param input - Scope key and value to store
     */
    set: async (pluginId: string, input: SetPluginState): Promise<void> => {
      await assertPluginReady(pluginId);

      const namespace = input.namespace ?? DEFAULT_NAMESPACE;
      const scopeId = input.scopeId ?? null;

      await db
        .insert(pluginState)
        .values({
          pluginId,
          scopeKind: input.scopeKind,
          scopeId,
          namespace,
          stateKey: input.stateKey,
          valueJson: input.value,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            pluginState.pluginId,
            pluginState.scopeKind,
            pluginState.scopeId,
            pluginState.namespace,
            pluginState.stateKey,
          ],
          set: {
            valueJson: input.value,
            updatedAt: new Date(),
          },
        });
    },

    /**
     * Delete a state value.
     *
     * No-ops silently if the entry does not exist (idempotent by design).
     *
     * Requires `plugin.state.write` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param scopeKind - Granularity of the scope
     * @param stateKey - The key to delete
     * @param scopeId - Identifier for the scoped entity (null for `instance` scope)
     * @param namespace - Sub-namespace (defaults to `"default"`)
     */
    delete: async (
      pluginId: string,
      scopeKind: PluginStateScopeKind,
      stateKey: string,
      {
        scopeId,
        namespace = DEFAULT_NAMESPACE,
      }: { scopeId?: string; namespace?: string } = {},
    ): Promise<void> => {
      await assertPluginReady(pluginId);
      await db
        .delete(pluginState)
        .where(scopeConditions(pluginId, scopeKind, scopeId, namespace, stateKey));
    },
  };
}
