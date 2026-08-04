/**
 * Centralized environment run orchestrator.
 *
 * Owns the full environment lifecycle for an issue-execution run:
 *   1. Resolve selected environment
 *   2. Validate environment is active and allowed
 *   3. Acquire or resume lease
 *   4. Realize workspace in the environment
 *   5. Resolve execution target for the adapter
 *   6. Release / retain / fail lease according to policy
 *   7. Record activity and operator-visible status
 *
 * Issue-execution callers delegate to this service instead of inlining
 * environment resolution, lease management, workspace realization,
 * and transport logic.
 */

import { randomUUID } from "node:crypto";
import {
  issueExecutionWorkspaceBindings,
  type Db,
} from "@paperclipai/db";
import type {
  Environment,
  EnvironmentDriver,
  EnvironmentLease,
  EnvironmentLeaseStatus,
  ExecutionWorkspace,
} from "@paperclipai/shared";
import { environmentService } from "./environments.js";
import {
  environmentRuntimeService,
  buildEnvironmentLeaseContext,
  type EnvironmentRuntimeLeaseRecord,
  type EnvironmentRuntimeService,
} from "./environment-runtime.js";
import {
  resolveEnvironmentExecutionTarget,
} from "./environment-execution-target.js";
import {
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { buildWorkspaceRealizationRequest } from "./workspace-realization.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { logActivity } from "./activity-log.js";
import type { RealizedExecutionWorkspace } from "./workspace-runtime.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  deriveAgentExecutionTargetDigest,
} from "./agent-adapter-config-revisions.js";
import { and, eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type EnvironmentErrorCode =
  | "environment_not_found"
  | "environment_inactive"
  | "unsupported_environment"
  | "unsupported_adapter_environment"
  | "probe_failed"
  | "lease_acquire_failed"
  | "workspace_realization_failed"
  | "transport_resolution_failed"
  | "lease_release_failed"
  | "lease_cleanup_failed";

export class EnvironmentRunError extends Error {
  code: EnvironmentErrorCode;
  environmentId?: string;
  driver?: string;
  provider?: string;
  cause?: unknown;

  constructor(
    code: EnvironmentErrorCode,
    message: string,
    details?: {
      environmentId?: string;
      driver?: string;
      provider?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "EnvironmentRunError";
    this.code = code;
    this.environmentId = details?.environmentId;
    this.driver = details?.driver;
    this.provider = details?.provider;
    this.cause = details?.cause;
  }
}

// ---------------------------------------------------------------------------
// Orchestration result types
// ---------------------------------------------------------------------------

export interface EnvironmentAcquisitionResult {
  environment: Environment;
  lease: EnvironmentLease;
  leaseContext: ReturnType<typeof buildEnvironmentLeaseContext>;
}

export interface EnvironmentExecutionTargetAcquisitionResult
  extends EnvironmentAcquisitionResult {
  executionTarget: AdapterExecutionTarget;
  releaseExecutionTarget(failed?: boolean): Promise<void>;
}

export interface EnvironmentReleaseResult {
  released: EnvironmentRuntimeLeaseRecord[];
  errors: Array<{ leaseId: string; error: unknown }>;
}

function firstNonEmptyLine(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line) return line;
  }
  return null;
}

