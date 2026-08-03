import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AdapterExecutionTarget,
  AdapterExecutionTargetProcessSessionBridgeHandle,
} from "../execution-target.js";
import type { CommandManagedRuntimeRunner } from "../command-managed-runtime.js";
import * as executionTargetModule from "../execution-target.js";
import * as materializationModule from "../execution-target-materialization.js";
import * as localSandboxModule from "../local-process-sandbox.js";
import * as selectedCompanySkillsModule from "../selected-company-skills.js";
import * as sshModule from "../ssh.js";
import type { AcpSubprocessLaunch } from "./contract.js";
import { resolveApprovedAcpLaunch } from "./agent-registry.js";
import { PaperclipAcpClient } from "./client.js";
import { prepareAcpExecutionTargetSubprocess } from "./execution-target.js";
import * as processModule from "./process.js";
import {
  spawnPreparedAcpSubprocess,
  type AcpSubprocessHostLaunch,
} from "./process.js";

const realSpawnPreparedAcpSubprocess = spawnPreparedAcpSubprocess;
const cleanupDirectories: string[] = [];
const nativeFixture = fileURLToPath(
  new URL("./fixtures/codex-app-server-conformance.mjs", import.meta.url),
);
let nativeFixtureRoot: string | null = null;
let originalPath: string | undefined;

async function removeFixtureDirectory(directory: string): Promise<void> {
  const stats = await fs.lstat(directory).catch(() => null);
  if (!stats) return;
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    await fs.chmod(directory, 0o700);
    const children = await fs.readdir(directory);
    await Promise.all(
      children.map((child) =>
        removeFixtureDirectory(path.join(directory, child)),
      ),
    );
  }
  await fs.rm(directory, { recursive: true, force: true });
}

beforeAll(async () => {
  nativeFixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acp-target-native-"),
  );
  const fixtureBin = path.join(nativeFixtureRoot, "bin");
  await fs.mkdir(fixtureBin);
  const controlledCodex = path.join(fixtureBin, "codex");
  await fs.copyFile(nativeFixture, controlledCodex);
  await fs.chmod(controlledCodex, 0o700);
  originalPath = process.env.PATH;
  process.env.PATH = `${fixtureBin}${path.delimiter}${originalPath ?? ""}`;
});

afterAll(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (nativeFixtureRoot) await removeFixtureDirectory(nativeFixtureRoot);
});

function successfulResult(stdout = "", stderr = "") {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    pid: null,
    startedAt: new Date(0).toISOString(),
  };
}

function targetRuntimeFixture(
  nodeExecutable = "/opt/paperclip/node/bin/node",
  tamperFrontend = false,
) {
  const nativeExecutable = "/opt/openai/bin/codex";
  const files = new Map<string, string>();
  const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  const execute: CommandManagedRuntimeRunner["execute"] = vi.fn(
    async (input) => {
      const args = input.args ?? [];
      calls.push({ command: input.command, args: [...args] });
      const shellScript =
        (input.command === "sh" || input.command === "bash") &&
        (args[0] === "-c" || args[0] === "-lc")
          ? args[1] ?? ""
          : "";
      if (shellScript === "command -v node") {
        return successfulResult(`${nodeExecutable}\n`);
      }
      if (shellScript === "command -v codex") {
        return successfulResult(`${nativeExecutable}\n`);
      }
      if (shellScript === "command -v bwrap") {
        return successfulResult("/opt/paperclip/bin/bwrap\n");
      }
      if (shellScript.includes("process.stdout.write(process.execPath)")) {
        return successfulResult(nodeExecutable);
      }
      if (shellScript.includes("realpathSync")) {
        return successfulResult(nativeExecutable);
      }
      if (shellScript.includes("createHash") && shellScript.includes("sha256")) {
        const pathMatch = /'([^']+)'$/.exec(shellScript);
        const contents = pathMatch?.[1]
          ? files.get(pathMatch[1])
          : undefined;
        if (contents === undefined) {
          return { ...successfulResult("", "missing artifact"), exitCode: 1 };
        }
        return successfulResult(
          createHash("sha256").update(contents, "utf8").digest("hex"),
        );
      }
      if (shellScript.includes("cat > ")) {
        const match = /cat > '([^']+)'/.exec(shellScript);
        if (!match?.[1] || input.stdin === undefined) {
          return { ...successfulResult("", "invalid write"), exitCode: 1 };
        }
        files.set(
          match[1],
          tamperFrontend && match[1].endsWith("codex-acp-1.1.7.mjs")
            ? `${input.stdin}\n// drift`
            : input.stdin,
        );
        return successfulResult();
      }
      if (shellScript.startsWith("rm -rf ")) {
        const match = /rm -rf '([^']+)'/.exec(shellScript);
        if (match?.[1]) {
          for (const filePath of files.keys()) {
            if (filePath.startsWith(`${match[1]}/`)) files.delete(filePath);
          }
        }
        return successfulResult();
      }
      if (
        input.command === nodeExecutable &&
        args[0] === "-e" &&
        args[1] === "process.stdout.write(process.execPath)"
      ) {
        return successfulResult(nodeExecutable);
      }
      if (
        input.command === nodeExecutable &&
        args[0] === "-e" &&
        args[1]?.includes("realpathSync") &&
        args[2] === nativeExecutable
      ) {
        return successfulResult(nativeExecutable);
      }
      if (
        input.command === nodeExecutable &&
        args[0] === "-e" &&
        args[1]?.includes('createHash("sha256")') &&
        args[2]
      ) {
        const contents = files.get(args[2]);
        if (contents === undefined) {
          return { ...successfulResult("", "missing artifact"), exitCode: 1 };
        }
        return successfulResult(
          createHash("sha256").update(contents, "utf8").digest("hex"),
        );
      }
      return { ...successfulResult("", "unexpected command"), exitCode: 1 };
    },
  );
  return {
    calls,
    files,
    nativeExecutable,
    runner: {
      execute,
      cancelExecution: vi.fn(async ({ executionId }) => ({
        executionId,
        cancelled: true,
      })),
    } satisfies CommandManagedRuntimeRunner,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory) {
      await removeFixtureDirectory(directory);
    }
  }
});

