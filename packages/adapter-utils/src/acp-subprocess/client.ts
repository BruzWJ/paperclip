import path from "node:path";
import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  type CancelNotification,
  type ClientApp,
  type ClientConnection,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk";
import type {
  AcpPromptSettlement,
  AcpPromptRequest,
  AcpSessionConfigSelection,
  AcpSessionConfigValue,
  AcpSubprocessLaunch,
} from "./contract.js";
import { ACP_STABLE_WIRE_VERSION } from "./contract.js";
import {
  normalizeAcpSessionUpdate,
  type NormalizedAcpSessionEvent,
} from "./events.js";
import {
  type AcpSubprocess,
  type AcpSubprocessExit,
  type AcpSubprocessStartOptions,
} from "./process.js";

export const ACP_TARGET_NOT_FOUND_ERROR_CODE = -32002 as const;
export const ACP_AUTHENTICATION_REQUIRED_ERROR_CODE = -32000 as const;
const DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS = 5_000;

export type AcpInitializationCapabilityFailure =
  | "protocol_version_mismatch"
  | "session_resume_unavailable";

/** Typed, provider-neutral initialize incompatibility for readiness callers. */
export class AcpInitializationCapabilityError extends Error {
  readonly code = "acp_initialization_capability_incompatible" as const;

  constructor(
    readonly failure: AcpInitializationCapabilityFailure,
    message: string,
  ) {
    super(message);
    this.name = "AcpInitializationCapabilityError";
  }
}

export function isAcpInitializationCapabilityError(
  error: unknown,
): error is AcpInitializationCapabilityError {
  return error instanceof AcpInitializationCapabilityError;
}

export interface PaperclipAcpClientOperations {
  readonly requestPermission?: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
}

export interface PaperclipAcpClientHooks {
  readonly onSessionEvent: (
    event: NormalizedAcpSessionEvent,
    notification: SessionNotification,
  ) => Promise<void> | void;
  readonly onProtocolViolation?: (error: Error) => Promise<void> | void;
}

type ClientState =
  | "created"
  | "initializing"
  | "initialized"
  | "session_setup"
  | "session_ready"
  | "prompt_active"
  | "terminal"
  | "closed";

function exactAbsolutePaths(values: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  return values.map((value, index) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value !== value.trim() ||
      !path.isAbsolute(value) ||
      seen.has(value)
    ) {
      throw new Error(`${label}[${index}] must be a unique exact absolute path`);
    }
    seen.add(value);
    return value;
  });
}

function sortedConfigOptions(
  values: readonly AcpSessionConfigSelection[],
): readonly AcpSessionConfigSelection[] {
  if (values.length === 0) {
    throw new Error("ACP session config selections must be non-empty");
  }
  const sorted = [...values].sort((left, right) =>
    left.configId < right.configId
      ? -1
      : left.configId > right.configId
        ? 1
        : 0,
  );
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    if (
      current.configId.length === 0 ||
      current.configId !== current.configId.trim() ||
      (index > 0 && sorted[index - 1]!.configId === current.configId)
    ) {
      throw new Error("ACP config option ids must be exact and unique");
    }
    if (
      typeof current.value === "string" &&
      current.value.length === 0
    ) {
      throw new Error(`ACP config option ${current.configId} is invalid`);
    }
  }
  return sorted;
}

function exactSelectableValues(option: SessionConfigOption): ReadonlySet<string> {
  if (option.type !== "select") return new Set();
  const values = new Set<string>();
  for (const candidate of option.options) {
    const entries = "group" in candidate ? candidate.options : [candidate];
    for (const entry of entries) {
      if (
        entry.value.length === 0 ||
        values.has(entry.value)
      ) {
        throw new Error(`ACP config option ${option.id} has invalid values`);
      }
      values.add(entry.value);
    }
  }
  if (values.size === 0 || !values.has(option.currentValue)) {
    throw new Error(`ACP config option ${option.id} has invalid current state`);
  }
  return values;
}

interface AcpSessionConfigOptionSnapshot {
  readonly type: SessionConfigOption["type"];
  readonly currentValue: AcpSessionConfigValue;
  readonly selectableValues: ReadonlySet<string>;
}

