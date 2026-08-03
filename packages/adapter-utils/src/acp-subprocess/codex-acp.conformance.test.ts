// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: PAPERCLIP_API_URL, codex-positional-resume, provider-parsed-session-result
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { executeAcpSubprocessPrompt } from "./client.js";
import type { AcpSubprocessLaunch } from "./contract.js";
import type { NormalizedAcpSessionEvent } from "./events.js";
import { prepareAcpExecutionTargetSubprocess } from "./execution-target.js";
import { resolveApprovedAcpLaunch } from "./agent-registry.js";

const nativeFixture = fileURLToPath(
  new URL("./fixtures/codex-app-server-conformance.mjs", import.meta.url),
);
const temporaryRoots: string[] = [];

interface TraceEntry {
  readonly kind: "startup" | "request";
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly environment?: Record<string, string | null>;
}

async function removeFixtureRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await removeFixtureRoot(root);
  }
});

async function targetFixture(label: string) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), `paperclip-codex-acp-${label}-`),
  );
  temporaryRoots.push(root);
  const hostCwd = path.join(root, "host");
  const targetCwd = path.join(root, "target");
  const binDir = path.join(root, "bin");
  await Promise.all([
    fs.mkdir(hostCwd),
    fs.mkdir(targetCwd),
    fs.mkdir(binDir),
  ]);
  const controlledCodex = path.join(binDir, "codex");
  await fs.copyFile(nativeFixture, controlledCodex);
  await fs.chmod(controlledCodex, 0o700);
  return {
    root,
    hostCwd,
    targetCwd,
    binDir,
    controlledCodex,
    tracePath: path.join(
      targetCwd,
      ".paperclip-codex-app-server-trace.ndjson",
    ),
  };
}

function mcpServer(): McpServer {
  return {
    name: "paperclip capability server",
    command: process.execPath,
    args: ["/target/paperclip-run-tools.mjs"],
    env: [{ name: "RUN_TOOLS_GENERATION", value: "7" }],
  };
}

