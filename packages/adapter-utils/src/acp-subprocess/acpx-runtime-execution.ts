import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult,
  type AcpSessionStore,
} from "acpx/runtime";
import type { StopReason, ToolCallStatus } from "@agentclientprotocol/sdk";
import {
  assertAcpRegistryAgentName,
  isAcpRegistryAgentLocallyAvailable,
  loadAcpxAgentRegistry,
} from "./agent-registry.js";
import type {
  AcpPromptSettlement,
  AcpTerminalOccupancy,
} from "./contract.js";
import type { NormalizedAcpSessionEvent } from "./events.js";

const TEMPORARY_STATE_DIRECTORY_PREFIX = "paperclip-acpx-one-shot-";

export type AcpxRuntimeMcpServer = NonNullable<
  AcpRuntimeOptions["mcpServers"]
>[number];

/**
 * ACPX owns the exact option ids and values. In particular, ACPX's public
 * runtime API accepts strings for `setConfigOption`, so this bridge does not
 * reinterpret booleans or provider-specific option names.
 */
export interface AcpxRuntimeConfigSelection {
  readonly configId: string;
  readonly value: string;
}

/**
 * A role/bootstrap turn sent before the normal work prompt. It reuses the
 * same ACPX runtime handle, configured MCP servers, and provider session.
 */
export interface AcpxOneShotBootstrapInput {
  readonly message: string;
}

/** The ACPX runtime's fresh-session or durable-backend-session start choice. */
export type AcpxRuntimeSessionStart =
  | { readonly kind: "new" }
  | { readonly kind: "resume"; readonly sessionId: string };

/**
 * Narrow public ACPX runtime surface used by Paperclip's disposable runner.
 * Keeping this interface here makes the one-shot lifecycle testable without
 * substituting a provider-specific or raw-ACP implementation.
 */
export type AcpxOneShotRuntime = Pick<
  AcpRuntime,
  | "ensureSession"
  | "startTurn"
  | "setConfigOption"
  | "cancel"
  | "close"
> & {
  /** Required to seal the current ACPX backend id after configuration. */
  readonly getStatus: NonNullable<AcpRuntime["getStatus"]>;
};

export interface AcpxOneShotExecutionDependencies {
  /** Defaults to ACPX's resolved global + project registry. */
  readonly loadAgentRegistry?: (input: {
    readonly cwd: string;
  }) => Promise<AcpAgentRegistry>;
  readonly createAcpRuntime?: (
    options: AcpRuntimeOptions,
  ) => AcpxOneShotRuntime;
  readonly createRuntimeStore?: (options: {
    readonly stateDir: string;
  }) => AcpSessionStore;
  /** Test seam for the private, disposable ACPX state directory. */
  readonly createTemporaryStateDir?: () => Promise<string>;
  /** Test seam paired only with createTemporaryStateDir. */
  readonly removeTemporaryStateDir?: (stateDir: string) => Promise<void>;
  readonly createSessionKey?: () => string;
}

export interface AcpxOneShotPromptInput {
  /** Workspace used by ACPX for the disposable agent session. */
  readonly cwd: string;
  /**
   * Optional Paperclip ACPX configuration scope. When supplied, ACPX resolves
   * its registry and configured overrides here while the provider session runs in
   * `cwd`. This keeps catalog, revision validation, readiness, and execution
   * on one ACPX registry without treating an issue workspace as configuration.
   */
  readonly registryCwd?: string;
  /** Must be an exact, locally available name in ACPX's registry. */
  readonly agentName: string;
  readonly start: AcpxRuntimeSessionStart;
  /** Optional role/bootstrap turn sent before the normal work message. */
  readonly bootstrapPrompt?: AcpxOneShotBootstrapInput;
  readonly message: string;
  /** Immutable selections supplied by ACPX's own discovery contract. */
  readonly configSelections: readonly AcpxRuntimeConfigSelection[];
  readonly permissionMode: AcpRuntimeOptions["permissionMode"];
  readonly nonInteractivePermissions?: AcpRuntimeOptions["nonInteractivePermissions"];
  readonly mcpServers?: readonly AcpxRuntimeMcpServer[];
  readonly onPermissionRequest?: AcpRuntimeOptions["onPermissionRequest"];
  readonly timeoutMs?: number;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
  /** Receives ACPX's public runtime event before Paperclip's safe projection. */
  readonly onRuntimeEvent?: (
    event: AcpRuntimeEvent,
  ) => Promise<void> | void;
  /** Receives only ACPX events that map exactly to Paperclip's stable stream. */
  readonly onSessionEvent?: (
    event: NormalizedAcpSessionEvent,
  ) => Promise<void> | void;
  /** Activates Paperclip's durable execution authority after ACPX configuration. */
  readonly activatePrompt?: (input: {
    readonly sessionId: string;
  }) => Promise<void>;
  /** Records the durable work-transmission fence immediately before its `startTurn`. */
  readonly beginPromptTransmission?: (input: {
    readonly sessionId: string;
  }) => Promise<void>;
  readonly dependencies?: AcpxOneShotExecutionDependencies;
}