type AcpSessionConfigSnapshot = ReadonlyMap<
  string,
  AcpSessionConfigOptionSnapshot
>;

function readConfigOptions(
  options: readonly SessionConfigOption[] | null | undefined,
): AcpSessionConfigSnapshot {
  if (!options) {
    throw new Error("ACP frontend omitted required session config options");
  }
  const advertised = new Map<string, AcpSessionConfigOptionSnapshot>();
  for (const option of options) {
    if (
      option.id.length === 0 ||
      option.id !== option.id.trim() ||
      advertised.has(option.id)
    ) {
      throw new Error("ACP frontend advertised invalid session config ids");
    }
    advertised.set(option.id, {
      type: option.type,
      currentValue: option.currentValue,
      selectableValues: exactSelectableValues(option),
    });
  }
  return advertised;
}

function sameExactValues(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function validateConfigOptions(
  options: readonly SessionConfigOption[] | null | undefined,
  requested: readonly AcpSessionConfigSelection[],
  appliedCount: number,
  initial?: AcpSessionConfigSnapshot,
): AcpSessionConfigSnapshot {
  const advertised = readConfigOptions(options);
  const baseline = initial ?? advertised;
  if (advertised.size !== baseline.size) {
    throw new Error("ACP frontend changed its advertised config option set");
  }
  for (const [configId, baselineOption] of baseline) {
    const option = advertised.get(configId);
    if (!option) {
      throw new Error("ACP frontend changed its advertised config option set");
    }
    if (
      option.type !== baselineOption.type ||
      !sameExactValues(
        option.selectableValues,
        baselineOption.selectableValues,
      )
    ) {
      throw new Error(
        `ACP frontend changed config option ${configId}'s type or legal values`,
      );
    }
    const selectionIndex = requested.findIndex(
      (selection) => selection.configId === configId,
    );
    const expectedCurrentValue =
      selectionIndex >= 0 && selectionIndex < appliedCount
        ? requested[selectionIndex]!.value
        : baselineOption.currentValue;
    if (option.currentValue !== expectedCurrentValue) {
      throw new Error(
        `ACP config option ${configId} changed outside the requested sequence`,
      );
    }
  }

  requested.forEach((selection) => {
    const option = advertised.get(selection.configId);
    if (!option) {
      throw new Error(
        `ACP frontend did not advertise config option ${selection.configId}`,
      );
    }
    if (typeof selection.value === "boolean") {
      if (option.type !== "boolean") {
        throw new Error(
          `ACP config option ${selection.configId} does not accept a boolean`,
        );
      }
    } else if (
      option.type !== "select" ||
      !option.selectableValues.has(selection.value)
    ) {
      throw new Error(
        `ACP config option ${selection.configId} rejects the selected value`,
      );
    }
  });
  return baseline;
}

function configRequest(
  sessionId: string,
  selection: AcpSessionConfigSelection,
): SetSessionConfigOptionRequest {
  return typeof selection.value === "boolean"
    ? {
        sessionId,
        configId: selection.configId,
        type: "boolean",
        value: selection.value,
      }
    : {
        sessionId,
        configId: selection.configId,
        value: selection.value,
      };
}

function attachClientHandlers(
  app: ClientApp,
  operations: PaperclipAcpClientOperations,
  receiveSessionUpdate: (notification: SessionNotification) => Promise<void>,
): void {
  app.onRequest(
    methods.client.session.requestPermission,
    async ({ params, signal }) =>
      operations.requestPermission
        ? operations.requestPermission(params, signal)
        : { outcome: { outcome: "cancelled" } },
  );
  app.onNotification(methods.client.session.update, ({ params }) =>
    receiveSessionUpdate(params),
  );
}

export class PaperclipAcpClient {
  readonly #launch: AcpSubprocessLaunch;
  readonly #subprocess: AcpSubprocess;
  readonly #hooks: PaperclipAcpClientHooks;
  readonly #configSelections: readonly AcpSessionConfigSelection[];
  readonly #connection: ClientConnection;
  #initialConfigOptions: AcpSessionConfigSnapshot | null = null;
  #state: ClientState = "created";
  #initializeResponse: InitializeResponse | null = null;
  #sessionId: string | null = null;
  #pendingSetupSessionId: string | null = null;
  #lastPromptEvent: NormalizedAcpSessionEvent | null = null;

  constructor(input: {
    readonly launch: AcpSubprocessLaunch;
    readonly subprocess: AcpSubprocess;
    readonly operations: PaperclipAcpClientOperations;
    readonly hooks: PaperclipAcpClientHooks;
  }) {
    this.#launch = input.launch;
    this.#subprocess = input.subprocess;
    this.#hooks = input.hooks;
    this.#configSelections = sortedConfigOptions(input.launch.configOptions);
    const app = client({ name: "paperclip" });
    attachClientHandlers(app, input.operations, (notification) =>
      this.#receiveSessionUpdate(notification),
    );
    this.#connection = app.connect(input.subprocess.stream);
  }

  get state(): ClientState {
    return this.#state;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get initializeResponse(): InitializeResponse | null {
    return this.#initializeResponse;
  }

  async initialize(): Promise<InitializeResponse> {
    if (this.#state !== "created") {
      throw new Error(`ACP initialize is invalid in state ${this.#state}`);
    }
    this.#state = "initializing";
    try {
      const response = await this.#connection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            session: { configOptions: { boolean: {} } },
          },
          clientInfo: { name: "paperclip", version: "1" },
        },
      );
      if (
        PROTOCOL_VERSION !== ACP_STABLE_WIRE_VERSION ||
        response.protocolVersion !== ACP_STABLE_WIRE_VERSION
      ) {
        throw new AcpInitializationCapabilityError(
          "protocol_version_mismatch",
          `ACP protocol version mismatch: ${response.protocolVersion}`,
        );
      }
      if (response.agentCapabilities?.sessionCapabilities?.resume == null) {
        throw new AcpInitializationCapabilityError(
          "session_resume_unavailable",
          "ACP frontend does not advertise stable session/resume",
        );
      }
      this.#initializeResponse = response;
      this.#state = "initialized";
      return response;
    } catch (error) {
      this.#state = "terminal";
      throw error;
    }
  }

  async startSession(start: AcpPromptRequest["start"]): Promise<string> {
    if (this.#state !== "initialized" || !this.#initializeResponse) {
      throw new Error(`ACP session setup is invalid in state ${this.#state}`);
    }
    this.#state = "session_setup";
    try {
      if (
        !path.isAbsolute(this.#launch.cwd) ||
        this.#launch.cwd !== this.#launch.cwd.trim()
      ) {
        throw new Error("ACP cwd must be an exact absolute path");
      }
      const additionalDirectories = exactAbsolutePaths(
        this.#launch.additionalDirectories,
        "ACP additionalDirectories",
      );
      const mcpServers = [...this.#launch.mcpServers];
      let initialConfigOptions:
        | readonly SessionConfigOption[]
        | null
        | undefined;

      if (start.kind === "new") {
        this.#pendingSetupSessionId = null;
        const response = await this.#connection.agent.request(
          methods.agent.session.new,
          {
            cwd: this.#launch.cwd,
            additionalDirectories,
            mcpServers,
          },
        );
        if (
          typeof response.sessionId !== "string" ||
          response.sessionId.length === 0
        ) {
          throw new Error("ACP session/new returned an invalid session id");
        }
        if (
          this.#pendingSetupSessionId !== null &&
          this.#pendingSetupSessionId !== response.sessionId
        ) {
          throw new Error(
            "ACP session/new response crossed its pending setup session",
          );
        }
        this.#sessionId = response.sessionId;
        this.#pendingSetupSessionId = null;
        initialConfigOptions = response.configOptions;
      } else {
        if (
          typeof start.sessionId !== "string" ||
          start.sessionId.length === 0
        ) {
          throw new Error("ACP session/resume requires an exact session id");
        }
        this.#pendingSetupSessionId = start.sessionId;
        const response = await this.#connection.agent.request(
          methods.agent.session.resume,
          {
            sessionId: start.sessionId,
            cwd: this.#launch.cwd,
            additionalDirectories,
            mcpServers,
          },
        );
        this.#sessionId = start.sessionId;
        this.#pendingSetupSessionId = null;
        initialConfigOptions = response.configOptions;
      }

      this.#initialConfigOptions = validateConfigOptions(
        initialConfigOptions,
        this.#configSelections,
        0,
      );
      for (let index = 0; index < this.#configSelections.length; index += 1) {
        const selection = this.#configSelections[index]!;
        const response = await this.#connection.agent.request(
          methods.agent.session.setConfigOption,
          configRequest(this.#sessionId, selection),
        );
        validateConfigOptions(
          response.configOptions,
          this.#configSelections,
          index + 1,
          this.#initialConfigOptions,
        );
      }
      this.#state = "session_ready";
      return this.#sessionId;
    } catch (error) {
      this.#pendingSetupSessionId = null;
      this.#state = "terminal";
      throw error;
    }
  }

  async prompt(message: string): Promise<AcpPromptSettlement> {
    if (this.#state !== "session_ready" || !this.#sessionId) {
      throw new Error(`ACP prompt is invalid in state ${this.#state}`);
    }
    if (typeof message !== "string" || message.length === 0) {
      throw new Error("ACP prompt message must be non-empty");
    }
    this.#state = "prompt_active";
    this.#lastPromptEvent = null;
    try {
      const response = await this.#connection.agent.request(
        methods.agent.session.prompt,
        {
          sessionId: this.#sessionId,
          prompt: [{ type: "text", text: message }],
        },
      );
      this.#state = "terminal";
      const occupancy = this.#terminalOccupancy();
      if (!occupancy) {
        const error = new Error(
          "ACP prompt stopped without an immediately preceding terminal usage update",
        );
        await this.#hooks.onProtocolViolation?.(error);
        this.#subprocess.cancel();
        throw error;
      }
      return {
        kind: "protocol_settled",
        stopReason: response.stopReason,
        occupancy,
      };
    } catch (error) {
      this.#state = "terminal";
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (this.#state !== "prompt_active" || !this.#sessionId) return;
    const notification: CancelNotification = { sessionId: this.#sessionId };
    await this.#connection.agent.notify(
      methods.agent.session.cancel,
      notification,
    );
  }

  close(error?: unknown): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#connection.close(error);
    this.#subprocess.closeInput();
  }

  #terminalOccupancy(): AcpPromptSettlement["occupancy"] | null {
    const event = this.#lastPromptEvent;
    return event?.kind === "usage"
      ? { used: event.used, size: event.size, cost: event.cost }
      : null;
  }

  async #receiveSessionUpdate(
    notification: SessionNotification,
  ): Promise<void> {
    const setupMetadata =
      (this.#state === "session_setup" || this.#state === "session_ready") &&
      (notification.update.sessionUpdate === "available_commands_update" ||
        notification.update.sessionUpdate === "session_info_update" ||
        notification.update.sessionUpdate === "config_option_update");
    if (setupMetadata && this.#state === "session_setup") {
      if (
        notification.sessionId.length === 0 ||
        (this.#pendingSetupSessionId !== null &&
          notification.sessionId !== this.#pendingSetupSessionId) ||
        (this.#sessionId !== null && notification.sessionId !== this.#sessionId)
      ) {
        const error = new Error(
          "ACP session/update crossed its pending setup session",
        );
        await this.#hooks.onProtocolViolation?.(error);
        this.#subprocess.cancel();
        throw error;
      }
      if (this.#sessionId === null && this.#pendingSetupSessionId === null) {
        this.#pendingSetupSessionId = notification.sessionId;
      }
    }
    const ownedSessionId = this.#sessionId ?? this.#pendingSetupSessionId;
    if (
      !ownedSessionId ||
      notification.sessionId !== ownedSessionId ||
      (this.#state !== "prompt_active" && !setupMetadata)
    ) {
      const error = new Error(
        "ACP session/update does not match the active prompt session",
      );
      await this.#hooks.onProtocolViolation?.(error);
      this.#subprocess.cancel();
      throw error;
    }
    try {
      if (notification.update.sessionUpdate === "config_option_update") {
        if (!this.#initialConfigOptions) {
          throw new Error(
            "ACP config update arrived before session configuration was fixed",
          );
        }
        validateConfigOptions(
          notification.update.configOptions,
          this.#configSelections,
          this.#configSelections.length,
          this.#initialConfigOptions,
        );
      }
      const event = normalizeAcpSessionUpdate(notification);
      // ACP frontends may publish session-level metadata after session/new or
      // session/resume resolves but before the first prompt starts. Validate
      // those notifications here, but do not publish them as prompt output or
      // let them become the terminal-usage predecessor for a later prompt.
      if (setupMetadata) return;
      this.#lastPromptEvent = event;
      await this.#hooks.onSessionEvent(event, notification);
    } catch (error) {
      const protocolError =
        error instanceof Error ? error : new Error(String(error));
      await this.#hooks.onProtocolViolation?.(protocolError);
      this.#subprocess.cancel();
      throw protocolError;
    }
  }
}

export function isAcpTargetNotFoundError(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    error.code === ACP_TARGET_NOT_FOUND_ERROR_CODE
  );
}

export function isAcpAuthenticationRequiredError(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    error.code === ACP_AUTHENTICATION_REQUIRED_ERROR_CODE
  );
}

function redactControlError(
  error: unknown,
  redactText: (value: string) => string,
  sessionId: string | null,
): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const withoutSession = sessionId
    ? rawMessage.split(sessionId).join("[REDACTED]")
    : rawMessage;
  const message = safelyRedactText(redactText, withoutSession);
  return error instanceof RequestError
    ? new RequestError(error.code, message)
    : new Error(message);
}

