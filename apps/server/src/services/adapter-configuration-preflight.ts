import type { Db } from "@paperclipai/db";
import {
  adapterRuntimeReadinessSchema,
  agentAdapterAcpConfigurationSchema,
  type AdapterRuntimeReadiness,
  type AdapterRuntimeReadinessIncompleteReason,
  type AdapterRuntimeReadinessScope,
  type AgentAdapterAcpConfiguration,
  type IssueExecutionRunStatus,
} from "@paperclipai/shared";
import {
  AcpxRuntimeReadinessCapabilityError,
  AcpxRuntimeReadinessCleanupError,
  probeAcpxRuntimeReadiness,
  type AcpxRuntimeReadinessProbeInput,
  type AcpxRuntimeReadinessProbeResult,
} from "@paperclipai/adapter-utils/acp-subprocess";
import type { SelectedCompanySkillLaunchChannel } from "@paperclipai/adapter-utils/selected-company-skills";
import { ZodError } from "zod";
import { notFound } from "../errors.js";
import {
  createIssueExecutionTargetAcquirer,
  type AcquiredIssueExecutionTarget,
  type IssueExecutionTargetAcquirer,
} from "./issue-execution-provider-configuration.js";
import {
  EnvironmentRunError,
  type EnvironmentRunOrchestrator,
} from "./environment-run-orchestrator.js";
import {
  CompanySkillMaterializationLifecycleRejected,
  resolveCompanySkillMaterializationRevisionInTransaction,
} from "./company-skill-materialization-lifecycle.js";
import {
  readIssueExecutionRuntimeReadinessBinding,
  type IssueExecutionRuntimeReadinessBinding,
} from "./issue-execution-run-service.js";

const PREFLIGHTABLE_RUN_STATUSES = new Set<IssueExecutionRunStatus>([
  "queued",
  "scheduled_retry",
  "running",
]);

export interface AdapterRuntimeReadinessIdentity {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
}

export interface AdapterRuntimeReadinessRepository {
  loadExactBinding(
    identity: AdapterRuntimeReadinessIdentity,
  ): Promise<IssueExecutionRuntimeReadinessBinding | null>;
  /**
   * Resolves the immutable skill pin as a revision-integrity check. ACPX owns
   * its local runtime environment, so readiness does not prepare a
   * Paperclip-managed skills home for this disposable probe.
   */
  resolveCompanySkills(
    binding: IssueExecutionRuntimeReadinessBinding,
  ): Promise<SelectedCompanySkillLaunchChannel>;
}

export interface AdapterConfigurationPreflightRuntime {
  readonly targetAcquirer: IssueExecutionTargetAcquirer;
  /**
   * Test seam. Production uses ACPX's public runtime through adapter-utils;
   * Paperclip does not own a launch catalog or a raw ACP client here.
   */
  readonly probeAcpxRuntimeReadiness?: (
    input: AcpxRuntimeReadinessProbeInput,
  ) => Promise<AcpxRuntimeReadinessProbeResult>;
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
      return readIssueExecutionRuntimeReadinessBinding(db, identity);
    },
    async resolveCompanySkills(binding) {
      return db.transaction(async (transaction) => {
        const resolved =
          await resolveCompanySkillMaterializationRevisionInTransaction(
            transaction,
            {
              companyId: binding.companyId,
              agentId: binding.agentId,
              adapterConfigRevisionId: binding.adapterConfigRevisionId,
            },
          );
        return resolved.launchChannel;
      });
    },
  };
}

function readinessScope(
  binding: IssueExecutionRuntimeReadinessBinding,
): AdapterRuntimeReadinessScope {
  return {
    runId: binding.runId,
    agentId: binding.agentId,
    adapterConfigRevisionId: binding.adapterConfigRevisionId,
    environmentId: binding.environmentId,
  };
}

function incomplete(
  scope: AdapterRuntimeReadinessScope,
  reason: AdapterRuntimeReadinessIncompleteReason,
  remediationCommand: string | null = null,
): AdapterRuntimeReadiness {
  return adapterRuntimeReadinessSchema.parse({
    status: "incomplete",
    scope,
    reason,
    remediationCommand,
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
  if (!(error instanceof EnvironmentRunError)) {
    return "execution_target_unavailable";
  }
  if (
    error.code === "environment_not_found" ||
    error.code === "environment_inactive" ||
    error.code === "unsupported_environment" ||
    error.code === "unsupported_adapter_environment" ||
    error.code === "probe_failed" ||
    error.code === "lease_acquire_failed"
  ) {
    return "environment_unavailable";
  }
  if (error.code === "workspace_realization_failed") {
    return "workspace_unavailable";
  }
  return "execution_target_unavailable";
}

async function releaseReadinessTarget(
  acquired: AcquiredIssueExecutionTarget,
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
        throw notFound("Issue execution run not found");
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

      try {
        // Retain immutable selected-skill revision validation. No skills home
        // is materialized: ACPX owns the local runtime process and its config.
        await options.repository.resolveCompanySkills(binding);
      } catch (error) {
        if (
          !(error instanceof ZodError) &&
          !(error instanceof CompanySkillMaterializationLifecycleRejected)
        ) {
          throw error;
        }
        return incomplete(scope, "adapter_revision_invalid");
      }

      let acquired: AcquiredIssueExecutionTarget;
      try {
        acquired = await options.runtime.targetAcquirer.acquire({
          companyId: binding.companyId,
          issueId: binding.issueId,
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

      // ACPX's public runtime executes the locally installed CLI itself. It
      // cannot acquire an SSH, sandbox, or plugin target on Paperclip's behalf.
      if (acquired.executionTarget.kind !== "local") {
        const cleanupFailed = await releaseReadinessTarget(acquired, true);
        return cleanupFailed
          ? incomplete(scope, "target_cleanup_failed")
          : incomplete(scope, "execution_target_unavailable");
      }

      let result: AdapterRuntimeReadiness;
      try {
        const probe = await (options.runtime.probeAcpxRuntimeReadiness ??
          probeAcpxRuntimeReadiness)({
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
    readonly environmentOrchestrator: Pick<
      EnvironmentRunOrchestrator,
      "acquireExecutionTargetForRun"
    >;
  },
): AdapterConfigurationPreflightService {
  return createAdapterConfigurationPreflightService({
    repository: createPostgresAdapterRuntimeReadinessRepository(db),
    runtime: {
      targetAcquirer: createIssueExecutionTargetAcquirer({
        environmentOrchestrator: options.environmentOrchestrator,
      }),
    },
  });
}
