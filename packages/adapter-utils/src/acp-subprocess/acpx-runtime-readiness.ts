import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeCapabilities,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpSessionStore,
} from "acpx/runtime";
import { loadConfiguredAcpRegistry } from "./agent-registry.js";
import type { AcpSessionConfigSelection } from "./contract.js";

const TEMPORARY_STATE_DIRECTORY_PREFIX = "paperclip-acpx-readiness-";
const DEFAULT_ACPX_READINESS_TIMEOUT_MS = 15_000;

/** ACPX's public local runtime surface used by the disposable readiness probe. */
export type AcpxRuntimeReadinessRuntime = Pick<
  AcpRuntime,
  "ensureSession" | "close"
> & {
  readonly getCapabilities?: AcpRuntime["getCapabilities"];
  readonly getStatus?: AcpRuntime["getStatus"];
  readonly setConfigOption?: AcpRuntime["setConfigOption"];
};

export interface AcpxRuntimeReadinessProbeDependencies {
  /** Defaults to ACPX's resolved global and project configuration. */
  readonly loadAgentRegistry?: (input: {
    readonly cwd: string;
  }) => Promise<AcpAgentRegistry>;
  readonly createAcpRuntime?: (
    options: AcpRuntimeOptions,
  ) => AcpxRuntimeReadinessRuntime;
  readonly createRuntimeStore?: (options: {
    readonly stateDir: string;
  }) => AcpSessionStore;
  /** Test seams for the private, disposable ACPX state directory. */
  readonly createTemporaryStateDir?: () => Promise<string>;
  readonly removeTemporaryStateDir?: (stateDir: string) => Promise<void>;
  readonly createSessionKey?: () => string;
}

export interface AcpxRuntimeReadinessProbeInput {
  /** Local workspace used by ACPX's disposable agent session. */
  readonly cwd: string;
  /**
   * Optional Paperclip ACPX configuration scope. Supplying this keeps ACPX
   * registry resolution independent from the per-run execution workspace.
   */
  readonly registryCwd?: string;
  /** Must exactly match an ACPX registry name listed at this cwd. */
  readonly agentName: string;
  /** Immutable generic selections previously supplied by ACPX discovery. */
  readonly configSelections: readonly AcpSessionConfigSelection[];
  readonly timeoutMs?: number;
  readonly dependencies?: AcpxRuntimeReadinessProbeDependencies;
}

export interface AcpxRuntimeReadinessProbeResult {
  /** Exact public ACPX controls observed for this disposable probe. */
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

/**
 * ACPX state cleanup failed. `operationError` retains any setup failure, but
 * callers should surface cleanup failure because the disposable-state promise
 * could not be proven.
 */
export class AcpxRuntimeReadinessCleanupError extends Error {
  readonly operationError: unknown | undefined;
  readonly cleanupErrors: readonly unknown[];

  constructor(input: {
    readonly operationError?: unknown;
    readonly cleanupErrors: readonly unknown[];
  }) {
    super("ACPX readiness cleanup failed");
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

function resolveCwd(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("ACPX readiness cwd is required");
  }
  return value;
}

function resolveAgentName(value: string): string {
  const agentName = exactString(value);
  if (!agentName) {
    throw new Error("ACPX readiness agent name must be exact and non-empty");
  }
  return agentName;
}

function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ACPX_READINESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("ACPX readiness timeout must be a positive integer");
  }
  return value;
}

/**
 * ACPX permits a raw-command convenience fallback for an unknown input. Do
 * not invoke it: Paperclip accepts only the exact dynamic registry names ACPX
 * lists in this workspace.
 */
function assertRegistryListedAgent(
  registry: AcpAgentRegistry,
  agentName: string,
): void {
  const names = registry.list();
  if (
    !Array.isArray(names) ||
    names.some((name) => exactString(name) === null) ||
    !names.includes(agentName)
  ) {
    throw new Error(`ACPX agent is not registry-listed: ${agentName}`);
  }
}

function selectionRuntimeValue(value: AcpSessionConfigSelection["value"]): string {
  // ACPX's public setter accepts strings. Stringification preserves the
  // generic persisted boolean while deliberately avoiding provider mappings.
  return typeof value === "boolean" ? String(value) : value;
}

function supportsControl(
  capabilities: AcpRuntimeCapabilities,
  control: AcpRuntimeCapabilities["controls"][number],
): boolean {
  return capabilities.controls.includes(control);
}