function safelyRedactText(
  redactText: (value: string) => string,
  value: string,
): string {
  try {
    const redacted = redactText(value);
    return typeof redacted === "string"
      ? redacted
      : "[ACP runtime redaction failed]";
  } catch {
    return "[ACP runtime redaction failed]";
  }
}


export type AcpPromptExecutionPhase =
  | "spawn"
  | "initialize"
  | "session_setup"
  | "prompt_activation"
  | "prompt_transmission"
  | "prompt";

export type AcpSubprocessStarter = (
  launch: AcpSubprocessLaunch,
  options: AcpSubprocessStartOptions,
) => AcpSubprocess | Promise<AcpSubprocess>;

export type AcpPromptClosureOutcome =
  | {
      readonly kind: "settled";
      readonly sessionId: string;
      readonly settlement: AcpPromptSettlement;
      readonly cancellationNotificationError: unknown | null;
    }
  | { readonly kind: "target_not_found" }
  | {
      readonly kind: "error";
      readonly failure: "authentication_required" | "runtime";
      readonly phase: AcpPromptExecutionPhase;
      readonly promptTransmitted: boolean;
      readonly cause: unknown;
    };

export type AcpSubprocessTeardownOutcome =
  | { readonly kind: "not_started" }
  | {
      readonly kind: "reaped";
      readonly processExit: AcpSubprocessExit;
    }
  | {
      readonly kind: "failed";
      readonly cause: unknown;
    };

