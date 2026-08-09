import path from "node:path";
import type {
  AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import type { AgentAdapterAcpConfiguration } from "@paperclipai/shared";
import { agentAdapterAcpConfigurationSchema } from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";
import type { LocalExecutionOrchestrator } from "./local-execution-orchestrator.js";

/**
 * Immutable non-provider facts needed to acquire the physical target for one
 * productive or consult ACP prompt. The caller resolves and fences these
 * values from the canonical run/ref/segment snapshot before entering this
 * service; this service performs no scheduler or adapter-configuration read.
 */
export interface IssueExecutionTargetAcquisitionInput {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly acpConfiguration: AgentAdapterAcpConfiguration;
  /** Exact host cwd recorded for the local provider process. */
  readonly hostCwd: string;
  /** Exact local workspace cwd when the selected target is local. */
  readonly localWorkspaceCwd: string;
  /** Already-authorized target-visible additional directories. */
  readonly targetAdditionalDirectories: readonly string[];
}

export interface IssueExecutionRuntimeRedactor {
  redactText(value: string): string;
}

export interface AcquiredIssueExecutionTarget {
  readonly adapterConfigRevisionId: string;
  readonly acpConfiguration: AgentAdapterAcpConfiguration;
  readonly executionTarget: AdapterExecutionTarget;
  readonly hostCwd: string;
  readonly targetCwd: string;
  readonly targetAdditionalDirectories: readonly string[];
  readonly redactor: IssueExecutionRuntimeRedactor;
  release(failed?: boolean): Promise<void>;
}

export interface IssueExecutionTargetAcquirer {
  acquire(
    input: IssueExecutionTargetAcquisitionInput,
  ): Promise<AcquiredIssueExecutionTarget>;
}

export class IssueExecutionTargetAcquisitionRejected extends Error {
  readonly code = "issue_execution_target_acquisition_rejected";

  constructor(message: string) {
    super(message);
    this.name = "IssueExecutionTargetAcquisitionRejected";
  }
}

function exactNonempty(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new IssueExecutionTargetAcquisitionRejected(
      `${label} must be exact and non-empty`,
    );
  }
  return value;
}

function exactHostPath(value: string, label: string): string {
  exactNonempty(value, label);
  if (!path.isAbsolute(value)) {
    throw new IssueExecutionTargetAcquisitionRejected(
      `${label} must be an absolute host path`,
    );
  }
  return value;
}

export function createIssueExecutionRuntimeRedactor(): IssueExecutionRuntimeRedactor {
  return Object.freeze({
    redactText: redactSensitiveText,
  });
}

/**
 * Acquires the invariant local workspace execution target without
 * resolving provider credentials, invocation payloads, or adapter callbacks.
 */
export function createIssueExecutionTargetAcquirer(options: {
  readonly localExecutionOrchestrator: Pick<
    LocalExecutionOrchestrator,
    "acquireExecutionTargetForRun"
  >;
}): IssueExecutionTargetAcquirer {
  return {
    async acquire(input) {
      const acpConfiguration =
        agentAdapterAcpConfigurationSchema.parse(input.acpConfiguration);
      const hostCwd = exactHostPath(input.hostCwd, "ACP host cwd");
      const localWorkspaceCwd = exactHostPath(
        input.localWorkspaceCwd,
        "ACP local workspace cwd",
      );
      exactNonempty(
        input.adapterConfigRevisionId,
        "adapter configuration revision id",
      );
      exactNonempty(
        input.executionWorkspaceBindingId,
        "execution workspace binding id",
      );

      const acquired =
        await options.localExecutionOrchestrator.acquireExecutionTargetForRun({
          companyId: input.companyId,
          issueId: input.issueId,
          agentId: input.targetAgentId,
          runId: input.runId,
          executionWorkspaceBindingId: input.executionWorkspaceBindingId,
        });
      const target = acquired.executionTarget;
      if (
        target.kind !== "local" ||
        target.leaseId !== acquired.lease.id
      ) {
        await acquired.releaseExecutionTarget(true).catch(() => undefined);
        throw new IssueExecutionTargetAcquisitionRejected(
          "Local execution acquisition returned a different run lease",
        );
      }

      return Object.freeze({
        adapterConfigRevisionId: input.adapterConfigRevisionId,
        acpConfiguration,
        executionTarget: target,
        hostCwd,
        targetCwd: localWorkspaceCwd,
        targetAdditionalDirectories: Object.freeze([
          ...input.targetAdditionalDirectories,
        ]),
        redactor: createIssueExecutionRuntimeRedactor(),
        release: (failed = false) =>
          acquired.releaseExecutionTarget(failed),
      });
    },
  };
}
