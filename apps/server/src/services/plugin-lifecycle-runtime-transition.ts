import type { PluginRecord } from "@paperclipai/shared";
import { type LifecycleEventName, type PluginLifecycleEvents } from "./plugin-lifecycle-contracts.js";
import { type PluginLifecycleContext } from "./plugin-lifecycle.js";
import { buildPluginLifecycleTransitions } from "./plugin-lifecycle-transitions.js";

export function buildPluginLifecycleRuntimeTransition(
  scope: PluginLifecycleContext & ReturnType<typeof buildPluginLifecycleTransitions>,
) {
  const {
    pluginLoaderInstance,
    dispatchRef,
    taskExecutionCancellation,
    emitter,
    log,
    transition,
    commitDisabledTransition,
  } = scope;

  async function finishDisabledTransition(
    committed: NonNullable<Awaited<ReturnType<typeof commitDisabledTransition>>>,
  ): Promise<void> {
    let teardownFailure: { error: unknown } | null = null;
    const deferredRecoveryErrors: unknown[] = [];

    // unloadSingle revokes the host binding synchronously before its first
    // fallible drain step. Always begin that fence before post-commit effects.
    try {
      await deactivatePluginRuntime(committed.plugin.id);
    } catch (error) {
      teardownFailure = { error };
    }

    for (const suspensionRequests of committed.suspensionRequests) {
      try {
        await taskExecutionCancellation.reconcileRequestedCancellations(suspensionRequests);
      } catch (error) {
        deferredRecoveryErrors.push(error);
      }
    }
    for (const refId of committed.dispatchRefIds) {
      try {
        await dispatchRef(refId);
      } catch (error) {
        deferredRecoveryErrors.push(error);
      }
    }

    if (deferredRecoveryErrors.length > 0) {
      // Cancellation intents and execution refs were committed before these
      // notifications. The instance recovery loop reconciles both durable
      // queues at startup and on scheduler ticks; do not pretend replaying the
      // plugin lifecycle transition owns their delivery retry.
      log.warn(
        {
          pluginId: committed.plugin.id,
          errors: deferredRecoveryErrors.map(errorMessage),
        },
        "plugin lifecycle: deferred durable post-commit reconciliation",
      );
    }
    if (teardownFailure) throw teardownFailure.error;
  }

  function emitDomain(event: LifecycleEventName, payload: PluginLifecycleEvents[LifecycleEventName]): void {
    emitter.emit(event, payload);
  }

  async function activateReadyPlugin(pluginId: string): Promise<void> {
    const loadResult = await pluginLoaderInstance.loadSingle(pluginId);
    if (!loadResult.success) {
      const message = loadResult.error;
      await transition(pluginId, "error", `Activation failed: ${message}`);
      throw new Error(message);
    }
    emitDomain("plugin.activated", {
      pluginId,
    });
  }

  async function deactivatePluginRuntime(pluginId: string): Promise<void> {
    await pluginLoaderInstance.unloadSingle(pluginId);
    emitDomain("plugin.deactivated", { pluginId });
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function persistReadyRuntimeFailure(
    plugin: PluginRecord,
    operation: string,
    cause: unknown,
  ): Promise<never> {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    try {
      await transition(plugin.id, "error", `${operation} failed: ${failure.message}`, plugin);
    } catch (statusError) {
      throw new AggregateError(
        [failure, statusError],
        `${operation} failed and the error status could not be persisted: ${failure.message}`,
      );
    }
    throw failure;
  }

  /**
   * Replace one ready runtime without ever leaving a durable ready row bound
   * to a known-stale runtime. Teardown is the authority fence; only after it
   * succeeds may the durable replacement mutation run.
   */
  async function replaceReadyRuntime<T>(
    plugin: PluginRecord,
    operation: string,
    replace: () => Promise<T>,
  ): Promise<T> {
    try {
      await deactivatePluginRuntime(plugin.id);
    } catch (error) {
      return persistReadyRuntimeFailure(plugin, operation, error);
    }

    let result: T;
    try {
      result = await replace();
    } catch (error) {
      return persistReadyRuntimeFailure(plugin, operation, error);
    }

    await activateReadyPlugin(plugin.id);
    return result;
  }

  return {
    finishDisabledTransition,
    emitDomain,
    activateReadyPlugin,
    deactivatePluginRuntime,
    errorMessage,
    persistReadyRuntimeFailure,
    replaceReadyRuntime,
  };
}
