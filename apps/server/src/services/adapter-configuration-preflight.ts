import type { Db } from "@paperclipai/db";
import {
  adapterRuntimeReadinessSchema,
  agentAdapterAcpConfigurationSchema,
  type AdapterRuntimeReadiness,
  type AdapterRuntimeReadinessIncompleteReason,
  type AdapterRuntimeReadinessScope,
  type AgentAdapterAcpConfiguration,
  type TaskExecutionRunStatus,
} from "@paperclipai/shared";
import {
  AcpxRuntimeReadinessCapabilityError,
  AcpxRuntimeReadinessCleanupError,
  probeAcpxRuntimeReadiness,
} from "@paperclipai/adapter-utils/acpx-runtime";
import { notFound } from "../errors.js";
import {
  createTaskExecutionTargetAcquirer,
  type AcquiredTaskExecutionTarget,
  type TaskExecutionTargetAcquirer,
} from "./task-execution-provider-configuration.js";
import {
  LocalExecutionTargetError,
  type LocalExecutionOrchestrator,
} from "./local-execution-orchestrator.js";
import {
  readTaskExecutionRuntimeReadinessBinding,
  type TaskExecutionRuntimeReadinessBinding,
} from "./task-execution-run-service.js";

const PREFLIGHTABLE_RUN_STATUSES = new Set<TaskExecutionRunStatus>([
  "queued",
  "scheduled_retry",
  "running",
]);

export interface AdapterRuntimeReadinessIdentity {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
}

export interface AdapterRuntimeReadinessRepository {
  loadExactBinding(
    identity: AdapterRuntimeReadinessIdentity,
  ): Promise<TaskExecutionRuntimeReadinessBinding | null>;
}

export interface AdapterConfigurationPreflightRuntime {
  readonly targetAcquirer: TaskExecutionTargetAcquirer;
}

export interface AdapterConfigurationPreflightService {
  inspect(
    identity: AdapterRuntimeReadinessIdentity,
  ): Promise<AdapterRuntimeReadiness>;
}

function createPostgresAdapterRuntimeReadinessRepository(
  db: Db,
): AdapterRuntimeReadinessRepository {
  return {
    async loadExactBinding(identity) {
      return readTaskExecutionRuntimeReadinessBinding(db, identity);
    },
  };
}

function readinessScope(
  binding: TaskExecutionRuntimeReadinessBinding,
): AdapterRuntimeReadinessScope {
  return {
    runId: binding.runId,
    agentId: binding.agentId,
    adapterConfigRevisionId: binding.adapterConfigRevisionId,
  };
}

function incomplete(
  scope: AdapterRuntimeReadinessScope,
  reason: AdapterRuntimeReadinessIncompleteReason,
): AdapterRuntimeReadiness {
  return adapterRuntimeReadinessSchema.parse({
    status: "incomplete",
    scope,
    reason,
  });
}

function ready(
  scope: AdapterRuntimeReadinessScope,
  runtimeControls: readonly string[],
): AdapterRuntimeReadiness {
  return adapterRuntimeReadinessSchema.parse({
    status: "ready",
    scope,
    runtimeControls: [...runtimeControls],
  });
}

function acquisitionFailureReason(
  error: unknown,
): AdapterRuntimeReadinessIncompleteReason {
  if (!(error instanceof LocalExecutionTargetError)) {
    return "execution_target_unavailable";
  }
  if (error.code === "workspace_binding_unavailable") {
    return "workspace_unavailable";
  }
  return "execution_target_unavailable";
}

async function releaseReadinessTarget(
  acquired: AcquiredTaskExecutionTarget,
  failed: boolean,
): Promise<boolean> {
  return await acquired
    .release(failed)
    .then(() => false)
    .catch(() => true);
}

export function createAdapterConfigurationPreflightService(options: {
  readonly repository: AdapterRuntimeReadinessRepository;
  readonly runtime: AdapterConfigurationPreflightRuntime;
}): AdapterConfigurationPreflightService {
  return {
    async inspect(identity) {
      const binding = await options.repository.loadExactBinding(identity);
      if (!binding) {
        throw notFound("Task execution run not found");
      }
      const scope = readinessScope(binding);
      if (
        (binding.runKind !== "productive" && binding.runKind !== "consult") ||
        !PREFLIGHTABLE_RUN_STATUSES.has(binding.runStatus)
      ) {
        return incomplete(scope, "run_not_preflightable");
      }
      if (
        binding.currentAdapterConfigRevisionId !==
        binding.adapterConfigRevisionId
      ) {
        return incomplete(scope, "agent_revision_not_current");
      }
      if (!binding.absoluteCwd) {
        return incomplete(scope, "workspace_unavailable");
      }

      let acpConfiguration: AgentAdapterAcpConfiguration;
      try {
        acpConfiguration = agentAdapterAcpConfigurationSchema.parse(
          binding.acpConfiguration,
        );
      } catch {
        return incomplete(scope, "adapter_revision_invalid");
      }

      let acquired: AcquiredTaskExecutionTarget;
      try {
        acquired = await options.runtime.targetAcquirer.acquire({
          companyId: binding.companyId,
          taskId: binding.taskId,
          runId: binding.runId,
          targetAgentId: binding.agentId,
          adapterConfigRevisionId: binding.adapterConfigRevisionId,
          executionWorkspaceBindingId: binding.executionWorkspaceBindingId,
          acpConfiguration,
          hostCwd: binding.absoluteCwd,
          localWorkspaceCwd: binding.absoluteCwd,
          targetAdditionalDirectories: Object.freeze([]),
        });
      } catch (error) {
        return incomplete(scope, acquisitionFailureReason(error));
      }

      let result: AdapterRuntimeReadiness;
      try {
        const probe = await probeAcpxRuntimeReadiness({
          cwd: acquired.targetCwd,
          // All ACPX catalog/revision validation is resolved relative to the
          // Paperclip service configuration scope. The acquired workspace is
          // only the disposable provider-session cwd.
          registryCwd: process.cwd(),
          agentName: acpConfiguration.launchProfile.registryName,
          configSelections: acpConfiguration.sessionConfigSelections,
        });
        result = ready(scope, probe.capabilities.controls);
      } catch (error) {
        result = incomplete(
          scope,
          error instanceof AcpxRuntimeReadinessCleanupError
            ? "target_cleanup_failed"
            : error instanceof AcpxRuntimeReadinessCapabilityError
              ? "acp_capability_incompatible"
              : "acp_initialization_failed",
        );
      }

      const cleanupFailed = await releaseReadinessTarget(
        acquired,
        result.status !== "ready",
      );
      return cleanupFailed ? incomplete(scope, "target_cleanup_failed") : result;
    },
  };
}

export function createPostgresAdapterConfigurationPreflightService(
  db: Db,
  options: {
    readonly localExecutionOrchestrator: Pick<
      LocalExecutionOrchestrator,
      "acquireExecutionTargetForRun"
    >;
  },
): AdapterConfigurationPreflightService {
  return createAdapterConfigurationPreflightService({
    repository: createPostgresAdapterRuntimeReadinessRepository(db),
    runtime: {
      targetAcquirer: createTaskExecutionTargetAcquirer({
        localExecutionOrchestrator: options.localExecutionOrchestrator,
      }),
    },
  });
}