function formatProvisionFailureDetail(result: {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): string {
  if (result.timedOut) {
    return "provision command timed out";
  }
  const signal = typeof result.signal === "string" && result.signal.trim().length > 0
    ? ` (signal ${result.signal.trim()})`
    : "";
  const detail = firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout);
  const status = `exit code ${result.exitCode ?? "null"}${signal}`;
  return detail ? `${status}: ${detail}` : status;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function environmentRunOrchestrator(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    environmentRuntime?: EnvironmentRuntimeService;
  } = {},
) {
  const environmentsSvc = environmentService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const environmentRuntime = options.environmentRuntime ?? environmentRuntimeService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });

  /**
   * Resolve exactly the environment persisted on the immutable adapter
   * revision. Execution never substitutes an instance-local environment or
   * creates environment state while resolving a run.
   */
  async function resolveEnvironment(input: {
    environmentId: string;
    executionTargetDriver: string;
    executionTargetDigest: string;
    adapterType: string;
    allowedDrivers: readonly EnvironmentDriver[];
  }): Promise<Environment> {
    if (
      input.environmentId.length === 0 ||
      input.environmentId !== input.environmentId.trim()
    ) {
      throw new EnvironmentRunError(
        "environment_not_found",
        "Adapter revision requires an exact persisted environment id.",
        { environmentId: input.environmentId },
      );
    }
    const environment = await environmentsSvc.getById(
      input.environmentId,
    );

    if (!environment) {
      throw new EnvironmentRunError("environment_not_found", `Environment "${input.environmentId}" not found.`, {
        environmentId: input.environmentId,
      });
    }

    if (environment.status !== "active") {
      throw new EnvironmentRunError("environment_inactive", `Environment "${environment.name}" is not active (status: ${environment.status}).`, {
        environmentId: environment.id,
        driver: environment.driver,
      });
    }
    // `executionTargetDriver` is validated against the exact ACPX adapter
    // definition when the immutable revision is created, and execution
    // admission pins that definition identity again. Do not reintroduce a
    // shared all-driver fallback here; this layer only verifies that the
    // selected live environment still matches that ACPX-derived revision.
    if (
      environment.driver !== input.executionTargetDriver
      || !input.allowedDrivers.includes(
        environment.driver as EnvironmentDriver,
      )
    ) {
      throw new EnvironmentRunError(
        "unsupported_adapter_environment",
        `Environment "${environment.name}" does not match the adapter revision execution target.`,
        {
          environmentId: environment.id,
          driver: environment.driver,
        },
      );
    }
    const digest = deriveAgentExecutionTargetDigest({
      environmentId: environment.id,
      driver: environment.driver,
      config: environment.config,
    });
    if (digest !== input.executionTargetDigest) {
      throw new EnvironmentRunError(
        "unsupported_environment",
        `Environment "${environment.name}" no longer matches the immutable adapter revision.`,
        {
          environmentId: environment.id,
          driver: environment.driver,
        },
      );
    }

    return environment;
  }

  /**
   * Acquire an environment lease for an issue-execution run.
   * Wraps the runtime driver's acquire call with standardized error handling.
   */
  async function acquireLease(input: {
    companyId: string;
    environment: Environment;
    issueId: string | null;
    agentId: string;
    runId: string;
    persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
    adapterType: string | null;
  }): Promise<EnvironmentRuntimeLeaseRecord> {
    try {
      return await environmentRuntime.acquireRunLease(input);
    } catch (err) {
      throw new EnvironmentRunError(
        "lease_acquire_failed",
        `Failed to acquire lease for environment "${input.environment.name}" (${input.environment.driver}): ${err instanceof Error ? err.message : String(err)}`,
        {
          environmentId: input.environment.id,
          driver: input.environment.driver,
          cause: err,
        },
      );
    }
  }

  async function resolveExecutionWorkspaceBinding(input: {
    companyId: string;
    issueId: string;
    executionWorkspaceBindingId: string;
  }): Promise<{
    persistedExecutionWorkspace: ExecutionWorkspace;
    executionWorkspace: RealizedExecutionWorkspace;
  }> {
    const binding = await db
      .select({
        executionWorkspaceId:
          issueExecutionWorkspaceBindings.executionWorkspaceId,
        absoluteCwd:
          issueExecutionWorkspaceBindings.absoluteCwd,
      })
      .from(issueExecutionWorkspaceBindings)
      .where(
        and(
          eq(
            issueExecutionWorkspaceBindings.id,
            input.executionWorkspaceBindingId,
          ),
          eq(
            issueExecutionWorkspaceBindings.companyId,
            input.companyId,
          ),
          eq(
            issueExecutionWorkspaceBindings.issueId,
            input.issueId,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const workspace = binding
      ? await executionWorkspacesSvc.getById(
          binding.executionWorkspaceId,
        )
      : null;
    if (
      !binding ||
      !workspace ||
      workspace.companyId !== input.companyId ||
      !binding.absoluteCwd.startsWith("/")
    ) {
      throw new EnvironmentRunError(
        "workspace_realization_failed",
        "Provider execution requires its exact persisted issue execution workspace binding.",
      );
    }
    const strategy =
      workspace.strategyType === "git_worktree"
        ? "git_worktree"
        : "project_primary";
    return {
      persistedExecutionWorkspace: workspace,
      executionWorkspace: {
        baseCwd: binding.absoluteCwd,
        source:
          workspace.mode === "shared_workspace"
            ? "project_primary"
            : "issue_execution",
        projectId: workspace.projectId,
        workspaceId: workspace.projectWorkspaceId,
        repoUrl: workspace.repoUrl,
        repoRef: workspace.baseRef,
        strategy,
        cwd: binding.absoluteCwd,
        branchName: workspace.branchName,
        worktreePath:
          strategy === "git_worktree"
            ? workspace.providerRef ?? binding.absoluteCwd
            : null,
        warnings: [],
        created: false,
      },
    };
  }

  /**
   * Acquire the exact persisted environment lease and resolve the adapter
   * execution target used by productive and consult provider work.
   */
  async function acquireExecutionTargetForRun(input: {
    companyId: string;
    environmentId: string;
    executionTargetDriver: string;
    executionTargetDigest: string;
    adapterType: string;
    /** Exact drivers carried forward from the ACPX-admitted revision. */
    allowedDrivers: readonly EnvironmentDriver[];
    issueId: string;
    runId: string;
    agentId: string;
    executionWorkspaceBindingId: string;
  }): Promise<EnvironmentExecutionTargetAcquisitionResult> {
    const environment = await resolveEnvironment({
      environmentId: input.environmentId,
      executionTargetDriver: input.executionTargetDriver,
      executionTargetDigest: input.executionTargetDigest,
      adapterType: input.adapterType,
      allowedDrivers: input.allowedDrivers,
    });
    const workspace = await resolveExecutionWorkspaceBinding({
      companyId: input.companyId,
      issueId: input.issueId,
      executionWorkspaceBindingId:
        input.executionWorkspaceBindingId,
    });
    const acquired = await acquireLease({
      companyId: input.companyId,
      environment,
      issueId: input.issueId,
      agentId: input.agentId,
      runId: input.runId,
      persistedExecutionWorkspace:
        workspace.persistedExecutionWorkspace,
      adapterType: input.adapterType,
    });
    let released = false;
    try {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "agent",
        actorId: input.agentId,
        agentId: input.agentId,
        runId: input.runId,
        action: "environment.lease_acquired",
        entityType: "environment_lease",
        entityId: acquired.lease.id,
        issueId: input.issueId,
        details: {
          environmentId: environment.id,
          driver: environment.driver,
          leasePolicy: acquired.lease.leasePolicy,
          provider: acquired.lease.provider,
          executionWorkspaceId:
            acquired.leaseContext.executionWorkspaceId,
          issueId: input.issueId,
        },
      });
      const realized = await realizeForRun({
        environment,
        lease: acquired.lease,
        adapterType: input.adapterType,
        allowedDrivers: input.allowedDrivers,
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        executionWorkspace: workspace.executionWorkspace,
        effectiveExecutionWorkspaceMode:
          workspace.persistedExecutionWorkspace.mode,
        persistedExecutionWorkspace:
          workspace.persistedExecutionWorkspace,
      });
      const executionTarget = realized.executionTarget;
      if (
        !executionTarget ||
        executionTarget.environmentId !== input.environmentId ||
        executionTarget.leaseId !== acquired.lease.id
      ) {
        throw new EnvironmentRunError(
          "transport_resolution_failed",
          "Configured environment did not resolve its exact persisted execution target.",
          {
            environmentId: acquired.environment.id,
            driver: acquired.environment.driver,
          },
        );
      }
      return {
        environment,
        lease: realized.lease,
        leaseContext: acquired.leaseContext,
        executionTarget,
        async releaseExecutionTarget(failed = false) {
          if (released) return;
          released = true;
          const result = await releaseForRun({
            runId: input.runId,
            companyId: input.companyId,
            agentId: input.agentId,
            status: failed ? "failed" : "released",
          });
          if (result.errors.length > 0) {
            throw new EnvironmentRunError(
              "lease_release_failed",
              `Failed to release execution target lease for environment "${environment.name}".`,
              {
                environmentId: environment.id,
                driver: environment.driver,
                cause: result.errors[0]?.error,
              },
            );
          }
        },
      };
    } catch (error) {
      if (!released) {
        released = true;
        await releaseForRun({
          runId: input.runId,
          companyId: input.companyId,
          agentId: input.agentId,
          status: "failed",
          failureReason:
            error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * Realize workspace in the environment and resolve the execution target.
   *
   * After lease acquisition, this method:
   *   1. Builds a workspace realization request
   *   2. Calls the environment runtime driver to realize the workspace
   *   3. Persists realization metadata on the lease and execution workspace
   *   4. Resolves the adapter execution target
   *
   * Returns the updated lease, realization metadata, and the execution
   * target spec that the adapter needs to run.
   */
  async function realizeForRun(input: {
    environment: Environment;
    lease: EnvironmentLease;
    adapterType: string;
    allowedDrivers: readonly EnvironmentDriver[];
    companyId: string;
    issueId: string | null;
    runId: string;
    executionWorkspace: RealizedExecutionWorkspace;
    effectiveExecutionWorkspaceMode: string | null;
    persistedExecutionWorkspace: ExecutionWorkspace | null;
  }): Promise<{
    lease: EnvironmentLease;
    workspaceRealization: Record<string, unknown>;
    executionTarget: AdapterExecutionTarget | null;
    persistedExecutionWorkspace: ExecutionWorkspace | null;
  }> {
    const {
      environment,
      adapterType,
      companyId,
      issueId,
      runId,
      executionWorkspace,
      effectiveExecutionWorkspaceMode,
    } = input;
    let { lease, persistedExecutionWorkspace } = input;

    // Step 1: Build workspace realization request
    const workspaceRealizationRequest = buildWorkspaceRealizationRequest({
      adapterType,
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: persistedExecutionWorkspace?.id ?? null,
      issueId,
      runId,
      requestedMode: persistedExecutionWorkspace?.mode ?? effectiveExecutionWorkspaceMode,
      workspace: executionWorkspace,
      workspaceConfig: persistedExecutionWorkspace?.config ?? null,
    });

    // Step 2: Realize workspace in the environment via the runtime driver
    let workspaceRealization: Record<string, unknown> = {};
    let realizedWorkspaceCwd: string | null = null;
    if (
      environment.driver === "local" ||
      environment.driver === "ssh" ||
      environment.driver === "sandbox" ||
      environment.driver === "plugin"
    ) {
      try {
        const remoteCwd =
          typeof lease.metadata?.remoteCwd === "string" && lease.metadata.remoteCwd.trim().length > 0
            ? lease.metadata.remoteCwd
            : undefined;
        const workspaceRealizationResult = await environmentRuntime.realizeWorkspace({
          environment,
          lease,
          workspace: {
            localPath: executionWorkspace.cwd,
            remotePath: remoteCwd,
            mode: persistedExecutionWorkspace?.mode ?? effectiveExecutionWorkspaceMode ?? undefined,
            metadata: {
              workspaceRealizationRequest,
            },
          },
        });
        realizedWorkspaceCwd =
          typeof workspaceRealizationResult.cwd === "string" && workspaceRealizationResult.cwd.trim().length > 0
            ? workspaceRealizationResult.cwd.trim()
            : null;
        workspaceRealization = parseObject(workspaceRealizationResult.metadata?.workspaceRealization);
      } catch (err) {
        throw new EnvironmentRunError(
          "workspace_realization_failed",
          `Failed to realize workspace for environment "${environment.name}" (${environment.driver}): ${err instanceof Error ? err.message : String(err)}`,
          {
            environmentId: environment.id,
            driver: environment.driver,
            cause: err,
          },
        );
      }
    }

    const provisionCommand = workspaceRealizationRequest.runtimeOverlay.provisionCommand?.trim() ?? "";
    if (
      environment.driver === "plugin" &&
      !realizedWorkspaceCwd
    ) {
      throw new EnvironmentRunError(
        "workspace_realization_failed",
        `Plugin environment "${environment.name}" did not return its exact realized workspace cwd.`,
        {
          environmentId: environment.id,
          driver: environment.driver,
        },
      );
    }
    const realizedCwd =
      realizedWorkspaceCwd ??
      (typeof lease.metadata?.remoteCwd === "string" && lease.metadata.remoteCwd.trim().length > 0
        ? lease.metadata.remoteCwd.trim()
        : executionWorkspace.cwd);
    if (provisionCommand && environment.driver !== "local") {
      try {
        const provisionResult = await environmentRuntime.execute({
          environment,
          lease,
          executionId: randomUUID(),
          command: "bash",
          args: ["-lc", provisionCommand],
          cwd: realizedCwd,
          env: {
            SHELL: "/bin/bash",
          },
          timeoutMs: 300_000,
        });
        if (provisionResult.exitCode !== 0 || provisionResult.timedOut) {
          throw new Error(formatProvisionFailureDetail(provisionResult));
        }
      } catch (err) {
        throw new EnvironmentRunError(
          "workspace_realization_failed",
          `Failed to provision workspace for environment "${environment.name}" (${environment.driver}): ${err instanceof Error ? err.message : String(err)}`,
          {
            environmentId: environment.id,
            driver: environment.driver,
            cause: err,
          },
        );
      }
    }

    // Step 3: Persist realization metadata on lease and execution workspace
    if (Object.keys(workspaceRealization).length > 0) {
      const nextLeaseMetadata = {
        ...(lease.metadata ?? {}),
        workspaceRealization,
      };
      const updatedLease = await environmentsSvc.updateLeaseMetadata(lease.id, nextLeaseMetadata);
      if (updatedLease) {
        lease = updatedLease;
      }
      if (persistedExecutionWorkspace) {
        const updatedEw = await executionWorkspacesSvc.update(persistedExecutionWorkspace.id, {
          metadata: {
            ...(persistedExecutionWorkspace.metadata ?? {}),
            workspaceRealizationRequest,
            workspaceRealization,
          },
        });
        if (updatedEw) {
          persistedExecutionWorkspace = updatedEw;
        }
      }
    }

    // Step 4: Resolve execution target for the adapter
    let executionTarget: AdapterExecutionTarget | null;
    try {
      executionTarget = await resolveEnvironmentExecutionTarget({
        db,
        companyId,
        adapterType,
        allowedDrivers: input.allowedDrivers,
        environment,
        leaseId: lease.id,
        leaseMetadata: (lease.metadata as Record<string, unknown> | null) ?? null,
        realizedCwd,
        lease,
        environmentRuntime,
      });
    } catch (err) {
      throw new EnvironmentRunError(
        "transport_resolution_failed",
        `Failed to resolve execution target for "${environment.name}": ${err instanceof Error ? err.message : String(err)}`,
        {
          environmentId: environment.id,
          driver: environment.driver,
          cause: err,
        },
      );
    }

    return {
      lease,
      workspaceRealization,
      executionTarget,
      persistedExecutionWorkspace,
    };
  }

  /**
   * Release all active leases for an issue-execution run.
   * Tracks cleanup status per lease. Errors during individual lease release
   * are captured but do not prevent other leases from being released.
   * The original run failure (if any) is never hidden by cleanup errors.
   */
  async function releaseForRun(input: {
    runId: string;
    companyId: string;
    agentId: string;
    status?: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
    failureReason?: string;
  }): Promise<EnvironmentReleaseResult> {
    const status = input.status ?? "released";
    const result: EnvironmentReleaseResult = { released: [], errors: [] };

    let releasedLeases: EnvironmentRuntimeLeaseRecord[];
    try {
      releasedLeases = await environmentRuntime.releaseRunLeases(input.runId, status);
    } catch (err) {
      result.errors.push({ leaseId: "*", error: err });
      return result;
    }

    for (const released of releasedLeases) {
      try {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId: input.runId,
          action: "environment.lease_released",
          entityType: "environment_lease",
          entityId: released.lease.id,
          issueId: released.lease.issueId,
          details: {
            environmentId: released.lease.environmentId,
            driver: released.environment.driver,
            leasePolicy: released.lease.leasePolicy,
            provider: released.lease.provider,
            executionWorkspaceId: released.lease.executionWorkspaceId,
            issueId: released.lease.issueId,
            status: released.lease.status,
            cleanupStatus: released.lease.cleanupStatus,
            failureReason: input.failureReason ?? released.lease.failureReason,
          },
        });
      } catch {
        // Activity logging failure should not block lease release
      }
      result.released.push(released);
    }

    return result;
  }

  return {
    acquireExecutionTargetForRun,
  };
}

export type EnvironmentRunOrchestrator = ReturnType<typeof environmentRunOrchestrator>;
