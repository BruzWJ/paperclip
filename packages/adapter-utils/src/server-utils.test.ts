// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: AGENT_HOME, CODEX_HOME, codexHome, PAPERCLIP_API_KEY, PAPERCLIP_API_URL, PAPERCLIP_RUN_ID
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runChildProcess,
  sanitizeInheritedProviderChildEnv,
  sanitizeSshRemoteEnv,
} from "./server-utils.js";

function isPidRunning(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform === "linux") {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const state = /^State:\s+([A-Z])/m.exec(status)?.[1];
      return state !== "Z" && state !== "X";
    } catch {
      // The process disappeared between the liveness probe and /proc read.
      return false;
    }
  }

  return true;
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidRunning(pid);
}

describe("sanitizeSshRemoteEnv", () => {
  it("drops inherited host shell identity variables for SSH remote execution", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          NVM_DIR: "/Users/local/.nvm",
          TMPDIR: "/var/folders/local/T",
          XDG_CONFIG_HOME: "/Users/local/.config",
          SAFE_VALUE: "visible",
        },
        {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          NVM_DIR: "/Users/local/.nvm",
          TMPDIR: "/var/folders/local/T",
          XDG_CONFIG_HOME: "/Users/local/.config",
        },
      ),
    ).toEqual({
      SAFE_VALUE: "visible",
    });
  });

  it("preserves explicit remote overrides even for filtered key names", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          PATH: "/custom/remote/bin:/usr/bin",
          HOME: "/home/agent",
          TMPDIR: "/tmp",
          SAFE_VALUE: "visible",
        },
        {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          TMPDIR: "/var/folders/local/T",
        },
      ),
    ).toEqual({
      PATH: "/custom/remote/bin:/usr/bin",
      HOME: "/home/agent",
      TMPDIR: "/tmp",
      SAFE_VALUE: "visible",
    });
  });

  it("filters identity keys via case-insensitive match against the inherited env", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          // Caller passed PATH in upper case while the inherited (Windows-style)
          // host env exposes it as Path. The lookup must still treat them as
          // equal so the leaked host PATH gets stripped.
          PATH: "/host/bin:/usr/bin",
          HOME: "/host/home",
        },
        {
          Path: "/host/bin:/usr/bin",
          home: "/host/home",
        },
      ),
    ).toEqual({});
  });

  it("preserves explicitly-set identity keys when the inherited env disagrees in case but not in value", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          PATH: "/explicit/remote/bin",
        },
        {
          Path: "/host/bin:/usr/bin",
        },
      ),
    ).toEqual({ PATH: "/explicit/remote/bin" });
  });

  it("strips exact control-plane keys while preserving operator-native names byte-for-byte", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          SAFE_VALUE: "visible",
          PAPERCLIP_CLOUD_PROD_PROVIDER_TOKEN: "operator-selected",
          PAPERCLIP_API_URL: "https://paperclip.invalid",
          paperclip_api_key: "case-insensitive",
          AGENT_HOME: "/server/agent-home",
        },
        {},
      ),
    ).toEqual({
      SAFE_VALUE: "visible",
      PAPERCLIP_CLOUD_PROD_PROVIDER_TOKEN: "operator-selected",
    });
  });
});

describe("sanitizeInheritedProviderChildEnv", () => {
  it("removes inherited Paperclip channels, provider configuration, credentials, and homes", () => {
    expect(
      sanitizeInheritedProviderChildEnv({
        SAFE_VALUE: "visible",
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        PAPERCLIP_OPERATOR_NATIVE_VALUE: "server-inherited",
        PAPERCLIP_RUN_ID: "run-1",
        paperclip_api_url: "https://paperclip.invalid",
        AGENT_HOME: "/server/agent-home",
        HOME: "/server/home",
        XDG_CONFIG_HOME: "/server/config",
        CODEX_HOME: "/server/codex",
        ANTHROPIC_API_KEY: "host-anthropic-key",
        OPENAI_API_KEY: "host-openai-key",
        OPENAI_MODEL: "host-model",
        AWS_PROFILE: "host-bedrock-profile",
        GOOGLE_APPLICATION_CREDENTIALS: "/server/google.json",
        UNRELATED_ACCESS_TOKEN: "host-secret",
      }),
    ).toEqual({
      SAFE_VALUE: "visible",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
    });
  });
});