export type AcpPromptExecutionResult =
  | {
      readonly kind: "settled";
      readonly sessionId: string;
      readonly settlement: AcpPromptSettlement;
      readonly cancellationNotificationError: unknown | null;
      readonly closureError: unknown | null;
      readonly teardown: AcpSubprocessTeardownOutcome;
      readonly stderr: string;
    }
  | {
      readonly kind: "target_not_found";
      readonly closureError: unknown | null;
      readonly teardown: AcpSubprocessTeardownOutcome;
      readonly stderr: string;
    }
  | {
      readonly kind: "error";
      readonly failure: "authentication_required" | "runtime";
      readonly phase: AcpPromptExecutionPhase;
      readonly promptTransmitted: boolean;
      readonly cause: unknown;
      readonly closureError: unknown | null;
      readonly teardown: AcpSubprocessTeardownOutcome;
      readonly stderr: string;
    };

export interface AcpPromptExecutionInput {
  readonly launch: AcpSubprocessLaunch;
  readonly request: AcpPromptRequest;
  /**
   * The existing worker execution-target topology supplies the supervised
   * duplex process. The common ACP lifecycle never assumes a local target.
   */
  readonly startSubprocess: AcpSubprocessStarter;
  /**
   * Runs after new/resume and every required config setter, but immediately
   * before the sole prompt. The caller atomically revalidates the run and
   * activates its pending prompt capability here.
   */
  readonly activatePrompt: (input: {
    readonly sessionId: string;
  }) => Promise<void>;
  /**
   * Durably changes the exact ref/segment from never-transmitted to
   * transmitted after activation and immediately before the external ACP
   * request begins. A rejected fence sends no prompt bytes.
   */
  readonly beginPromptTransmission: (input: {
    readonly sessionId: string;
  }) => Promise<void>;
  /**
   * Runs exactly once for every lifecycle outcome before the subprocess is
   * closed or its result is exposed. The caller atomically records the prompt
   * outcome and revokes the pending/active request capability here.
   */
  readonly closePrompt: (outcome: AcpPromptClosureOutcome) => Promise<void>;
  /** Bounded wait before a non-settling cancelled prompt is force-terminated. */
  readonly cancellationSettlementTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly operations?: PaperclipAcpClientOperations;
  readonly redactStderr: (chunk: string) => string;
  readonly onStderr?: (chunk: string) => void;
  readonly onSessionEvent: (
    event: NormalizedAcpSessionEvent,
  ) => Promise<void> | void;
  /**
   * Final request-local event validation after the prompt response and its
   * immediately preceding updates, but before protocol settlement is exposed.
   */
  readonly validatePromptEvents?: () => Promise<void> | void;
  readonly onProtocolViolation?: (error: Error) => Promise<void> | void;
}