function fixtureLaunch(input: {
  cwd: string;
  additionalDirectories?: readonly string[];
  environment?: Readonly<Record<string, string>>;
}): AcpSubprocessLaunch {
  return {
    version: "acp-subprocess/v1",
    launch: resolveApprovedAcpLaunch("codex"),
    cwd: input.cwd,
    additionalDirectories: input.additionalDirectories ?? [],
    environment: input.environment ?? {},
    mcpServers: [],
    configOptions: [{ configId: "model", value: "fixture" }],
  };
}

async function fixtureDirectories() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acp-target-"),
  );
  cleanupDirectories.push(root);
  const hostCwd = path.join(root, "host");
  const targetCwd = path.join(root, "target");
  const additional = path.join(root, "additional");
  await Promise.all([
    fs.mkdir(hostCwd),
    fs.mkdir(targetCwd),
    fs.mkdir(additional),
  ]);
  return { root, hostCwd, targetCwd, additional };
}

function isolatedCompanySkills(label: string) {
  return {
    channel: "isolated_skills_home" as const,
    identity: {
      companyId: `company-${label}`,
      agentId: `agent-${label}`,
      executionTargetIdentity: createHash("sha256")
        .update(`target-${label}`)
        .digest("hex"),
      adapterConfigRevisionId: `revision-${label}`,
    },
    entries: [
      {
        key: `paperclipai/paperclip/${label}`,
        runtimeName: label,
        versionId: `version-${label}`,
        files: [
          {
            path: "SKILL.md",
            kind: "skill" as const,
            content: `# ${label}\n`,
          },
          {
            path: "references/contract.md",
            kind: "reference" as const,
            content: `immutable ${label}\n`,
          },
        ],
      },
    ],
  };
}

function mockPreparedCompanySkillHome(label: string) {
  const materializationKey = createHash("sha256")
    .update(`materialization-${label}`)
    .digest("hex");
  const storeRoot = path.join(
    os.tmpdir(),
    "paperclip-company-skills-v1",
  );
  const homeDir = path.join(storeRoot, "homes", materializationKey);
  const releasePreparationLock = vi.fn(async () => {});
  const verifyAfterReap = vi.fn(async () => {});
  const collectExact = vi.fn(async () => ({
    materializationKey,
    outcome: "collected" as const,
  }));
  vi.spyOn(
    selectedCompanySkillsModule,
    "prepareSelectedCompanySkillTargetHome",
  ).mockResolvedValue({
    materializationKey,
    selectedSetDigest: "1".repeat(64),
    sourceFingerprint: "2".repeat(64),
    contentDigest: "3".repeat(64),
    storeRoot,
    homeDir,
    skillsDir: path.join(homeDir, "skills"),
    discoveryRoot: "/run/paperclip-company-skills/selected",
    preparationLockToken: `lock-${label}`,
    reused: false,
    releasePreparationLock,
    verifyAfterReap,
    collectExact,
  });
  return {
    materializationKey,
    storeRoot,
    homeDir,
    releasePreparationLock,
    verifyAfterReap,
  };
}

