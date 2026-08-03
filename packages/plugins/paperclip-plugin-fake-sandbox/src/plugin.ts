import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  buildCancelEnvironmentShellCommand,
  createEnvironmentExecutionCancellationRegistry,
  definePlugin,
  wrapCancellableEnvironmentShellCommand,
} from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentCancelExecutionParams,
  PluginEnvironmentCancelExecutionResult,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentCancelInteractiveSetupParams,
  PluginEnvironmentCancelInteractiveSetupResult,
  PluginEnvironmentCaptureTemplateParams,
  PluginEnvironmentCaptureTemplateResult,
  PluginEnvironmentDeleteTemplateParams,
  PluginEnvironmentDeleteTemplateResult,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentGetInteractiveSetupParams,
  PluginEnvironmentInteractiveSetupSession,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentStartInteractiveSetupParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

interface FakeDriverConfig {
  image: string;
  timeoutMs: number;
  reuseLease: boolean;
}

interface FakeLeaseState {
  providerLeaseId: string;
  rootDir: string;
  remoteCwd: string;
  image: string;
  reuseLease: boolean;
}

interface FakeSetupState {
  providerLeaseId: string;
  environmentId: string;
  sessionId: string;
  image: string;
  sourceTemplateRef: string | null;
  expiresAt: string | null;
  status: "waiting_for_user" | "capturing" | "promoted" | "cancelled" | "timed_out" | "failed";
  capturedTemplateRef: string | null;
}

interface FakeTemplateState {
  templateRef: string;
  environmentId: string;
  sessionId: string;
  image: string;
  sourceTemplateRef: string | null;
  previousTemplateRef: string | null;
  deleted: boolean;
}

const leases = new Map<string, FakeLeaseState>();
const setupSessions = new Map<string, FakeSetupState>();
const templates = new Map<string, FakeTemplateState>();
const DEFAULT_FAKE_SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const FAKE_SANDBOX_SIGKILL_GRACE_MS = 250;
const REDACTED_FAKE_SSH_COMMAND = "ssh sandbox@[fake-setup-host-redacted] -p [fake-port-redacted]";

function parseConfig(raw: Record<string, unknown>): FakeDriverConfig {
  return {
    image: typeof raw.image === "string" && raw.image.trim().length > 0 ? raw.image.trim() : "fake:latest",
    timeoutMs: typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) ? raw.timeoutMs : 300_000,
    reuseLease: raw.reuseLease === true,
  };
}

async function createLeaseState(input: {
  providerLeaseId: string;
  image: string;
  reuseLease: boolean;
}): Promise<FakeLeaseState> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-fake-sandbox-"));
  const remoteCwd = path.join(rootDir, "workspace");
  await mkdir(remoteCwd, { recursive: true });
  const state = {
    providerLeaseId: input.providerLeaseId,
    rootDir,
    remoteCwd,
    image: input.image,
    reuseLease: input.reuseLease,
  };
  leases.set(input.providerLeaseId, state);
  return state;
}

function leaseMetadata(state: FakeLeaseState) {
  return {
    provider: "fake-plugin",
    image: state.image,
    reuseLease: state.reuseLease,
    remoteCwd: state.remoteCwd,
    fakeRootDir: state.rootDir,
  };
}

function encodeRefPart(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}

function buildSetupProviderLeaseId(environmentId: string, sessionId: string): string {
  return `fake-plugin-setup://${encodeRefPart(environmentId)}/${encodeRefPart(sessionId)}`;
}

function buildTemplateRef(environmentId: string, sessionId: string): string {
  return `fake-template:${encodeRefPart(environmentId)}:${encodeRefPart(sessionId)}`;
}

function setupMetadata(state: FakeSetupState): Record<string, unknown> {
  return {
    provider: "fake-plugin",
    image: state.image,
    sourceTemplateRefRedacted: Boolean(state.sourceTemplateRef),
    setupSessionId: state.sessionId,
    redactedConnectionOnly: true,
    capturedTemplateRefRedacted: Boolean(state.capturedTemplateRef),
  };
}

