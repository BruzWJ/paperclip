import type { Db } from "@paperclipai/db";
import type { PluginConfig } from "@paperclipai/shared";
import { EventEmitter } from "node:events";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validatePluginInstanceConfig } from "./plugin-config-validator.js";
import {
  type PluginLifecycleManager,
  type PluginLifecycleManagerOptions,
} from "./plugin-lifecycle-contracts.js";
import { createPluginLifecycleMethods1 } from "./plugin-lifecycle-methods-1.js";
import { buildPluginLifecycleRuntimeTransition } from "./plugin-lifecycle-runtime-transition.js";
import { buildPluginLifecycleTransitions } from "./plugin-lifecycle-transitions.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";

export function createPluginLifecycleContext(db: Db, options: PluginLifecycleManagerOptions) {
  const pluginLoaderInstance = options.loader;

  const dispatchRef = options.dispatchRef;

  const taskExecutionCancellation = options.taskExecutionCancellation;

  const registry = pluginRegistryService(db);

  const canonicalSessions = createTaskSessionAdmissionService(db);

  const emitter = new EventEmitter();

  const log = logger.child({ service: "plugin-lifecycle" });

  const operationTails = new Map<string, Promise<void>>();

  return {
    db,
    options,
    pluginLoaderInstance,
    dispatchRef,
    taskExecutionCancellation,
    registry,
    canonicalSessions,
    emitter,
    log,
    operationTails,
  };
}

export type PluginLifecycleContext = ReturnType<typeof createPluginLifecycleContext>;

export function createPluginLifecycleMethods2(
  scope: PluginLifecycleContext &
    ReturnType<typeof buildPluginLifecycleTransitions> &
    ReturnType<typeof buildPluginLifecycleRuntimeTransition>,
) {
  const {
    registry,
    emitter,
    log,
    serializeLifecycleOperation,
    pluginIdentity,
    requirePlugin,
    replaceReadyRuntime,
  } = scope;

  return {
    // -- reloadRuntime ----------------------------------------------------
    async reloadRuntime(pluginId: string): Promise<void> {
      return serializeLifecycleOperation(pluginIdentity(pluginId), async () => {
        const plugin = await requirePlugin(pluginId);
        if (plugin.status !== "ready") {
          throw badRequest(
            `Cannot reload runtime for plugin in status '${plugin.status}'. ` +
              `Plugin must be in 'ready' status.`,
          );
        }

        log.info(
          { pluginId, pluginKey: plugin.pluginKey },
          "plugin lifecycle: reloading complete plugin runtime",
        );

        await replaceReadyRuntime(plugin, "Plugin runtime restart", async () => undefined);

        log.info({ pluginId, pluginKey: plugin.pluginKey }, "plugin lifecycle: plugin reloaded");
      });
    },

    // -- updateConfig -----------------------------------------------------
    async updateConfig(pluginId: string, configJson: Record<string, unknown>): Promise<PluginConfig> {
      return serializeLifecycleOperation(pluginIdentity(pluginId), async () => {
        const plugin = await requirePlugin(pluginId);
        const validation = validatePluginInstanceConfig(configJson, plugin.manifestJson.instanceConfigSchema);
        if (!validation.valid) {
          throw badRequest(
            "Configuration does not match the plugin's instanceConfigSchema",
            validation.errors,
          );
        }

        if (plugin.status !== "ready") {
          return registry.upsertConfig(pluginId, configJson);
        }

        return replaceReadyRuntime(plugin, "Plugin configuration update", () =>
          registry.upsertConfig(pluginId, configJson),
        );
      });
    },

    // -- Event subscriptions ----------------------------------------------
    on(event, listener) {
      emitter.on(event, listener);
    },

    off(event, listener) {
      emitter.off(event, listener);
    },
  } satisfies Pick<PluginLifecycleManager, "reloadRuntime" | "updateConfig" | "on" | "off">;
}

export type { PluginLifecycleManager } from "./plugin-lifecycle-contracts.js";

export function pluginLifecycleManager(
  db: Db,
  options: PluginLifecycleManagerOptions,
): PluginLifecycleManager {
  const context = createPluginLifecycleContext(db, options);
  const helpers1 = buildPluginLifecycleTransitions(context);
  const scope1 = { ...context, ...helpers1 };
  const helpers2 = buildPluginLifecycleRuntimeTransition(scope1);
  const scope2 = { ...scope1, ...helpers2 };
  const scope = scope2;
  const methods1 = createPluginLifecycleMethods1(scope);
  const methods2 = createPluginLifecycleMethods2(scope);
  return { ...methods1, ...methods2 };
}
