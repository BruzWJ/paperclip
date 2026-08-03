// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: CODEX_HOME, PAPERCLIP_API_KEY, PAPERCLIP_API_URL
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import * as serverUtils from "./server-utils.js";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCwd,
  resolveAdapterExecutionTargetNativeIdentityEnvironment,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
} from "./execution-target.js";

describe("target-native identity environment", () => {
  it("carries only exact local identity roots and never provider state", () => {
    expect(
      resolveAdapterExecutionTargetNativeIdentityEnvironment(
        { kind: "local" },
        {
          HOME: "/operator/home",
          USERPROFILE: "/operator/profile",
          APPDATA: "/operator/appdata",
          LOCALAPPDATA: "/operator/local-appdata",
          XDG_CONFIG_HOME: "/operator/xdg/config",
          XDG_CACHE_HOME: "/operator/xdg/cache",
          XDG_DATA_HOME: "/operator/xdg/data",
          XDG_STATE_HOME: "/operator/xdg/state",
          CODEX_HOME: "/forbidden/codex-home",
          CODEX_PATH: "/forbidden/codex",
          OPENAI_API_KEY: "forbidden-secret",
          PAPERCLIP_API_URL: "https://forbidden.invalid",
        },
      ),
    ).toEqual({
      HOME: "/operator/home",
      USERPROFILE: "/operator/profile",
      APPDATA: "/operator/appdata",
      LOCALAPPDATA: "/operator/local-appdata",
      XDG_CONFIG_HOME: "/operator/xdg/config",
      XDG_CACHE_HOME: "/operator/xdg/cache",
      XDG_DATA_HOME: "/operator/xdg/data",
      XDG_STATE_HOME: "/operator/xdg/state",
    });
  });

  it("uses target-native defaults remotely and rejects malformed local roots", () => {
    expect(
      resolveAdapterExecutionTargetNativeIdentityEnvironment(
        {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: "/workspace",
        },
        { HOME: "/host/home" },
      ),
    ).toEqual({});
    expect(() =>
      resolveAdapterExecutionTargetNativeIdentityEnvironment(
        { kind: "local" },
        { HOME: " relative/home" },
      ),
    ).toThrow(/HOME must be an exact absolute path/);
  });
});

describe("runAdapterExecutionTargetShellCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("quotes remote shell commands with the shared SSH quoting helper", async () => {
    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
    });

    await runAdapterExecutionTargetShellCommand(
      "run-1",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      `printf '%s\\n' "$HOME" && echo "it's ok"`,
      {
        cwd: "/tmp/local",
        env: {},
      },
    );

    // runSshCommand owns profile sourcing and the outer shell wrapper —
    // the caller passes the raw command string. Wrapping it here would
    // double-nest the login shell and re-source profiles after the explicit
    // env override, silently undoing identity-var preservation.
    expect(runSshCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "ssh.example.test",
        username: "ssh-user",
      }),
      `printf '%s\\n' "$HOME" && echo "it's ok"`,
      expect.any(Object),
    );
  });

  it("sanitizes inherited host env before SSH shell execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");

    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
    });

    await runAdapterExecutionTargetShellCommand(
      "run-1b",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "env",
      {
        cwd: "/tmp/local",
        env: {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          SAFE_VALUE: "visible",
        },
      },
    );

    expect(runSshCommandSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({
        env: {
          SAFE_VALUE: "visible",
        },
      }),
    );
  });

  it("returns a timedOut result when the SSH shell command times out", async () => {
    vi.spyOn(ssh, "runSshCommand").mockRejectedValue(Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT",
      stdout: "partial stdout",
      stderr: "partial stderr",
      signal: "SIGTERM",
    }));
    const onLog = vi.fn(async () => {});

    const result = await runAdapterExecutionTargetShellCommand(
      "run-2",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "sleep 10",
      {
        cwd: "/tmp/local",
        env: {},
        onLog,
      },
    );

    expect(result).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "partial stdout",
      stderr: "partial stderr",
    });
    expect(onLog).toHaveBeenCalledWith("stdout", "partial stdout");
    expect(onLog).toHaveBeenCalledWith("stderr", "partial stderr");
  });

  it("preserves the sanitized local target PATH without login-profile rewriting", async () => {
    const expectedPath = process.env.PATH;
    expect(expectedPath).toBeTruthy();

    const result = await runAdapterExecutionTargetShellCommand(
      "run-local-path",
      { kind: "local" },
      'printf %s "$PATH"',
      {
        cwd: process.cwd(),
        env: {},
      },
    );

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: expectedPath,
    });
  });

  it("returns the SSH process exit code for non-zero remote command failures", async () => {
    vi.spyOn(ssh, "runSshCommand").mockRejectedValue(Object.assign(new Error("non-zero exit"), {
      code: 17,
      stdout: "partial stdout",
      stderr: "partial stderr",
      signal: null,
    }));
    const onLog = vi.fn(async () => {});

    const result = await runAdapterExecutionTargetShellCommand(
      "run-3",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "false",
      {
        cwd: "/tmp/local",
        env: {},
        onLog,
      },
    );

    expect(result).toMatchObject({
      exitCode: 17,
      signal: null,
      timedOut: false,
      stdout: "partial stdout",
      stderr: "partial stderr",
    });
    expect(onLog).toHaveBeenCalledWith("stdout", "partial stdout");
    expect(onLog).toHaveBeenCalledWith("stderr", "partial stderr");
  });

});