export type AcpxOneShotExecutionPhase =
  | "session_setup"
  | "configuration"
  | "prompt_activation"
  | "prompt_transmission"
  | "prompt";

export interface AcpxOneShotCleanup {
  /**
   * True only after the private ACPX runtime store was removed. A successful
   * provider turn is not enough to claim a one-shot lifecycle: Paperclip must
   * be able to prove it retained no ACPX session/runtime state.
   */
  readonly stateRemoved: boolean;
  /** Every cleanup failure is reported without hiding the completed turn. */
  readonly errors: readonly unknown[];
}

export type AcpxOneShotPromptResult =
  | {
      readonly kind: "completed";
      readonly sessionId: string;
      readonly turnResult: Extract<AcpRuntimeTurnResult, { status: "completed" }>;
      /** Present only when ACPX supplied an exact stop reason and occupancy. */
      readonly settlement: AcpPromptSettlement | null;
      readonly cleanup: AcpxOneShotCleanup;
    }
  | {
      readonly kind: "cancelled";
      readonly sessionId: string;
      readonly turnResult: Extract<AcpRuntimeTurnResult, { status: "cancelled" }>;
      /** Present only when ACPX supplied an exact stop reason and occupancy. */
      readonly settlement: AcpPromptSettlement | null;
      readonly cleanup: AcpxOneShotCleanup;
    }
  | {
      readonly kind: "failed";
      readonly sessionId: string;
      readonly turnResult: Extract<AcpRuntimeTurnResult, { status: "failed" }>;
      readonly cleanup: AcpxOneShotCleanup;
    }
  | {
      readonly kind: "error";
      readonly phase: AcpxOneShotExecutionPhase;
      readonly sessionId: string | null;
      /** True only after the normal work prompt was handed to ACPX. */
      readonly promptTransmitted: boolean;
      readonly cause: unknown;
      readonly cleanup: AcpxOneShotCleanup;
    };

type AcpxOneShotPromptResultWithoutCleanup =
  | {
      readonly kind: "completed";
      readonly sessionId: string;
      readonly turnResult: Extract<AcpRuntimeTurnResult, { status: "completed" }>;
      readonly settlement: AcpPromptSettlement | null;
    }
  | {
      readonly kind: "cancelled";
      readonly sessionId: string;
      readonly turnResult: Extract<AcpRuntimeTurnResult, { status: "cancelled" }>;
      readonly settlement: AcpPromptSettlement | null;
    }
  | {
      readonly kind: "failed";
      readonly sessionId: string;
      readonly turnResult: Extract<AcpRuntimeTurnResult, { status: "failed" }>;
    }
  | {
      readonly kind: "error";
      readonly phase: AcpxOneShotExecutionPhase;
      readonly sessionId: string | null;
      /** True only after the normal work prompt was handed to ACPX. */
      readonly promptTransmitted: boolean;
      readonly cause: unknown;
    };

function exactString(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return value;
}

function exactPromptMessage(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
  return value;
}

function resolveExecutionCwd(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("ACPX one-shot execution cwd is required");
  }
  return resolve(value);
}

function resolveTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("ACPX one-shot execution timeout must be a positive integer");
  }
  return value;
}

function exactConfigSelections(
  selections: readonly AcpxRuntimeConfigSelection[],
): readonly AcpxRuntimeConfigSelection[] {
  const ids = new Set<string>();
  return Object.freeze(
    selections.map((selection) => {
      const configId = exactString(selection.configId, "ACPX config id");
      const value = exactString(selection.value, `ACPX config ${configId} value`);
      if (ids.has(configId)) {
        throw new Error(`ACPX config id is duplicated: ${configId}`);
      }
      ids.add(configId);
      return Object.freeze({ configId, value });
    }),
  );
}

function exactSessionStart(
  start: AcpxRuntimeSessionStart,
): AcpxRuntimeSessionStart {
  if (!start || typeof start !== "object") {
    throw new Error("ACPX session start is required");
  }
  if (start.kind === "new") return Object.freeze({ kind: "new" });
  if (start.kind === "resume") {
    return Object.freeze({
      kind: "resume",
      sessionId: exactString(start.sessionId, "ACPX resume session id"),
    });
  }
  throw new Error("ACPX session start kind must be new or resume");
}

function durableBackendSessionId(
  value: Pick<AcpRuntimeHandle, "backendSessionId"> | Pick<AcpRuntimeStatus, "backendSessionId">,
): string | null {
  const sessionId = value.backendSessionId;
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId === sessionId.trim()
    ? sessionId
    : null;
}

function safeTemporaryStateDir(stateDir: string): string {
  const resolvedStateDir = resolve(exactString(stateDir, "ACPX temporary state directory"));
  const temporaryRoot = resolve(tmpdir());
  const pathFromTemporaryRoot = relative(temporaryRoot, resolvedStateDir);
  if (
    pathFromTemporaryRoot.length === 0 ||
    pathFromTemporaryRoot === ".." ||
    pathFromTemporaryRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromTemporaryRoot) ||
    !basename(resolvedStateDir).startsWith(TEMPORARY_STATE_DIRECTORY_PREFIX)
  ) {
    throw new Error("ACPX temporary state directory is outside the managed temporary path");
  }
  return resolvedStateDir;
}

async function createDefaultTemporaryStateDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), TEMPORARY_STATE_DIRECTORY_PREFIX));
}

async function removeDefaultTemporaryStateDir(stateDir: string): Promise<void> {
  await rm(stateDir, { recursive: true, force: true });
}

function stripMeta<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripMeta(entry)) as T;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "_meta")
      .map(([key, entry]) => [key, stripMeta(entry)]),
  ) as T;
}

function normalizedToolCallStatus(value: string | undefined): ToolCallStatus | undefined {
  return value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed"
    ? value
    : undefined;
}

function normalizedRuntimeEvent(
  event: AcpRuntimeEvent,
): NormalizedAcpSessionEvent | undefined {
  if (event.type === "text_delta") {
    return {
      kind: "message_chunk",
      channel: event.stream === "thought" ? "thought" : "assistant",
      content: { type: "text", text: event.text },
    };
  }
  if (event.type === "tool_call") {
    if (!event.toolCallId) return undefined;
    const status = normalizedToolCallStatus(event.status);
    const title = event.title ?? (event.text || "tool call");
    const fields = {
      ...(event.kind === undefined ? {} : { toolKind: event.kind }),
      ...(status === undefined ? {} : { status }),
      ...(event.content === undefined
        ? {}
        : { content: stripMeta(event.content) }),
      ...(event.locations === undefined
        ? {}
        : { locations: stripMeta(event.locations) }),
      ...(event.rawInput === undefined
        ? {}
        : { rawInput: stripMeta(event.rawInput) }),
      ...(event.rawOutput === undefined
        ? {}
        : { rawOutput: stripMeta(event.rawOutput) }),
    };
    if (event.tag === "tool_call_update") {
      return {
        kind: "tool_call_update",
        toolCallId: event.toolCallId,
        ...(event.title === undefined ? {} : { title: event.title }),
        ...fields,
      };
    }
    return {
      kind: "tool_call",
      toolCallId: event.toolCallId,
      title,
      ...fields,
    };
  }
  const occupancy = terminalOccupancyFromRuntimeEvent(event);
  return occupancy ? { kind: "usage", ...occupancy } : undefined;
}