function assertRuntimeCapabilities(input: {
  readonly capabilities: AcpRuntimeCapabilities;
  readonly configSelections: readonly AcpSessionConfigSelection[];
  readonly runtime: AcpxRuntimeReadinessRuntime;
}): void {
  if (!supportsControl(input.capabilities, "session/status")) {
    throw new AcpxRuntimeReadinessCapabilityError(
      "ACPX runtime does not advertise session/status",
    );
  }
  if (
    input.configSelections.length > 0 &&
    (!supportsControl(input.capabilities, "session/set_config_option") ||
      !input.runtime.setConfigOption)
  ) {
    throw new AcpxRuntimeReadinessCapabilityError(
      "ACPX runtime cannot apply persisted session configuration",
    );
  }
  const advertisedKeys = input.capabilities.configOptionKeys;
  if (!advertisedKeys) return;
  const keys = new Set(advertisedKeys);
  for (const selection of input.configSelections) {
    if (!keys.has(selection.configId)) {
      throw new AcpxRuntimeReadinessCapabilityError(
        `ACPX runtime no longer advertises persisted configuration ${selection.configId}`,
      );
    }
  }
}

async function createDefaultTemporaryStateDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), TEMPORARY_STATE_DIRECTORY_PREFIX));
}

async function removeDefaultTemporaryStateDir(stateDir: string): Promise<void> {
  await rm(stateDir, { recursive: true, force: true });
}

/**
 * Opens a no-prompt disposable ACPX session using only ACPX's public runtime,
 * checks its generic controls/status, applies immutable generic selections,
 * then removes all ACPX runtime state. It never reads a provider config file,
 * launches a raw ACP subprocess, or accepts a Paperclip-owned agent catalog.
 */
export async function probeAcpxRuntimeReadiness(
  input: AcpxRuntimeReadinessProbeInput,
): Promise<AcpxRuntimeReadinessProbeResult> {
  const cwd = resolveCwd(input.cwd);
  const registryCwd = input.registryCwd === undefined
    ? cwd
    : resolveCwd(input.registryCwd);
  const agentName = resolveAgentName(input.agentName);
  const timeoutMs = resolveTimeoutMs(input.timeoutMs);
  const dependencies = input.dependencies;
  const stateDir = await (
    dependencies?.createTemporaryStateDir ?? createDefaultTemporaryStateDir
  )();
  const removeTemporaryStateDir =
    dependencies?.removeTemporaryStateDir ?? removeDefaultTemporaryStateDir;
  let runtime: AcpxRuntimeReadinessRuntime | undefined;
  let handle: AcpRuntimeHandle | undefined;
  let result: AcpxRuntimeReadinessProbeResult | undefined;
  let operationError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    const registry = await (
      dependencies?.loadAgentRegistry ??
      (({ cwd }: { readonly cwd: string }) => loadConfiguredAcpRegistry({ cwd }))
    )({ cwd: registryCwd });
    assertRegistryListedAgent(registry, agentName);
    const sessionStore = (dependencies?.createRuntimeStore ?? createRuntimeStore)(
      { stateDir },
    );
    runtime = (dependencies?.createAcpRuntime ?? createAcpRuntime)({
      cwd,
      sessionStore,
      agentRegistry: registry,
      mcpServers: [],
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
      timeoutMs,
    });
    handle = await runtime.ensureSession({
      sessionKey:
        dependencies?.createSessionKey?.() ??
        `acpx-readiness-${randomUUID()}`,
      agent: agentName,
      // Keep ACPX's client alive while applying configuration. The surrounding
      // probe remains disposable: it sends no prompt, explicitly closes the
      // probe backend, then deletes its local ACPX state directory.
      mode: "persistent",
      cwd,
    });
    if (!runtime.getCapabilities || !runtime.getStatus) {
      throw new AcpxRuntimeReadinessCapabilityError(
        "ACPX runtime does not expose readiness controls",
      );
    }
    const capabilities = await runtime.getCapabilities({ handle });
    assertRuntimeCapabilities({
      capabilities,
      configSelections: input.configSelections,
      runtime,
    });
    for (const selection of input.configSelections) {
      // `assertRuntimeCapabilities` proved this method exists whenever the
      // selections are nonempty.
      await runtime.setConfigOption!({
        handle,
        key: selection.configId,
        value: selectionRuntimeValue(selection.value),
      });
    }
    const status = await runtime.getStatus({ handle });
    result = Object.freeze({ capabilities, status });
  } catch (error) {
    operationError = error;
  }

  if (runtime && handle) {
    try {
      await runtime.close({
        handle,
        reason: "temporary ACPX readiness session",
        discardPersistentState: true,
      });
    } catch (discardError) {
      try {
        await runtime.close({
          handle,
          reason: "temporary ACPX readiness session",
          discardPersistentState: false,
        });
      } catch (closeError) {
        // Some ACPX frontends do not implement backend session close. A
        // successful non-discarding close still releases the disposable
        // runtime record before the state directory is removed, so only a
        // failure of both operations is an incomplete cleanup.
        cleanupErrors.push(
          new AggregateError(
            [discardError, closeError],
            "ACPX readiness session close failed",
          ),
        );
      }
    }
  }
  try {
    await removeTemporaryStateDir(stateDir);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length > 0) {
    throw new AcpxRuntimeReadinessCleanupError({
      ...(operationError === undefined ? {} : { operationError }),
      cleanupErrors,
    });
  }
  if (operationError !== undefined) throw operationError;
  if (!result) throw new Error("ACPX readiness returned no result");
  return result;
}