function setupConnectionSummary(): PluginEnvironmentInteractiveSetupSession["connectionSummary"] {
  return {
    type: "ssh",
    username: "sandbox",
    hostRedacted: true,
    portRedacted: true,
    commandRedacted: true,
    metadata: {
      placeholderOnly: true,
    },
  };
}

function setupConnectionPayload(expiresAt: string | null): PluginEnvironmentInteractiveSetupSession["connectionPayload"] {
  return {
    type: "ssh",
    command: REDACTED_FAKE_SSH_COMMAND,
    expiresAt,
    metadata: {
      placeholderOnly: true,
    },
  };
}

function presentSetupSession(
  state: FakeSetupState,
  options: { includeConnectionPayload: boolean },
): PluginEnvironmentInteractiveSetupSession {
  const canConnect = state.status === "waiting_for_user";
  return {
    providerLeaseId: state.providerLeaseId,
    status: state.status,
    connectionSummary: canConnect ? setupConnectionSummary() : null,
    connectionPayload: canConnect && options.includeConnectionPayload ? setupConnectionPayload(state.expiresAt) : null,
    expiresAt: state.expiresAt,
    metadata: setupMetadata(state),
  };
}

function cancelStatusFromReason(
  reason: string | null | undefined,
): Extract<FakeSetupState["status"], "cancelled" | "timed_out" | "failed"> {
  if (reason === "timed_out") return "timed_out";
  if (reason === "failed") return "failed";
  return "cancelled";
}

async function removeLease(providerLeaseId: string | null | undefined): Promise<void> {
  if (!providerLeaseId) return;
  const state = leases.get(providerLeaseId);
  leases.delete(providerLeaseId);
  if (state) {
    await rm(state.rootDir, { recursive: true, force: true });
  }
}

function buildCommandLine(command: string, args: string[] | undefined): string {
  return [command, ...(args ?? [])]
    .map((value) => `'${value.replace(/'/g, `'"'"'`)}'`)
    .join(" ");
}

function buildCommandEnvironment(explicitEnv: Record<string, string> | undefined): Record<string, string> {
  return {
    PATH: explicitEnv?.PATH ?? DEFAULT_FAKE_SANDBOX_PATH,
    ...(explicitEnv ?? {}),
  };
}

const activeExecutions = createEnvironmentExecutionCancellationRegistry();

async function cancelChildProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // The exact process already exited.
      }
      finish();
    }, FAKE_SANDBOX_SIGKILL_GRACE_MS);
    child.once("close", finish);
    try {
      if (child.pid && process.platform !== "win32") {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      finish();
    }
  });
}