describe("ensureAdapterExecutionTargetCommandResolvable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed when the requested command is missing on the SSH target", async () => {
    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockRejectedValue(
      Object.assign(new Error("remote command exited 127"), {
        code: 127,
      }),
    );

    await expect(
      ensureAdapterExecutionTargetCommandResolvable(
        "node",
        {
          kind: "remote",
          transport: "ssh",
          remoteCwd: "/srv/paperclip/workspace",
          spec: {
            host: "ssh.example.test",
            port: 22,
            username: "ssh-user",
            remoteCwd: "/srv/paperclip/workspace",
            remoteWorkspacePath: "/srv/paperclip/workspace",
            privateKey: null,
            knownHosts: null,
            strictHostKeyChecking: true,
          },
        },
        "/tmp/local",
        {
          PATH: "/host/bin:/usr/bin",
          PAPERCLIP_API_KEY: "must-not-cross",
        },
      ),
    ).rejects.toThrow(
      'Command "node" is not installed or not on PATH in the ssh environment.',
    );

    expect(runSshCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "ssh.example.test",
        username: "ssh-user",
      }),
      "cd '/srv/paperclip/workspace' && command -v 'node' >/dev/null 2>&1",
      {
        env: {
          PATH: "/host/bin:/usr/bin",
        },
        timeoutMs: 15_000,
      },
    );
  });
});

describe("runAdapterExecutionTargetProcess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sanitizes inherited host env before SSH process execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");

    const runChildProcessSpy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    });

    await runAdapterExecutionTargetProcess(
      "run-ssh-process",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "agent-cli",
      ["--json"],
      {
        cwd: "/tmp/local",
        env: {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          SAFE_VALUE: "visible",
        },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(runChildProcessSpy).toHaveBeenCalledWith(
      "run-ssh-process",
      "agent-cli",
      ["--json"],
      expect.objectContaining({
        env: {
          SAFE_VALUE: "visible",
        },
      }),
    );
  });

  it("executes plugin targets through their exact command-managed runner", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "plugin output",
      stderr: "",
      pid: null,
      startedAt: "2026-01-01T00:00:00.000Z",
    }));
    const cancelExecution = vi.fn(
      async (input: { executionId: string }) => ({
        executionId: input.executionId,
        cancelled: true,
      }),
    );
    const runChildProcessSpy = vi.spyOn(
      serverUtils,
      "runChildProcess",
    );

    const result = await runAdapterExecutionTargetProcess(
      "plugin-attempt-1",
      {
        kind: "remote",
        transport: "plugin",
        pluginKey: "acme.environments",
        driverKey: "workspace-driver",
        remoteCwd: "/plugin/workspace",
        runner: {
          execute,
          cancelExecution,
        },
      },
      "provider-cli",
      ["--stream"],
      {
        cwd: "/host/workspace",
        env: { SAFE_VALUE: "visible" },
        timeoutSec: 30,
        graceSec: 5,
        onLog: async () => {},
      },
    );

    expect(result.stdout).toBe("plugin output");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "plugin-attempt-1",
        command: "provider-cli",
        args: ["--stream"],
        cwd: "/plugin/workspace",
        env: { SAFE_VALUE: "visible" },
        timeoutMs: 30_000,
      }),
    );
    expect(runChildProcessSpy).not.toHaveBeenCalled();
  });
});

describe("ensureAdapterExecutionTargetRuntimeCommandInstalled", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs install commands for sandbox targets", async () => {
    const runner = {
      cancelExecution: vi.fn(async (input: { executionId: string }) => ({
        executionId: input.executionId,
        cancelled: false,
      })),
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId: "run-install",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "e2b",
        remoteCwd: "/remote/workspace",
        runner,
      },
      installCommand: "npm install -g @fixture/agent-cli",
      cwd: "/local/workspace",
      env: { PATH: "/usr/bin" },
      timeoutSec: 30,
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "sh",
      args: ["-c", "npm install -g @fixture/agent-cli"],
      cwd: "/remote/workspace",
      env: { PATH: "/usr/bin" },
      timeoutMs: 30_000,
    }));
  });

  it("skips install commands for SSH targets", async () => {
    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
    });

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId: "run-skip",
      target: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      installCommand: "npm install -g @fixture/agent-cli",
      cwd: "/tmp/local",
      env: {},
    });

    expect(runSshCommandSpy).not.toHaveBeenCalled();
  });
});

describe("resolveAdapterExecutionTargetCwd", () => {
  const sshTarget = {
    kind: "remote" as const,
    transport: "ssh" as const,
    remoteCwd: "/srv/paperclip/workspace",
    spec: {
      host: "ssh.example.test",
      port: 22,
      username: "ssh-user",
      remoteCwd: "/srv/paperclip/workspace",
      remoteWorkspacePath: "/srv/paperclip/workspace",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
    },
  };

  it("falls back to the remote cwd when no adapter cwd is configured", () => {
    expect(resolveAdapterExecutionTargetCwd(sshTarget, "", "/Users/host/repo/server")).toBe(
      "/srv/paperclip/workspace",
    );
    expect(resolveAdapterExecutionTargetCwd(sshTarget, "   ", "/Users/host/repo/server")).toBe(
      "/srv/paperclip/workspace",
    );
    expect(resolveAdapterExecutionTargetCwd(sshTarget, null, "/Users/host/repo/server")).toBe(
      "/srv/paperclip/workspace",
    );
  });

  it("preserves an explicit adapter cwd when one is configured", () => {
    expect(
      resolveAdapterExecutionTargetCwd(
        sshTarget,
        "/srv/paperclip/custom-agent-dir",
        "/Users/host/repo/server",
      ),
    ).toBe("/srv/paperclip/custom-agent-dir");
  });

  it("keeps the local fallback cwd for local targets", () => {
    expect(resolveAdapterExecutionTargetCwd(null, "", "/Users/host/repo/server")).toBe(
      "/Users/host/repo/server",
    );
  });
});
