import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AcpAgentRegistry } from "acpx/runtime";
import {
  adapterExecutionTargetIsCommandManaged,
  resolveAdapterExecutionTargetNativeIdentityEnvironment,
  resolveAdapterExecutionTargetExecutable,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetProcessSessionBridge,
  type AdapterExecutionTarget,
} from "../execution-target.js";
import {
  materializeAdapterExecutionTargetTextFiles,
  type AdapterExecutionTargetMaterializedTextFiles,
  type AdapterExecutionTargetTextFile,
} from "../execution-target-materialization.js";
import {
  buildLocalProcessSandboxSpawnTarget,
  type LocalProcessSandboxOptions,
} from "../local-process-sandbox.js";
import {
  prepareSelectedCompanySkillTargetHome,
  type CollectedSelectedCompanySkillTargetHome,
  type PreparedSelectedCompanySkillTargetHome,
  type SelectedCompanySkillLaunchChannel,
} from "../selected-company-skills.js";
import { buildSshSpawnTarget, shellQuote } from "../ssh.js";
import {
  loadConfiguredAcpRegistry,
  resolveAcpRegistryLaunch,
  sameAcpRegistryLaunch,
  type AcpRegistryLaunch,
} from "./agent-registry.js";
import type { AcpSubprocessStarter } from "./client.js";
import type { AcpSubprocessLaunch } from "./contract.js";
import {
  spawnPreparedAcpSubprocess,
  type AcpSubprocess,
  type AcpSubprocessExit,
  type AcpSubprocessHostLaunch,
} from "./process.js";

const DEFAULT_TARGET_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_TARGET_PROBE_TIMEOUT_SEC = 15;

type CleanupStep = {
  readonly label: string;
  readonly run: () => Promise<void>;
};

export interface PrepareAcpExecutionTargetSubprocessInput {
  /** Durable attempt/run-scoped identity used only by the existing target. */
  readonly runId: string;
  readonly target: AdapterExecutionTarget;
  /** Persisted ACPX registry reference; ACPX resolves argv at execution time. */
  readonly sourceLaunch: Readonly<{ registryName: string }>;
  /** Test/host injection; production uses ACPX's installed default registry. */
  readonly agentRegistry?: AcpAgentRegistry;
  /** Explicit cwd for the local transport wrapper, never an ACP session cwd. */
  readonly hostCwd: string;
  /** Exact target-visible cwd sent later to ACP session/new or session/resume. */
  readonly targetCwd: string;
  readonly targetAdditionalDirectories: readonly string[];
  /** Exact immutable revision selection; operator_native performs zero I/O. */
  readonly companySkills: SelectedCompanySkillLaunchChannel;
  readonly runtimeRootDir?: string | null;
  readonly timeoutSec?: number | null;
  readonly cleanupTimeoutMs?: number;
  readonly localProcessSandbox?: LocalProcessSandboxOptions | null;
  readonly invocationFiles?: readonly AdapterExecutionTargetTextFile[];
  readonly onTargetLog?: (
    stream: "stdout" | "stderr",
    chunk: string,
  ) => Promise<void>;
}

export interface PreparedAcpExecutionTargetSubprocess {
  /** Exact launch resolved from ACPX's current host-workspace registry. */
  readonly launch: AcpRegistryLaunch;
  readonly targetCwd: string;
  readonly targetAdditionalDirectories: readonly string[];
  /** Target-local paths only. File contents are never returned. */
  readonly invocationFilePaths: Readonly<Record<string, string>>;
  /** Exact absolute Node executable resolved on the selected target. */
  readonly targetNodeExecutable: string;
  /** Exact target executable selected from ACPX's current registry launch. */
  readonly targetNativeExecutable: string;
  readonly selectedCompanySkillMaterialization: {
    readonly materializationKey: string;
    collectExact(
      expectedMaterializationKey: string,
    ): Promise<CollectedSelectedCompanySkillTargetHome>;
  } | null;
  readonly startSubprocess: AcpSubprocessStarter;
  /** Releases materialized files when setup fails before startSubprocess. */
  disposeBeforeStart(): Promise<void>;
}