function normalizedCost(
  value: Extract<AcpRuntimeEvent, { type: "status" }>["cost"],
): AcpTerminalOccupancy["cost"] {
  if (
    !value ||
    typeof value.amount !== "number" ||
    !Number.isFinite(value.amount) ||
    typeof value.currency !== "string" ||
    value.currency.length === 0 ||
    value.currency !== value.currency.trim()
  ) {
    return null;
  }
  return { amount: value.amount, currency: value.currency };
}

function terminalOccupancyFromRuntimeEvent(
  event: AcpRuntimeEvent,
): AcpTerminalOccupancy | null {
  const used = event.type === "status" ? event.used : undefined;
  const size = event.type === "status" ? event.size : undefined;
  if (
    event.type !== "status" ||
    typeof used !== "number" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(used) ||
    !Number.isSafeInteger(size) ||
    used < 0 ||
    size <= 0 ||
    used > size
  ) {
    return null;
  }
  return {
    used,
    size,
    cost: normalizedCost(event.cost),
  };
}

function normalizedStopReason(value: string | undefined): StopReason | undefined {
  return value === "end_turn" ||
    value === "max_tokens" ||
    value === "max_turn_requests" ||
    value === "refusal" ||
    value === "cancelled"
    ? value
    : undefined;
}

function settlementFromRuntimeTurn(input: {
  readonly turnResult: Extract<
    AcpRuntimeTurnResult,
    { status: "completed" } | { status: "cancelled" }
  >;
  readonly terminalOccupancy: AcpTerminalOccupancy | null;
}): AcpPromptSettlement | null {
  const stopReason = normalizedStopReason(input.turnResult.stopReason);
  if (!stopReason || !input.terminalOccupancy) return null;
  return {
    kind: "protocol_settled",
    stopReason,
    occupancy: input.terminalOccupancy,
  };
}

function requestIdFor(input: AcpxOneShotPromptInput): string {
  return input.requestId === undefined
    ? randomUUID()
    : exactString(input.requestId, "ACPX request id");
}

function sessionKeyFor(
  dependencies: AcpxOneShotExecutionDependencies | undefined,
): string {
  return exactString(
    dependencies?.createSessionKey?.() ?? `paperclip-${randomUUID()}`,
    "ACPX temporary session key",
  );
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("ACPX one-shot execution was cancelled");
}

/**
 * Runs a fresh ACPX session with a private on-disk state store that is removed
 * in all outcomes. The invocation, configuration setters, event stream, and
 * lifecycle are all ACPX runtime operations; Paperclip does not resolve or
 * launch an underlying provider CLI itself.
 */
