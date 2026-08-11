import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpSessionStore,
} from "acpx/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeAcpxOneShotPrompt,
  type AcpxOneShotPromptInput,
} from "./acpx-runtime-execution.js";

const runtimeMocks = vi.hoisted(() => ({ create: vi.fn(), createStore: vi.fn() }));
const registryMocks = vi.hoisted(() => ({ load: vi.fn() }));
const stateMocks = vi.hoisted(() => ({
  createKey: vi.fn(),
  createDir: vi.fn(),
  removeDir: vi.fn(),
}));

vi.mock("acpx/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("acpx/runtime")>(),
  createAcpRuntime: runtimeMocks.create,
  createRuntimeStore: runtimeMocks.createStore,
}));
vi.mock("./agent-registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./agent-registry.js")>(),
  loadAcpxAgentRegistry: registryMocks.load,
}));
vi.mock("./temporary-state.js", () => ({
  createTemporarySessionKey: stateMocks.createKey,
  createTemporaryStateDir: stateMocks.createDir,
  removeTemporaryStateDir: stateMocks.removeDir,
}));

const actualAcpxRuntime = await vi.importActual<typeof import("acpx/runtime")>(
  "acpx/runtime",
);
const actualTemporaryState = await vi.importActual<
  typeof import("./temporary-state.js")
>("./temporary-state.js");
const fixtureEntrypoint = fileURLToPath(
  new URL("./fixtures/acp-agent-fixture.mjs", import.meta.url),
);
const TEST_TIMEOUT_MS = 60_000;
const completedTurnResult = { status: "completed", stopReason: "end_turn" } as const;
const usageEvent = { type: "status", text: "usage", used: 1, size: 128 } as const;

type AcpxOneShotRuntime = Pick<
  AcpRuntime,
  "ensureSession" | "startTurn" | "setConfigOption" | "close"
> & { readonly getStatus: NonNullable<AcpRuntime["getStatus"]> };
type TestPromptInput = Partial<Omit<AcpxOneShotPromptInput, "timeoutMs">>;

function executePrompt(input: TestPromptInput) {
  return executeAcpxOneShotPrompt({
    cwd: process.cwd(),
    agentName: "fixture",
    start: { kind: "new" },
    message: "inspect this",
    configSelections: [],
    permissionMode: "deny-all",
    timeoutMs: TEST_TIMEOUT_MS,
    onSessionEvent: async () => {},
    activatePrompt: async () => {},
    beginPromptTransmission: async () => {},
    ...input,
  });
}

function asyncEvents(events: readonly AcpRuntimeEvent[]): AsyncIterable<AcpRuntimeEvent> {
  return { async *[Symbol.asyncIterator]() { yield* events; } };
}

function runtimeTurn(input: {
  readonly events?: readonly AcpRuntimeEvent[];
  readonly result?: Awaited<AcpRuntimeTurn["result"]>;
  readonly cancel?: () => Promise<void>;
} = {}): AcpRuntimeTurn {
  return {
    requestId: "turn-request",
    events: asyncEvents(input.events ?? [usageEvent]),
    result: Promise.resolve(input.result ?? completedTurnResult),
    cancel: input.cancel ?? (async () => {}),
    closeStream: async () => {},
  };
}

function runtimeHandle(overrides: Partial<AcpRuntimeHandle> = {}): AcpRuntimeHandle {
  return {
    sessionKey: "one-shot-session",
    backend: "acpx",
    runtimeSessionName: "one-shot-session",
    backendSessionId: "provider-session",
    ...overrides,
  };
}

function testRuntime(overrides: Partial<AcpxOneShotRuntime> = {}): AcpxOneShotRuntime {
  return {
    ensureSession: async () => runtimeHandle(),
    setConfigOption: async () => {},
    getStatus: async () => ({ backendSessionId: "provider-session" }),
    startTurn: () => runtimeTurn(),
    close: async () => {},
    ...overrides,
  };
}

function registry(): AcpAgentRegistry {
  return { list: () => ["fixture"], resolve: (name) => [process.execPath, name] };
}

