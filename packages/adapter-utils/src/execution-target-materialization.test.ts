import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  materializeAdapterExecutionTargetTextFile,
  materializeAdapterExecutionTargetTextFiles,
} from "./execution-target-materialization.js";
import type {
  AdapterPluginExecutionTarget,
  AdapterSandboxExecutionTarget,
} from "./execution-target.js";
import * as serverUtils from "./server-utils.js";

const SECRET_CONTENT =
  '{"Authorization":"Bearer productive-run-secret"}\n';

describe("execution-target text-file materialization", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const directoryPath = cleanupDirs.pop();
      if (!directoryPath) continue;
      await fs.rm(directoryPath, {
        recursive: true,
        force: true,
      });
    }
  });

  function localCommandRunner() {
    return {
      cancelExecution: vi.fn(
        async (input: { executionId: string }) => ({
          executionId: input.executionId,
          cancelled: false,
        }),
      ),
      execute: vi.fn(
        async (input: {
          command: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          stdin?: string;
          timeoutMs?: number;
        }) =>
          await serverUtils.runChildProcess(
            randomUUID(),
            input.command,
            input.args ?? [],
            {
              cwd: input.cwd ?? process.cwd(),
              env: input.env ?? {},
              stdin: input.stdin,
              timeoutSec: Math.max(
                1,
                Math.ceil(
                  (input.timeoutMs ?? 15_000) / 1000,
                ),
              ),
              graceSec: 2,
              onLog: async () => {},
            },
          ),
      ),
    };
  }

  it("creates and cleans a mode-0600 local file", async () => {
    const materialized =
      await materializeAdapterExecutionTargetTextFile({
        target: { kind: "local" },
        fileName: "mcp.json",
        contents: SECRET_CONTENT,
      });
    cleanupDirs.push(materialized.directoryPath);

    expect(
      await fs.readFile(materialized.filePath, "utf8"),
    ).toBe(SECRET_CONTENT);
    expect(
      (await fs.stat(materialized.directoryPath)).mode & 0o777,
    ).toBe(0o700);
    expect(
      (await fs.stat(materialized.filePath)).mode & 0o777,
    ).toBe(0o600);

    await materialized.cleanup();
    await materialized.cleanup();
    await expect(
      fs.access(materialized.filePath),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("owns one cleanup lifecycle for a secret and proxy asset bundle", async () => {
    const materialized =
      await materializeAdapterExecutionTargetTextFiles({
        target: { kind: "local" },
        files: [
          {
            fileName: "run-tools.json",
            contents: SECRET_CONTENT,
          },
          {
            fileName: "run-tools-proxy.mjs",
            contents: "process.exit(0);\n",
          },
        ],
      });
    cleanupDirs.push(materialized.directoryPath);

    expect(
      path.dirname(
        materialized.filePaths["run-tools.json"]!,
      ),
    ).toBe(materialized.directoryPath);
    expect(
      path.dirname(
        materialized.filePaths["run-tools-proxy.mjs"]!,
      ),
    ).toBe(materialized.directoryPath);
    for (const filePath of Object.values(
      materialized.filePaths,
    )) {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(
        0o600,
      );
    }

    await materialized.cleanup();
    await expect(
      fs.access(materialized.directoryPath),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    {
      label: "sandbox",
      makeTarget(
        remoteCwd: string,
        runner: ReturnType<typeof localCommandRunner>,
      ): AdapterSandboxExecutionTarget {
        return {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fixture-sandbox",
          remoteCwd,
          runner,
        };
      },
    },
    {
      label: "plugin",
      makeTarget(
        remoteCwd: string,
        runner: ReturnType<typeof localCommandRunner>,
      ): AdapterPluginExecutionTarget {
        return {
          kind: "remote",
          transport: "plugin",
          pluginKey: "fixture.environments",
          driverKey: "fixture-driver",
          remoteCwd,
          runner,
        };
      },
    },
  ])(
    "creates and cleans a target-local mode-0600 file through the $label runner",
    async ({ makeTarget }) => {
      const remoteCwd = await fs.mkdtemp(
        path.join(os.tmpdir(), "paperclip-target-file-"),
      );
      cleanupDirs.push(remoteCwd);
      const runner = localCommandRunner();
      const materialized =
        await materializeAdapterExecutionTargetTextFile({
          target: makeTarget(remoteCwd, runner),
          fileName: "mcp.json",
          contents: SECRET_CONTENT,
        });

      expect(
        await fs.readFile(materialized.filePath, "utf8"),
      ).toBe(SECRET_CONTENT);
      expect(
        (await fs.stat(materialized.directoryPath)).mode &
          0o777,
      ).toBe(0o700);
      expect(
        (await fs.stat(materialized.filePath)).mode & 0o777,
      ).toBe(0o600);
      const writeCall = runner.execute.mock.calls.find(
        ([input]) => input.stdin === SECRET_CONTENT,
      );
      expect(writeCall).toBeDefined();
      expect(
        JSON.stringify({
          command: writeCall?.[0].command,
          args: writeCall?.[0].args,
          env: writeCall?.[0].env,
        }),
      ).not.toContain("productive-run-secret");

      await materialized.cleanup();
      await materialized.cleanup();
      await expect(
        fs.access(materialized.filePath),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("sends SSH file contents only over stdin and cleans the exact generated path", async () => {
    const runChildProcess = vi.spyOn(
      serverUtils,
      "runChildProcess",
    ).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: "2026-07-30T00:00:00.000Z",
    });
    const materialized =
      await materializeAdapterExecutionTargetTextFile({
        target: {
          kind: "remote",
          transport: "ssh",
          remoteCwd: "/srv/paperclip/workspace",
          spec: {
            host: "ssh.example.test",
            port: 22,
            username: "paperclip",
            remoteWorkspacePath:
              "/srv/paperclip/workspace",
            remoteCwd: "/srv/paperclip/workspace",
            privateKey: null,
            knownHosts: null,
            strictHostKeyChecking: true,
          },
        },
        fileName: "mcp.json",
        contents: SECRET_CONTENT,
      });

    expect(materialized.filePath).toMatch(
      /^\/srv\/paperclip\/workspace\/\.paperclip-runtime\/provider-invocations\/[^/]+\/mcp\.json$/,
    );
    const writeOptions = runChildProcess.mock.calls[0]?.[3];
    expect(writeOptions?.stdin).toBe(SECRET_CONTENT);
    expect(
      JSON.stringify({
        command: runChildProcess.mock.calls[0]?.[1],
        args: runChildProcess.mock.calls[0]?.[2],
        env: writeOptions?.env,
      }),
    ).not.toContain("productive-run-secret");
    expect(
      String(runChildProcess.mock.calls[0]?.[2]),
    ).toContain("chmod 600");

    await materialized.cleanup();
    expect(runChildProcess).toHaveBeenCalledTimes(2);
    const cleanupArgs = String(
      runChildProcess.mock.calls[1]?.[2],
    );
    expect(cleanupArgs).toContain(
      materialized.directoryPath,
    );
    expect(cleanupArgs).not.toContain(
      "productive-run-secret",
    );
  });

  it("rejects path-bearing file names before touching a target", async () => {
    await expect(
      materializeAdapterExecutionTargetTextFile({
        target: { kind: "local" },
        fileName: "../mcp.json",
        contents: SECRET_CONTENT,
      }),
    ).rejects.toThrow("simple file name");
  });

  it("does not surface a provider error that echoes secret stdin", async () => {
    const execute = vi.fn(
      async (input: { stdin?: string }) => {
        throw new Error(
          `provider echoed ${input.stdin ?? ""}`,
        );
      },
    );

    const materialization =
      materializeAdapterExecutionTargetTextFile({
        target: {
          kind: "remote",
          transport: "plugin",
          pluginKey: "fixture.environments",
          driverKey: "fixture-driver",
          remoteCwd: "/plugin/workspace",
          runner: {
            execute,
            cancelExecution: vi.fn(),
          },
        },
        fileName: "mcp.json",
        contents: SECRET_CONTENT,
      });
    await expect(materialization).rejects.toThrow(
      "Invocation-file materialization failed on the execution target.",
    );
    await expect(materialization).rejects.not.toThrow(
      "productive-run-secret",
    );
  });
});
