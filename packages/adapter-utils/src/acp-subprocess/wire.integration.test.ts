import path from "node:path";
import { fileURLToPath } from "node:url";
import { RequestError, type McpServer } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  PaperclipAcpClient,
  executeAcpSubprocessPrompt,
  isAcpTargetNotFoundError,
} from "./client.js";
import type { AcpSubprocessLaunch } from "./contract.js";
import type { NormalizedAcpSessionEvent } from "./events.js";
import {
  spawnPreparedAcpSubprocess,
  type AcpSubprocess,
  type AcpSubprocessStartOptions,
} from "./process.js";

const fixtureEntrypoint = fileURLToPath(
  new URL("./fixtures/acp-agent-fixture.mjs", import.meta.url),
);
const fixtureCwd = path.resolve(process.cwd());
const additionalDirectory = path.resolve(fixtureCwd, "packages");

interface TraceEntry {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function fixtureMcpServer(generation: string): McpServer {
  return {
    name: `paperclip-${generation}`,
    command: process.execPath,
    args: [path.resolve(fixtureCwd, "fixture-run-tools.mjs")],
    env: [{ name: "PAPERCLIP_CAPABILITY_GENERATION", value: generation }],
  };
}

function fixtureLaunch(input: {
  readonly mode?:
    | "normal"
    | "ignore-cancel"
    | "target-not-found"
    | "resume-error"
    | "missing-usage"
    | "config-option-removed"
    | "config-type-drift"
    | "config-legal-values-drift"
    | "config-unrequested-current-drift"
    | "early-setup-controls";
  readonly generation: string;
}): AcpSubprocessLaunch {
  return {
    version: "acp-subprocess/v1",
    launch: {
      registryName: "fixture",
      targetNativeCli: "fixture-native",
      command: process.execPath,
      args: [fixtureEntrypoint],
      frontendPackage: "paperclip-acp-wire-fixture",
      frontendVersion: "1",
      frontendDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
    cwd: fixtureCwd,
    additionalDirectories: [additionalDirectory],
    environment: {
      PAPERCLIP_ACP_FIXTURE_MODE: input.mode ?? "normal",
    },
    mcpServers: [fixtureMcpServer(input.generation)],
    configOptions: [
      { configId: "zeta-enabled", value: true },
      { configId: "alpha-model", value: "model-b" },
    ],
  };
}

function spawnFixtureAcpSubprocess(
  launch: AcpSubprocessLaunch,
  options: AcpSubprocessStartOptions,
): AcpSubprocess {
  return spawnPreparedAcpSubprocess(
    launch,
    {
      command: launch.launch.command,
      args: launch.launch.args,
      cwd: launch.cwd,
      environment: launch.environment,
    },
    options,
  );
}

function traces(subprocess: AcpSubprocess): TraceEntry[] {
  return subprocess
    .stderr()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TraceEntry);
}

async function closeAndReap(
  client: PaperclipAcpClient,
  subprocess: AcpSubprocess,
): Promise<TraceEntry[]> {
  client.close();
  const exit = await subprocess.closeAndReap();
  expect(exit).toEqual({ exitCode: 0, signal: null });
  return traces(subprocess);
}

function startFixture(input: {
  readonly mode?:
    | "normal"
    | "ignore-cancel"
    | "target-not-found"
    | "resume-error"
    | "missing-usage"
    | "config-option-removed"
    | "config-type-drift"
    | "config-legal-values-drift"
    | "config-unrequested-current-drift"
    | "early-setup-controls";
  readonly generation: string;
  readonly onEvent?: (event: NormalizedAcpSessionEvent) => void;
}) {
  const launch = fixtureLaunch(input);
  const subprocess = spawnFixtureAcpSubprocess(launch, {
    redactStderr: (chunk) => chunk,
  });
  const events: NormalizedAcpSessionEvent[] = [];
  const violations: Error[] = [];
  const client = new PaperclipAcpClient({
    launch,
    subprocess,
    operations: {},
    hooks: {
      onSessionEvent(event) {
        events.push(event);
        input.onEvent?.(event);
      },
      onProtocolViolation(error) {
        violations.push(error);
      },
    },
  });
  return { client, events, launch, subprocess, violations };
}

describe("official ACP subprocess wire", () => {
  it("rejects config ids with surrounding whitespace before opening ACP", async () => {
    const launch: AcpSubprocessLaunch = {
      ...fixtureLaunch({ generation: "invalid-config-id-generation" }),
      configOptions: [{ configId: "alpha-model ", value: "model-b" }],
    };
    const subprocess = spawnFixtureAcpSubprocess(launch, {
      redactStderr: (chunk) => chunk,
    });

    expect(
      () =>
        new PaperclipAcpClient({
          launch,
          subprocess,
          operations: {},
          hooks: { onSessionEvent() {} },
        }),
    ).toThrow(/config option ids must be exact and unique/);

    subprocess.cancel();
    await subprocess.closeAndReap();
  });

  it("tentatively owns safe setup controls before new/resume responses", async () => {
    for (const start of [
      { kind: "new" as const },
      { kind: "resume" as const, sessionId: "early-resume-session" },
    ]) {
      const run = startFixture({
        generation: `early-${start.kind}-generation`,
        mode: "early-setup-controls",
      });
      await run.client.initialize();
      await expect(run.client.startSession(start)).resolves.toBe(
        start.kind === "new" ? "fixture-new-session" : start.sessionId,
      );
      expect(run.client.state).toBe("session_ready");
      expect(run.events).toEqual([]);
      expect(run.violations).toEqual([]);
      await closeAndReap(run.client, run.subprocess);
    }
  });

  it("owns one complete fresh-process prompt lifecycle", async () => {
    const launch = fixtureLaunch({ generation: "execution-generation" });
    const events: NormalizedAcpSessionEvent[] = [];
    const activatedSessions: string[] = [];
    const closedOutcomes: unknown[] = [];
    const result = await executeAcpSubprocessPrompt({
      launch,
      request: { start: { kind: "new" }, message: "one lifecycle" },
      startSubprocess: spawnFixtureAcpSubprocess,
      async activatePrompt({ sessionId }) {
        activatedSessions.push(sessionId);
      },
      async beginPromptTransmission({ sessionId }) {
        expect(sessionId).toBe("fixture-new-session");
      },
      async closePrompt(outcome) {
        closedOutcomes.push(outcome);
      },
      redactStderr: (chunk) => chunk,
      onSessionEvent(event) {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      kind: "settled",
      sessionId: "fixture-new-session",
      settlement: {
        kind: "protocol_settled",
        stopReason: "end_turn",
        occupancy: { used: 9, size: 128, cost: null },
      },
      cancellationNotificationError: null,
      closureError: null,
      teardown: {
        kind: "reaped",
        processExit: { exitCode: 0, signal: null },
      },
    });
    expect(events.at(-1)).toEqual({
      kind: "usage",
      used: 9,
      size: 128,
      cost: null,
    });
    expect(activatedSessions).toEqual(["fixture-new-session"]);
    expect(closedOutcomes).toEqual([
      {
        kind: "settled",
        sessionId: "fixture-new-session",
        settlement: {
          kind: "protocol_settled",
          stopReason: "end_turn",
          occupancy: { used: 9, size: 128, cost: null },
        },
        cancellationNotificationError: null,
      },
    ]);
    const methods =
      result.kind === "settled"
        ? result.stderr
            .split("\n")
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as TraceEntry).method)
        : [];
    expect(methods).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
  });

  it("returns target_not_found without retrying inside the failed process", async () => {
    const launch = fixtureLaunch({
      generation: "execution-missing-generation",
      mode: "target-not-found",
    });
    const closedOutcomes: unknown[] = [];
    const result = await executeAcpSubprocessPrompt({
      launch,
      request: {
        start: { kind: "resume", sessionId: "missing-native-session" },
        message: "must not be sent",
      },
      startSubprocess: spawnFixtureAcpSubprocess,
      async activatePrompt() {
        throw new Error("target-not-found must not reach prompt activation");
      },
      async beginPromptTransmission() {
        throw new Error("target-not-found must not reach prompt transmission");
      },
      async closePrompt(outcome) {
        closedOutcomes.push(outcome);
      },
      redactStderr: (chunk) => chunk,
      onSessionEvent() {},
    });

    expect(result).toMatchObject({
      kind: "target_not_found",
      closureError: null,
      teardown: {
        kind: "reaped",
        processExit: { exitCode: 0, signal: null },
      },
    });
    const methods =
      result.kind === "target_not_found"
        ? result.stderr
            .split("\n")
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as TraceEntry).method)
        : [];
    expect(methods).toEqual(["initialize", "session/resume"]);
    expect(closedOutcomes).toEqual([{ kind: "target_not_found" }]);
  });

  it("fails closed after setup when prompt activation does not commit", async () => {
    const launch = fixtureLaunch({
      generation: "activation-failure-generation",
    });
    const closedOutcomes: unknown[] = [];
    const result = await executeAcpSubprocessPrompt({
      launch,
      request: { start: { kind: "new" }, message: "must not be sent" },
      startSubprocess: spawnFixtureAcpSubprocess,
      async activatePrompt({ sessionId }) {
        expect(sessionId).toBe("fixture-new-session");
        throw new Error("activation fence rejected");
      },
      async beginPromptTransmission() {
        throw new Error("failed activation must not reach prompt transmission");
      },
      async closePrompt(outcome) {
        closedOutcomes.push(outcome);
      },
      redactStderr: (chunk) => chunk,
      onSessionEvent() {},
    });

    expect(result).toMatchObject({
      kind: "error",
      phase: "prompt_activation",
      promptTransmitted: false,
      teardown: {
        kind: "reaped",
        processExit: { exitCode: 0, signal: null },
      },
    });
    const methods =
      result.kind === "error"
        ? result.stderr
            .split("\n")
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as TraceEntry).method)
        : [];
    expect(methods).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
    ]);
    expect(closedOutcomes).toHaveLength(1);
    expect(closedOutcomes[0]).toMatchObject({
      kind: "error",
      phase: "prompt_activation",
      promptTransmitted: false,
    });
  });

  it("normalizes native CLI authentication and redacts provider detail", async () => {
    const launch = fixtureLaunch({
      generation: "authentication-required-generation",
    });
    const closedOutcomes: unknown[] = [];
    const result = await executeAcpSubprocessPrompt({
      launch,
      request: { start: { kind: "new" }, message: "must not be sent" },
      async startSubprocess() {
        throw RequestError.authRequired(
          { secret: "provider-native-detail" },
          "provider-native-detail",
        );
      },
      async activatePrompt() {},
      async beginPromptTransmission() {},
      async closePrompt(outcome) {
        closedOutcomes.push(outcome);
      },
      redactStderr() {
        throw new Error("redactor unavailable");
      },
      onSessionEvent() {},
    });

    expect(result).toMatchObject({
      kind: "error",
      failure: "authentication_required",
      phase: "spawn",
      promptTransmitted: false,
      teardown: { kind: "not_started" },
    });
    expect(closedOutcomes).toHaveLength(1);
    expect(closedOutcomes[0]).toMatchObject({
      kind: "error",
      failure: "authentication_required",
      phase: "spawn",
      promptTransmitted: false,
    });
    expect(result.kind === "error" && result.cause).toMatchObject({
      message: "[ACP runtime redaction failed]",
    });
    expect(JSON.stringify({ result, closedOutcomes })).not.toContain(
      "provider-native-detail",
    );
  });

  it("sends no prompt when the durable transmission fence rejects", async () => {
    const launch = fixtureLaunch({
      generation: "transmission-failure-generation",
    });
    const result = await executeAcpSubprocessPrompt({
      launch,
      request: { start: { kind: "new" }, message: "must not be sent" },
      startSubprocess: spawnFixtureAcpSubprocess,
      async activatePrompt() {},
      async beginPromptTransmission() {
        throw new Error("transmission fence rejected");
      },
      async closePrompt() {},
      redactStderr: (chunk) => chunk,
      onSessionEvent() {},
    });

    expect(result).toMatchObject({
      kind: "error",
      phase: "prompt_transmission",
      promptTransmitted: false,
    });
    const methods =
      result.kind === "error"
        ? result.stderr
            .split("\n")
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as TraceEntry).method)
        : [];
    expect(methods).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
    ]);
  });

  it("preserves protocol settlement when the prompt-closure transaction rejects", async () => {
    const launch = fixtureLaunch({
      generation: "closure-failure-generation",
    });
    const result = await executeAcpSubprocessPrompt({
      launch,
      request: { start: { kind: "new" }, message: "close before expose" },
      startSubprocess: spawnFixtureAcpSubprocess,
      async activatePrompt() {},
      async beginPromptTransmission() {},
      async closePrompt(outcome) {
        expect(outcome.kind).toBe("settled");
        throw new Error("closure transaction rejected");
      },
      redactStderr: (chunk) => chunk,
      onSessionEvent() {},
    });

    expect(result).toMatchObject({
      kind: "settled",
      sessionId: "fixture-new-session",
      settlement: {
        kind: "protocol_settled",
        stopReason: "end_turn",
        occupancy: { used: 9, size: 128, cost: null },
      },
      teardown: {
        kind: "reaped",
        processExit: { exitCode: null, signal: "SIGTERM" },
      },
    });
    expect(result.closureError).toBeInstanceOf(Error);
    expect((result.closureError as Error).message).toBe(
      "closure transaction rejected",
    );
  });

  it("preserves protocol settlement when subprocess teardown reporting fails", async () => {
    const launch = fixtureLaunch({
      generation: "teardown-failure-generation",
    });
    const result = await executeAcpSubprocessPrompt({
      launch,
      request: { start: { kind: "new" }, message: "retain settlement" },
      async startSubprocess(nextLaunch, options) {
        const subprocess = spawnFixtureAcpSubprocess(nextLaunch, options);
        return {
          ...subprocess,
          async closeAndReap(graceMs) {
            await subprocess.closeAndReap(graceMs);
            throw new Error("target cleanup rejected");
          },
        };
      },
      async activatePrompt() {},
      async beginPromptTransmission() {},
      async closePrompt() {},
      redactStderr: (chunk) => chunk,
      onSessionEvent() {},
    });

    expect(result).toMatchObject({
      kind: "settled",
      sessionId: "fixture-new-session",
      settlement: {
        kind: "protocol_settled",
        stopReason: "end_turn",
        occupancy: { used: 9, size: 128, cost: null },
      },
      closureError: null,
      teardown: { kind: "failed" },
    });
    expect(result.teardown.kind).toBe("failed");
    if (result.teardown.kind === "failed") {
      expect(result.teardown.cause).toBeInstanceOf(Error);
      expect((result.teardown.cause as Error).message).toBe(
        "target cleanup rejected",
      );
    }
  });

  it("uses ACP cancellation before closing and then runs the closure fence", async () => {
    const launch = fixtureLaunch({
      generation: "execution-cancel-generation",
    });
    const controller = new AbortController();
    const closedOutcomes: unknown[] = [];
    let cancelled = false;
    const result = await executeAcpSubprocessPrompt({
      launch,
      request: { start: { kind: "new" }, message: "wait-for-cancel" },
      startSubprocess: spawnFixtureAcpSubprocess,
      async activatePrompt() {},
      async beginPromptTransmission() {},
      async closePrompt(outcome) {
        closedOutcomes.push(outcome);
      },
      signal: controller.signal,
      redactStderr: (chunk) => chunk,
      onSessionEvent() {
        if (!cancelled) {
          cancelled = true;
          controller.abort(new Error("steering requested"));
        }
      },
    });

    expect(result).toMatchObject({
      kind: "settled",
      settlement: {
        kind: "protocol_settled",
        stopReason: "cancelled",
        occupancy: { used: 3, size: 128, cost: null },
      },
      cancellationNotificationError: null,
      closureError: null,
      teardown: {
        kind: "reaped",
        processExit: { exitCode: 0, signal: null },
      },
    });
    expect(closedOutcomes).toEqual([
      {
        kind: "settled",
        sessionId: "fixture-new-session",
        settlement: {
          kind: "protocol_settled",
          stopReason: "cancelled",
          occupancy: { used: 3, size: 128, cost: null },
        },
        cancellationNotificationError: null,
      },
    ]);
  });

  it("force-terminates a cancelled prompt that does not settle by the deadline", async () => {
    const launch = fixtureLaunch({
      generation: "execution-cancel-timeout-generation",
      mode: "ignore-cancel",
    });
    const controller = new AbortController();
    let cancelled = false;
    const result = await executeAcpSubprocessPrompt({
      launch,
      request: { start: { kind: "new" }, message: "wait-for-cancel" },
      startSubprocess: spawnFixtureAcpSubprocess,
      async activatePrompt() {},
      async beginPromptTransmission() {},
      async closePrompt() {},
      cancellationSettlementTimeoutMs: 25,
      signal: controller.signal,
      redactStderr: (chunk) => chunk,
      onSessionEvent() {
        if (!cancelled) {
          cancelled = true;
          controller.abort(new Error("bounded cancellation requested"));
        }
      },
    });

    expect(result).toMatchObject({
      kind: "error",
      phase: "prompt",
      promptTransmitted: true,
      closureError: null,
      teardown: { kind: "reaped" },
    });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid cancellation settlement timeout %s before spawning",
    async (cancellationSettlementTimeoutMs) => {
      let spawnCalls = 0;
      await expect(
        executeAcpSubprocessPrompt({
          launch: fixtureLaunch({
            generation: "invalid-cancel-timeout-generation",
          }),
          request: { start: { kind: "new" }, message: "must-not-spawn" },
          startSubprocess() {
            spawnCalls += 1;
            throw new Error("must not spawn");
          },
          async activatePrompt() {},
          async beginPromptTransmission() {},
          async closePrompt() {},
          cancellationSettlementTimeoutMs,
          redactStderr: (chunk) => chunk,
          onSessionEvent() {},
        }),
      ).rejects.toThrow(
        "ACP cancellation settlement timeout must be a positive integer",
      );
      expect(spawnCalls).toBe(0);
    },
  );

  it("uses stable wire v1 for initialize/new, sorted config, one prompt, and streamed updates", async () => {
    const run = startFixture({ generation: "new-generation" });

    const initialized = await run.client.initialize();
    expect(initialized.protocolVersion).toBe(1);
    expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toEqual(
      {},
    );

    await expect(run.client.startSession({ kind: "new" })).resolves.toBe(
      "fixture-new-session",
    );
    await expect(run.client.prompt("exact source bytes")).resolves.toEqual({
      kind: "protocol_settled",
      stopReason: "end_turn",
      occupancy: { used: 9, size: 128, cost: null },
    });

    const trace = await closeAndReap(run.client, run.subprocess);
    expect(trace.map((entry) => entry.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(trace[0]?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "paperclip", version: "1" },
    });
    expect(trace[1]?.params).toEqual({
      cwd: fixtureCwd,
      additionalDirectories: [additionalDirectory],
      mcpServers: run.launch.mcpServers,
    });
    expect(trace.slice(2, 4).map((entry) => entry.params)).toEqual([
      {
        sessionId: "fixture-new-session",
        configId: "alpha-model",
        value: "model-b",
      },
      {
        sessionId: "fixture-new-session",
        configId: "zeta-enabled",
        type: "boolean",
        value: true,
      },
    ]);
    expect(trace[4]?.params).toEqual({
      sessionId: "fixture-new-session",
      prompt: [{ type: "text", text: "exact source bytes" }],
    });
    expect(run.events).toEqual([
      {
        kind: "message_chunk",
        channel: "thought",
        content: { type: "text", text: "fixture thinking" },
      },
      {
        kind: "plan",
        entries: [
          {
            content: "exercise the wire",
            priority: "high",
            status: "in_progress",
          },
        ],
      },
      {
        kind: "tool_call",
        toolCallId: "fixture-tool",
        title: "Fixture tool",
        toolKind: "other",
        status: "in_progress",
        rawInput: { text: "exact source bytes" },
      },
      {
        kind: "tool_call_update",
        toolCallId: "fixture-tool",
        status: "completed",
        rawOutput: { ok: true },
      },
      {
        kind: "message_chunk",
        channel: "assistant",
        content: { type: "text", text: "fixture:exact source bytes" },
      },
      { kind: "usage", used: 9, size: 128, cost: null },
    ]);
    expect(run.violations).toEqual([]);
  });

  it("uses stable resume with the request's complete replacement MCP set", async () => {
    const run = startFixture({ generation: "resume-generation" });
    await run.client.initialize();
    await expect(
      run.client.startSession({
        kind: "resume",
        sessionId: "opaque-native-session",
      }),
    ).resolves.toBe("opaque-native-session");
    await expect(run.client.prompt("resume bytes")).resolves.toEqual({
      kind: "protocol_settled",
      stopReason: "end_turn",
      occupancy: { used: 9, size: 128, cost: null },
    });

    const trace = await closeAndReap(run.client, run.subprocess);
    expect(trace.map((entry) => entry.method)).toEqual([
      "initialize",
      "session/resume",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(trace[1]?.params).toEqual({
      sessionId: "opaque-native-session",
      cwd: fixtureCwd,
      additionalDirectories: [additionalDirectory],
      mcpServers: run.launch.mcpServers,
    });
    expect(trace.some((entry) => entry.method === "session/new")).toBe(false);
    expect(trace[4]?.params).toEqual({
      sessionId: "opaque-native-session",
      prompt: [{ type: "text", text: "resume bytes" }],
    });
    expect(run.violations).toEqual([]);
  });

  it.each([
    ["config-option-removed", /changed its advertised config option set/],
    ["config-type-drift", /changed config option .* type or legal values/],
    [
      "config-legal-values-drift",
      /changed config option .* type or legal values/,
    ],
    [
      "config-unrequested-current-drift",
      /changed outside the requested sequence/,
    ],
  ] as const)(
    "rejects %s across the complete session configuration response",
    async (mode, expected) => {
      const run = startFixture({
        generation: `${mode}-generation`,
        mode,
      });
      await run.client.initialize();

      await expect(run.client.startSession({ kind: "new" })).rejects.toThrow(
        expected,
      );
      expect(run.client.state).toBe("terminal");
      run.client.close();
      await run.subprocess.closeAndReap();
    },
  );

  it("classifies only exact ACP resource-not-found as target_not_found", async () => {
    const run = startFixture({
      generation: "missing-generation",
      mode: "target-not-found",
    });
    await run.client.initialize();

    const error = await run.client
      .startSession({ kind: "resume", sessionId: "missing-native-session" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: -32002 });
    expect(isAcpTargetNotFoundError(error)).toBe(true);
    expect(run.client.state).toBe("terminal");
    await expect(
      run.client.startSession({ kind: "new" }),
    ).rejects.toThrow(/invalid in state terminal/);
    expect(
      isAcpTargetNotFoundError(
        new RequestError(-32001, "another ACP request error"),
      ),
    ).toBe(false);
    expect(
      isAcpTargetNotFoundError({ code: -32002, message: "lookalike" }),
    ).toBe(false);

    const trace = await closeAndReap(run.client, run.subprocess);
    expect(trace.map((entry) => entry.method)).toEqual([
      "initialize",
      "session/resume",
    ]);
  });

  it("keeps every other resume failure on the error path without session/new", async () => {
    const run = startFixture({
      generation: "error-generation",
      mode: "resume-error",
    });
    await run.client.initialize();

    const error = await run.client
      .startSession({ kind: "resume", sessionId: "unavailable-native-session" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: -32603 });
    expect(isAcpTargetNotFoundError(error)).toBe(false);
    expect(run.client.state).toBe("terminal");
    await expect(
      run.client.startSession({ kind: "new" }),
    ).rejects.toThrow(/invalid in state terminal/);

    const trace = await closeAndReap(run.client, run.subprocess);
    expect(trace.map((entry) => entry.method)).toEqual([
      "initialize",
      "session/resume",
    ]);
  });

  it("sends session/cancel and waits for the prompt's cancelled stop response", async () => {
    let releaseFirstUpdate: (() => void) | undefined;
    const firstUpdate = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const run = startFixture({
      generation: "cancel-generation",
      onEvent() {
        releaseFirstUpdate?.();
        releaseFirstUpdate = undefined;
      },
    });
    await run.client.initialize();
    await run.client.startSession({ kind: "new" });

    const prompt = run.client.prompt("wait-for-cancel");
    await firstUpdate;
    expect(run.client.state).toBe("prompt_active");
    await run.client.cancel();
    await expect(prompt).resolves.toEqual({
      kind: "protocol_settled",
      stopReason: "cancelled",
      occupancy: { used: 3, size: 128, cost: null },
    });
    expect(run.client.state).toBe("terminal");

    const trace = await closeAndReap(run.client, run.subprocess);
    expect(trace.map((entry) => entry.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
      "session/cancel",
    ]);
    expect(trace.at(-1)?.params).toEqual({
      sessionId: "fixture-new-session",
    });
    expect(run.events.at(-1)).toEqual({
      kind: "usage",
      used: 3,
      size: 128,
      cost: null,
    });
    expect(run.violations).toEqual([]);
  });

  it("rejects a stop response without immediately preceding terminal usage", async () => {
    const run = startFixture({
      generation: "missing-usage-generation",
      mode: "missing-usage",
    });
    await run.client.initialize();
    await run.client.startSession({ kind: "new" });

    await expect(run.client.prompt("missing usage")).rejects.toThrow(
      /immediately preceding terminal usage update/,
    );
    expect(run.violations).toHaveLength(1);

    run.client.close();
    const exit = await run.subprocess.exited;
    expect(exit.exitCode === 0 || exit.signal === "SIGTERM").toBe(true);
  });
});
