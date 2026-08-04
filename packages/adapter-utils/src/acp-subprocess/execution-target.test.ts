import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpAgentRegistry } from "acpx/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { PaperclipAcpClient } from "./client.js";
import type { AcpSubprocessLaunch } from "./contract.js";
import { prepareAcpExecutionTargetSubprocess } from "./execution-target.js";

const fixtureEntrypoint = fileURLToPath(
  new URL("./fixtures/acp-agent-fixture.mjs", import.meta.url),
);
const temporaryRoots: string[] = [];

function fixtureRegistry(argv: readonly string[] = ["node", fixtureEntrypoint]): AcpAgentRegistry {
  return {
    list: () => ["fixture-agent"],
    resolve(agentName) {
      if (agentName !== "fixture-agent") {
        throw new Error(`unexpected agent: ${agentName}`);
      }
      return [...argv];
    },
  };
}

function fixtureLaunch(cwd: string): AcpSubprocessLaunch {
  return {
    version: "acp-subprocess/v1",
    launch: {
      registryName: "fixture-agent",
      command: "node",
      args: [fixtureEntrypoint],
    },
    cwd,
    additionalDirectories: [],
    environment: {},
    mcpServers: [],
    // The client must apply every generic ACP option in a stable order.
    configOptions: [
      { configId: "zeta-enabled", value: true },
      { configId: "alpha-model", value: "model-b" },
    ],
  };
}

async function fixtureDirectories() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-execution-target-"),
  );
  temporaryRoots.push(root);
  const hostCwd = path.join(root, "host");
  const targetCwd = path.join(root, "target");
  await Promise.all([fs.mkdir(hostCwd), fs.mkdir(targetCwd)]);
  return { hostCwd, targetCwd };
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

describe("ACPX execution-target subprocess preparation", () => {
  it("resolves a generic ACPX registry launch on the target and uses its live ACP wire", async () => {
    const dirs = await fixtureDirectories();
    const launch = fixtureLaunch(dirs.targetCwd);
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "generic-acpx-launch",
      target: { kind: "local" },
      sourceLaunch: { registryName: "fixture-agent" },
      agentRegistry: fixtureRegistry(),
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
    });

    expect(prepared.targetCwd).toBe(dirs.targetCwd);
    expect(prepared.targetNativeExecutable).toMatch(/^\//);
    expect(prepared.targetNodeExecutable).toMatch(/^\//);

    const subprocess = await prepared.startSubprocess(launch, {
      redactStderr: (chunk) => chunk,
    });
    const client = new PaperclipAcpClient({
      launch,
      subprocess,
      operations: {},
      hooks: { onSessionEvent() {} },
    });

    await expect(client.initialize()).resolves.toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: "paperclip-acp-wire-fixture" },
    });
    await expect(client.startSession({ kind: "new" })).resolves.toBe(
      "fixture-new-session",
    );
    client.close();
    await expect(subprocess.closeAndReap()).resolves.toEqual({
      exitCode: 0,
      signal: null,
    });

    const methods = subprocess
      .stderr()
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
    ]);
  });

  it("rejects provider environment input at the generic ACP boundary", async () => {
    const dirs = await fixtureDirectories();
    const launch = fixtureLaunch(dirs.targetCwd);
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "generic-identity-environment",
      target: { kind: "local" },
      sourceLaunch: { registryName: "fixture-agent" },
      agentRegistry: fixtureRegistry(),
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
    });

    await expect(
      prepared.startSubprocess(
        {
          ...launch,
          environment: { PROVIDER_TOKEN: "forbidden" },
        },
        { redactStderr: (chunk) => chunk },
      ),
    ).rejects.toThrow("ACP launch environment must remain empty");
    await prepared.disposeBeforeStart().catch(() => undefined);
  });

  it("rejects a launch whose resolved ACPX argv changed after preparation", async () => {
    const dirs = await fixtureDirectories();
    const launch = fixtureLaunch(dirs.targetCwd);
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "acpx-launch-drift",
      target: { kind: "local" },
      sourceLaunch: { registryName: "fixture-agent" },
      agentRegistry: fixtureRegistry(),
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
      invocationFiles: [{ fileName: "run-tools.json", contents: "secret" }],
    });
    const secretPath = prepared.invocationFilePaths["run-tools.json"]!;

    await expect(
      prepared.startSubprocess(
        {
          ...launch,
          launch: {
            ...launch.launch,
            args: ["--unexpected-argument", fixtureEntrypoint],
          },
        },
        { redactStderr: (chunk) => chunk },
      ),
    ).rejects.toThrow("ACPX launch changed after execution-target preparation");
    await expect(fs.access(secretPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a source name that ACPX did not publish before probing the target", async () => {
    const dirs = await fixtureDirectories();

    await expect(
      prepareAcpExecutionTargetSubprocess({
        runId: "unpublished-acpx-name",
        target: { kind: "local" },
        sourceLaunch: { registryName: "unpublished-agent" },
        agentRegistry: fixtureRegistry(),
        hostCwd: dirs.hostCwd,
        targetCwd: dirs.targetCwd,
        targetAdditionalDirectories: [],
        companySkills: { channel: "operator_native" },
      }),
    ).rejects.toThrow("ACP registry name is not published by ACPX");
  });
});