interface TargetReadOnlySkillBinding {
  readonly binderExecutable: string;
  readonly home: PreparedSelectedCompanySkillTargetHome;
}

function requireExactNonempty(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be exact and non-empty`);
  }
  return value;
}

function requireAbsolutePath(
  value: string,
  label: string,
  remote: boolean,
): string {
  requireExactNonempty(value, label);
  if (!(remote ? path.posix.isAbsolute(value) : path.isAbsolute(value))) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * ACPX registry names are opaque protocol identifiers, not filesystem names.
 * Derive the target runtime directory key instead of imposing a Paperclip
 * character allowlist on a dynamically supplied agent name.
 */
function acpxRuntimeKey(registryName: string): string {
  return `acpx-${createHash("sha256")
    .update(registryName, "utf8")
    .digest("hex")}`;
}

function probeTimeoutSec(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, DEFAULT_TARGET_PROBE_TIMEOUT_SEC)
    : DEFAULT_TARGET_PROBE_TIMEOUT_SEC;
}

function requireSuccessfulProbe(
  result: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>,
  label: string,
): string {
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`${label} failed on the execution target`);
  }
  const output = result.stdout;
  if (
    output.length === 0 ||
    output !== output.trim() ||
    output.includes("\n") ||
    output.includes("\r")
  ) {
    throw new Error(`${label} returned a non-canonical result`);
  }
  return output;
}

async function resolveTargetNodeExecutable(input: {
  readonly target: AdapterExecutionTarget;
  readonly targetCwd: string;
  readonly timeoutSec: number;
}): Promise<string> {
  const remote = input.target.kind === "remote";
  let candidate = process.execPath;
  if (remote) {
    const probe = await runAdapterExecutionTargetShellCommand(
      randomUUID(),
      input.target,
      "command -v node",
      {
        cwd: input.targetCwd,
        env: {},
        timeoutSec: input.timeoutSec,
      },
    );
    if (probe.timedOut || probe.exitCode !== 0) {
      throw new Error(
        "The execution target does not expose its pinned Node runtime",
      );
    }
    const candidateMatch = /^([^\r\n]+)\r?\n?$/.exec(probe.stdout);
    candidate = candidateMatch?.[1] ?? "";
    if (candidate.length === 0 || candidate !== candidate.trim()) {
      throw new Error(
        "The execution target returned an ambiguous Node runtime path",
      );
    }
    requireAbsolutePath(candidate, "ACP target Node probe", true);
  } else {
    requireAbsolutePath(candidate, "ACP local Node executable", false);
  }

  const identity = requireSuccessfulProbe(
    remote
      ? await runAdapterExecutionTargetShellCommand(
          randomUUID(),
          input.target,
          `${shellQuote(candidate)} -e ${shellQuote("process.stdout.write(process.execPath)")}`,
          {
            cwd: input.targetCwd,
            env: {},
            timeoutSec: input.timeoutSec,
          },
        )
      : await runAdapterExecutionTargetProcess(
          randomUUID(),
          input.target,
          candidate,
          ["-e", "process.stdout.write(process.execPath)"],
          {
            cwd: input.targetCwd,
            env: {},
            timeoutSec: input.timeoutSec,
            graceSec: 2,
            onLog: async () => {},
          },
        ),
    "ACP target Node identity probe",
  );
  return requireAbsolutePath(identity, "ACP target Node executable", remote);
}

async function resolveTargetReadOnlyBinder(input: {
  readonly target: AdapterExecutionTarget;
  readonly targetCwd: string;
  readonly timeoutSec: number;
}): Promise<string> {
  const result = await runAdapterExecutionTargetShellCommand(
    randomUUID(),
    input.target,
    "command -v bwrap",
    {
      cwd: input.targetCwd,
      env: {},
      timeoutSec: input.timeoutSec,
    },
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      "This execution target cannot enforce isolated_skills_home; select operator_native or install a conforming read-only binder",
    );
  }
  const executable = result.stdout.trim();
  if (
    executable.length === 0 ||
    executable.includes("\n") ||
    executable.includes("\r")
  ) {
    throw new Error(
      "The execution target returned an ambiguous read-only binder path",
    );
  }
  return requireAbsolutePath(
    executable,
    "ACP target read-only binder",
    input.target.kind === "remote",
  );
}

function requireCleanupTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TARGET_CLEANUP_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "ACP execution-target cleanup timeout must be a positive integer",
    );
  }
  return timeoutMs;
}

async function boundedCleanup(
  step: CleanupStep,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      step.run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `ACP execution-target ${step.label} exceeded its cleanup deadline`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runCleanupSteps(
  steps: readonly CleanupStep[],
  timeoutMs: number,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await boundedCleanup(step, timeoutMs);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "ACP execution-target cleanup failed",
    );
  }
}

function createOnceCleanup(
  steps: readonly CleanupStep[],
  timeoutMs: number,
): () => Promise<void> {
  let cleanup: Promise<void> | null = null;
  return () => {
    cleanup ??= runCleanupSteps(steps, timeoutMs);
    return cleanup;
  };
}

async function finishWithCleanup(
  reap: () => Promise<AcpSubprocessExit>,
  cleanup: () => Promise<void>,
): Promise<AcpSubprocessExit> {
  let processExit: AcpSubprocessExit | null = null;
  let reapFailure: unknown | null = null;
  let cleanupFailure: unknown | null = null;
  try {
    processExit = await reap();
  } catch (error) {
    reapFailure = error;
  }
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = error;
  }
  if (reapFailure !== null && cleanupFailure !== null) {
    throw new AggregateError(
      [reapFailure, cleanupFailure],
      "ACP process reap and execution-target cleanup failed",
    );
  }
  if (reapFailure !== null) throw reapFailure;
  if (cleanupFailure !== null) throw cleanupFailure;
  if (!processExit) {
    throw new Error("ACP subprocess did not produce a process exit");
  }
  return processExit;
}

function withTargetCleanup(
  subprocess: AcpSubprocess,
  cleanup: () => Promise<void>,
): AcpSubprocess {
  return Object.freeze({
    ...subprocess,
    closeAndReap(graceMs?: number) {
      return finishWithCleanup(
        () => subprocess.closeAndReap(graceMs),
        cleanup,
      );
    },
    terminateAndReap(graceMs?: number) {
      return finishWithCleanup(
        () => subprocess.terminateAndReap(graceMs),
        cleanup,
      );
    },
  });
}

function localSandboxOptions(
  configured: LocalProcessSandboxOptions,
  materialized: AdapterExecutionTargetMaterializedTextFiles | null,
): LocalProcessSandboxOptions {
  if (!materialized) return configured;
  return {
    ...configured,
    managedPaths: [
      { path: materialized.directoryPath, access: "ro" },
      ...(configured.managedPaths ?? []),
    ],
  };
}

function validateLaunchAgainstTarget(
  launch: AcpSubprocessLaunch,
  sourceLaunch: AcpRegistryLaunch,
  targetCwd: string,
  targetAdditionalDirectories: readonly string[],
): void {
  if (launch.cwd !== targetCwd) {
    throw new Error(
      "ACP launch cwd does not match the prepared execution-target cwd",
    );
  }
  if (
    !sameStrings(
      launch.additionalDirectories,
      targetAdditionalDirectories,
    )
  ) {
    throw new Error(
      "ACP launch additional directories do not match the prepared execution target",
    );
  }
  if (!sameAcpRegistryLaunch(launch.launch, sourceLaunch)) {
    throw new Error(
      "ACPX launch changed after execution-target preparation",
    );
  }
  if (Object.keys(launch.environment).length !== 0) {
    throw new Error(
      "ACP launch environment must remain empty at the provider boundary",
    );
  }
}

async function prepareHostLaunch(input: {
  readonly launch: AcpSubprocessLaunch;
  readonly target: AdapterExecutionTarget;
  readonly hostCwd: string;
  readonly targetCwd: string;
  readonly runId: string;
  readonly runtimeRootDir: string | null | undefined;
  readonly timeoutSec: number | null | undefined;
  readonly localProcessSandbox: LocalProcessSandboxOptions | null | undefined;
  readonly materialized: AdapterExecutionTargetMaterializedTextFiles | null;
  readonly adapterKey: string;
  readonly targetCommand: string;
  readonly targetArgs: readonly string[];
  readonly targetNativeExecutable: string;
  readonly targetNativeIdentityEnvironment: Readonly<Record<string, string>>;
  readonly selectedCompanySkillBinding: TargetReadOnlySkillBinding | null;
  readonly onTargetLog:
    | ((stream: "stdout" | "stderr", chunk: string) => Promise<void>)
    | undefined;
}): Promise<{
  readonly hostLaunch: AcpSubprocessHostLaunch;
  readonly cleanup: CleanupStep | null;
}> {
  const target = input.target;
  const targetEnvironment = input.targetNativeIdentityEnvironment;
  let targetCommand = input.targetCommand;
  let targetArgs = [...input.targetArgs];
  if (input.selectedCompanySkillBinding) {
    const { binderExecutable, home } = input.selectedCompanySkillBinding;
    const discoveryParent = path.posix.dirname(home.discoveryRoot);
    const discoveryAgentRoot = path.posix.join(
      home.discoveryRoot,
      ".agents",
    );
    const discoverySkillsRoot = path.posix.join(
      discoveryAgentRoot,
      "skills",
    );
    targetCommand = binderExecutable;
    targetArgs = [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--disable-userns",
      "--cap-drop",
      "ALL",
      "--bind",
      "/",
      "/",
      // Replace any target-owned discovery parent inside this mount namespace;
      // a pre-existing directory or symlink can never steer the binding.
      "--tmpfs",
      discoveryParent,
      "--dir",
      home.discoveryRoot,
      "--dir",
      discoveryAgentRoot,
      "--dir",
      discoverySkillsRoot,
      "--ro-bind",
      home.skillsDir,
      discoverySkillsRoot,
      // The target-private source store must not be navigable by the child;
      // only its one read-only bind is visible at discoveryRoot.
      "--tmpfs",
      home.storeRoot,
      "--remount-ro",
      discoveryParent,
      "--chdir",
      input.targetCwd,
      "--",
      input.targetCommand,
      ...input.targetArgs,
    ];
  }
  if (target.kind === "local") {
    if (!input.localProcessSandbox) {
      return {
        hostLaunch: {
          command: targetCommand,
          args: targetArgs,
          cwd: input.targetCwd,
          environment: targetEnvironment,
        },
        cleanup: null,
      };
    }
    const sandbox = await buildLocalProcessSandboxSpawnTarget({
      executable: targetCommand,
      args: targetArgs,
      cwd: input.targetCwd,
      options: localSandboxOptions(
        input.localProcessSandbox,
        input.materialized,
      ),
      requiredExecutables: [input.targetNativeExecutable],
      requiredIdentityEnvironment: input.targetNativeIdentityEnvironment,
    });
    return {
      hostLaunch: {
        command: sandbox.command,
        args: sandbox.args,
        cwd: sandbox.cwd,
        environment: {
          ...targetEnvironment,
          ...sandbox.env,
        },
      },
      cleanup: sandbox.cleanup
        ? { label: "local sandbox cleanup", run: sandbox.cleanup }
        : null,
    };
  }

  if (target.transport === "ssh") {
    if (input.localProcessSandbox) {
      throw new Error(
        "Local process confinement cannot wrap a remote ACP execution target",
      );
    }
    const ssh = await buildSshSpawnTarget({
      spec: target.spec,
      command: targetCommand,
      args: targetArgs,
      env: { ...targetEnvironment },
      cwd: input.targetCwd,
    });
    return {
      hostLaunch: {
      command: ssh.command,
        args: ssh.args,
        cwd: input.hostCwd,
        environment: {},
      },
      cleanup: { label: "SSH authentication cleanup", run: ssh.cleanup },
    };
  }

  if (!adapterExecutionTargetIsCommandManaged(target)) {
    throw new Error("Unsupported ACP execution target");
  }
  if (input.localProcessSandbox) {
    throw new Error(
      "Local process confinement cannot wrap a remote ACP execution target",
    );
  }
  const bridge = await startAdapterExecutionTargetProcessSessionBridge({
    runId: input.runId,
    target,
    runtimeRootDir: input.runtimeRootDir,
    adapterKey: input.adapterKey,
    command: targetCommand,
    args: targetArgs,
    cwd: input.targetCwd,
    env: { ...targetEnvironment },
    timeoutSec: input.timeoutSec,
    onLog: input.onTargetLog,
  });
  if (!bridge) {
    throw new Error(
      "Command-managed ACP execution target did not create its process bridge",
    );
  }
  return {
    hostLaunch: {
      command: bridge.agentCommand,
      args: [],
      cwd: input.hostCwd,
      environment: {},
    },
    cleanup: {
      label: `${target.transport} process bridge cleanup`,
      run: bridge.stop,
    },
  };
}

/**
 * Prepares the one target-neutral subprocess starter consumed by the common
 * ACP lifecycle. The immutable approved launch remains the client's input;
 * only host-side transport mechanics are wrapped per the existing target.
 */
export async function prepareAcpExecutionTargetSubprocess(
  input: PrepareAcpExecutionTargetSubprocessInput,
): Promise<PreparedAcpExecutionTargetSubprocess> {
  const runId = requireExactNonempty(input.runId, "ACP execution run id");
  const remote = input.target.kind === "remote";
  const hostCwd = requireAbsolutePath(
    input.hostCwd,
    "ACP host wrapper cwd",
    false,
  );
  const targetCwd = requireAbsolutePath(
    input.targetCwd,
    "ACP target cwd",
    remote,
  );
  const baseTargetAdditionalDirectories = Object.freeze(
    input.targetAdditionalDirectories.map((directory, index) =>
      requireAbsolutePath(
        directory,
        `ACP target additionalDirectories[${index}]`,
        remote,
      ),
    ),
  );
  if (input.runtimeRootDir !== null && input.runtimeRootDir !== undefined) {
    requireAbsolutePath(
      input.runtimeRootDir,
      "ACP target runtime root",
      remote,
    );
  }
  if (input.localProcessSandbox && remote) {
    throw new Error(
      "Local process confinement cannot wrap a remote ACP execution target",
    );
  }
  if (
    input.companySkills.channel === "isolated_skills_home" &&
    input.localProcessSandbox
  ) {
    throw new Error(
      "isolated_skills_home cannot bypass or nest a configured local sandbox; select operator_native for this target policy",
    );
  }
  const cleanupTimeoutMs = requireCleanupTimeout(input.cleanupTimeoutMs);
  const registry = input.agentRegistry ?? await loadConfiguredAcpRegistry({
    cwd: hostCwd,
  });
  const acpxLaunch = resolveAcpRegistryLaunch(
    input.sourceLaunch.registryName,
    registry,
  );
  const targetOperationTimeoutSec = probeTimeoutSec(input.timeoutSec);
  const targetNodeExecutable = await resolveTargetNodeExecutable({
    target: input.target,
    targetCwd,
    timeoutSec: targetOperationTimeoutSec,
  });
  const targetNativeExecutable =
    await resolveAdapterExecutionTargetExecutable({
      runId: randomUUID(),
      target: input.target,
      selector: acpxLaunch.command,
      targetNodeExecutable,
      cwd: targetCwd,
      timeoutSec: targetOperationTimeoutSec,
    });
  const targetNativeIdentityEnvironment =
    resolveAdapterExecutionTargetNativeIdentityEnvironment(input.target);
  let selectedCompanySkillBinding: TargetReadOnlySkillBinding | null = null;
  if (input.companySkills.channel === "isolated_skills_home") {
    const binderExecutable = await resolveTargetReadOnlyBinder({
      target: input.target,
      targetCwd,
      timeoutSec: targetOperationTimeoutSec,
    });
    const home = await prepareSelectedCompanySkillTargetHome({
      target: input.target,
      targetNodeExecutable,
      targetCwd,
      frontendIdentity:
        `acpx:${acpxLaunch.registryName}`,
      identity: input.companySkills.identity,
      entries: input.companySkills.entries,
      timeoutSec: targetOperationTimeoutSec,
    });
    selectedCompanySkillBinding = Object.freeze({
      binderExecutable,
      home,
    });
  }
  const targetAdditionalDirectories = Object.freeze([
    ...baseTargetAdditionalDirectories,
    ...(selectedCompanySkillBinding
      ? [selectedCompanySkillBinding.home.discoveryRoot]
      : []),
  ]);
  if (
    new Set(targetAdditionalDirectories).size !==
    targetAdditionalDirectories.length
  ) {
    await selectedCompanySkillBinding?.home.releasePreparationLock();
    throw new Error(
      "ACP target additionalDirectories contain a duplicate skills-home binding",
    );
  }
  const invocationFiles = input.invocationFiles ?? [];
  let materialized: AdapterExecutionTargetMaterializedTextFiles | null = null;
  try {
    if (invocationFiles.length > 0) {
      materialized = await materializeAdapterExecutionTargetTextFiles({
        target: input.target,
        files: invocationFiles,
        timeoutSec: targetOperationTimeoutSec,
      });
    }
  } catch (preparationError) {
    let skillLockCleanupError: unknown | null = null;
    if (selectedCompanySkillBinding) {
      try {
        await selectedCompanySkillBinding.home.releasePreparationLock();
      } catch (error) {
        skillLockCleanupError = error;
      }
    }
    if (materialized) {
      try {
        await boundedCleanup(
          { label: "invocation-file cleanup", run: materialized.cleanup },
          cleanupTimeoutMs,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [preparationError, cleanupError, skillLockCleanupError].filter(
            (error) => error !== null,
          ),
          "ACP invocation-file preparation and cleanup failed",
        );
      }
    }
    if (skillLockCleanupError !== null) {
      throw new AggregateError(
        [preparationError, skillLockCleanupError],
        "ACP invocation-file preparation and skills-home lock cleanup failed",
      );
    }
    throw preparationError;
  }
  const invocationFilePaths: Record<string, string> = {};
  for (const file of invocationFiles) {
    const filePath = materialized?.filePaths[file.fileName];
    if (!filePath) {
      if (materialized) {
        await boundedCleanup(
          { label: "invocation-file cleanup", run: materialized.cleanup },
          cleanupTimeoutMs,
        );
      }
      throw new Error(
        `Prepared invocation file path is missing: ${file.fileName}`,
      );
    }
    invocationFilePaths[file.fileName] = filePath;
  }
  const materializedCleanup: CleanupStep | null = materialized
    ? { label: "invocation-file cleanup", run: materialized.cleanup }
    : null;
  let started = false;
  let disposed = false;
  const disposeMaterialized = createOnceCleanup(
    [
      selectedCompanySkillBinding
        ? {
            label: "selected company skill preparation-lock cleanup",
            run: selectedCompanySkillBinding.home.releasePreparationLock,
          }
        : null,
      materializedCleanup,
    ].filter((step): step is CleanupStep => step !== null),
    cleanupTimeoutMs,
  );

  const startSubprocess: AcpSubprocessStarter = async (
    launch,
    options,
  ) => {
    if (started || disposed) {
      throw new Error(
        "An ACP execution-target preparation can start exactly one subprocess",
      );
    }
    started = true;
    let targetCleanup: CleanupStep | null = null;
    let subprocessCleanup: (() => Promise<void>) | null = null;
    try {
      validateLaunchAgainstTarget(
        launch,
        acpxLaunch,
        targetCwd,
        targetAdditionalDirectories,
      );
      const prepared = await prepareHostLaunch({
        launch,
        target: input.target,
        hostCwd,
        targetCwd,
        runId,
        runtimeRootDir: input.runtimeRootDir,
        timeoutSec: input.timeoutSec,
        localProcessSandbox: input.localProcessSandbox,
        materialized,
        adapterKey: acpxRuntimeKey(acpxLaunch.registryName),
        targetCommand: targetNativeExecutable,
        targetArgs: acpxLaunch.args,
        targetNativeExecutable,
        targetNativeIdentityEnvironment,
        selectedCompanySkillBinding,
        onTargetLog: input.onTargetLog,
      });
      targetCleanup = prepared.cleanup;
      const postReapSkillVerification: CleanupStep | null =
        selectedCompanySkillBinding
          ? {
              label: "selected company skill post-reap verification",
              run: selectedCompanySkillBinding.home.verifyAfterReap,
            }
          : null;
      const cleanup = createOnceCleanup(
        [
          targetCleanup,
          selectedCompanySkillBinding
            ? {
                label: "selected company skill preparation-lock cleanup",
                run: selectedCompanySkillBinding.home.releasePreparationLock,
              }
            : null,
          postReapSkillVerification,
          materializedCleanup,
        ].filter(
          (step): step is CleanupStep => step !== null,
        ),
        cleanupTimeoutMs,
      );
      subprocessCleanup = cleanup;
      let rawSubprocess: AcpSubprocess | null = null;
      const startOptions = selectedCompanySkillBinding
        ? {
            ...options,
            onFirstStdoutChunk: () => {
              let callbackFailed = false;
              try {
                options.onFirstStdoutChunk?.();
              } catch {
                callbackFailed = true;
              }
              if (callbackFailed) rawSubprocess?.cancel();
              void selectedCompanySkillBinding.home
                .releasePreparationLock()
                .catch(() => rawSubprocess?.cancel());
            },
          }
        : options;
      rawSubprocess = spawnPreparedAcpSubprocess(
        launch,
        prepared.hostLaunch,
        startOptions,
      );
      const subprocess = withTargetCleanup(
        rawSubprocess,
        cleanup,
      );
      return subprocess;
    } catch (preparationError) {
      const cleanup =
        subprocessCleanup ??
        createOnceCleanup(
          [
            targetCleanup,
            selectedCompanySkillBinding
              ? {
                  label: "selected company skill preparation-lock cleanup",
                  run: selectedCompanySkillBinding.home.releasePreparationLock,
                }
              : null,
            materializedCleanup,
          ].filter(
            (step): step is CleanupStep => step !== null,
          ),
          cleanupTimeoutMs,
        );
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [preparationError, cleanupError],
          "ACP execution-target preparation and cleanup failed",
        );
      }
      throw preparationError;
    }
  };

  return Object.freeze({
    launch: acpxLaunch,
    targetCwd,
    targetAdditionalDirectories,
    invocationFilePaths: Object.freeze(invocationFilePaths),
    targetNodeExecutable,
    targetNativeExecutable,
    selectedCompanySkillMaterialization: selectedCompanySkillBinding
      ? Object.freeze({
          materializationKey:
            selectedCompanySkillBinding.home.materializationKey,
          collectExact:
            selectedCompanySkillBinding.home.collectExact.bind(
              selectedCompanySkillBinding.home,
            ),
        })
      : null,
    startSubprocess,
    async disposeBeforeStart() {
      if (started) {
        throw new Error(
          "Started ACP execution-target resources are released by subprocess teardown",
        );
      }
      disposed = true;
      await disposeMaterialized();
    },
  });
}
