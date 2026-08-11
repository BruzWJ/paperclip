import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpRuntimeTurnResult,
} from "acpx/runtime";
import {
  assertAcpRegistryAgentName,
  isAcpRegistryAgentLocallyAvailable,
  loadAcpxAgentRegistry,
} from "./agent-registry.js";
import type {
  AcpPromptSettlement,
  AcpSessionConfigSelection,
  AcpSessionStart,
  AcpTerminalOccupancy,
} from "./contract.js";
import type { NormalizedAcpSessionEvent } from "./events.js";
import {
  createTemporarySessionKey,
  createTemporaryStateDir,
  removeTemporaryStateDir,
} from "./temporary-state.js";

const TEMPORARY_STATE_DIRECTORY_PREFIX = "paperclip-acpx-one-shot-";

/**
 * Exact ACPX runtime surface used by Paperclip's disposable runner.
 */
type AcpxOneShotRuntime = Pick<
  AcpRuntime,
  | "ensureSession"
  | "startTurn"
  | "setConfigOption"
  | "close"
> & {
  /** Required to seal the current ACPX backend id after configuration. */
  readonly getStatus: NonNullable<AcpRuntime["getStatus"]>;
};

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
  readonly start: AcpSessionStart;
  /** One ordinary Paperclip run message. */
  readonly message: string;
  /** Immutable selections supplied by ACPX's own discovery contract. */
  readonly configSelections: readonly AcpSessionConfigSelection[];
  readonly permissionMode: AcpRuntimeOptions["permissionMode"];
  readonly nonInteractivePermissions?: AcpRuntimeOptions["nonInteractivePermissions"];
  readonly mcpServers?: readonly NonNullable<
    AcpRuntimeOptions["mcpServers"]
  >[number][];
  readonly onPermissionRequest?: AcpRuntimeOptions["onPermissionRequest"];
  /** Finite Paperclip execution deadline applied once to the ACPX runtime. */
  readonly timeoutMs: number;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
  /** Receives only ACPX events that map exactly to Paperclip's stable stream. */
  readonly onSessionEvent: (
    event: NormalizedAcpSessionEvent,
  ) => Promise<void> | void;
  /** Activates Paperclip's durable execution authority after ACPX configuration. */
  readonly activatePrompt: (input: {
    readonly sessionId: string;
  }) => Promise<void>;
  /** Records the durable transmission fence immediately before the turn. */
  readonly beginPromptTransmission: (input: {
    readonly sessionId: string;
  }) => Promise<void>;
}

type AcpxOneShotExecutionPhase =
  | "session_setup"
  | "configuration"
  | "prompt_activation"
  | "prompt_transmission"
  | "prompt";

export type AcpxOneShotPromptResult =
  | {
      readonly kind: "completed";
      readonly sessionId: string;
      readonly settlement: AcpPromptSettlement;
    }
  | {
      readonly kind: "cancelled";
      readonly sessionId: string;
      /** Present only when ACPX supplied an exact stop reason and occupancy. */
      readonly settlement: AcpPromptSettlement | null;
    }
  | {
      readonly kind: "error";
      readonly phase: AcpxOneShotExecutionPhase;
      /** True only after the prompt crossed its durable transmission fence. */
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

function resolveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("ACPX one-shot execution timeout must be a positive integer");
  }
  return value;
}

function exactConfigSelections(
  selections: readonly AcpSessionConfigSelection[],
): readonly Readonly<{ configId: string; value: string }>[] {
  const ids = new Set<string>();
  return Object.freeze(
    selections.map((selection) => {
      const configId = exactString(selection.configId, "ACPX config id");
      const value = exactString(
        typeof selection.value === "boolean"
          ? String(selection.value)
          : selection.value,
        `ACPX config ${configId} value`,
      );
      if (ids.has(configId)) {
        throw new Error(`ACPX config id is duplicated: ${configId}`);
      }
      ids.add(configId);
      return Object.freeze({ configId, value });
    }),
  );
}

