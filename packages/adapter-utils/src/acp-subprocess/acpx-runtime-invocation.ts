import path from "node:path";
import {
  materializeAdapterExecutionTargetTextFiles,
  type AdapterExecutionTargetTextFile,
} from "../execution-target-materialization.js";
import type { AdapterExecutionTarget } from "../execution-target.js";
import type { SelectedCompanySkillLaunchChannel } from "../selected-company-skills.js";

/**
 * The narrow target preparation needed by ACPX's public local runtime.
 *
 * This intentionally has no ACPX registry, argv, executable-probe, transport,
 * or subprocess-starter input. ACPX resolves and launches its selected local
 * frontend itself; Paperclip only creates request-scoped MCP support files.
 */
export interface PrepareAcpxRuntimeInvocationInput {
  /** ACPX's public runtime can only launch a locally installed frontend. */
  readonly target: AdapterExecutionTarget;
  /** Exact local workspace passed to ACPX as its session cwd. */
  readonly targetCwd: string;
  /** Request-scoped files consumed by Paperclip-owned MCP helpers. */
  readonly invocationFiles?: readonly AdapterExecutionTargetTextFile[];
  /** ACPX has no generic additional-directories or skills-home API. */
  readonly companySkills: SelectedCompanySkillLaunchChannel;
}

/**
 * Local files and facts that an ACPX runtime invocation needs. No provider
 * launch information is present because it remains ACPX-owned.
 */
export interface PreparedAcpxRuntimeInvocation {
  readonly targetCwd: string;
  readonly invocationFilePaths: Readonly<Record<string, string>>;
  readonly targetNodeExecutable: string;
  readonly selectedCompanySkillMaterialization: null;
  /** Releases every invocation-scoped local file; safe to call repeatedly. */
  disposeBeforeStart(): Promise<void>;
}

function requireLocalTarget(target: AdapterExecutionTarget): void {
  if (target.kind !== "local") {
    throw new Error(
      "ACPX public runtime supports only a local execution target",
    );
  }
}

function requireAbsoluteLocalCwd(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !path.isAbsolute(value)
  ) {
    throw new Error("ACPX runtime target cwd must be an exact absolute local path");
  }
  return value;
}

function requireOperatorNativeSkills(
  companySkills: SelectedCompanySkillLaunchChannel,
): void {
  if (companySkills.channel !== "operator_native") {
    throw new Error(
      "ACPX public runtime does not support isolated_skills_home; select operator_native skills",
    );
  }
}

/**
 * Prepares only the local request-scoped assets that ACPX receives through its
 * public runtime API. It deliberately does not inspect an ACPX agent name or
 * command and cannot create a raw ACP subprocess fallback.
 */
export async function prepareAcpxRuntimeInvocation(
  input: PrepareAcpxRuntimeInvocationInput,
): Promise<PreparedAcpxRuntimeInvocation> {
  requireLocalTarget(input.target);
  const targetCwd = requireAbsoluteLocalCwd(input.targetCwd);
  requireOperatorNativeSkills(input.companySkills);
  const invocationFiles = input.invocationFiles ?? [];

  if (invocationFiles.length === 0) {
    return Object.freeze({
      targetCwd,
      targetNodeExecutable: process.execPath,
      invocationFilePaths: Object.freeze({}),
      selectedCompanySkillMaterialization: null,
      async disposeBeforeStart() {},
    });
  }

  const materialized = await materializeAdapterExecutionTargetTextFiles({
    target: input.target,
    files: invocationFiles,
  });
  return Object.freeze({
    targetCwd,
    targetNodeExecutable: process.execPath,
    invocationFilePaths: materialized.filePaths,
    selectedCompanySkillMaterialization: null,
    disposeBeforeStart: materialized.cleanup,
  });
}
