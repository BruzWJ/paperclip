import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  parseAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  resolveAdapterExecutionTargetNativeIdentityEnvironment,
  resolveAdapterExecutionTargetTimeout,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
} from "./execution-target.js";

const LOCAL_TARGET = { kind: "local" as const };

describe("local target-native identity environment", () => {
  it("carries only exact local identity roots and never provider state", () => {
    expect(
      resolveAdapterExecutionTargetNativeIdentityEnvironment(LOCAL_TARGET, {
        HOME: "/operator/home",
        XDG_CONFIG_HOME: "/operator/config",
        OPENAI_API_KEY: "secret",
        PAPERCLIP_API_URL: "https://paperclip.invalid",
      }),
    ).toEqual({
      HOME: "/operator/home",
      XDG_CONFIG_HOME: "/operator/config",
    });
  });

  it("rejects malformed identity roots", () => {
    expect(() =>
      resolveAdapterExecutionTargetNativeIdentityEnvironment(LOCAL_TARGET, {
        HOME: "relative/home",
      }),
    ).toThrow("must be an exact absolute path");
  });
});

describe("local execution", () => {
  it("runs a shell command in the selected cwd and environment", async () => {
    const result = await runAdapterExecutionTargetShellCommand(
      "local-shell",
      LOCAL_TARGET,
      'printf "%s:%s" "$PWD" "$VISIBLE"',
      {
        cwd: process.cwd(),
        env: { VISIBLE: "yes" },
      },
    );

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toBe(`${process.cwd()}:yes`);
  });

  it("passes local process confinement options through to the runner", async () => {
    const result = await runAdapterExecutionTargetProcess(
      "local-process",
      LOCAL_TARGET,
      process.execPath,
      ["-e", "process.stdout.write(process.cwd())"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: null,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(process.cwd());
  });

  it("checks the local PATH without any install fallback", async () => {
    await expect(
      ensureAdapterExecutionTargetCommandResolvable(
        process.execPath,
        LOCAL_TARGET,
        process.cwd(),
        process.env,
      ),
    ).resolves.toBeUndefined();
    await expect(
      ensureAdapterExecutionTargetCommandResolvable(
        "paperclip-command-that-does-not-exist",
        LOCAL_TARGET,
        process.cwd(),
        process.env,
      ),
    ).rejects.toThrow("Command not found in PATH");
  });
});

describe("local execution target configuration", () => {
  it("uses only an explicit cwd or the local fallback", () => {
    expect(
      resolveAdapterExecutionTargetCwd(
        LOCAL_TARGET,
        "/operator/configured",
        "/workspace/fallback",
      ),
    ).toBe("/operator/configured");
    expect(
      resolveAdapterExecutionTargetCwd(
        LOCAL_TARGET,
        "",
        "/workspace/fallback",
      ),
    ).toBe("/workspace/fallback");
  });

  it("accepts only local serialized targets", () => {
    expect(
      parseAdapterExecutionTarget({
        kind: "local",
        leaseId: "lease-1",
      }),
    ).toEqual({
      kind: "local",
      leaseId: "lease-1",
    });
    expect(
      parseAdapterExecutionTarget({
        kind: "unsupported",
      }),
    ).toBeNull();
  });

  it("preserves configured, disabled, and unlimited timeout semantics", () => {
    expect(resolveAdapterExecutionTargetTimeout(LOCAL_TARGET, 0.5)).toEqual({
      timeoutSec: 0.5,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout(LOCAL_TARGET, -1)).toEqual({
      timeoutSec: 0,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout(LOCAL_TARGET, 0)).toEqual({
      timeoutSec: 0,
      source: "unlimited",
    });
  });

  it("keeps timeout diagnostics self-describing", () => {
    const configured = { timeoutSec: 30, source: "configured" as const };
    expect(formatAdapterExecutionTimeoutErrorMessage(configured)).toContain(
      "timeoutSec=30",
    );
    expect(formatAdapterExecutionTimeoutStartLogLine(configured)).toContain(
      "configured via adapterConfig.timeoutSec",
    );
  });

  it("uses host-native absolute path semantics", () => {
    expect(path.isAbsolute(process.execPath)).toBe(true);
  });
});