function exactSessionStart(
  start: AcpSessionStart,
): AcpSessionStart {
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
  value: Pick<AcpRuntimeStatus, "backendSessionId">,
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

type NormalizedToolCallStatus = NonNullable<
  Extract<NormalizedAcpSessionEvent, { kind: "tool_call" }>["status"]
>;

function normalizedToolCallStatus(
  value: string | undefined,
): NormalizedToolCallStatus | undefined {
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
  return undefined;
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

function normalizedStopReason(
  value: string | undefined,
): AcpPromptSettlement["stopReason"] | undefined {
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

function sessionKeyFor(): string {
  return exactString(createTemporarySessionKey("paperclip-"), "ACPX temporary session key");
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
  const message = exactPromptMessage(
    input.message,
    "ACPX one-shot prompt message",
  );
  const configSelections = exactConfigSelections(input.configSelections);
  const start = exactSessionStart(input.start);
  const timeoutMs = resolveTimeout(input.timeoutMs);
  const requestId = requestIdFor(input);
  const registry = await loadAcpxAgentRegistry(registryCwd);
  // Admit ACPX's exact resolved registry name only after local executable
  // evidence prevents a materializing package runner. ACPX owns the launch.
  assertAcpRegistryAgentName(agentName, registry);
  if (
    !(await isAcpRegistryAgentLocallyAvailable(agentName, registry, { cwd }))
  ) {
    throw new Error(`ACPX agent is not locally available: ${agentName}`);
  }

  const stateDir = safeTemporaryStateDir(
    await createTemporaryStateDir(TEMPORARY_STATE_DIRECTORY_PREFIX),
  );
  let runtime: AcpxOneShotRuntime | null = null;
  let handle: AcpRuntimeHandle | null = null;
  let phase: AcpxOneShotExecutionPhase = "session_setup";
  let result: AcpxOneShotPromptResult | null = null;
  const cleanupErrors: unknown[] = [];
  let promptTransmitted = false;
  try {
    const sessionKey = sessionKeyFor();
    runtime = createAcpRuntime({
      cwd,
      sessionStore: createRuntimeStore({
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
      timeoutMs,
    });
    abortIfNeeded(input.signal);
    handle = await runtime.ensureSession({
      sessionKey,
      agent: agentName,
      // Paperclip sends one turn, then deletes this runtime's state directory.
      // ACPX's persistent mode keeps its client alive across setup,
      // configuration, and the turn, preventing an implicit reconnect
      // from replacing the opaque provider backend id before we seal it.
      mode: "persistent",
      cwd,
      ...(start.kind === "resume" ? { resumeSessionId: start.sessionId } : {}),
    });
    phase = "configuration";
    if (configSelections.length > 0) {
      if (!runtime.setConfigOption) {
        throw new Error("ACPX runtime does not expose session/set_config_option");
      }
      const setConfigOption = runtime.setConfigOption.bind(runtime);
      for (const selection of configSelections) {
        abortIfNeeded(input.signal);
        await setConfigOption({
          handle,
          key: selection.configId,
          value: selection.value,
        });
      }
    }

    // ACPX may update its active backend session while applying configuration,
    // so only the post-configuration status can supply the sealed id.
    const status = await runtime.getStatus({ handle });
    const sessionId = durableBackendSessionId(status);
    if (!sessionId) {
      throw new Error("ACPX session did not return a durable backend session id");
    }

    phase = "prompt_activation";
    abortIfNeeded(input.signal);
    await input.activatePrompt({ sessionId });

    phase = "prompt_transmission";
    abortIfNeeded(input.signal);
    await input.beginPromptTransmission({ sessionId });
    promptTransmitted = true;

    abortIfNeeded(input.signal);
    const activeTurn = runtime.startTurn({
      handle,
      text: message,
      mode: "prompt",
      requestId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    phase = "prompt";
    // A projection failure exits to the single runtime.close cancellation and
    // cleanup boundary. Attach a rejection handler immediately so a provider
    // failure cannot become unhandled while that boundary settles.
    const turnResultPromise = activeTurn.result;
    void turnResultPromise.catch(() => {});
    let terminalOccupancy: AcpTerminalOccupancy | null = null;
    // ACPX text_delta events are append-only fragments. Cross the durable
    // Session boundary once per contiguous text/reasoning block, not per token.
    const pendingText: {
      channel: "assistant" | "thought" | null;
      fragments: string[];
    } = { channel: null, fragments: [] };
    const flushPendingText = async () => {
      const channel = pendingText.channel;
      if (channel === null) return;
      const text = pendingText.fragments.join("");
      pendingText.channel = null;
      pendingText.fragments = [];
      await input.onSessionEvent({
        kind: "message_chunk",
        channel,
        content: { type: "text", text },
      });
    };
    for await (const runtimeEvent of activeTurn.events) {
      terminalOccupancy =
        terminalOccupancyFromRuntimeEvent(runtimeEvent) ?? terminalOccupancy;
      const event = normalizedRuntimeEvent(runtimeEvent);
      if (!event) continue;
      if (event.kind === "message_chunk" && event.content.type === "text") {
        if (pendingText.channel !== event.channel) {
          await flushPendingText();
          pendingText.channel = event.channel;
        }
        pendingText.fragments.push(event.content.text);
        continue;
      }
      await flushPendingText();
      await input.onSessionEvent(event);
    }
    await flushPendingText();
    const turnResult = await turnResultPromise;
    if (turnResult.status === "failed") {
      result = {
        kind: "error",
        phase: "prompt",
        promptTransmitted,
        cause: turnResult.error,
      };
    } else {
      const settlement = settlementFromRuntimeTurn({
        turnResult,
        terminalOccupancy,
      });
      if (
        turnResult.status === "completed" &&
        settlement &&
        settlement.stopReason !== "cancelled"
      ) {
        result = { kind: "completed", sessionId, settlement };
      } else if (
        turnResult.status === "cancelled" &&
        (!settlement || settlement.stopReason === "cancelled")
      ) {
        result = { kind: "cancelled", sessionId, settlement };
      } else {
        result = {
          kind: "error",
          phase: "prompt",
          promptTransmitted,
          cause: new Error(
            turnResult.status === "cancelled"
              ? "ACPX cancelled turn returned a non-cancelled stop reason"
              : settlement
                ? "ACPX completed turn returned a cancelled stop reason"
                : "ACPX prompt ended without an exact terminal stop reason and usage occupancy",
          ),
        };
      }
    }
  } catch (cause) {
    result = {
      kind: "error",
      phase,
      promptTransmitted,
      cause,
    };
  } finally {
    if (handle && runtime) {
      try {
        // Paperclip deliberately retains only the opaque backend session id
        // for an eligible future resume. `discardPersistentState: false`
        // releases the local runtime without closing that provider-owned
        // session; the temporary ACPX store is removed immediately below.
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
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    const failures = [
      result?.kind === "error" ? result.cause : null,
      ...cleanupErrors,
    ].filter((failure) => failure !== null);
    return {
      kind: "error",
      phase: promptTransmitted
        ? "prompt"
        : result?.kind === "error"
          ? result.phase
          : phase,
      promptTransmitted,
      cause: failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            "ACPX one-shot runtime cleanup did not complete",
          ),
    };
  }
  return result ?? {
    kind: "error",
    phase,
    promptTransmitted,
    cause: new Error("ACPX one-shot execution produced no result"),
  };
}
