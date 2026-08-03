import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  isEnvironmentDriverSupportedForAdapter,
  type Environment,
  type EnvironmentLease,
} from "@paperclipai/shared";
import {
  type AdapterExecutionTarget,
  type AdapterCommandManagedExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";

export const DEFAULT_SANDBOX_REMOTE_CWD = "/tmp";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readShellCommand(
  ...values: unknown[]
): "bash" | "sh" | null {
  for (const value of values) {
    if (value === "bash" || value === "sh") return value;
  }
  return null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : null;
}

export async function resolveEnvironmentExecutionTarget(input: {
  db: Db;
  companyId: string;
  adapterType: string;
  environment: {
    id?: string;
    driver: string;
    config: Record<string, unknown> | null;
  };
  leaseId?: string | null;
  leaseMetadata: Record<string, unknown> | null;
  realizedCwd?: string | null;
  lease?: EnvironmentLease | null;
  environmentRuntime?: EnvironmentRuntimeService | null;
}): Promise<AdapterExecutionTarget | null> {
  if (input.environment.driver === "local") {
    return {
      kind: "local",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
    };
  }

  if (input.environment.driver === "sandbox") {
    if (
      !isEnvironmentDriverSupportedForAdapter(
        input.adapterType,
        "sandbox",
      )
    ) {
      return null;
    }

    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      id: input.environment.id,
      driver: input.environment.driver as "sandbox",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "sandbox") {
      return null;
    }
    if (
      input.environmentRuntime
      && input.lease
      && !input.environmentRuntime.supportsExecutionCancellation({
        environment: input.environment as Environment,
        lease: input.lease,
      })
    ) {
      throw new Error(
        `Sandbox provider "${parsed.config.provider}" is not execution-ready because it does not support exact command cancellation.`,
      );
    }

    const remoteCwd =
      readNonEmptyString(input.realizedCwd) ??
      readNonEmptyString(input.leaseMetadata?.remoteCwd) ??
      DEFAULT_SANDBOX_REMOTE_CWD;
    const timeoutMs = "timeoutMs" in parsed.config ? parsed.config.timeoutMs : null;
    const shellCommand = readShellCommand(
      input.leaseMetadata?.shellCommand,
      (parsed.config as Record<string, unknown>).shellCommand,
    );
    const runtime = input.environmentRuntime;
    const lease = input.lease;

    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: parsed.config.provider,
      shellCommand,
      remoteCwd,
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      timeoutMs,
      runner: runtime && lease
        ? createCommandManagedRuntimeRunner(
            {
              ...input,
              environmentRuntime: runtime,
              lease,
            },
            remoteCwd,
          )
        : undefined,
    };
  }

  if (input.environment.driver === "plugin") {
    if (
      !isEnvironmentDriverSupportedForAdapter(
        input.adapterType,
        "plugin",
      )
    ) {
      return null;
    }
    const parsed =
      await resolveEnvironmentDriverConfigForRuntime(
        input.db,
        input.companyId,
        {
          id: input.environment.id,
          driver: "plugin",
          config: parseObject(input.environment.config),
        },
      );
    if (parsed.driver !== "plugin") return null;

    const remoteCwd = readNonEmptyString(input.realizedCwd);
    if (!remoteCwd) {
      throw new Error(
        `Plugin environment driver "${parsed.config.pluginKey}:${parsed.config.driverKey}" did not realize an exact workspace cwd.`,
      );
    }
    const runtime = input.environmentRuntime;
    const lease = input.lease;
    if (!runtime || !lease) {
      throw new Error(
        `Plugin environment driver "${parsed.config.pluginKey}:${parsed.config.driverKey}" is missing its acquired runtime lease.`,
      );
    }
    if (!runtime.supportsExecutionCancellation({
      environment: input.environment as Environment,
      lease,
    })) {
      throw new Error(
        `Plugin environment driver "${parsed.config.pluginKey}:${parsed.config.driverKey}" is not execution-ready because it does not support exact command cancellation.`,
      );
    }

    return {
      kind: "remote",
      transport: "plugin",
      pluginKey: parsed.config.pluginKey,
      driverKey: parsed.config.driverKey,
      shellCommand: readShellCommand(
        input.leaseMetadata?.shellCommand,
        parsed.config.driverConfig.shellCommand,
      ),
      remoteCwd,
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      timeoutMs: readPositiveInteger(
        parsed.config.driverConfig.timeoutMs,
      ),
      runner: createCommandManagedRuntimeRunner(
        {
          ...input,
          environmentRuntime: runtime,
          lease,
        },
        remoteCwd,
      ),
    };
  }

  if (
    input.environment.driver !== "ssh" ||
    !isEnvironmentDriverSupportedForAdapter(
      input.adapterType,
      "ssh",
    )
  ) {
    return null;
  }

  const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
    id: input.environment.id,
    driver: input.environment.driver as "ssh",
    config: parseObject(input.environment.config),
  });
  if (parsed.driver !== "ssh") {
    return null;
  }

  const remoteCwd =
    readNonEmptyString(input.realizedCwd) ??
    readNonEmptyString(input.leaseMetadata?.remoteCwd) ??
    parsed.config.remoteWorkspacePath;

  return {
    kind: "remote",
    transport: "ssh",
    environmentId: input.environment.id ?? null,
    leaseId: input.leaseId ?? null,
    remoteCwd,
    spec: {
      host: parsed.config.host,
      port: parsed.config.port,
      username: parsed.config.username,
      remoteWorkspacePath: parsed.config.remoteWorkspacePath,
      privateKey: parsed.config.privateKey,
      knownHosts: parsed.config.knownHosts,
      strictHostKeyChecking: parsed.config.strictHostKeyChecking,
      remoteCwd,
    },
  };
}

function createCommandManagedRuntimeRunner(
  input: Parameters<typeof resolveEnvironmentExecutionTarget>[0] & {
    environmentRuntime: EnvironmentRuntimeService;
    lease: EnvironmentLease;
  },
  remoteCwd: string,
): NonNullable<AdapterCommandManagedExecutionTarget["runner"]> {
  const environment = input.environment as Environment;
  const runtime = input.environmentRuntime;
  const lease = input.lease;
  return {
    supportsSingleStreamStdinProgress: false,
    execute: async (commandInput) => {
      const executionId =
        commandInput.executionId ?? randomUUID();
      const startedAt = new Date().toISOString();
      const result = await runtime.execute({
        environment,
        lease,
        executionId,
        command: commandInput.command,
        args: commandInput.args,
        cwd: commandInput.cwd ?? remoteCwd,
        env: commandInput.env,
        stdin: commandInput.stdin,
        timeoutMs: commandInput.timeoutMs,
      });
      if (result.stdout) {
        await commandInput.onLog?.("stdout", result.stdout);
      }
      if (result.stderr) {
        await commandInput.onLog?.("stderr", result.stderr);
      }
      return {
        exitCode: result.exitCode,
        signal: result.signal ?? null,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        pid: null,
        startedAt,
      };
    },
    cancelExecution: ({ executionId, reason }) =>
      runtime.cancelExecution({
        companyId: input.companyId,
        environment,
        lease,
        executionId,
        reason,
      }),
    ...(runtime.supportsSync({ environment, lease })
      ? {
          syncIn: (operations) =>
            runtime.syncIn({
              environment,
              lease,
              operations,
            }),
          syncOut: (operations) =>
            runtime.syncOut({
              environment,
              lease,
              operations,
            }),
        }
      : {}),
  };
}