async function runExactCancellation(
  executionId: string,
): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      "sh",
      [
        "-c",
        buildCancelEnvironmentShellCommand(
          executionId,
          FAKE_SANDBOX_SIGKILL_GRACE_MS,
        ),
      ],
      { stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code === 0));
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Fake sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Fake sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseConfig(params.config);
    return {
      ok: true,
      normalizedConfig: { ...config },
    };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseConfig(params.config);
    return {
      ok: true,
      summary: `Fake sandbox provider is ready for image ${config.image}.`,
      metadata: {
        provider: "fake-plugin",
        image: config.image,
        timeoutMs: config.timeoutMs,
        reuseLease: config.reuseLease,
      },
    };
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseConfig(params.config);
    const providerLeaseId = config.reuseLease
      ? `fake-plugin://${params.environmentId}`
      : `fake-plugin://${params.runId}/${randomUUID()}`;
    const existing = leases.get(providerLeaseId);
    const state = existing ?? await createLeaseState({
      providerLeaseId,
      image: config.image,
      reuseLease: config.reuseLease,
    });

    return {
      providerLeaseId,
      metadata: {
        ...leaseMetadata(state),
        resumedLease: Boolean(existing),
      },
    };
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseConfig(params.config);
    const existing = leases.get(params.providerLeaseId);
    const state = existing ?? await createLeaseState({
      providerLeaseId: params.providerLeaseId,
      image: config.image,
      reuseLease: config.reuseLease,
    });

    return {
      providerLeaseId: state.providerLeaseId,
      metadata: {
        ...leaseMetadata(state),
        resumedLease: true,
      },
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    const config = parseConfig(params.config);
    if (!config.reuseLease) {
      await removeLease(params.providerLeaseId);
    }
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    await removeLease(params.providerLeaseId);
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const state = params.lease.providerLeaseId
      ? leases.get(params.lease.providerLeaseId)
      : null;
    const remoteCwd =
      state?.remoteCwd ??
      (typeof params.lease.metadata?.remoteCwd === "string" ? params.lease.metadata.remoteCwd : null) ??
      params.workspace.remotePath ??
      params.workspace.localPath ??
      path.join(os.tmpdir(), "paperclip-fake-sandbox-workspace");

    await mkdir(remoteCwd, { recursive: true });

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "fake-plugin",
        remoteCwd,
      },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    const config = parseConfig(params.config);
    let child: ChildProcess | null = null;
    return await activeExecutions.execute(params, {
      execute: async () => {
        const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : process.cwd();
        const startedAt = new Date().toISOString();
        const stdinPath =
          params.stdin == null
            ? null
            : path.join(
                os.tmpdir(),
                `paperclip-fake-stdin-${randomUUID()}`,
              );
        if (stdinPath) {
          await writeFile(stdinPath, params.stdin!, "utf8");
        }
        const commandLine = buildCommandLine(
          params.command,
          params.args,
        );
        const commandScript = stdinPath
          ? `${commandLine} < '${stdinPath.replace(/'/g, `'"'"'`)}'`
          : commandLine;
        return await new Promise((resolve, reject) => {
          const spawned = spawn("sh", [
            "-c",
            wrapCancellableEnvironmentShellCommand(
              params.executionId,
              commandScript,
            ),
          ], {
            cwd,
            env: buildCommandEnvironment(params.env),
            detached: process.platform !== "win32",
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          });
          child = spawned;
          let stdout = "";
          let stderr = "";
          let timedOut = false;
          const timer = (params.timeoutMs ?? config.timeoutMs) > 0
            ? setTimeout(() => {
                timedOut = true;
                void runExactCancellation(
                  params.executionId,
                ).finally(() => {
                  if (
                    spawned.exitCode === null &&
                    spawned.signalCode === null
                  ) {
                    spawned.kill("SIGKILL");
                  }
                });
              }, params.timeoutMs ?? config.timeoutMs)
            : null;

          spawned.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
          });
          spawned.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
          });
          spawned.on("error", (error) => {
            if (timer) clearTimeout(timer);
            if (stdinPath) {
              void rm(stdinPath, { force: true });
            }
            reject(error);
          });
          spawned.on("close", (code, signal) => {
            if (timer) clearTimeout(timer);
            if (stdinPath) {
              void rm(stdinPath, { force: true });
            }
            resolve({
              exitCode: timedOut ? null : code,
              signal,
              timedOut,
              stdout,
              stderr,
              metadata: {
                startedAt,
                commandLine,
              },
            });
          });
        });
      },
      cancel: async () => {
        await runExactCancellation(params.executionId);
        await cancelChildProcess(child);
      },
    });
  },

  async onEnvironmentCancelExecution(
    params: PluginEnvironmentCancelExecutionParams,
  ): Promise<PluginEnvironmentCancelExecutionResult> {
    return await activeExecutions.cancel(
      params,
      async () =>
        runExactCancellation(params.executionId),
    );
  },

  async onEnvironmentStartInteractiveSetup(
    params: PluginEnvironmentStartInteractiveSetupParams,
  ): Promise<PluginEnvironmentInteractiveSetupSession> {
    const config = parseConfig(params.config);
    const providerLeaseId = buildSetupProviderLeaseId(params.environmentId, params.sessionId);
    const state = setupSessions.get(providerLeaseId) ?? {
      providerLeaseId,
      environmentId: params.environmentId,
      sessionId: params.sessionId,
      image: config.image,
      sourceTemplateRef: params.sourceTemplateRef ?? null,
      expiresAt: params.expiresAt ?? null,
      status: "waiting_for_user" as const,
      capturedTemplateRef: null,
    };
    setupSessions.set(providerLeaseId, state);
    return presentSetupSession(state, { includeConnectionPayload: true });
  },

  async onEnvironmentGetInteractiveSetup(
    params: PluginEnvironmentGetInteractiveSetupParams,
  ): Promise<PluginEnvironmentInteractiveSetupSession> {
    const state = params.providerLeaseId ? setupSessions.get(params.providerLeaseId) : undefined;
    if (!state) {
      return {
        providerLeaseId: params.providerLeaseId,
        status: "missing",
        connectionSummary: null,
        connectionPayload: null,
        metadata: {
          provider: "fake-plugin",
          found: false,
        },
      };
    }
    return presentSetupSession(state, { includeConnectionPayload: params.includeConnectionPayload === true });
  },

  async onEnvironmentCaptureTemplate(
    params: PluginEnvironmentCaptureTemplateParams,
  ): Promise<PluginEnvironmentCaptureTemplateResult> {
    const config = parseConfig(params.config);
    const state = params.providerLeaseId ? setupSessions.get(params.providerLeaseId) : undefined;
    if (!state) {
      throw new Error("Fake setup session not found.");
    }
    if (state.status === "cancelled" || state.status === "timed_out" || state.status === "failed") {
      throw new Error(`Fake setup session cannot be captured from status ${state.status}.`);
    }

    state.status = "capturing";
    const templateRef = buildTemplateRef(state.environmentId, state.sessionId);
    const template: FakeTemplateState = {
      templateRef,
      environmentId: state.environmentId,
      sessionId: state.sessionId,
      image: config.image,
      sourceTemplateRef: params.sourceTemplateRef ?? state.sourceTemplateRef,
      previousTemplateRef: params.previousTemplateRef ?? null,
      deleted: false,
    };
    templates.set(templateRef, template);
    state.status = "promoted";
    state.capturedTemplateRef = templateRef;
    await removeLease(state.providerLeaseId);

    return {
      templateRef,
      templateKind: "snapshot",
      metadata: {
        provider: "fake-plugin",
        image: template.image,
        sourceTemplateRefRedacted: Boolean(template.sourceTemplateRef),
        previousTemplateRefRedacted: Boolean(template.previousTemplateRef),
        setupSessionId: state.sessionId,
        promoted: true,
      },
    };
  },

  async onEnvironmentCancelInteractiveSetup(
    params: PluginEnvironmentCancelInteractiveSetupParams,
  ): Promise<PluginEnvironmentCancelInteractiveSetupResult> {
    const status = cancelStatusFromReason(params.reason);
    const state = params.providerLeaseId ? setupSessions.get(params.providerLeaseId) : undefined;
    if (state) {
      state.status = status;
      await removeLease(state.providerLeaseId);
    }
    return {
      status,
      metadata: {
        provider: "fake-plugin",
        found: Boolean(state),
      },
    };
  },

  async onEnvironmentDeleteTemplate(
    params: PluginEnvironmentDeleteTemplateParams,
  ): Promise<PluginEnvironmentDeleteTemplateResult> {
    const template = templates.get(params.templateRef);
    if (template) {
      template.deleted = true;
    }
    return {
      deleted: Boolean(template),
      metadata: {
        provider: "fake-plugin",
        templateRef: params.templateRef,
        templateKind: params.templateKind ?? "snapshot",
      },
    };
  },
});

export default plugin;
