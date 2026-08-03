import { randomUUID } from "node:crypto";
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
  ACP_SUBPROCESS_CONTRACT_VERSION,
  isAcpInitializationCapabilityError,
  PaperclipAcpClient,
  prepareAcpExecutionTargetSubprocess,
  resolveApprovedAcpNativeAuthentication,
  resolveApprovedAcpLaunch,
  sameApprovedAcpLaunch,
  type AcpSubprocess,
  type AcpSubprocessLaunch,
  type ApprovedAcpLaunch,
  type ApprovedAcpNativeAuthentication,
  type PreparedAcpExecutionTargetSubprocess,
} from "@paperclipai/adapter-utils/acp-subprocess";
import {
  resolveAdapterExecutionTargetNativeIdentityEnvironment,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
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
  collectCompanySkillMaterializationIfUnreferencedInTransaction,
  CompanySkillMaterializationLifecycleRejected,
  resolveCompanySkillMaterializationRevisionInTransaction,
  type ReapedCompanySkillMaterialization,
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
const READINESS_PROCESS_TIMEOUT_SEC = 15;
const READINESS_PROCESS_GRACE_SEC = 2;
const READINESS_PROCESS_REAP_GRACE_MS = 5_000;

export interface AdapterRuntimeReadinessIdentity {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
}

export interface AdapterRuntimeReadinessRepository {
  loadExactBinding(
    identity: AdapterRuntimeReadinessIdentity,
  ): Promise<IssueExecutionRuntimeReadinessBinding | null>;
  resolveCompanySkills(
    binding: IssueExecutionRuntimeReadinessBinding,
  ): Promise<SelectedCompanySkillLaunchChannel>;
  collectMaterialization(
    candidate: ReapedCompanySkillMaterialization,
  ): Promise<void>;
}

interface InitializeOnlyAcpClient {
  initialize(): Promise<{
    readonly protocolVersion: number;
    readonly agentCapabilities?: {
      readonly sessionCapabilities?: {
        readonly resume?: unknown;
      };
    };
  }>;
  close(error?: unknown): void;
}

export interface AdapterConfigurationPreflightRuntime {
  readonly targetAcquirer: IssueExecutionTargetAcquirer;
  readonly prepareTarget: typeof prepareAcpExecutionTargetSubprocess;
  readonly runTargetProcess: typeof runAdapterExecutionTargetProcess;
  readonly createInitializeOnlyClient: (input: {
    readonly launch: AcpSubprocessLaunch;
    readonly subprocess: AcpSubprocess;
  }) => InitializeOnlyAcpClient;
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
    async collectMaterialization(candidate) {
      await db.transaction(async (transaction) => {
        await collectCompanySkillMaterializationIfUnreferencedInTransaction(
          transaction,
          candidate,
        );
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
    executionWorkspaceBindingId:
      binding.executionWorkspaceBindingId,
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
): AdapterRuntimeReadiness {
  return adapterRuntimeReadinessSchema.parse({
    status: "ready",
    scope,
    protocolVersion: 1,
    sessionResume: true,
  });
}

function preparationFailureReason(
  error: unknown,
): AdapterRuntimeReadinessIncompleteReason {
  const message = error instanceof Error ? error.message : "";
  if (
    message.includes("required executable") ||
    message.includes("executable selector") ||
    message.includes("executable canonicalization")
  ) {
    return "target_native_executable_unavailable";
  }
  if (
    message.includes("frontend") ||
    message.includes("artifact")
  ) {
    return "acp_frontend_unavailable";
  }
  return "execution_target_unavailable";
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

function exactApprovedLaunch(
  configuration: AgentAdapterAcpConfiguration,
): ApprovedAcpLaunch {
  const approved = resolveApprovedAcpLaunch(
    configuration.launchProfile.registryName,
  );
  if (!sameApprovedAcpLaunch(configuration.launchProfile, approved)) {
    throw new Error(
      "Persisted adapter revision does not match its approved launch",
    );
  }
  return approved;
}

async function closeReadinessResources(input: {
  readonly acquired: AcquiredIssueExecutionTarget;
  readonly prepared: PreparedAcpExecutionTargetSubprocess | null;
  readonly subprocess: AcpSubprocess | null;
  readonly client: InitializeOnlyAcpClient | null;
  readonly subprocessLaunchAttempted: boolean;
  readonly failed: boolean;
  readonly companySkills: SelectedCompanySkillLaunchChannel;
  readonly repository: AdapterRuntimeReadinessRepository;
}): Promise<boolean> {
  let cleanupFailed = false;
  if (input.subprocess) {
    try {
      input.client?.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      await input.subprocess.closeAndReap(
        READINESS_PROCESS_REAP_GRACE_MS,
      );
    } catch {
      cleanupFailed = true;
      await input.subprocess
        .terminateAndReap(READINESS_PROCESS_REAP_GRACE_MS)
        .catch(() => {
          cleanupFailed = true;
        });
    }
  } else if (input.prepared && !input.subprocessLaunchAttempted) {
    await input.prepared.disposeBeforeStart().catch(() => {
      cleanupFailed = true;
    });
  }
  const materialization =
    input.prepared?.selectedCompanySkillMaterialization ?? null;
  if (
    !cleanupFailed &&
    materialization &&
    input.companySkills.channel === "isolated_skills_home"
  ) {
    await input.repository
      .collectMaterialization({
        identity: input.companySkills.identity,
        materializationKey: materialization.materializationKey,
        collectExact: materialization.collectExact,
      })
      .catch(() => {
        cleanupFailed = true;
      });
  } else if (
    materialization &&
    input.companySkills.channel !== "isolated_skills_home"
  ) {
    cleanupFailed = true;
  }
  await input.acquired.release(input.failed || cleanupFailed).catch(() => {
    cleanupFailed = true;
  });
  return cleanupFailed;
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
        (binding.runKind !== "productive" &&
          binding.runKind !== "consult") ||
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
      let approvedLaunch: ApprovedAcpLaunch;
      let nativeAuthentication: ApprovedAcpNativeAuthentication;
      try {
        acpConfiguration = agentAdapterAcpConfigurationSchema.parse(
          binding.acpConfiguration,
        );
        approvedLaunch = exactApprovedLaunch(acpConfiguration);
        nativeAuthentication =
          resolveApprovedAcpNativeAuthentication(approvedLaunch);
      } catch {
        return incomplete(scope, "adapter_revision_invalid");
      }

      let companySkills: SelectedCompanySkillLaunchChannel;
      try {
        companySkills = await options.repository.resolveCompanySkills(binding);
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
          adapterConfigRevisionId:
            binding.adapterConfigRevisionId,
          executionWorkspaceBindingId:
            binding.executionWorkspaceBindingId,
          acpConfiguration,
          hostCwd: binding.absoluteCwd,
          localWorkspaceCwd: binding.absoluteCwd,
          targetAdditionalDirectories: Object.freeze([]),
        });
      } catch (error) {
        return incomplete(scope, acquisitionFailureReason(error));
      }

      let prepared: PreparedAcpExecutionTargetSubprocess | null = null;
      let subprocess: AcpSubprocess | null = null;
      let client: InitializeOnlyAcpClient | null = null;
      let subprocessLaunchAttempted = false;
      let result: AdapterRuntimeReadiness;

      try {
        try {
          prepared = await options.runtime.prepareTarget({
            runId: binding.runId,
            target: acquired.executionTarget,
            sourceLaunch: approvedLaunch,
            hostCwd: acquired.hostCwd,
            targetCwd: acquired.targetCwd,
            targetAdditionalDirectories:
              acquired.targetAdditionalDirectories,
            companySkills,
            runtimeRootDir: null,
            timeoutSec: READINESS_PROCESS_TIMEOUT_SEC,
          });
        } catch (error) {
          result = incomplete(scope, preparationFailureReason(error));
          const cleanupFailed = await closeReadinessResources({
            acquired,
            prepared,
            subprocess,
            client,
            subprocessLaunchAttempted,
            failed: true,
            companySkills,
            repository: options.repository,
          });
          return cleanupFailed
            ? incomplete(scope, "target_cleanup_failed")
            : result;
        }

        let authenticationExitCode: number | null;
        let authenticationTimedOut: boolean;
        try {
          ({
            exitCode: authenticationExitCode,
            timedOut: authenticationTimedOut,
          } = await options.runtime.runTargetProcess(
            randomUUID(),
            acquired.executionTarget,
            prepared.targetNativeExecutable,
            [...nativeAuthentication.statusArgs],
            {
              cwd: prepared.targetCwd,
              env: {
                ...resolveAdapterExecutionTargetNativeIdentityEnvironment(
                  acquired.executionTarget,
                ),
              },
              timeoutSec: READINESS_PROCESS_TIMEOUT_SEC,
              graceSec: READINESS_PROCESS_GRACE_SEC,
              onLog: async () => {},
            },
          ));
        } catch {
          result = incomplete(
            scope,
            "native_authentication_check_failed",
            nativeAuthentication.loginGuidance,
          );
          const cleanupFailed = await closeReadinessResources({
            acquired,
            prepared,
            subprocess,
            client,
            subprocessLaunchAttempted,
            failed: true,
            companySkills,
            repository: options.repository,
          });
          return cleanupFailed
            ? incomplete(scope, "target_cleanup_failed")
            : result;
        }
        if (authenticationTimedOut || authenticationExitCode !== 0) {
          result = incomplete(
            scope,
            "native_authentication_required",
            nativeAuthentication.loginGuidance,
          );
          const cleanupFailed = await closeReadinessResources({
            acquired,
            prepared,
            subprocess,
            client,
            subprocessLaunchAttempted,
            failed: true,
            companySkills,
            repository: options.repository,
          });
          return cleanupFailed
            ? incomplete(scope, "target_cleanup_failed")
            : result;
        }

        const launch: AcpSubprocessLaunch = Object.freeze({
          version: ACP_SUBPROCESS_CONTRACT_VERSION,
          launch: approvedLaunch,
          cwd: prepared.targetCwd,
          additionalDirectories:
            prepared.targetAdditionalDirectories,
          environment: Object.freeze({}),
          mcpServers: Object.freeze([]),
          configOptions: acpConfiguration.sessionConfigSelections,
        });
        try {
          subprocessLaunchAttempted = true;
          subprocess = await prepared.startSubprocess(launch, {
            redactStderr: () => "",
          });
          client = options.runtime.createInitializeOnlyClient({
            launch,
            subprocess,
          });
          const initialized = await client.initialize();
          if (
            initialized.protocolVersion !== 1 ||
            initialized.agentCapabilities?.sessionCapabilities?.resume ==
              null
          ) {
            result = incomplete(scope, "acp_capability_incompatible");
          } else {
            result = ready(scope);
          }
        } catch (error) {
          result = incomplete(
            scope,
            isAcpInitializationCapabilityError(error)
              ? "acp_capability_incompatible"
              : "acp_initialization_failed",
          );
        }
      } catch {
        result = incomplete(scope, "acp_initialization_failed");
      }

      const cleanupFailed = await closeReadinessResources({
        acquired,
        prepared,
        subprocess,
        client,
        subprocessLaunchAttempted,
        failed: result.status !== "ready",
        companySkills,
        repository: options.repository,
      });
      return cleanupFailed
        ? incomplete(scope, "target_cleanup_failed")
        : result;
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
      prepareTarget: prepareAcpExecutionTargetSubprocess,
      runTargetProcess: runAdapterExecutionTargetProcess,
      createInitializeOnlyClient({ launch, subprocess }) {
        return new PaperclipAcpClient({
          launch,
          subprocess,
          operations: Object.freeze({}),
          hooks: {
            onSessionEvent() {
              throw new Error(
                "ACP readiness initialize emitted a session update",
              );
            },
          },
        });
      },
    },
  });
}
