import { realpath } from "node:fs/promises";
import type { PluginInstallRequest, PluginStatus, PluginRecord } from "@paperclipai/shared";
import { lockPluginInstallationInTransaction, persistPluginStatusInTransaction } from "./plugin-registry.js";
import { badRequest, notFound } from "../errors.js";
import { pausePluginManagedAgentsIntoTriageInTransaction } from "./plugin-managed-agents.js";
import type { RequestedAgentRunCancellations } from "./task-execution-cancellation.js";
import { publishCommittedActivity, type PersistedActivityLog } from "./activity-log.js";
import { terminalizePluginCreatorEdgesInTransaction } from "./system-escalation-postgres.js";
import { isValidTransition } from "./plugin-lifecycle-contracts.js";
import { type PluginLifecycleContext } from "./plugin-lifecycle.js";

export function buildPluginLifecycleTransitions(scope: PluginLifecycleContext) {
  const { db, options, taskExecutionCancellation, registry, canonicalSessions, log, operationTails } = scope;

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function serializeLifecycleOperation<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const previous = operationTails.get(identity) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    operationTails.set(identity, settled);
    try {
      return await result;
    } finally {
      if (operationTails.get(identity) === settled) {
        operationTails.delete(identity);
      }
    }
  }

  async function installIdentity(options: PluginInstallRequest): Promise<string> {
    if (options.source === "npm") {
      return `install:npm:${options.packageName}`;
    }
    return `install:local:${await realpath(options.path)}`;
  }

  function pluginIdentity(pluginId: string): string {
    return `plugin:${pluginId}`;
  }

  async function requirePlugin(pluginId: string): Promise<PluginRecord> {
    const plugin = await registry.getById(pluginId);
    if (!plugin) throw notFound(`Plugin not found: ${pluginId}`);
    return plugin;
  }

  function assertTransition(plugin: PluginRecord, to: PluginStatus): void {
    if (!isValidTransition(plugin.status, to)) {
      throw badRequest(
        `Invalid lifecycle transition: ${plugin.status} → ${to} for plugin ${plugin.pluginKey}`,
      );
    }
  }

  async function transition(
    pluginId: string,
    to: PluginStatus,
    lastError: string | null = null,
    existingPlugin?: PluginRecord,
  ): Promise<PluginRecord> {
    const plugin = existingPlugin ?? (await requirePlugin(pluginId));
    assertTransition(plugin, to);

    const previousStatus = plugin.status;

    const updated = await registry.updateStatus(pluginId, {
      status: to,
      lastError,
    });

    if (!updated) throw notFound(`Plugin not found after status update: ${pluginId}`);
    const result = updated;

    log.info(
      { pluginId, pluginKey: result.pluginKey, from: previousStatus, to },
      `plugin lifecycle: ${previousStatus} → ${to}`,
    );

    return result;
  }

  async function commitDisabledTransition(
    pluginId: string,
    options: {
      lastError: string | null;
      managedAgentReason: string;
      terminalReason: "plugin_disabled" | "plugin_uninstalled";
    },
  ): Promise<{
    previousStatus: PluginStatus;
    plugin: PluginRecord;
    suspensionRequests: RequestedAgentRunCancellations[];
    dispatchRefIds: string[];
    activities: PersistedActivityLog[];
  } | null> {
    const committed = await db.transaction(async (tx) => {
      // Global lock order for plugin-originated work is installation first,
      // then managed bindings/agents, then creator edges/deliveries.
      const locked = await lockPluginInstallationInTransaction(tx, pluginId);
      if (!locked) return null;
      const plugin = locked;
      if (plugin.status === "disabled") {
        return {
          previousStatus: plugin.status,
          plugin,
          suspensionRequests: [],
          dispatchRefIds: [],
          activities: [],
        };
      }
      assertTransition(plugin, "disabled");
      const now = new Date();

      const managedAgentTransition = await pausePluginManagedAgentsIntoTriageInTransaction(
        tx,
        {
          pluginId,
          pluginKey: plugin.pluginKey,
          reason: options.managedAgentReason,
          actorType: "system",
          actorId: pluginId,
        },
        taskExecutionCancellation,
        now,
      );
      const pluginEscalations = await terminalizePluginCreatorEdgesInTransaction(tx, canonicalSessions, {
        pluginInstallationId: pluginId,
        reason: options.terminalReason,
        sourceId: `${options.terminalReason.replaceAll("_", "-")}:${pluginId}`,
        now,
      });
      const updated = await persistPluginStatusInTransaction(
        tx,
        pluginId,
        {
          status: "disabled",
          lastError: options.lastError,
        },
        now,
      );
      if (!updated) {
        throw notFound(`Plugin not found after status update: ${pluginId}`);
      }
      return {
        previousStatus: plugin.status,
        plugin: updated,
        suspensionRequests: managedAgentTransition.suspensionRequests,
        dispatchRefIds: pluginEscalations.flatMap((escalation) =>
          escalation.dispatchRefId ? [escalation.dispatchRefId] : [],
        ),
        activities: managedAgentTransition.activities,
      };
    });
    for (const activity of committed?.activities ?? []) {
      publishCommittedActivity(activity);
    }
    return committed;
  }

  return {
    serializeLifecycleOperation,
    installIdentity,
    pluginIdentity,
    requirePlugin,
    assertTransition,
    transition,
    commitDisabledTransition,
  };
}
