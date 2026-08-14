import path from "node:path";
import type { AcpxLocalWorkspaceTarget } from "@paperclipai/adapter-utils/acpx-runtime";
import { type AgentAdapterAcpConfiguration, agentAdapterAcpConfigurationSchema } from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";
import type { LocalExecutionOrchestrator } from "./local-execution-orchestrator.js";

/**
 * Immutable non-provider facts needed to acquire the physical target for one
 * productive or consult ACP prompt. The caller resolves and fences these
 * values from the canonical run/ref/segment snapshot before entering this
 * service; this service performs no scheduler or adapter-configuration read.
 */
export interface TaskExecutionTargetAcquisitionInput {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly acpConfiguration: AgentAdapterAcpConfiguration;
  /** Exact host cwd supplied to the bounded ACPX execution. */
  readonly hostCwd: string;
  /** Exact local workspace cwd when the selected target is local. */
  readonly localWorkspaceCwd: string;
  /** Already-authorized target-visible additional directories. */
  readonly targetAdditionalDirectories: readonly string[];
}

export interface TaskExecutionRuntimeRedactor {
  redactText(value: string): string;
}

export interface AcquiredTaskExecutionTarget {
  readonly adapterConfigRevisionId: string;
  readonly acpConfiguration: AgentAdapterAcpConfiguration;
  readonly executionTarget: AcpxLocalWorkspaceTarget;
  readonly hostCwd: string;
  readonly targetCwd: string;
  readonly targetAdditionalDirectories: readonly string[];
  readonly redactor: TaskExecutionRuntimeRedactor;
  release(failed?: boolean): Promise<void>;
}

export interface TaskExecutionTargetAcquirer {
  acquire(input: TaskExecutionTargetAcquisitionInput): Promise<AcquiredTaskExecutionTarget>;
}

export class TaskExecutionTargetAcquisitionRejected extends Error {
  readonly code = "task_execution_target_acquisition_rejected";

  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionTargetAcquisitionRejected";
  }
}

function exactNonempty(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new TaskExecutionTargetAcquisitionRejected(`${label} must be exact and non-empty`);
  }
  return value;
}

function exactHostPath(value: string, label: string): string {
  exactNonempty(value, label);
  if (!path.isAbsolute(value)) {
    throw new TaskExecutionTargetAcquisitionRejected(`${label} must be an absolute host path`);
  }
  return value;
}

export function createTaskExecutionRuntimeRedactor(): TaskExecutionRuntimeRedactor {
  return Object.freeze({
    redactText: redactSensitiveText,
  });
}

/**
 * Acquires the invariant local workspace execution target without
 * resolving provider credentials, invocation payloads, or adapter callbacks.
 */
export function createTaskExecutionTargetAcquirer(options: {
  readonly localExecutionOrchestrator: Pick<LocalExecutionOrchestrator, "acquireExecutionTargetForRun">;
}): TaskExecutionTargetAcquirer {
  return {
    async acquire(input) {
      const acpConfiguration = agentAdapterAcpConfigurationSchema.parse(input.acpConfiguration);
      const hostCwd = exactHostPath(input.hostCwd, "ACP host cwd");
      const localWorkspaceCwd = exactHostPath(input.localWorkspaceCwd, "ACP local workspace cwd");
      exactNonempty(input.adapterConfigRevisionId, "adapter configuration revision id");
      exactNonempty(input.executionWorkspaceBindingId, "execution workspace binding id");

      const acquired = await options.localExecutionOrchestrator.acquireExecutionTargetForRun({
        companyId: input.companyId,
        taskId: input.taskId,
        agentId: input.targetAgentId,
        runId: input.runId,
        executionWorkspaceBindingId: input.executionWorkspaceBindingId,
      });
      const target = acquired.executionTarget;
      if (target.kind !== "local" || target.leaseId !== acquired.lease.id) {
        await acquired.releaseExecutionTarget(true).catch(() => undefined);
        throw new TaskExecutionTargetAcquisitionRejected(
          "Local execution acquisition returned a different run lease",
        );
      }

      return Object.freeze({
        adapterConfigRevisionId: input.adapterConfigRevisionId,
        acpConfiguration,
        executionTarget: target,
        hostCwd,
        targetCwd: localWorkspaceCwd,
        targetAdditionalDirectories: Object.freeze([...input.targetAdditionalDirectories]),
        redactor: createTaskExecutionRuntimeRedactor(),
        release: (failed = false) => acquired.releaseExecutionTarget(failed),
      });
    },
  };
}
