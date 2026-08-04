import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AcpAgentRegistry,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpSessionStore,
} from "acpx/runtime";
import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
} from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  executeAcpxOneShotPrompt,
  type AcpxOneShotRuntime,
} from "./acpx-runtime-execution.js";

const fixtureEntrypoint = fileURLToPath(
  new URL("./fixtures/acp-agent-fixture.mjs", import.meta.url),
);

function asyncEvents(
  events: readonly AcpRuntimeEvent[],
): AsyncIterable<AcpRuntimeEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function runtimeTurn(input: {
  readonly events: readonly AcpRuntimeEvent[];
  readonly result: Awaited<AcpRuntimeTurn["result"]>;
  readonly cancel?: () => Promise<void>;
}): AcpRuntimeTurn {
  return {
    requestId: "turn-request",
    events: asyncEvents(input.events),
    result: Promise.resolve(input.result),
    cancel: input.cancel ?? (async () => {}),
    closeStream: async () => {},
  };
}

function registry(): AcpAgentRegistry {
  return {
    list: () => ["fixture"],
    resolve: (name) => ["fixture-command", name],
  };
}

function store(): AcpSessionStore {
  return { load: async () => undefined, save: async () => {} };
}

describe("ACPX one-shot runtime bridge", () => {
  it("executes the fixture through ACPX's public runtime with a reasoning setting", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-acpx-one-shot-test-"),
    );
    const removeTemporaryStateDir = vi.fn(async (directory: string) => {
      await fs.rm(directory, { recursive: true, force: true });
    });
    const sessionEvents: unknown[] = [];

    const result = await executeAcpxOneShotPrompt({
      cwd: process.cwd(),
      agentName: "fixture",
      start: { kind: "new" },
      message: "prove ACPX runtime execution",
      configSelections: [
        { configId: "alpha-model", value: "model-b" },
        { configId: "reasoning_effort", value: "high" },
        { configId: "zeta-enabled", value: "true" },
      ],
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
      onSessionEvent: (event) => {
        sessionEvents.push(event);
      },
      dependencies: {
        loadAgentRegistry: async () =>
          createAgentRegistry({
            overrides: { fixture: [process.execPath, fixtureEntrypoint] },
          }),
        createAcpRuntime,
        createRuntimeStore,
        createTemporaryStateDir: async () => stateDir,
        removeTemporaryStateDir,
        createSessionKey: () => "actual-acpx-runtime",
      },
    });

    expect(result).toMatchObject({
      kind: "completed",
      sessionId: "fixture-new-session",
      turnResult: { status: "completed", stopReason: "end_turn" },
      settlement: {
        kind: "protocol_settled",
        stopReason: "end_turn",
        occupancy: { used: 9, size: 128, cost: null },
      },
    });
    // The fixture intentionally lacks session/close. The bridge must not ask
    // ACPX to close a provider session just because Paperclip is discarding
    // its own temporary ACPX state directory.
    expect(result.cleanup).toMatchObject({ stateRemoved: true });
    expect(result.cleanup.errors).toHaveLength(0);
    expect(sessionEvents).toContainEqual({
      kind: "message_chunk",
      channel: "assistant",
      content: { type: "text", text: "fixture:prove ACPX runtime execution" },
    });
    expect(removeTemporaryStateDir).toHaveBeenCalledWith(stateDir);
    await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses ACPX's one-shot lifecycle, applies generic settings before the prompt, and projects stable events", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-acpx-one-shot-test-"),
    );
    const handle: AcpRuntimeHandle = {
      sessionKey: "one-shot-session",
      backend: "acpx",
      runtimeSessionName: "one-shot-session",
      backendSessionId: "provider-session",
    };
    const trace: string[] = [];
    const setConfigOption = vi.fn(async (input: { key: string; value: string }) => {
      trace.push(`config:${input.key}=${input.value}`);
    });
    const runtime: AcpxOneShotRuntime = {
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
            {
              type: "text_delta",
              text: "reasoning",
              stream: "thought",
            },
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
            { type: "text_delta", text: "done", stream: "output" },
            {
              type: "status",
              text: "usage updated: 8/128",
              tag: "usage_update",
              used: 8,
              size: 128,
              cost: { amount: 0.12, currency: "USD" },
            },
          ],
          result: { status: "completed", stopReason: "end_turn" },
        });
      }),
      cancel: async () => {},
      close: vi.fn(async (input: { discardPersistentState?: boolean }) => {
        trace.push(`close:${String(input.discardPersistentState)}`);
      }),
    };
    const removeTemporaryStateDir = vi.fn(async (directory: string) => {
      trace.push("remove-state");
      await fs.rm(directory, { recursive: true, force: true });
    });
    const runtimeEvents: AcpRuntimeEvent[] = [];
    const sessionEvents: unknown[] = [];

    const result = await executeAcpxOneShotPrompt({
      cwd: process.cwd(),
      agentName: "fixture",
      start: { kind: "new" },
      message: "inspect this",
      configSelections: [
        { configId: "model", value: "model-b" },
        { configId: "reasoning_effort", value: "high" },
      ],
      permissionMode: "deny-all",
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event);
      },
      onSessionEvent: (event) => {
        sessionEvents.push(event);
      },
      activatePrompt: ({ sessionId }) => {
        trace.push(`activate:${sessionId}`);
        return Promise.resolve();
      },
      beginPromptTransmission: ({ sessionId }) => {
        trace.push(`begin:${sessionId}`);
        return Promise.resolve();
      },
      dependencies: {
        loadAgentRegistry: async () => registry(),
        createAcpRuntime: (options: AcpRuntimeOptions) => {
          expect(options).toMatchObject({
            cwd: process.cwd(),
            agentRegistry: expect.any(Object),
            permissionMode: "deny-all",
          });
          return runtime;
        },
        createRuntimeStore: () => store(),
        createTemporaryStateDir: async () => stateDir,
        removeTemporaryStateDir,
        createSessionKey: () => "one-shot-session",
      },
    });

    expect(trace).toEqual([
      "ensure:persistent",
      "config:model=model-b",
      "config:reasoning_effort=high",
      "status",
      "activate:provider-session-after-config",
      "begin:provider-session-after-config",
      "prompt",
      "close:false",
      "remove-state",
    ]);
    expect(runtimeEvents).toHaveLength(5);
    expect(sessionEvents).toEqual([
      {
        kind: "message_chunk",
        channel: "thought",
        content: { type: "text", text: "reasoning" },
      },
      {
        kind: "tool_call",
        toolCallId: "call-1",
        title: "Read package",
        toolKind: "read",
        status: "in_progress",
        rawInput: { path: "package.json" },
      },
      {
        kind: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: { ok: true },
      },
      {
        kind: "message_chunk",
        channel: "assistant",
        content: { type: "text", text: "done" },
      },
      {
        kind: "usage",
        used: 8,
        size: 128,
        cost: { amount: 0.12, currency: "USD" },
      },
    ]);
    expect(result).toEqual({
      kind: "completed",
      sessionId: "provider-session-after-config",
      turnResult: { status: "completed", stopReason: "end_turn" },
      settlement: {
        kind: "protocol_settled",
        stopReason: "end_turn",
        occupancy: {
          used: 8,
          size: 128,
          cost: { amount: 0.12, currency: "USD" },
        },
      },
      cleanup: { stateRemoved: true, errors: [] },
    });
    expect(removeTemporaryStateDir).toHaveBeenCalledWith(stateDir);
    await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves the ACPX registry at an explicit service scope while keeping the session in its execution workspace", async () => {
    const registryCwds: string[] = [];
    const runtimeCwds: string[] = [];
    const sessionCwds: string[] = [];
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-acpx-one-shot-scope-"),
    );
    const handle: AcpRuntimeHandle = {
      sessionKey: "scope-session",
      backend: "acpx",
      runtimeSessionName: "scope-session",
      backendSessionId: "provider-session",
    };

    const result = await executeAcpxOneShotPrompt({
      cwd: "/execution/workspace",
      registryCwd: "/paperclip/acpx-config",
      agentName: "fixture",
      start: { kind: "new" },
      message: "scoped execution",
      configSelections: [],
      permissionMode: "deny-all",
      dependencies: {
        loadAgentRegistry: async ({ cwd }) => {
          registryCwds.push(cwd);
          return registry();
        },
        createAcpRuntime: (options) => {
          runtimeCwds.push(options.cwd);
          return {
            ensureSession: async (input) => {
              if (!input.cwd) throw new Error("session cwd was omitted");
              sessionCwds.push(input.cwd);
              return handle;
            },
            getStatus: async () => ({ backendSessionId: "provider-session" }),
            startTurn: () => runtimeTurn({
              events: [],
              result: { status: "completed", stopReason: "end_turn" },
            }),
            cancel: async () => {},
            close: async () => {},
          };
        },
        createRuntimeStore: () => store(),
        createTemporaryStateDir: async () => stateDir,
        removeTemporaryStateDir: async (directory) => {
          await fs.rm(directory, { recursive: true, force: true });
        },
        createSessionKey: () => "scope-session",
      },
    });

    expect(result).toMatchObject({ kind: "completed" });
    expect(registryCwds).toEqual(["/paperclip/acpx-config"]);
    expect(runtimeCwds).toEqual(["/execution/workspace"]);
    expect(sessionCwds).toEqual(["/execution/workspace"]);
  });

  it("releases only ACPX state and preserves the provider session for a later resume", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-acpx-one-shot-test-"),
    );
    const handle: AcpRuntimeHandle = {
      sessionKey: "one-shot-session",
      backend: "acpx",
      runtimeSessionName: "one-shot-session",
      backendSessionId: "provider-session",
    };
    const close = vi.fn(async () => {});
    const runtime: AcpxOneShotRuntime = {
      ensureSession: vi.fn(async () => handle),
      setConfigOption: async () => {},
      getStatus: async () => ({ backendSessionId: "provider-session" }),
      startTurn: () =>
        runtimeTurn({
          events: [],
          result: { status: "completed", stopReason: "end_turn" },
        }),
      cancel: async () => {},
      close,
    };
    const removeTemporaryStateDir = vi.fn(async (directory: string) => {
      await fs.rm(directory, { recursive: true, force: true });
    });

    const result = await executeAcpxOneShotPrompt({
      cwd: process.cwd(),
      agentName: "fixture",
      start: { kind: "resume", sessionId: "previous-provider-session" },
      message: "inspect this",
      configSelections: [],
      permissionMode: "deny-all",
      dependencies: {
        loadAgentRegistry: async () => registry(),
        createAcpRuntime: () => runtime,
        createRuntimeStore: () => store(),
        createTemporaryStateDir: async () => stateDir,
        removeTemporaryStateDir,
        createSessionKey: () => "one-shot-session",
      },
    });

    expect(result.kind).toBe("completed");
    expect(result.cleanup).toMatchObject({ stateRemoved: true });
    expect(result.cleanup.errors).toHaveLength(0);
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
    await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses ACPX turn cancellation when an abort arrives during a running prompt", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-acpx-one-shot-test-"),
    );
    const abortController = new AbortController();
    const handle: AcpRuntimeHandle = {
      sessionKey: "one-shot-session",
      backend: "acpx",
      runtimeSessionName: "one-shot-session",
      backendSessionId: "provider-session",
    };
    let cancelled = false;
    let releaseEvents: (() => void) | undefined;
    let resolveTurnResult:
      | ((value: Awaited<AcpRuntimeTurn["result"]>) => void)
      | undefined;
    const turn = {
      requestId: "turn-request",
      events: {
        async *[Symbol.asyncIterator]() {
          if (cancelled) return;
          await new Promise<void>((resolve) => {
            releaseEvents = resolve;
          });
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
    const startTurn = vi.fn(() => turn);
    const runtime: AcpxOneShotRuntime = {
      ensureSession: async () => handle,
      setConfigOption: async () => {},
      getStatus: async () => ({ backendSessionId: "provider-session" }),
      startTurn,
      cancel: vi.fn(async () => {}),
      close: async () => {},
    };
    const removeTemporaryStateDir = vi.fn(async (directory: string) => {
      await fs.rm(directory, { recursive: true, force: true });
    });

    const execution = executeAcpxOneShotPrompt({
      cwd: process.cwd(),
      agentName: "fixture",
      start: { kind: "new" },
      message: "inspect this",
      configSelections: [],
      permissionMode: "deny-all",
      signal: abortController.signal,
      dependencies: {
        loadAgentRegistry: async () => registry(),
        createAcpRuntime: () => runtime,
        createRuntimeStore: () => store(),
        createTemporaryStateDir: async () => stateDir,
        removeTemporaryStateDir,
        createSessionKey: () => "one-shot-session",
      },
    });

    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    abortController.abort(new Error("operator cancelled"));

    await expect(execution).resolves.toMatchObject({
      kind: "cancelled",
      sessionId: "provider-session",
      settlement: null,
    });
    expect(turn.cancel).toHaveBeenCalledWith({
      reason: "Paperclip execution aborted",
    });
    expect(runtime.cancel).not.toHaveBeenCalled();
    await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an ephemeral ACPX handle instead of using its temporary record id as correlation", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-acpx-one-shot-test-"),
    );
    const handle: AcpRuntimeHandle = {
      sessionKey: "one-shot-session",
      backend: "acpx",
      runtimeSessionName: "one-shot-session",
      acpxRecordId: "ephemeral-acpx-record",
    };
    const startTurn = vi.fn();
    const runtime: AcpxOneShotRuntime = {
      ensureSession: async () => handle,
      setConfigOption: async () => {},
      getStatus: async () => ({}),
      startTurn,
      cancel: async () => {},
      close: async () => {},
    };

    const result = await executeAcpxOneShotPrompt({
      cwd: process.cwd(),
      agentName: "fixture",
      start: { kind: "new" },
      message: "inspect this",
      configSelections: [],
      permissionMode: "deny-all",
      dependencies: {
        loadAgentRegistry: async () => registry(),
        createAcpRuntime: () => runtime,
        createRuntimeStore: () => store(),
        createTemporaryStateDir: async () => stateDir,
        removeTemporaryStateDir: async (directory) => {
          await fs.rm(directory, { recursive: true, force: true });
        },
        createSessionKey: () => "one-shot-session",
      },
    });

    expect(result).toMatchObject({
      kind: "error",
      phase: "configuration",
      sessionId: null,
      promptTransmitted: false,
    });
    expect(startTurn).not.toHaveBeenCalled();
    await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an incomplete one-shot lifecycle when private ACPX state cannot be removed", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-acpx-one-shot-test-"),
    );
    const handle: AcpRuntimeHandle = {
      sessionKey: "one-shot-session",
      backend: "acpx",
      runtimeSessionName: "one-shot-session",
      backendSessionId: "provider-session",
    };
    const runtime: AcpxOneShotRuntime = {
      ensureSession: async () => handle,
      setConfigOption: async () => {},
      getStatus: async () => ({ backendSessionId: "provider-session" }),
      startTurn: () => runtimeTurn({
        events: [],
        result: { status: "completed", stopReason: "end_turn" },
      }),
      cancel: async () => {},
      close: async () => {},
    };

    const result = await executeAcpxOneShotPrompt({
      cwd: process.cwd(),
      agentName: "fixture",
      start: { kind: "new" },
      message: "inspect this",
      configSelections: [],
      permissionMode: "deny-all",
      dependencies: {
        loadAgentRegistry: async () => registry(),
        createAcpRuntime: () => runtime,
        createRuntimeStore: () => store(),
        createTemporaryStateDir: async () => stateDir,
        removeTemporaryStateDir: async () => {
          throw new Error("state removal failed");
        },
        createSessionKey: () => "one-shot-session",
      },
    });

    expect(result).toMatchObject({
      kind: "completed",
      cleanup: { stateRemoved: false },
    });
    expect(result.cleanup.errors).toHaveLength(1);
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("rejects non-string configuration values before ACPX creates a session", async () => {
    const createAcpRuntime = vi.fn();

    await expect(
      executeAcpxOneShotPrompt({
        cwd: process.cwd(),
        agentName: "fixture",
        start: { kind: "new" },
        message: "inspect this",
        configSelections: [
          { configId: "fast-mode", value: true as unknown as string },
        ],
        permissionMode: "deny-all",
        dependencies: {
          createAcpRuntime,
        },
      }),
    ).rejects.toThrow(/ACPX config fast-mode value/);
    expect(createAcpRuntime).not.toHaveBeenCalled();
  });
});