describe("ACP execution-target subprocess preparation", () => {
  it("lowers the approved artifact to exact local Node and a verified target-local frontend", async () => {
    const dirs = await fixtureDirectories();
    const launch = fixtureLaunch({
      cwd: dirs.targetCwd,
      additionalDirectories: [dirs.additional],
    });
    const approvedIdentity = launch.launch;
    const seen: AcpSubprocessHostLaunch[] = [];
    vi.spyOn(processModule, "spawnPreparedAcpSubprocess").mockImplementation(
      (nextLaunch, hostLaunch, options) => {
        expect(nextLaunch.launch).toBe(approvedIdentity);
        seen.push(hostLaunch);
        return realSpawnPreparedAcpSubprocess(nextLaunch, {
          ...hostLaunch,
          command: process.execPath,
          args: [
            "-e",
            "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
          ],
        }, options);
      },
    );
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "local-attempt",
      target: { kind: "local" },
      sourceLaunch: launch.launch,
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [dirs.additional],
      companySkills: { channel: "operator_native" },
    });

    const subprocess = await prepared.startSubprocess(launch, {
      redactStderr: (chunk) => chunk,
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(subprocess)).toBe(true);
    await expect(subprocess.closeAndReap(250)).resolves.toEqual({
      exitCode: 0,
      signal: null,
    });
    expect(seen).toEqual([
      {
        command: prepared.targetNodeExecutable,
        args: [prepared.targetFrontendEntrypoint],
        cwd: dirs.targetCwd,
        environment: {
          ...executionTargetModule.resolveAdapterExecutionTargetNativeIdentityEnvironment(
            { kind: "local" },
          ),
          CODEX_PATH: prepared.targetNativeExecutable,
        },
      },
    ]);
    expect(prepared.targetNodeExecutable).toBe(process.execPath);
    expect(path.isAbsolute(prepared.targetNativeExecutable)).toBe(true);
    expect(prepared.targetNativeExecutable).toMatch(/codex(?:\.js)?$/);
    expect(prepared.targetFrontendEntrypoint).not.toBe(
      approvedIdentity.args[0],
    );
    await expect(
      fs.access(prepared.targetFrontendEntrypoint),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("performs no selected-skill resolution, probe, or file operation for operator_native", async () => {
    const dirs = await fixtureDirectories();
    const selectedSkillPreparation = vi.spyOn(
      selectedCompanySkillsModule,
      "prepareSelectedCompanySkillTargetHome",
    );
    const targetShell = vi.spyOn(
      executionTargetModule,
      "runAdapterExecutionTargetShellCommand",
    );
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "operator-native-zero-skill-io",
      target: { kind: "local" },
      sourceLaunch: resolveApprovedAcpLaunch("codex"),
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
    });
    await prepared.disposeBeforeStart();

    expect(selectedSkillPreparation).not.toHaveBeenCalled();
    expect(
      targetShell.mock.calls.some((call) => call[2] === "command -v bwrap"),
    ).toBe(false);
    expect(prepared.targetAdditionalDirectories).toEqual([]);
  });

  it("binds an immutable selected set through a target-enforced read-only local discovery root", async () => {
    const dirs = await fixtureDirectories();
    const sourceLaunch = fixtureLaunch({
      cwd: dirs.targetCwd,
      additionalDirectories: [dirs.additional],
    });
    const selected = isolatedCompanySkills("local-review");
    const runTargetShell =
      executionTargetModule.runAdapterExecutionTargetShellCommand;
    vi.spyOn(
      executionTargetModule,
      "runAdapterExecutionTargetShellCommand",
    ).mockImplementation((runId, target, command, options) =>
      command === "command -v bwrap"
        ? Promise.resolve(successfulResult("/usr/bin/bwrap"))
        : runTargetShell(runId, target, command, options),
    );
    const hostLaunches: AcpSubprocessHostLaunch[] = [];
    vi.spyOn(processModule, "spawnPreparedAcpSubprocess").mockImplementation(
      (launch, hostLaunch, options) => {
        hostLaunches.push(hostLaunch);
        return realSpawnPreparedAcpSubprocess(
          launch,
          {
            ...hostLaunch,
            command: process.execPath,
            args: [
              "-e",
              "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
            ],
          },
          options,
        );
      },
    );

    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "local-isolated-attempt",
      target: { kind: "local" },
      sourceLaunch: sourceLaunch.launch,
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [dirs.additional],
      companySkills: selected,
    });
    const discoveryRoot = prepared.targetAdditionalDirectories[1]!;
    const launch = {
      ...sourceLaunch,
      additionalDirectories: prepared.targetAdditionalDirectories,
    };
    const subprocess = await prepared.startSubprocess(launch, {
      redactStderr: (chunk) => chunk,
    });
    await expect(subprocess.closeAndReap(250)).resolves.toEqual({
      exitCode: 0,
      signal: null,
    });

    expect(discoveryRoot).toBe(
      "/run/paperclip-company-skills/selected",
    );
    expect(prepared.targetAdditionalDirectories).toEqual([
      dirs.additional,
      discoveryRoot,
    ]);
    const hostLaunch = hostLaunches[0]!;
    expect(hostLaunch.command).toBe("/usr/bin/bwrap");
    const readOnlyBindIndex = hostLaunch.args.indexOf("--ro-bind");
    const sourceSkillsDir = hostLaunch.args[readOnlyBindIndex + 1]!;
    expect(hostLaunch.args[readOnlyBindIndex + 2]).toBe(
      `${discoveryRoot}/.agents/skills`,
    );
    const storeRoot = path.join(
      os.tmpdir(),
      "paperclip-company-skills-v1",
    );
    expect(path.dirname(path.dirname(sourceSkillsDir))).toBe(
      path.join(storeRoot, "homes"),
    );
    expect(path.basename(path.dirname(sourceSkillsDir))).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(path.basename(sourceSkillsDir)).toBe("skills");
    expect(sourceSkillsDir).not.toContain("/.agents/skills");
    expect(sourceSkillsDir).not.toContain("local-isolated-attempt");
    expect(hostLaunch.args).toEqual(
      expect.arrayContaining([
        "--tmpfs",
        storeRoot,
        "--remount-ro",
        "/run/paperclip-company-skills",
        "--chdir",
        dirs.targetCwd,
        "--",
        prepared.targetNodeExecutable,
        prepared.targetFrontendEntrypoint,
      ]),
    );
    const homeDir = path.dirname(sourceSkillsDir);
    cleanupDirectories.push(homeDir);
    await expect(
      fs.readFile(
        path.join(homeDir, ".paperclip-materialized-skill.json"),
        "utf8",
      ),
    ).resolves.toContain(`"versionId":"${selected.entries[0]!.versionId}"`);
    await expect(fs.access(discoveryRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires operator_native before writing skill files when the target has no read-only binder", async () => {
    const dirs = await fixtureDirectories();
    const selectedSkillPreparation = vi.spyOn(
      selectedCompanySkillsModule,
      "prepareSelectedCompanySkillTargetHome",
    );
    const runTargetShell =
      executionTargetModule.runAdapterExecutionTargetShellCommand;
    vi.spyOn(
      executionTargetModule,
      "runAdapterExecutionTargetShellCommand",
    ).mockImplementation((runId, target, command, options) =>
      command === "command -v bwrap"
        ? Promise.resolve({
            ...successfulResult("", "bwrap unavailable"),
            exitCode: 127,
          })
        : runTargetShell(runId, target, command, options),
    );

    await expect(
      prepareAcpExecutionTargetSubprocess({
        runId: "isolated-without-binder",
        target: { kind: "local" },
        sourceLaunch: resolveApprovedAcpLaunch("codex"),
        hostCwd: dirs.hostCwd,
        targetCwd: dirs.targetCwd,
        targetAdditionalDirectories: [],
        companySkills: isolatedCompanySkills("no-binder"),
      }),
    ).rejects.toThrow("select operator_native");
    expect(selectedSkillPreparation).not.toHaveBeenCalled();
  });

  it("boots the materialized standalone frontend over the official SDK wire", async () => {
    const dirs = await fixtureDirectories();
    const launch = fixtureLaunch({ cwd: dirs.targetCwd });
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "materialized-frontend-wire-attempt",
      target: { kind: "local" },
      sourceLaunch: launch.launch,
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
    });
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
      agentInfo: {
        name: "@agentclientprotocol/codex-acp",
        version: "1.1.7",
      },
    });
    expect(client.state).toBe("initialized");
    client.close();
    await expect(subprocess.closeAndReap()).resolves.toMatchObject({
      exitCode: 0,
      signal: null,
    });
    await expect(
      fs.access(prepared.targetFrontendEntrypoint),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lowers SSH to remote absolute Node and a target-local frontend without worker paths", async () => {
    const dirs = await fixtureDirectories();
    const targetCwd = "/srv/paperclip/issues/ISSUE-1";
    const additional = "/srv/paperclip/shared-read";
    const launch = fixtureLaunch({
      cwd: targetCwd,
      additionalDirectories: [additional],
    });
    const targetNodeExecutable = "/opt/paperclip/node/bin/node";
    const targetNativeExecutable = "/opt/openai/bin/codex";
    const cleanup = vi.fn(async () => {});
    const buildSsh = vi.fn(async (input: {
      command: string;
      args: string[];
    }) => {
      if (input.args[1] === "process.stdout.write(process.execPath)") {
        return {
          command: process.execPath,
          args: ["-e", `process.stdout.write(${JSON.stringify(targetNodeExecutable)})`],
          cleanup,
        };
      }
      if (input.args[1]?.includes("realpathSync")) {
        return {
          command: process.execPath,
          args: ["-e", `process.stdout.write(${JSON.stringify(targetNativeExecutable)})`],
          cleanup,
        };
      }
      if (input.args[1]?.includes('createHash("sha256")')) {
        return {
          command: process.execPath,
          args: input.args,
          cleanup,
        };
      }
      return {
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
        ],
        cleanup,
      };
    });
    const hostLaunches: AcpSubprocessHostLaunch[] = [];
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/srv/paperclip",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        remoteCwd: "/srv/paperclip",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    vi.spyOn(sshModule, "runSshCommand").mockImplementation(
      async (_spec, command) => {
        if (command === "command -v node") {
          return { stdout: `${targetNodeExecutable}\n`, stderr: "" };
        }
        if (command === "command -v codex") {
          return { stdout: `${targetNativeExecutable}\n`, stderr: "" };
        }
        if (command.includes("process.stdout.write(process.execPath)")) {
          return { stdout: targetNodeExecutable, stderr: "" };
        }
        if (command.includes("realpathSync")) {
          return { stdout: targetNativeExecutable, stderr: "" };
        }
        if (command.includes("createHash") && command.includes("sha256")) {
          const pathMatch = /'([^']+)'$/.exec(command);
          if (!pathMatch?.[1]) throw new Error("missing target artifact path");
          const bytes = await fs.readFile(pathMatch[1]);
          return {
            stdout: createHash("sha256").update(bytes).digest("hex"),
            stderr: "",
          };
        }
        throw new Error(`unexpected SSH probe: ${command}`);
      },
    );
    vi.spyOn(sshModule, "buildSshSpawnTarget").mockImplementation(
      buildSsh as typeof sshModule.buildSshSpawnTarget,
    );
    const materialize = materializationModule.materializeAdapterExecutionTargetTextFiles;
    vi.spyOn(
      materializationModule,
      "materializeAdapterExecutionTargetTextFiles",
    ).mockImplementation((input) => materialize({
      ...input,
      target: { kind: "local" },
    }));
    vi.spyOn(processModule, "spawnPreparedAcpSubprocess").mockImplementation(
      (nextLaunch, hostLaunch, options) => {
        expect(nextLaunch).toBe(launch);
        hostLaunches.push(hostLaunch);
        return realSpawnPreparedAcpSubprocess(nextLaunch, {
          ...hostLaunch,
          command: process.execPath,
          args: [
            "-e",
            "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
          ],
        }, options);
      },
    );
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "ssh-attempt",
      target,
      sourceLaunch: launch.launch,
      hostCwd: dirs.hostCwd,
      targetCwd,
      targetAdditionalDirectories: [additional],
      companySkills: { channel: "operator_native" },
    });

    const subprocess = await prepared.startSubprocess(launch, {
      redactStderr: (chunk) => chunk,
    });
    await subprocess.closeAndReap(250);

    expect(buildSsh).toHaveBeenCalledWith({
      spec: target.spec,
      command: targetNodeExecutable,
      args: [prepared.targetFrontendEntrypoint],
      env: { CODEX_PATH: targetNativeExecutable },
      cwd: targetCwd,
    });
    expect(prepared.targetNodeExecutable).toBe(targetNodeExecutable);
    expect(prepared.targetNativeExecutable).toBe(targetNativeExecutable);
    expect(prepared.targetFrontendEntrypoint).not.toBe(launch.launch.args[0]);
    expect(
      buildSsh.mock.calls.some((call) =>
        JSON.stringify(call).includes(launch.launch.args[0]!),
      ),
    ).toBe(false);
    expect(hostLaunches[0]).toMatchObject({
      cwd: dirs.hostCwd,
      environment: {},
    });
    expect(cleanup).toHaveBeenCalled();
  });

  it("passes the same read-only selected-skills binding through the SSH driver", async () => {
    const dirs = await fixtureDirectories();
    const targetCwd = "/srv/paperclip/issues/ISSUE-SKILL";
    const sourceLaunch = fixtureLaunch({ cwd: targetCwd });
    const targetNodeExecutable = "/opt/paperclip/node/bin/node";
    const targetNativeExecutable = "/opt/openai/bin/codex";
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/srv/paperclip",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        remoteCwd: "/srv/paperclip",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    const selected = isolatedCompanySkills("ssh-review");
    const home = mockPreparedCompanySkillHome("ssh-review");
    vi.spyOn(sshModule, "runSshCommand").mockImplementation(
      async (_spec, command) => {
        if (command === "command -v node") {
          return { stdout: `${targetNodeExecutable}\n`, stderr: "" };
        }
        if (command === "command -v bwrap") {
          return { stdout: "/opt/paperclip/bin/bwrap\n", stderr: "" };
        }
        if (command === "command -v codex") {
          return { stdout: `${targetNativeExecutable}\n`, stderr: "" };
        }
        if (command.includes("process.stdout.write(process.execPath)")) {
          return { stdout: targetNodeExecutable, stderr: "" };
        }
        if (command.includes("realpathSync")) {
          return { stdout: targetNativeExecutable, stderr: "" };
        }
        if (command.includes("createHash") && command.includes("sha256")) {
          const pathMatch = /'([^']+)'$/.exec(command);
          if (!pathMatch?.[1]) throw new Error("missing target artifact path");
          const bytes = await fs.readFile(pathMatch[1]);
          return {
            stdout: createHash("sha256").update(bytes).digest("hex"),
            stderr: "",
          };
        }
        throw new Error(`unexpected SSH probe: ${command}`);
      },
    );
    const materialize =
      materializationModule.materializeAdapterExecutionTargetTextFiles;
    vi.spyOn(
      materializationModule,
      "materializeAdapterExecutionTargetTextFiles",
    ).mockImplementation((input) =>
      materialize({ ...input, target: { kind: "local" } }),
    );
    const sshCleanup = vi.fn(async () => {});
    const buildSsh = vi
      .spyOn(sshModule, "buildSshSpawnTarget")
      .mockImplementation(async (input) => ({
        command: process.execPath,
        args: input.args[1]?.includes("realpathSync")
          ? ["-e", `process.stdout.write(${JSON.stringify(targetNativeExecutable)})`]
          : [
              "-e",
              "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
            ],
        cleanup: sshCleanup,
      }));

    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "ssh-isolated-attempt",
      target,
      sourceLaunch: sourceLaunch.launch,
      hostCwd: dirs.hostCwd,
      targetCwd,
      targetAdditionalDirectories: [],
      companySkills: selected,
    });
    const launch = {
      ...sourceLaunch,
      additionalDirectories: prepared.targetAdditionalDirectories,
    };
    const subprocess = await prepared.startSubprocess(launch, {
      redactStderr: (chunk) => chunk,
    });
    // The exact-key lock is held until the target wrapper proves its bind is
    // live by producing ACP output; this fixture stays silent until reap.
    expect(home.releasePreparationLock).not.toHaveBeenCalled();
    await subprocess.closeAndReap(250);

    expect(
      selectedCompanySkillsModule.prepareSelectedCompanySkillTargetHome,
    ).toHaveBeenCalledWith(expect.objectContaining({ target, entries: selected.entries }));
    const sshInput = buildSsh.mock.calls.find(
      ([input]) => input.command === "/opt/paperclip/bin/bwrap",
    )?.[0];
    expect(sshInput).toBeDefined();
    expect(sshInput!.command).toBe("/opt/paperclip/bin/bwrap");
    const readOnlyBindIndex = sshInput!.args.indexOf("--ro-bind");
    expect(sshInput!.args.slice(readOnlyBindIndex, readOnlyBindIndex + 3)).toEqual([
      "--ro-bind",
      `${home.homeDir}/skills`,
      `${prepared.targetAdditionalDirectories[0]}/.agents/skills`,
    ]);
    expect(sshInput!.args).toEqual(
      expect.arrayContaining(["--tmpfs", home.storeRoot, "--remount-ro"]),
    );
    expect(sshInput!.cwd).toBe(targetCwd);
    expect(home.releasePreparationLock).toHaveBeenCalled();
    expect(home.verifyAfterReap).toHaveBeenCalledTimes(1);
    expect(sshCleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["sandbox", "plugin"] as const)(
    "uses the existing %s process bridge and reaps its local proxy before cleanup",
    async (transport) => {
      const dirs = await fixtureDirectories();
      const targetCwd = "/workspace/issue-1";
      const launch = fixtureLaunch({ cwd: targetCwd });
      const runtime = targetRuntimeFixture();
      const stop = vi.fn(async () => {});
      const bridge = vi.fn(
        async (
          _input: Parameters<
            typeof executionTargetModule.startAdapterExecutionTargetProcessSessionBridge
          >[0],
        ): Promise<AdapterExecutionTargetProcessSessionBridgeHandle> => ({
          agentCommand: "/bin/sh",
          stop,
        }),
      );
      const target: AdapterExecutionTarget =
        transport === "sandbox"
          ? {
              kind: "remote",
              transport,
              providerKey: "fixture",
              remoteCwd: "/workspace",
              runner: runtime.runner,
            }
          : {
              kind: "remote",
              transport,
              pluginKey: "fixture.environments",
              driverKey: "fixture",
              remoteCwd: "/workspace",
              runner: runtime.runner,
            };
      vi.spyOn(
        executionTargetModule,
        "startAdapterExecutionTargetProcessSessionBridge",
      ).mockImplementation(bridge);
      const prepared = await prepareAcpExecutionTargetSubprocess({
        runId: `${transport}-attempt`,
        target,
        sourceLaunch: launch.launch,
        hostCwd: dirs.hostCwd,
        targetCwd,
        targetAdditionalDirectories: [],
        companySkills: { channel: "operator_native" },
        runtimeRootDir: "/workspace/.paperclip-runtime/codex",
      });

      const subprocess = await prepared.startSubprocess(launch, {
        redactStderr: (chunk) => chunk,
      });
      subprocess.cancel("SIGTERM");
      await subprocess.terminateAndReap(50);

      expect(bridge).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: `${transport}-attempt`,
          target,
          adapterKey: "codex",
          command: prepared.targetNodeExecutable,
          args: [prepared.targetFrontendEntrypoint],
          cwd: targetCwd,
          env: { CODEX_PATH: runtime.nativeExecutable },
        }),
      );
      expect(prepared.targetNodeExecutable).toBe(
        "/opt/paperclip/node/bin/node",
      );
      expect(prepared.targetNativeExecutable).toBe(runtime.nativeExecutable);
      expect(prepared.targetFrontendEntrypoint).toMatch(
        /codex-acp-1\.1\.7\.mjs$/,
      );
      expect(JSON.stringify(runtime.calls)).not.toContain(
        launch.launch.args[0],
      );
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["sandbox", "sandbox"],
    ["custom-image sandbox", "sandbox"],
    ["plugin", "plugin"],
  ] as const)(
    "passes the target-enforced read-only skill binding through the %s bridge",
    async (label, transport) => {
      const dirs = await fixtureDirectories();
      const targetCwd = "/workspace/issue-skills";
      const sourceLaunch = fixtureLaunch({ cwd: targetCwd });
      const runtime = targetRuntimeFixture();
      const selected = isolatedCompanySkills(label.replaceAll(" ", "-"));
      const home = mockPreparedCompanySkillHome(label.replaceAll(" ", "-"));
      const stop = vi.fn(async () => {});
      const bridge = vi.fn(
        async (
          _input: Parameters<
            typeof executionTargetModule.startAdapterExecutionTargetProcessSessionBridge
          >[0],
        ): Promise<AdapterExecutionTargetProcessSessionBridgeHandle> => ({
          agentCommand: "/bin/sh",
          stop,
        }),
      );
      const target: AdapterExecutionTarget =
        transport === "sandbox"
          ? {
              kind: "remote",
              transport,
              providerKey: label,
              remoteCwd: "/workspace",
              runner: runtime.runner,
            }
          : {
              kind: "remote",
              transport,
              pluginKey: "fixture.environments",
              driverKey: "fixture",
              remoteCwd: "/workspace",
              runner: runtime.runner,
            };
      vi.spyOn(
        executionTargetModule,
        "startAdapterExecutionTargetProcessSessionBridge",
      ).mockImplementation(bridge);

      const prepared = await prepareAcpExecutionTargetSubprocess({
        runId: `${label.replaceAll(" ", "-")}-isolated-attempt`,
        target,
        sourceLaunch: sourceLaunch.launch,
        hostCwd: dirs.hostCwd,
        targetCwd,
        targetAdditionalDirectories: [],
        companySkills: selected,
        runtimeRootDir: "/workspace/.paperclip-runtime/codex",
      });
      const launch = {
        ...sourceLaunch,
        additionalDirectories: prepared.targetAdditionalDirectories,
      };
      const subprocess = await prepared.startSubprocess(launch, {
        redactStderr: (chunk) => chunk,
      });
      subprocess.cancel("SIGTERM");
      await subprocess.terminateAndReap(50);

      expect(
        selectedCompanySkillsModule.prepareSelectedCompanySkillTargetHome,
      ).toHaveBeenCalledWith(expect.objectContaining({ target, entries: selected.entries }));
      const bridgeInput = bridge.mock.calls[0]![0];
      expect(bridgeInput.command).toBe("/opt/paperclip/bin/bwrap");
      const readOnlyBindIndex = bridgeInput.args.indexOf("--ro-bind");
      expect(
        bridgeInput.args.slice(readOnlyBindIndex, readOnlyBindIndex + 3),
      ).toEqual([
        "--ro-bind",
        `${home.homeDir}/skills`,
        `${prepared.targetAdditionalDirectories[0]}/.agents/skills`,
      ]);
      expect(bridgeInput.args).toEqual(
        expect.arrayContaining(["--tmpfs", home.storeRoot, "--remount-ro"]),
      );
      expect(home.releasePreparationLock).toHaveBeenCalled();
      expect(home.verifyAfterReap).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  it("materializes invocation secrets target-side and exposes only paths to a confined local child", async () => {
    const dirs = await fixtureDirectories();
    const secret = "one-use-capability-bearer";
    const launch = fixtureLaunch({ cwd: dirs.targetCwd });
    const sandboxCleanup = vi.fn(async () => {});
    const buildLocalSandbox = vi.fn(async (input) => ({
      command: input.executable,
      args: input.args,
      cwd: input.cwd,
      env: { SANDBOX_MARKER: "1" },
      cleanup: sandboxCleanup,
    }));
    const hostLaunches: AcpSubprocessHostLaunch[] = [];
    vi.spyOn(
      localSandboxModule,
      "buildLocalProcessSandboxSpawnTarget",
    ).mockImplementation(buildLocalSandbox);
    vi.spyOn(processModule, "spawnPreparedAcpSubprocess").mockImplementation(
      (nextLaunch, hostLaunch, options) => {
        hostLaunches.push(hostLaunch);
        return realSpawnPreparedAcpSubprocess(nextLaunch, {
          ...hostLaunch,
          command: process.execPath,
          args: [
            "-e",
            "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
          ],
        }, options);
      },
    );
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "confined-local-attempt",
      target: { kind: "local" },
      sourceLaunch: launch.launch,
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
      localProcessSandbox: {
        workspaceDir: dirs.targetCwd,
        filesystemScope: "workspace",
      },
      invocationFiles: [
        {
          fileName: "run-tools.json",
          contents: JSON.stringify({ bearer: secret }),
        },
        {
          fileName: "run-tools-proxy.mjs",
          contents: "process.exit(0);\n",
        },
      ],
    });
    const secretPath = prepared.invocationFilePaths["run-tools.json"]!;
    expect(await fs.readFile(secretPath, "utf8")).toContain(secret);

    const subprocess = await prepared.startSubprocess(launch, {
      redactStderr: (chunk) => chunk,
    });
    await subprocess.closeAndReap(250);

    const sandboxInput = buildLocalSandbox.mock.calls[0]?.[0];
    expect(sandboxInput?.options.managedPaths?.[0]).toEqual({
      path: path.dirname(secretPath),
      access: "ro",
    });
    expect(sandboxInput?.executable).toBe(prepared.targetNodeExecutable);
    expect(sandboxInput?.requiredExecutables).toEqual([
      prepared.targetNativeExecutable,
    ]);
    expect(sandboxInput?.requiredIdentityEnvironment).toEqual(
      executionTargetModule.resolveAdapterExecutionTargetNativeIdentityEnvironment(
        { kind: "local" },
      ),
    );
    expect(sandboxInput?.args).toEqual([
      prepared.targetFrontendEntrypoint,
    ]);
    expect(
      JSON.stringify({
        command: sandboxInput?.executable,
        args: sandboxInput?.args,
        env: hostLaunches[0]?.environment,
      }),
    ).not.toContain(secret);
    expect(sandboxCleanup).toHaveBeenCalledTimes(1);
    await expect(fs.access(secretPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects target cwd drift and cleans materialized files without a spawn", async () => {
    const dirs = await fixtureDirectories();
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "cwd-drift-attempt",
      target: { kind: "local" },
      sourceLaunch: resolveApprovedAcpLaunch("codex"),
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
      invocationFiles: [
        { fileName: "run-tools.json", contents: "secret" },
      ],
    });
    const filePath = prepared.invocationFilePaths["run-tools.json"]!;

    await expect(
      prepared.startSubprocess(
        fixtureLaunch({ cwd: dirs.hostCwd }),
        { redactStderr: (chunk) => chunk },
      ),
    ).rejects.toThrow(
      "ACP launch cwd does not match the prepared execution-target cwd",
    );
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects launch-profile drift after target preparation", async () => {
    const dirs = await fixtureDirectories();
    const launch = fixtureLaunch({ cwd: dirs.targetCwd });
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "launch-drift-attempt",
      target: { kind: "local" },
      sourceLaunch: launch.launch,
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
      invocationFiles: [{ fileName: "run-tools.json", contents: "secret" }],
    });
    const filePath = prepared.invocationFilePaths["run-tools.json"]!;

    await expect(
      prepared.startSubprocess(
        {
          ...launch,
          launch: { ...launch.launch, frontendDigest: "f".repeat(64) },
        },
        { redactStderr: (chunk) => chunk },
      ),
    ).rejects.toThrow(
      "ACP launch identity changed after execution-target preparation",
    );
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects target-native selector drift after target preparation", async () => {
    const dirs = await fixtureDirectories();
    const launch = fixtureLaunch({ cwd: dirs.targetCwd });
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "target-native-drift-attempt",
      target: { kind: "local" },
      sourceLaunch: launch.launch,
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
      invocationFiles: [{ fileName: "run-tools.json", contents: "secret" }],
    });
    const filePath = prepared.invocationFilePaths["run-tools.json"]!;

    await expect(
      prepared.startSubprocess(
        {
          ...launch,
          launch: { ...launch.launch, targetNativeCli: "codex-other" },
        },
        { redactStderr: (chunk) => chunk },
      ),
    ).rejects.toThrow(
      "ACP launch identity changed after execution-target preparation",
    );
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects every productive environment input before native launch", async () => {
    const dirs = await fixtureDirectories();
    const launch = fixtureLaunch({ cwd: dirs.targetCwd });
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "provider-environment-attempt",
      target: { kind: "local" },
      sourceLaunch: launch.launch,
      hostCwd: dirs.hostCwd,
      targetCwd: dirs.targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
      invocationFiles: [{ fileName: "run-tools.json", contents: "secret" }],
    });
    const filePath = prepared.invocationFilePaths["run-tools.json"]!;

    await expect(
      prepared.startSubprocess(
        { ...launch, environment: { CODEX_PATH: "/ambient/forbidden" } },
        { redactStderr: (chunk) => chunk },
      ),
    ).rejects.toThrow(
      "ACP launch environment must remain empty at the provider boundary",
    );
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects target-side frontend byte drift and cleans the invocation bundle", async () => {
    const dirs = await fixtureDirectories();
    const runtime = targetRuntimeFixture(
      "/opt/paperclip/node/bin/node",
      true,
    );
    await expect(
      prepareAcpExecutionTargetSubprocess({
        runId: "target-artifact-drift-attempt",
        target: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: "/workspace",
          runner: runtime.runner,
        },
        sourceLaunch: resolveApprovedAcpLaunch("codex"),
        hostCwd: dirs.hostCwd,
        targetCwd: "/workspace/issue-1",
        targetAdditionalDirectories: [],
        companySkills: { channel: "operator_native" },
      }),
    ).rejects.toThrow("ACP target frontend artifact digest drifted");
    expect(runtime.files.size).toBe(0);
  });

  it("rejects a remote PATH alias that does not resolve to an absolute Node path", async () => {
    const dirs = await fixtureDirectories();
    const runtime = targetRuntimeFixture("node");
    await expect(
      prepareAcpExecutionTargetSubprocess({
        runId: "relative-node-attempt",
        target: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: "/workspace",
          runner: runtime.runner,
        },
        sourceLaunch: resolveApprovedAcpLaunch("codex"),
        hostCwd: dirs.hostCwd,
        targetCwd: "/workspace/issue-1",
        targetAdditionalDirectories: [],
        companySkills: { channel: "operator_native" },
      }),
    ).rejects.toThrow("ACP target Node probe must be an absolute path");
    expect(runtime.files.size).toBe(0);
  });

  it("bounds and surfaces remote bridge cleanup failure after process reap", async () => {
    const dirs = await fixtureDirectories();
    const targetCwd = "/workspace/issue-1";
    const launch = fixtureLaunch({ cwd: targetCwd });
    const runtime = targetRuntimeFixture();
    const never = new Promise<void>(() => {});
    vi.spyOn(
      executionTargetModule,
      "startAdapterExecutionTargetProcessSessionBridge",
    ).mockResolvedValue({
      agentCommand: "/bin/sh",
      stop: () => never,
    });
    const prepared = await prepareAcpExecutionTargetSubprocess({
      runId: "bounded-cleanup-attempt",
      target: {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
        runner: runtime.runner,
      },
      sourceLaunch: launch.launch,
      hostCwd: dirs.hostCwd,
      targetCwd,
      targetAdditionalDirectories: [],
      companySkills: { channel: "operator_native" },
      cleanupTimeoutMs: 20,
    });

    const subprocess = await prepared.startSubprocess(launch, {
      redactStderr: (chunk) => chunk,
    });
    await expect(subprocess.closeAndReap(50)).rejects.toThrow(
      "exceeded its cleanup deadline",
    );
  });
});