function store(): AcpSessionStore {
  return { load: async () => undefined, save: async () => {} };
}

let stateDir = "";

beforeEach(() => {
  stateDir = "";
  runtimeMocks.create.mockReset();
  runtimeMocks.createStore.mockReset().mockReturnValue(store());
  registryMocks.load.mockReset().mockResolvedValue(registry());
  stateMocks.createKey.mockReset().mockReturnValue("one-shot-session");
  stateMocks.createDir.mockReset().mockImplementation(async (prefix) => {
    stateDir = await actualTemporaryState.createTemporaryStateDir(prefix);
    return stateDir;
  });
  stateMocks.removeDir.mockReset().mockImplementation(
    actualTemporaryState.removeTemporaryStateDir,
  );
});

afterEach(async () => {
  if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
});

function expectStateRemoved() {
  return expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("ACPX one-shot runtime bridge", () => {
  it("executes the fixture through ACPX's public runtime with a reasoning setting", async () => {
    const sessionEvents: unknown[] = [];
    registryMocks.load.mockResolvedValue({
      list: () => ["fixture"],
      resolve: () => [process.execPath, fixtureEntrypoint],
    });
    runtimeMocks.create.mockImplementation(actualAcpxRuntime.createAcpRuntime);
    runtimeMocks.createStore.mockImplementation(actualAcpxRuntime.createRuntimeStore);
    stateMocks.createKey.mockReturnValue("actual-acpx-runtime");

    const result = await executePrompt({
      message: "prove ACPX runtime execution",
      configSelections: [
        { configId: "alpha-model", value: "model-b" },
        { configId: "reasoning_effort", value: "high" },
        { configId: "zeta-enabled", value: "true" },
      ],
      nonInteractivePermissions: "deny",
      onSessionEvent: (event) => { sessionEvents.push(event); },
    });

    expect(result).toMatchObject({
      kind: "completed", sessionId: "fixture-new-session",
      settlement: { kind: "protocol_settled", stopReason: "end_turn",
        occupancy: { used: 9, size: 128, cost: null } },
    });
    expect(sessionEvents).toContainEqual({
      kind: "message_chunk",
      channel: "assistant",
      content: { type: "text", text: "fixture:prove ACPX runtime execution" },
    });
    expect(stateMocks.removeDir).toHaveBeenCalledWith(stateDir);
    await expectStateRemoved();
  });

  it("uses ACPX's one-shot lifecycle, applies generic settings before the prompt, and projects stable events", async () => {
    const handle = runtimeHandle();
    const assistantFragments = Array.from(
      { length: 512 },
      (_, index) => `fragment-${index}:λ\n`,
    );
    const trace: string[] = [];
    const setConfigOption = vi.fn(async (input: { key: string; value: string }) => {
      trace.push(`config:${input.key}=${input.value}`);
    });
    const runtime = testRuntime({
      ensureSession: vi.fn(async () => {
        trace.push("ensure:persistent");
        return handle;
      }),
      setConfigOption,
      getStatus: vi.fn(async () => {
        trace.push("status");
        return { backendSessionId: "provider-session-after-config" };
      }),
      startTurn: vi.fn(() => {
        trace.push("prompt");
        return runtimeTurn({
          events: [
            { type: "text_delta", text: "rea", stream: "thought" },
            { type: "status", text: "provider heartbeat" },
            { type: "text_delta", text: "soning", stream: "thought" },
            {
              type: "tool_call",
              tag: "tool_call",
              text: "read package.json",
              toolCallId: "call-1",
              title: "Read package",
              status: "in_progress",
              kind: "read",
              rawInput: { path: "package.json", _meta: { private: true } },
            },
            {
              type: "tool_call",
              tag: "tool_call_update",
              text: "read complete",
              toolCallId: "call-1",
              status: "completed",
              rawOutput: { ok: true, _meta: { private: true } },
            },
            { type: "text_delta", text: "after tool", stream: "thought" },
            ...assistantFragments.map((text) => ({
              type: "text_delta" as const,
              text,
              stream: "output" as const,
            })),
            {
              type: "status",
              text: "usage updated: 8/128",
              tag: "usage_update",
              used: 8,
              size: 128,
              cost: { amount: 0.12, currency: "USD" },
            },
          ],
        });
      }),
      close: vi.fn(async (input: { discardPersistentState?: boolean }) => {
        trace.push(`close:${String(input.discardPersistentState)}`);
      }),
    });
    stateMocks.removeDir.mockImplementation(async (directory: string) => {
      trace.push("remove-state");
      await fs.rm(directory, { recursive: true, force: true });
    });
    runtimeMocks.create.mockImplementation((options: AcpRuntimeOptions) => {
      expect(options).toMatchObject({
        cwd: process.cwd(),
        agentRegistry: expect.any(Object),
        permissionMode: "deny-all",
        timeoutMs: TEST_TIMEOUT_MS,
      });
      return runtime;
    });
    const sessionEvents: unknown[] = [];

    const result = await executePrompt({
      configSelections: [
        { configId: "model", value: "model-b" },
        { configId: "reasoning_effort", value: "high" },
        { configId: "fast_mode", value: true },
      ],
      onSessionEvent: (event) => { sessionEvents.push(event); },
      activatePrompt: ({ sessionId }) => {
        trace.push(`activate:${sessionId}`);
        return Promise.resolve();
      },
      beginPromptTransmission: ({ sessionId }) => {
        trace.push(`begin:${sessionId}`);
        return Promise.resolve();
      },
    });

    expect(trace).toEqual([
      "ensure:persistent", "config:model=model-b", "config:reasoning_effort=high",
      "config:fast_mode=true", "status", "activate:provider-session-after-config",
      "begin:provider-session-after-config", "prompt", "close:false", "remove-state",
    ]);
    expect(runtime.startTurn).toHaveBeenCalledWith({
      handle,
      text: "inspect this",
      mode: "prompt",
      requestId: expect.any(String),
    });
    expect(sessionEvents).toEqual([
      { kind: "message_chunk", channel: "thought",
        content: { type: "text", text: "reasoning" } },
      { kind: "tool_call", toolCallId: "call-1", title: "Read package",
        toolKind: "read", status: "in_progress", rawInput: { path: "package.json" } },
      { kind: "tool_call_update", toolCallId: "call-1", status: "completed",
        rawOutput: { ok: true } },
      { kind: "message_chunk", channel: "thought",
        content: { type: "text", text: "after tool" } },
      { kind: "message_chunk", channel: "assistant",
        content: { type: "text", text: assistantFragments.join("") } },
    ]);
    expect(result).toEqual({
      kind: "completed",
      sessionId: "provider-session-after-config",
      settlement: { kind: "protocol_settled", stopReason: "end_turn",
        occupancy: { used: 8, size: 128,
          cost: { amount: 0.12, currency: "USD" } } },
    });
    expect(stateMocks.removeDir).toHaveBeenCalledWith(stateDir);
    await expectStateRemoved();
  });

  it("resolves the ACPX registry at an explicit service scope while keeping the session in its execution workspace", async () => {
    const registryCwds: string[] = [];
    const runtimeCwds: string[] = [];
    const sessionCwds: string[] = [];
    registryMocks.load.mockImplementation(async (cwd) => {
      registryCwds.push(cwd);
      return registry();
    });
    runtimeMocks.create.mockImplementation((options) => {
      runtimeCwds.push(options.cwd);
      return testRuntime({
        ensureSession: async (input: AcpRuntimeEnsureInput) => {
          if (!input.cwd) throw new Error("session cwd was omitted");
          sessionCwds.push(input.cwd);
          return runtimeHandle({ sessionKey: "scope-session", runtimeSessionName: "scope-session" });
        },
      });
    });

    const result = await executePrompt({
      cwd: "/execution/workspace",
      registryCwd: "/paperclip/acpx-config",
      message: "scoped execution",
    });

    expect(result).toMatchObject({ kind: "completed" });
    expect(registryCwds).toEqual(["/paperclip/acpx-config"]);
    expect(runtimeCwds).toEqual(["/execution/workspace"]);
    expect(sessionCwds).toEqual(["/execution/workspace"]);
  });

  it("releases only ACPX state and preserves the provider session for a later resume", async () => {
    const handle = runtimeHandle();
    const close = vi.fn(async () => {});
    const runtime = testRuntime({ ensureSession: vi.fn(async () => handle), close });
    runtimeMocks.create.mockReturnValue(runtime);

    const result = await executePrompt({
      start: { kind: "resume", sessionId: "previous-provider-session" },
    });

    expect(result.kind).toBe("completed");
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({
      handle,
      reason: "Paperclip one-shot execution release",
      discardPersistentState: false,
    });
    expect(runtime.ensureSession).toHaveBeenCalledWith({
      sessionKey: "one-shot-session",
      agent: "fixture",
      mode: "persistent",
      cwd: process.cwd(),
      resumeSessionId: "previous-provider-session",
    });
    await expectStateRemoved();
  });

  it("reports a resumed-session setup failure without parsing ACP error codes", async () => {
    const ensureSession = vi.fn(async () => {
      throw { code: 99123, message: "provider session was not found" };
    });
    const getStatus = vi.fn();
    const startTurn = vi.fn();
    const close = vi.fn();
    runtimeMocks.create.mockReturnValue(testRuntime({ ensureSession, getStatus, startTurn, close }));
    stateMocks.createKey.mockReturnValue("missing-resume-session");

    const result = await executePrompt({
      start: { kind: "resume", sessionId: "missing-provider-session" },
      message: "continue the issue",
    });

    expect(result).toMatchObject({ kind: "error", phase: "session_setup",
      promptTransmitted: false,
      cause: { code: 99123, message: "provider session was not found" } });
    expect(ensureSession).toHaveBeenCalledWith({
      sessionKey: "missing-resume-session",
      agent: "fixture",
      mode: "persistent",
      cwd: process.cwd(),
      resumeSessionId: "missing-provider-session",
    });
    expect(getStatus).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await expectStateRemoved();
  });

  it("lets ACPX consume the turn AbortSignal without a duplicate cancel call", async () => {
    const abortController = new AbortController();
    let cancelled = false;
    let releaseEvents: (() => void) | undefined;
    let resolveTurnResult: ((value: Awaited<AcpRuntimeTurn["result"]>) => void) | undefined;
    const turn = {
      requestId: "turn-request",
      events: {
        async *[Symbol.asyncIterator]() {
          if (cancelled) return;
          await new Promise<void>((resolve) => { releaseEvents = resolve; });
        },
      },
      result: new Promise<Awaited<AcpRuntimeTurn["result"]>>((resolve) => {
        resolveTurnResult = resolve;
      }),
      cancel: vi.fn(async () => {
        cancelled = true;
        releaseEvents?.();
        resolveTurnResult?.({ status: "cancelled", stopReason: "cancelled" });
      }),
      closeStream: async () => {},
    } satisfies AcpRuntimeTurn;
    const startTurn = vi.fn((input: { signal?: AbortSignal }) => {
      input.signal?.addEventListener("abort", () => {
        cancelled = true;
        releaseEvents?.();
        resolveTurnResult?.({ status: "cancelled", stopReason: "cancelled" });
      }, { once: true });
      return turn;
    });
    const close = vi.fn(async () => {});
    runtimeMocks.create.mockReturnValue(testRuntime({ startTurn, close }));

    const execution = executePrompt({ signal: abortController.signal });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    abortController.abort(new Error("operator cancelled"));

    await expect(execution).resolves.toMatchObject({
      kind: "cancelled", sessionId: "provider-session", settlement: null,
    });
    expect(turn.cancel).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    await expectStateRemoved();
  });

  it("uses one runtime close for iterator and Paperclip projection failures", async () => {
    async function executeFailure(input: {
      readonly events: AsyncIterable<AcpRuntimeEvent>;
      readonly onSessionEvent?: () => Promise<void>;
    }) {
      const cancel = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      runtimeMocks.create.mockReturnValue(testRuntime({
        startTurn: () => ({
          requestId: "turn-request",
          events: input.events,
          result: Promise.resolve(completedTurnResult),
          cancel,
          closeStream: async () => {},
        }),
        close,
      }));
      const result = await executePrompt(input.onSessionEvent === undefined
        ? {}
        : { onSessionEvent: input.onSessionEvent });
      return { cancel, close, result };
    }

    const iteratorError = new Error("ACPX event iterator failed");
    const iteratorFailure = await executeFailure({
      events: { async *[Symbol.asyncIterator]() { throw iteratorError; } },
    });
    expect(iteratorFailure.result).toMatchObject({
      kind: "error", phase: "prompt", cause: iteratorError,
    });
    expect(iteratorFailure.cancel).not.toHaveBeenCalled();
    expect(iteratorFailure.close).toHaveBeenCalledOnce();

    const projectionError = new Error("durable projection failed");
    const projectionFailure = await executeFailure({
      events: asyncEvents([
        { type: "text_delta", stream: "output", text: "partial" },
      ]),
      onSessionEvent: async () => { throw projectionError; },
    });
    expect(projectionFailure.result).toMatchObject({
      kind: "error", phase: "prompt", cause: projectionError,
    });
    expect(projectionFailure.cancel).not.toHaveBeenCalled();
    expect(projectionFailure.close).toHaveBeenCalledOnce();
  });

  it("checks cancellation between setup awaits without a manual cancel path", async () => {
    const abortController = new AbortController();
    let releaseConfiguration: (() => void) | undefined;
    const setConfigOption = vi.fn(() => new Promise<void>((resolve) => {
      releaseConfiguration = resolve;
    }));
    const startTurn = vi.fn();
    const close = vi.fn(async () => {});
    runtimeMocks.create.mockReturnValue(testRuntime({ setConfigOption, startTurn, close }));

    const execution = executePrompt({
      configSelections: [{ configId: "model", value: "model-a" }],
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(setConfigOption).toHaveBeenCalledOnce());
    abortController.abort(new Error("operator cancelled setup"));
    releaseConfiguration?.();

    await expect(execution).resolves.toMatchObject({
      kind: "error", phase: "prompt_activation", promptTransmitted: false,
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("requires the post-configuration ACPX status instead of reusing the initial handle", async () => {
    const startTurn = vi.fn();
    runtimeMocks.create.mockReturnValue(testRuntime({
      ensureSession: async () => runtimeHandle({ backendSessionId: "initial-provider-session" }),
      getStatus: async () => ({}),
      startTurn,
    }));

    const result = await executePrompt({});

    expect(result).toMatchObject({
      kind: "error", phase: "configuration", promptTransmitted: false,
    });
    expect(startTurn).not.toHaveBeenCalled();
    await expectStateRemoved();
  });

  it("reports an incomplete one-shot lifecycle when private ACPX state cannot be removed", async () => {
    runtimeMocks.create.mockReturnValue(testRuntime());
    stateMocks.removeDir.mockRejectedValue(new Error("state removal failed"));

    const result = await executePrompt({});

    expect(result).toMatchObject({ kind: "error", phase: "prompt", promptTransmitted: true,
      cause: expect.objectContaining({ message: "state removal failed" }) });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("rejects an uninstalled package-runner agent before ACPX creates a runtime", async () => {
    registryMocks.load.mockResolvedValue({
      list: () => ["definitely-not-installed-agent"],
      resolve: () => ["npx", "-y", "definitely-not-installed-package"],
    });

    await expect(executePrompt({
      agentName: "definitely-not-installed-agent",
      message: "must not materialize a package",
    })).rejects.toThrow("ACPX agent is not locally available");
    expect(runtimeMocks.create).not.toHaveBeenCalled();
  });
});