/**
 * Executes one and only one prompt-bearing ACP subprocess lifecycle. It never
 * retries a resume, falls back to session/new, or reuses a process. Callers
 * decide the separately authorized recovery branch from the closed result.
 */
export async function executeAcpSubprocessPrompt(
  input: AcpPromptExecutionInput,
): Promise<AcpPromptExecutionResult> {
  const cancellationSettlementTimeoutMs =
    input.cancellationSettlementTimeoutMs ??
    DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS;
  if (
    !Number.isInteger(cancellationSettlementTimeoutMs) ||
    cancellationSettlementTimeoutMs <= 0
  ) {
    throw new TypeError(
      "ACP cancellation settlement timeout must be a positive integer",
    );
  }
  let subprocess: AcpSubprocess;
  try {
    subprocess = await input.startSubprocess(input.launch, {
      redactStderr: input.redactStderr,
      ...(input.onStderr ? { onStderr: input.onStderr } : {}),
    });
  } catch (cause) {
    const redactedCause = redactControlError(
      cause,
      input.redactStderr,
      null,
    );
    const spawnFailure: AcpPromptClosureOutcome = {
      kind: "error",
      failure: isAcpAuthenticationRequiredError(redactedCause)
        ? "authentication_required"
        : "runtime",
      phase: "spawn",
      promptTransmitted: false,
      cause: redactedCause,
    };
    let closureError: unknown | null = null;
    try {
      await input.closePrompt(spawnFailure);
    } catch (closureCause) {
      closureError = closureCause;
    }
    return {
      ...spawnFailure,
      closureError,
      teardown: { kind: "not_started" },
      stderr: "",
    };
  }

  const acpClient = new PaperclipAcpClient({
    launch: input.launch,
    subprocess,
    operations: input.operations ?? {},
    hooks: {
      onSessionEvent: input.onSessionEvent,
      ...(input.onProtocolViolation
        ? { onProtocolViolation: input.onProtocolViolation }
        : {}),
    },
  });
  let phase: AcpPromptExecutionPhase = "initialize";
  let promptTransmitted = false;
  let result:
    | AcpPromptClosureOutcome
    | null = null;
  let cancellation: Promise<void> | null = null;
  let cancellationNotificationError: unknown | null = null;
  let cancellationForceTimer: ReturnType<typeof setTimeout> | null = null;
  const clearCancellationForceTimer = () => {
    if (cancellationForceTimer) clearTimeout(cancellationForceTimer);
    cancellationForceTimer = null;
  };
  const onAbort = () => {
    if (acpClient.state === "prompt_active") {
      if (!cancellation) {
        cancellation = acpClient.cancel().catch((error: unknown) => {
          cancellationNotificationError = error;
          subprocess.cancel();
        });
        cancellationForceTimer = setTimeout(() => {
          if (acpClient.state === "prompt_active") subprocess.cancel();
        }, cancellationSettlementTimeoutMs);
        cancellationForceTimer.unref?.();
      }
      return;
    }
    subprocess.cancel();
  };
  input.signal?.addEventListener("abort", onAbort);
  if (input.signal?.aborted) onAbort();

  try {
    await acpClient.initialize();
    phase = "session_setup";
    const sessionId = await acpClient.startSession(input.request.start);
    phase = "prompt_activation";
    await input.activatePrompt({ sessionId });
    phase = "prompt_transmission";
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("ACP prompt execution was cancelled");
    }
    if (
      typeof input.request.message !== "string" ||
      input.request.message.length === 0
    ) {
      throw new Error("ACP prompt message must be non-empty");
    }
    await input.beginPromptTransmission({ sessionId });
    promptTransmitted = true;
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("ACP prompt execution was cancelled");
    }
    phase = "prompt";
    const settlement = await acpClient.prompt(input.request.message);
    await input.validatePromptEvents?.();
    input.signal?.removeEventListener("abort", onAbort);
    const pendingCancellation = cancellation as Promise<void> | null;
    if (pendingCancellation) {
      let notificationWaitTimer: ReturnType<typeof setTimeout> | undefined;
      const notificationCompleted = await Promise.race([
        pendingCancellation.then(() => true),
        new Promise<false>((resolve) => {
          notificationWaitTimer = setTimeout(
            () => resolve(false),
            cancellationSettlementTimeoutMs,
          );
          notificationWaitTimer.unref?.();
        }),
      ]);
      if (notificationWaitTimer) clearTimeout(notificationWaitTimer);
      if (!notificationCompleted && cancellationNotificationError === null) {
        cancellationNotificationError = new Error(
          "ACP cancellation notification exceeded its settlement deadline",
        );
        subprocess.cancel();
      }
    }
    result = {
      kind: "settled",
      sessionId,
      settlement,
      cancellationNotificationError,
    };
  } catch (cause) {
    if (
      phase === "session_setup" &&
      input.request.start.kind === "resume" &&
      isAcpTargetNotFoundError(cause)
    ) {
      result = { kind: "target_not_found" };
    } else {
      result = {
        kind: "error",
        failure: isAcpAuthenticationRequiredError(cause)
          ? "authentication_required"
          : "runtime",
        phase,
        promptTransmitted,
        cause,
      };
    }
  } finally {
    clearCancellationForceTimer();
    input.signal?.removeEventListener("abort", onAbort);
  }

  if (!result) {
    result = {
      kind: "error",
      failure: "runtime",
      phase,
      promptTransmitted,
      cause: new Error("ACP execution produced no closed result"),
    };
  }
  const sessionIdForRedaction = acpClient.sessionId;
  const closureOutcome: AcpPromptClosureOutcome = result.kind === "error"
    ? {
        ...result,
        cause: redactControlError(
          result.cause,
          input.redactStderr,
          sessionIdForRedaction,
        ),
      }
    : result;
  let closureError: unknown | null = null;
  try {
    await input.closePrompt(closureOutcome);
  } catch (cause) {
    subprocess.cancel();
    closureError = cause;
  }

  acpClient.close();
  let teardown: AcpSubprocessTeardownOutcome;
  try {
    teardown = {
      kind: "reaped",
      processExit: await subprocess.closeAndReap(),
    };
  } catch (cause) {
    teardown = {
      kind: "failed",
      cause: redactControlError(
        cause,
        input.redactStderr,
        sessionIdForRedaction,
      ),
    };
  }
  const capturedStderr = subprocess.stderr();
  const stderrWithoutSession = sessionIdForRedaction
    ? capturedStderr.split(sessionIdForRedaction).join("[REDACTED]")
    : capturedStderr;
  const stderr = safelyRedactText(input.redactStderr, stderrWithoutSession);
  return { ...closureOutcome, closureError, teardown, stderr };
}
