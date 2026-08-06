import type {
  PluginEnvironmentCancelExecutionParams,
  PluginEnvironmentCancelExecutionResult,
  PluginEnvironmentExecuteParams,
} from "./protocol.js";

interface ActiveEnvironmentExecution {
  readonly companyId: string;
  readonly environmentId: string;
  readonly providerLeaseId: string | null;
  readonly executionId: string;
  readonly cancel: (reason: string) => Promise<void>;
  cancellation: Promise<void> | null;
}

function requireExecutionId(executionId: string): string {
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new Error("Environment executionId must be a non-empty opaque string.");
  }
  if (executionId.length > 512) {
    throw new Error("Environment executionId exceeds the 512-character limit.");
  }
  return executionId;
}

function sameExecutionScope(
  entry: ActiveEnvironmentExecution,
  params: PluginEnvironmentCancelExecutionParams,
): boolean {
  return entry.companyId === params.companyId
    && entry.environmentId === params.environmentId
    && entry.providerLeaseId === params.lease.providerLeaseId
    && entry.executionId === params.executionId;
}

function executionScopeKey(input: {
  companyId: string;
  environmentId: string;
  lease: { providerLeaseId: string | null };
  executionId: string;
}): string {
  return JSON.stringify([
    input.companyId,
    input.environmentId,
    input.lease.providerLeaseId,
    requireExecutionId(input.executionId),
  ]);
}

/**
 * Worker-local exact-command registry shared by sandbox providers.
 *
 * It intentionally tracks only active command identities and cancellation
 * callbacks. It never owns, releases, or destroys provider leases. Registering
 * happens synchronously before provider work starts, which lets a concurrent
 * cancellation request win even while execution is still connecting.
 */
export function createEnvironmentExecutionCancellationRegistry() {
  const active = new Map<string, ActiveEnvironmentExecution>();

  return {
    async execute<T>(
      params: PluginEnvironmentExecuteParams,
      handlers: {
        execute(): Promise<T>;
        cancel(reason: string): Promise<void>;
      },
    ): Promise<T> {
      const executionId = requireExecutionId(params.executionId);
      const key = executionScopeKey(params);
      if (active.has(key)) {
        throw new Error(`Environment execution "${executionId}" is already active.`);
      }

      const entry: ActiveEnvironmentExecution = {
        companyId: params.companyId,
        environmentId: params.environmentId,
        providerLeaseId: params.lease.providerLeaseId,
        executionId,
        cancel: handlers.cancel,
        cancellation: null,
      };
      active.set(key, entry);
      try {
        return await handlers.execute();
      } finally {
        if (active.get(key) === entry) {
          active.delete(key);
        }
      }
    },

    async cancel(
      params: PluginEnvironmentCancelExecutionParams,
      cancelUntracked?: (
        reason: string,
      ) => Promise<boolean>,
    ): Promise<PluginEnvironmentCancelExecutionResult> {
      const executionId = requireExecutionId(params.executionId);
      const entry = active.get(executionScopeKey(params));
      if (!entry || !sameExecutionScope(entry, params)) {
        return {
          executionId,
          cancelled:
            (await cancelUntracked?.(params.reason)) ?? false,
        };
      }
      entry.cancellation ??= Promise.resolve().then(() => entry.cancel(params.reason));
      await entry.cancellation;
      return { executionId, cancelled: true };
    },
  };
}
