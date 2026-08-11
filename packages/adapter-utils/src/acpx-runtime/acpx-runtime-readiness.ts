import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpRuntime,
  type AcpRuntimeCapabilities,
  type AcpRuntimeHandle,
  type AcpRuntimeStatus,
} from "acpx/runtime";
import {
  assertAcpRegistryAgentName,
  isAcpRegistryAgentLocallyAvailable,
  loadAcpxAgentRegistry,
} from "./agent-registry.js";
import type { AcpSessionConfigSelection } from "./contract.js";
import {
  createTemporarySessionKey,
  createTemporaryStateDir,
  removeTemporaryStateDir,
} from "./temporary-state.js";

const TEMPORARY_STATE_DIRECTORY_PREFIX = "paperclip-acpx-probe-";
const DEFAULT_ACPX_PROBE_TIMEOUT_MS = 15_000;

type DisposableAcpxRuntime = Pick<
  AcpRuntime,
  | "doctor"
  | "ensureSession"
  | "getCapabilities"
  | "getStatus"
  | "setConfigOption"
  | "close"
>;

interface DisposableAcpxProbeInput {
  readonly cwd: string;
  readonly registryCwd?: string;
  readonly agentName: string;
  readonly configSelections: readonly AcpSessionConfigSelection[];
  readonly timeoutMs?: number;
}

interface DisposableAcpxProbeResult {
  readonly capabilities: AcpRuntimeCapabilities;
  readonly status: AcpRuntimeStatus;
}

/** The runtime lacked a generic public capability Paperclip needs. */
export class AcpxRuntimeReadinessCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpxRuntimeReadinessCapabilityError";
  }
}

/** A disposable ACPX session or its temporary state could not be discarded. */
export class AcpxRuntimeReadinessCleanupError extends Error {
  readonly operationError: unknown | undefined;
  readonly cleanupErrors: readonly unknown[];

  constructor(input: {
    readonly operationError?: unknown;
    readonly cleanupErrors: readonly unknown[];
  }) {
    super("ACPX disposable probe cleanup failed");
    this.name = "AcpxRuntimeReadinessCleanupError";
    this.operationError = input.operationError;
    this.cleanupErrors = Object.freeze([...input.cleanupErrors]);
  }
}

function exactString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : null;
}

function exactCwd(value: string, label: string): string {
  const cwd = exactString(value);
  if (!cwd) throw new Error(`${label} must be exact and non-empty`);
  return cwd;
}

function probeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ACPX_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("ACPX probe timeout must be a positive integer");
  }
  return value;
}

function runtimeValue(value: AcpSessionConfigSelection["value"]): string {
  return typeof value === "boolean" ? String(value) : value;
}

function assertCapabilities(input: {
  readonly capabilities: AcpRuntimeCapabilities;
  readonly selections: readonly AcpSessionConfigSelection[];
  readonly runtime: DisposableAcpxRuntime;
}): void {
  if (!input.capabilities.controls.includes("session/status")) {
    throw new AcpxRuntimeReadinessCapabilityError(
      "ACPX runtime does not advertise session/status",
    );
  }
  if (
    input.selections.length > 0 &&
    (!input.capabilities.controls.includes("session/set_config_option") ||
      !input.runtime.setConfigOption)
  ) {
    throw new AcpxRuntimeReadinessCapabilityError(
      "ACPX runtime cannot apply persisted session configuration",
    );
  }
  if (!input.capabilities.configOptionKeys) return;
  const keys = new Set(input.capabilities.configOptionKeys);
  for (const selection of input.selections) {
    if (!keys.has(selection.configId)) {
      throw new AcpxRuntimeReadinessCapabilityError(
        `ACPX runtime no longer advertises persisted configuration ${selection.configId}`,
      );
    }
  }
}

/**
 * Sole disposable no-prompt ACPX probe lifecycle. Discovery and persisted
 * readiness project this observation; neither owns a runtime or session.
 * @internal
 */
export async function probeAcpxRuntimeReadiness(
  input: DisposableAcpxProbeInput,
): Promise<DisposableAcpxProbeResult> {
  const cwd = exactCwd(input.cwd, "ACPX probe cwd");
  const registryCwd = input.registryCwd === undefined
    ? cwd
    : exactCwd(input.registryCwd, "ACPX probe registry cwd");
  const timeoutMs = probeTimeout(input.timeoutMs);
  const registry = await loadAcpxAgentRegistry(registryCwd);
  const agentName = assertAcpRegistryAgentName(input.agentName, registry);
  if (!(await isAcpRegistryAgentLocallyAvailable(agentName, registry, { cwd }))) {
    throw new Error(`ACPX agent is not locally available: ${agentName}`);
  }

  const stateDir = await createTemporaryStateDir(
    TEMPORARY_STATE_DIRECTORY_PREFIX,
  );
  let runtime: DisposableAcpxRuntime | undefined;
  let handle: AcpRuntimeHandle | undefined;
  let result: DisposableAcpxProbeResult | undefined;
  let operationFailure: { readonly error: unknown } | null = null;

  try {
    runtime = createAcpRuntime({
      cwd,
      sessionStore: createRuntimeStore({ stateDir }),
      agentRegistry: registry,
      probeAgent: agentName,
      mcpServers: [],
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
      timeoutMs,
    });
    if (runtime.doctor && !(await runtime.doctor()).ok) {
      throw new Error("ACPX frontend availability probe failed");
    }
    handle = await runtime.ensureSession({
      sessionKey: createTemporarySessionKey("acpx-probe-"),
      agent: agentName,
      mode: "persistent",
      cwd,
    });
    if (!runtime.getCapabilities || !runtime.getStatus) {
      throw new AcpxRuntimeReadinessCapabilityError(
        "ACPX runtime does not expose probe controls",
      );
    }
    const capabilities = await runtime.getCapabilities({ handle });
    assertCapabilities({
      capabilities,
      selections: input.configSelections,
      runtime,
    });
    for (const selection of input.configSelections) {
      await runtime.setConfigOption!({
        handle,
        key: selection.configId,
        value: runtimeValue(selection.value),
      });
    }
    const status = await runtime.getStatus({ handle });
    result = Object.freeze({ capabilities, status });
  } catch (error) {
    operationFailure = { error };
  }

  const cleanupErrors: unknown[] = [];
  if (runtime && handle) {
    try {
      await runtime.close({
        handle,
        reason: "temporary ACPX probe session",
        discardPersistentState: true,
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

  if (cleanupErrors.length > 0) {
    throw new AcpxRuntimeReadinessCleanupError({
      ...(operationFailure ? { operationError: operationFailure.error } : {}),
      cleanupErrors,
    });
  }
  if (operationFailure) throw operationFailure.error;
  if (!result) throw new Error("ACPX disposable probe returned no result");
  return result;
}
