import { createHash, randomUUID } from "node:crypto";
import type { PluginWorkerStatus } from "@paperclipai/shared";
import {
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  PLUGIN_RPC_ERROR_CODES,
  createErrorResponse,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type HostToWorkerMethodName,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PluginInvocationContext,
  type PluginInvocationScope,
  type WorkerHostCallContext,
  type WorkerToHostMethodName,
} from "@paperclipai/plugin-sdk";
import type { ActiveInvocation, PendingRequest } from "./plugin-worker-foundation.js";

export function buildPluginWorkerRpcCore(scope: any) {
  const { pluginId, options, log, state, pendingRequests, activeInvocations, rejectAllPending } = scope;
  const typedPendingRequests = pendingRequests as Map<string | number, PendingRequest>;
  const typedActiveInvocations = activeInvocations as Map<string, ActiveInvocation>;

  // -----------------------------------------------------------------------
  // Status management
  // -----------------------------------------------------------------------

  function setStatus(newStatus: PluginWorkerStatus): void {
    const prev = state.status;
    if (prev === newStatus) return;
    state.status = newStatus;
    log.debug({ from: prev, to: newStatus }, "worker status change");
  }

  // -----------------------------------------------------------------------
  // JSON-RPC message sending
  // -----------------------------------------------------------------------

  function sendMessage(message: JsonRpcMessage): void {
    if (!state.childProcess?.stdin?.writable) {
      throw new Error(`Worker process for plugin "${pluginId}" is not writable`);
    }
    const serialized = serializeMessage(message);
    state.childProcess.stdin.write(serialized);
  }

  function errorCodeForWorkerHostError(err: unknown): number {
    const code = (err as { code?: unknown } | null)?.code;
    const pluginErrorCodes: readonly number[] = Object.values(PLUGIN_RPC_ERROR_CODES);
    return typeof code === "number" && pluginErrorCodes.includes(code)
      ? code
      : JSONRPC_ERROR_CODES.INTERNAL_ERROR;
  }

  // -----------------------------------------------------------------------
  // Incoming message handling
  // -----------------------------------------------------------------------

  function terminateForProtocolViolation(line: string, error: unknown): void {
    if (state.protocolViolationError) return;
    const detail = error instanceof Error ? error.message : String(error);
    state.protocolViolationError = new Error(`Worker protocol violation: ${detail}`);
    log.error(
      { err: detail, rawLine: line.slice(0, 200) },
      "worker emitted malformed protocol output; terminating",
    );

    if (!state.childProcess) {
      rejectAllPending(state.protocolViolationError);
      return;
    }
    try {
      if (!state.childProcess.kill("SIGKILL")) {
        rejectAllPending(state.protocolViolationError);
      }
    } catch {
      rejectAllPending(state.protocolViolationError);
    }
  }

  function handleLine(line: string): void {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = parseMessage(line);
    } catch (err) {
      terminateForProtocolViolation(line, err);
      return;
    }

    if (isJsonRpcResponse(message)) {
      handleResponse(message);
    } else {
      handleWorkerRequest(message);
    }
  }

  /**
   * Handle a JSON-RPC response from the worker (matching a pending request).
   */
  function handleResponse(response: JsonRpcResponse): void {
    const id = response.id;
    if (id === null || id === undefined) {
      log.warn("received response with null/undefined id");
      return;
    }

    const pending = pendingRequests.get(id);
    if (!pending) {
      log.warn({ id }, "received response for unknown request id");
      return;
    }

    clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.resolve(response);
  }

  function readNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function deriveInvocationScope(
    method: HostToWorkerMethodName | string,
    params: unknown,
  ): PluginInvocationScope | null {
    if (!isRecord(params)) return null;

    const directCompanyId = readNonEmptyString(params.companyId);
    if (directCompanyId) return { companyId: directCompanyId };

    if (method === "performAction" && isRecord(params.actorContext)) {
      const companyId = readNonEmptyString(params.actorContext.companyId);
      return companyId ? { companyId } : null;
    }

    if (method === "onEvent" && isRecord(params.event)) {
      const companyId = readNonEmptyString(params.event.companyId);
      return companyId ? { companyId } : null;
    }

    return null;
  }

  function registerInvocation(scope: PluginInvocationScope, ttlMs?: number): PluginInvocationContext {
    const invocation: PluginInvocationContext = {
      id: randomUUID(),
      scope,
    };
    const entry: ActiveInvocation = { scope };
    if (ttlMs !== undefined) {
      entry.timer = setTimeout(() => {
        activeInvocations.delete(invocation.id);
      }, ttlMs);
      if (entry.timer.unref) entry.timer.unref();
    }
    activeInvocations.set(invocation.id, entry);
    return invocation;
  }

  function clearInvocation(invocation: PluginInvocationContext | null): void {
    if (!invocation) return;
    const entry = activeInvocations.get(invocation.id);
    if (entry?.timer) clearTimeout(entry.timer);
    activeInvocations.delete(invocation.id);
  }

  function rpcOperationIdForWorkerRequest(request: JsonRpcRequest): string {
    // This is transport identity, not payload identity: the message/body is
    // deliberately excluded so distinct same-payload calls never deduplicate.
    const digest = createHash("sha256")
      .update(state.workerRpcIncarnationId)
      .update("\u0000")
      .update(request.method)
      .update("\u0000")
      .update(typeof request.id)
      .update("\u0000")
      .update(String(request.id))
      .digest("hex");
    return `pc_plugin_rpc_op_v1_${digest}`;
  }

  function contextForWorkerMessage(message: JsonRpcRequest): WorkerHostCallContext {
    const rpcOperationContext = {
      rpcOperationId: rpcOperationIdForWorkerRequest(message),
    };
    const invocationId = readNonEmptyString(
      (message as { paperclipInvocationId?: unknown }).paperclipInvocationId,
    );
    if (!invocationId) {
      const hasActiveInvocation =
        typedActiveInvocations.size > 0 ||
        Array.from(typedPendingRequests.values()).some((pending) => pending.invocationId);
      return hasActiveInvocation
        ? { ...rpcOperationContext, invalidInvocationScope: true }
        : rpcOperationContext;
    }
    const entry = typedActiveInvocations.get(invocationId);
    if (!entry) return { ...rpcOperationContext, invalidInvocationScope: true };
    return { ...rpcOperationContext, invocationScope: entry.scope };
  }

  function isWorkerToHostMethod(method: string): method is WorkerToHostMethodName {
    return Object.prototype.hasOwnProperty.call(options.hostHandlers, method);
  }

  /**
   * Handle a JSON-RPC request from the worker (worker→host call).
   */
  async function handleWorkerRequest(request: JsonRpcRequest): Promise<void> {
    const method = request.method;
    if (!isWorkerToHostMethod(method)) {
      log.warn({ method }, "worker called unknown host method");
      try {
        sendMessage(
          createErrorResponse(
            request.id,
            JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
            `Host does not handle method "${method}"`,
          ),
        );
      } catch {
        // Worker may have exited, ignore send error
      }
      return;
    }
    const handler = options.hostHandlers[method];

    try {
      const result = await handler(request.params as never, contextForWorkerMessage(request));
      sendMessage({
        jsonrpc: JSONRPC_VERSION,
        id: request.id,
        result: result ?? null,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error({ method, err: errorMessage }, "host handler error");
      try {
        sendMessage(createErrorResponse(request.id, errorCodeForWorkerHostError(err), errorMessage));
      } catch {
        // Worker may have exited, ignore send error
      }
    }
  }

  return {
    setStatus,
    sendMessage,
    errorCodeForWorkerHostError,
    terminateForProtocolViolation,
    handleLine,
    handleResponse,
    readNonEmptyString,
    isRecord,
    deriveInvocationScope,
    registerInvocation,
    clearInvocation,
    rpcOperationIdForWorkerRequest,
    contextForWorkerMessage,
    isWorkerToHostMethod,
    handleWorkerRequest,
  };
}