export async function executeAcpxOneShotPrompt(
  input: AcpxOneShotPromptInput,
): Promise<AcpxOneShotPromptResult> {
  const cwd = resolveExecutionCwd(input.cwd);
  const registryCwd = input.registryCwd === undefined
    ? cwd
    : resolveExecutionCwd(input.registryCwd);
  const agentName = exactString(input.agentName, "ACPX agent name");
  const initialWorkMessage = exactPromptMessage(
    input.message,
    "ACPX one-shot prompt message",
  );
  const configSelections = exactConfigSelections(input.configSelections);
  const start = exactSessionStart(input.start);
  const timeoutMs = resolveTimeout(input.timeoutMs);
  const requestId = requestIdFor(input);
  const bootstrapPrompt = input.bootstrapPrompt;
  if (bootstrapPrompt !== undefined && start.kind !== "new") {
    throw new Error("ACPX bootstrap prompt requires a new session");
  }
  const dependencies = input.dependencies;
  const registry = await (dependencies?.loadAgentRegistry ?? loadAcpxAgentRegistry)({
    cwd: registryCwd,
  });
  // ACPX intentionally supports a raw-command fallback. Admit the exact
  // registry name and require local executable evidence before its runtime can
  // reach a materializing package runner. ACPX still owns launch and execution.
  assertAcpRegistryAgentName(agentName, registry);
  if (
    !(await isAcpRegistryAgentLocallyAvailable(agentName, registry, { cwd }))
  ) {
    throw new Error(`ACPX agent is not locally available: ${agentName}`);
  }

  const createTemporaryStateDir =
    dependencies?.createTemporaryStateDir ?? createDefaultTemporaryStateDir;
  const removeTemporaryStateDir =
    dependencies?.removeTemporaryStateDir ?? removeDefaultTemporaryStateDir;
  const stateDir = safeTemporaryStateDir(await createTemporaryStateDir());
  let runtime: AcpxOneShotRuntime | null = null;
  let handle: AcpRuntimeHandle | null = null;
  let activeTurn: AcpRuntimeTurn | null = null;
  let phase: AcpxOneShotExecutionPhase = "session_setup";
  let result: AcpxOneShotPromptResultWithoutCleanup | null = null;
  const cleanupErrors: unknown[] = [];
  let stateRemoved = false;
  let promptTransmitted = false;
  let abortCancellation: Promise<void> | null = null;
  const requestAbortCancellation = (): Promise<void> => {
    if (abortCancellation) return abortCancellation;
    abortCancellation = (async () => {
      if (!runtime || !handle) return;
      if (activeTurn) {
        await activeTurn.cancel({ reason: "Paperclip execution aborted" });
        return;
      }
      await runtime.cancel({
        handle,
        reason: "Paperclip execution aborted",
      });
    })().catch((error: unknown) => {
      cleanupErrors.push(error);
    });
    return abortCancellation;
  };
  const onAbort = () => {
    void requestAbortCancellation();
  };

  try {
    const sessionKey = sessionKeyFor(dependencies);
    runtime = (dependencies?.createAcpRuntime ?? createAcpRuntime)({
      cwd,
      sessionStore: (dependencies?.createRuntimeStore ?? createRuntimeStore)({
        stateDir,
      }),
      agentRegistry: registry,
      mcpServers: input.mcpServers ? [...input.mcpServers] : [],
      permissionMode: input.permissionMode,
      ...(input.nonInteractivePermissions === undefined
        ? {}
        : { nonInteractivePermissions: input.nonInteractivePermissions }),
      ...(input.onPermissionRequest === undefined
        ? {}
        : { onPermissionRequest: input.onPermissionRequest }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    abortIfNeeded(input.signal);
    handle = await runtime.ensureSession({
      sessionKey,
      agent: agentName,
      // Paperclip may send one bootstrap turn before normal work, then deletes
      // this runtime's state directory. ACPX's persistent mode keeps its
      // client alive across setup, configuration, and both turns, preventing
      // an implicit reconnect
      // from replacing the opaque provider backend id before we seal it.
      mode: "persistent",
      cwd,
      ...(start.kind === "resume" ? { resumeSessionId: start.sessionId } : {}),
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();

    phase = "configuration";
    if (configSelections.length > 0 && !runtime.setConfigOption) {
      throw new Error("ACPX runtime does not expose session/set_config_option");
    }
    for (const selection of configSelections) {
      abortIfNeeded(input.signal);
      await runtime.setConfigOption?.({
        handle,
        key: selection.configId,
        value: selection.value,
      });
    }

    // ACPX may update its active backend session while applying configuration.
    // Read the status only after every selection and prefer that current id to
    // the initial handle before Paperclip activates its durable prompt fence.
    const status = await runtime.getStatus({ handle });
    const sessionId = durableBackendSessionId(status) ?? durableBackendSessionId(handle);
    if (!sessionId) {
      throw new Error("ACPX session did not return a durable backend session id");
    }

    phase = "prompt_activation";
    abortIfNeeded(input.signal);
    await input.activatePrompt?.({ sessionId });

    if (bootstrapPrompt) {
      phase = "prompt_transmission";
      abortIfNeeded(input.signal);
      const bootstrapTurn = runtime.startTurn({
        handle,
        text: exactPromptMessage(
          bootstrapPrompt.message,
          "ACPX one-shot bootstrap message",
        ),
        mode: "prompt",
        requestId: `${requestId}:bootstrap`,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      activeTurn = bootstrapTurn;
      phase = "prompt";
      const bootstrapResultPromise = bootstrapTurn.result;
      void bootstrapResultPromise.catch(() => {});
      try {
        for await (const _event of bootstrapTurn.events) {
          // Bootstrap output is internal; the stable work event stream begins
          // only after the canonical work prompt is sent.
        }
      } catch (cause) {
        await bootstrapTurn.cancel({ reason: "Paperclip bootstrap failed" }).catch(
          (cancelError: unknown) => cleanupErrors.push(cancelError),
        );
        throw cause;
      } finally {
        if (activeTurn === bootstrapTurn) activeTurn = null;
      }
      const bootstrapResult = await bootstrapResultPromise;
      if (bootstrapResult.status === "failed") {
        result = { kind: "failed", sessionId, turnResult: bootstrapResult };
      } else if (bootstrapResult.status === "cancelled") {
        result = {
          kind: "cancelled",
          sessionId,
          turnResult: bootstrapResult,
          settlement: null,
        };
      }
    }

    if (result === null) {
      phase = "prompt_transmission";
      abortIfNeeded(input.signal);
      await input.beginPromptTransmission?.({ sessionId });
      promptTransmitted = true;

      abortIfNeeded(input.signal);
      activeTurn = runtime.startTurn({
        handle,
        text: initialWorkMessage,
        mode: "prompt",
        requestId,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      phase = "prompt";
      // A callback failure causes a cooperative cancellation. Attach a rejection
      // handler immediately so a provider failure cannot become an unhandled
      // promise while cleanup closes the temporary runtime.
      const turnResultPromise = activeTurn.result;
      void turnResultPromise.catch(() => {});
      let terminalOccupancy: AcpTerminalOccupancy | null = null;
      try {
        for await (const runtimeEvent of activeTurn.events) {
          terminalOccupancy = terminalOccupancyFromRuntimeEvent(runtimeEvent);
          await input.onRuntimeEvent?.(runtimeEvent);
          const event = normalizedRuntimeEvent(runtimeEvent);
          if (event) await input.onSessionEvent?.(event);
        }
      } catch (cause) {
        await activeTurn.cancel({ reason: "Paperclip event projection failed" }).catch(
          (cancelError: unknown) => cleanupErrors.push(cancelError),
        );
        throw cause;
      }
      const turnResult = await turnResultPromise;
      if (turnResult.status === "failed") {
        result = { kind: "failed", sessionId, turnResult };
      } else if (turnResult.status === "cancelled") {
        result = {
          kind: "cancelled",
          sessionId,
          turnResult,
          settlement: settlementFromRuntimeTurn({ turnResult, terminalOccupancy }),
        };
      } else {
        result = {
          kind: "completed",
          sessionId,
          turnResult,
          settlement: settlementFromRuntimeTurn({ turnResult, terminalOccupancy }),
        };
      }
    }
  } catch (cause) {
    result = {
      kind: "error",
      phase,
      sessionId: handle ? durableBackendSessionId(handle) : null,
      promptTransmitted,
      cause,
    };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await abortCancellation;
    if (handle && runtime) {
      try {
        // `discardPersistentState: true` tells ACPX to issue provider
        // session/close. Paperclip deliberately retains only the opaque
        // backend session id for an eligible future resume, so release the
        // local ACPX record without closing that provider-owned session.
        // The temporary ACPX store is removed immediately below.
        await runtime.close({
          handle,
          reason: "Paperclip one-shot execution release",
          discardPersistentState: false,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await removeTemporaryStateDir(stateDir);
      stateRemoved = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  const cleanup: AcpxOneShotCleanup = {
    stateRemoved,
    errors: Object.freeze([...cleanupErrors]),
  };
  if (!result) {
    return {
      kind: "error",
      phase,
      sessionId: handle ? durableBackendSessionId(handle) : null,
      promptTransmitted,
      cause: new Error("ACPX one-shot execution produced no result"),
      cleanup,
    };
  }
  return { ...result, cleanup };
}