describe("runChildProcess", () => {
  it("does not spawn an attempt that was cancelled before launch", async () => {
    const attemptId = randomUUID();
    const controller = new AbortController();
    controller.abort("exact attempt cancelled");

    await expect(
      runChildProcess(
        attemptId,
        process.execPath,
        ["-e", "process.stdout.write('should-not-run')"],
        {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 0,
          graceSec: 1,
          abortSignal: controller.signal,
          onLog: async () => {},
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses explicit adapter provider configuration without inheriting host provider state", async () => {
    const inherited = {
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    process.env.HOME = "/server/implicit-home";
    process.env.CODEX_HOME = "/server/implicit-codex";
    process.env.ANTHROPIC_API_KEY = "host-anthropic-key";
    process.env.OPENAI_API_KEY = "host-openai-key";

    try {
      const result = await runChildProcess(
        randomUUID(),
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify({ home: process.env.HOME ?? null, userProfile: process.env.USERPROFILE ?? null, codexHome: process.env.CODEX_HOME ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null, openai: process.env.OPENAI_API_KEY ?? null, claudeEntrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null }))",
        ],
        {
          cwd: process.cwd(),
          env: {
            CODEX_HOME: "/operator/codex",
            OPENAI_API_KEY: "operator-openai-key",
            CLAUDE_CODE_ENTRYPOINT: "operator-entrypoint",
          },
          timeoutSec: 5,
          graceSec: 1,
          onLog: async () => {},
        },
      );

      const output = JSON.parse(result.stdout) as Record<string, string | null>;
      expect(output).toMatchObject({
        codexHome: "/operator/codex",
        anthropic: null,
        openai: "operator-openai-key",
        claudeEntrypoint: "operator-entrypoint",
      });
      expect(output.home).toBe(output.userProfile);
      expect(output.home).not.toBe("/server/implicit-home");
      expect(path.dirname(output.home!)).toBe(os.tmpdir());
      expect(existsSync(output.home!)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("preserves an explicitly configured operator home", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({ home: process.env.HOME ?? null, userProfile: process.env.USERPROFILE ?? null }))",
      ],
      {
        cwd: process.cwd(),
        env: { HOME: "/operator/provider-home" },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(JSON.parse(result.stdout)).toEqual({
      home: "/operator/provider-home",
      userProfile: "/operator/provider-home",
    });
  });

  it("does not arm a timeout when timeoutSec is 0", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('done'), 150);"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("done");
  });

  it("waits for onSpawn before sending stdin to the child", async () => {
    const spawnDelayMs = 150;
    const startedAt = Date.now();
    let onSpawnCompletedAt = 0;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(data));",
      ],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "hello from stdin",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
          onSpawnCompletedAt = Date.now();
        },
      },
    );
    const finishedAt = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
    expect(onSpawnCompletedAt).toBeGreaterThanOrEqual(startedAt + spawnDelayMs);
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(spawnDelayMs);
  });

  it.skipIf(process.platform === "win32")("kills descendant processes on timeout via the process group", async () => {
    let descendantPid: number | null = null;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write(String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {},
      },
    );

    descendantPid = Number.parseInt(result.stdout.trim(), 10);
    expect(result.timedOut).toBe(true);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

    expect(await waitForPidExit(descendantPid!, 2_000)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "force-kills a child that ignores SIGTERM once the grace window elapses",
    async () => {
      // Residual hang case: a child that installs a SIGTERM handler which
      // swallows the signal and keeps running. The timeout sends SIGTERM at
      // timeoutSec, then must escalate to SIGKILL graceSec later. If the
      // escalation were gated on `child.killed` (which is true the instant
      // SIGTERM is *sent*, not when the process exits) the SIGKILL would be
      // suppressed and this child would outlive its deadline.
      const result = await runChildProcess(
        randomUUID(),
        process.execPath,
        [
          "-e",
          [
            "process.on('SIGTERM', () => {});",
            "process.stdout.write(String(process.pid));",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 1,
          graceSec: 1,
          onLog: async () => {},
          onSpawn: async () => {},
        },
      );

      const childPid = Number.parseInt(result.stdout.trim(), 10);
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      expect(await waitForPidExit(childPid, 2_000)).toBe(true);
    },
  );

});