async function readTrace(tracePath: string): Promise<TraceEntry[]> {
  return (await fs.readFile(tracePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEntry);
}

function requestTrace(trace: readonly TraceEntry[], method: string) {
  return trace.filter(
    (entry) => entry.kind === "request" && entry.method === method,
  );
}

async function runConformanceLifecycle(input: {
  readonly label: string;
  readonly start:
    | { readonly kind: "new" }
    | { readonly kind: "resume"; readonly sessionId: string };
  readonly message: string;
  readonly mcpServers: readonly McpServer[];
  readonly cancel?: boolean;
}) {
  const fixture = await targetFixture(input.label);
  const originalEnvironment = {
    PATH: process.env.PATH,
    CODEX_PATH: process.env.CODEX_PATH,
    CODEX_CONFIG: process.env.CODEX_CONFIG,
    CODEX_API_KEY: process.env.CODEX_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    PAPERCLIP_API_URL: process.env.PAPERCLIP_API_URL,
  };
  const ambientHome = path.join(fixture.root, "ambient-home-must-not-cross");
  process.env.PATH = `${fixture.binDir}${path.delimiter}${originalEnvironment.PATH ?? ""}`;
  process.env.CODEX_PATH = "/ambient/incorrect/codex";
  process.env.CODEX_CONFIG = JSON.stringify({
    mcp_servers: { ambient_server: { command: "ambient" } },
  });
  process.env.CODEX_API_KEY = "ambient-codex-secret";
  process.env.OPENAI_API_KEY = "ambient-openai-secret";
  process.env.HOME = ambientHome;
  process.env.USERPROFILE = path.join(fixture.root, "operator-profile");
  process.env.APPDATA = path.join(fixture.root, "operator-appdata");
  process.env.LOCALAPPDATA = path.join(fixture.root, "operator-local-appdata");
  process.env.XDG_CONFIG_HOME = path.join(fixture.root, "operator-xdg-config");
  process.env.XDG_CACHE_HOME = path.join(fixture.root, "operator-xdg-cache");
  process.env.XDG_DATA_HOME = path.join(fixture.root, "operator-xdg-data");
  process.env.XDG_STATE_HOME = path.join(fixture.root, "operator-xdg-state");
  process.env.PAPERCLIP_API_URL = "https://server-state-must-not-cross.invalid";

  try {
    const approved = resolveApprovedAcpLaunch("codex");
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: `conformance-${input.label}`,
      target: { kind: "local" },
      sourceLaunch: approved,
      hostCwd: fixture.hostCwd,
      targetCwd: fixture.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
    });
    expect(prepared.targetNativeExecutable).toBe(fixture.controlledCodex);
    const launch: AcpSubprocessLaunch = {
      version: "acp-subprocess/v1",
      launch: approved,
      cwd: prepared.targetCwd,
      additionalDirectories: prepared.targetAdditionalDirectories,
      environment: Object.freeze({}),
      mcpServers: input.mcpServers,
      // Intentionally reversed: the common client must apply canonical id order.
      configOptions: [
        { configId: "reasoning_effort", value: "low" },
        { configId: "model", value: "gpt-5.6" },
      ],
    };
    const events: NormalizedAcpSessionEvent[] = [];
    const closed: unknown[] = [];
    const abort = new AbortController();
    const result = await executeAcpSubprocessPrompt({
      launch,
      request: { start: input.start, message: input.message },
      startSubprocess: prepared.startSubprocess,
      signal: abort.signal,
      cancellationSettlementTimeoutMs: 2_000,
      async activatePrompt() {},
      async beginPromptTransmission() {
        if (input.cancel) {
          setTimeout(() => abort.abort(new Error("controlled cancellation")), 50);
        }
      },
      async closePrompt(outcome) {
        closed.push(outcome);
      },
      redactStderr: (chunk) => chunk,
      onSessionEvent(event) {
        events.push(event);
      },
    });
    const trace = await readTrace(fixture.tracePath);
    await expect(
      fs.access(prepared.targetFrontendEntrypoint),
    ).rejects.toMatchObject({ code: "ENOENT" });
    return {
      fixture,
      result,
      events,
      closed,
      trace,
      identityEnvironment: {
        HOME: ambientHome,
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      },
    };
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe.sequential("real codex-acp 1.1.7 target conformance", () => {
  it("owns initialize, new, canonical config, MCP replacement, updates, usage, stop, teardown, and cleanup", async () => {
    const execution = await runConformanceLifecycle({
      label: "new",
      start: { kind: "new" },
      message: "new-session-conformance",
      mcpServers: [mcpServer()],
    });

    expect(execution.result).toMatchObject({
      kind: "settled",
      sessionId: "native-new-session",
      settlement: {
        stopReason: "end_turn",
        occupancy: { used: 9, size: 128, cost: null },
      },
      teardown: {
        kind: "reaped",
        processExit: { exitCode: 0, signal: null },
      },
    });
    expect(execution.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message_chunk",
          channel: "assistant",
        }),
        { kind: "usage", used: 9, size: 128, cost: null },
      ]),
    );
    expect(execution.events.at(-1)).toEqual({
      kind: "usage",
      used: 9,
      size: 128,
      cost: null,
    });
    expect(execution.closed).toHaveLength(1);
    expect(requestTrace(execution.trace, "initialize")).toHaveLength(1);
    expect(requestTrace(execution.trace, "thread/start")).toHaveLength(1);
    expect(requestTrace(execution.trace, "thread/resume")).toHaveLength(0);
    const start = requestTrace(execution.trace, "thread/start")[0]!.params!;
    expect(start.config).toMatchObject({
      mcp_servers: {
        paperclip_capability_server: {
          command: process.execPath,
          args: ["/target/paperclip-run-tools.mjs"],
          env: { RUN_TOOLS_GENERATION: "7" },
        },
      },
    });
    expect(Object.keys((start.config as { mcp_servers: object }).mcp_servers)).toEqual([
      "paperclip_capability_server",
    ]);
    const turn = requestTrace(execution.trace, "turn/start")[0]!.params!;
    expect(turn).toMatchObject({
      threadId: "native-new-session",
      model: "gpt-5.6",
      effort: "low",
    });
    const startup = execution.trace.find((entry) => entry.kind === "startup")!;
    expect(startup.environment).toMatchObject({
      CODEX_PATH: execution.fixture.controlledCodex,
      CODEX_CONFIG: null,
      CODEX_API_KEY: null,
      OPENAI_API_KEY: null,
      SERVER_CONTROL_ENV: null,
    });
    expect(startup.environment).toMatchObject(execution.identityEnvironment);
  });

  it("resumes the exact native session through the same prepared boundary", async () => {
    const execution = await runConformanceLifecycle({
      label: "resume",
      start: { kind: "resume", sessionId: "native-resume-session" },
      message: "resume-session-conformance",
      mcpServers: [],
    });
    expect(execution.result).toMatchObject({
      kind: "settled",
      sessionId: "native-resume-session",
      settlement: { stopReason: "end_turn" },
      teardown: { kind: "reaped" },
    });
    expect(requestTrace(execution.trace, "thread/start")).toHaveLength(0);
    expect(requestTrace(execution.trace, "thread/resume")).toHaveLength(1);
    expect(
      requestTrace(execution.trace, "thread/resume")[0]!.params,
    ).toMatchObject({ threadId: "native-resume-session" });
  });

  it("forwards cancel and fails incomplete when codex-acp emits post-usage interrupt text", async () => {
    const execution = await runConformanceLifecycle({
      label: "cancel",
      start: { kind: "new" },
      message: "wait-for-cancel",
      mcpServers: [],
      cancel: true,
    });
    expect(execution.result).toMatchObject({
      kind: "error",
      failure: "runtime",
      phase: "prompt",
      promptTransmitted: true,
      teardown: {
        kind: "reaped",
        processExit: { exitCode: null, signal: "SIGTERM" },
      },
    });
    expect(
      execution.result.kind === "error" && execution.result.cause,
    ).toMatchObject({
      message:
        "ACP prompt stopped without an immediately preceding terminal usage update",
    });
    expect(execution.result).not.toHaveProperty("settlement");
    expect(requestTrace(execution.trace, "turn/interrupt")).toHaveLength(1);
    expect(execution.events.at(-1)).toMatchObject({
      kind: "message_chunk",
      channel: "assistant",
    });
    expect(execution.closed).toHaveLength(1);
    expect(execution.closed[0]).toMatchObject({
      kind: "error",
      phase: "prompt",
      promptTransmitted: true,
    });
  });
});
