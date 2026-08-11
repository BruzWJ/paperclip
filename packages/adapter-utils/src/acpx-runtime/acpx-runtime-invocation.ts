import path from "node:path";
import {
  materializeAcpxInvocationFiles,
  type AcpxInvocationTextFile,
} from "./invocation-files.js";

/**
 * The exact Paperclip-owned workspace lease handed to ACPX for one bounded
 * local runtime execution. It carries no provider process or launch state.
 */
export interface AcpxLocalWorkspaceTarget {
  readonly kind: "local";
  readonly leaseId: string;
}

/**
 * The narrow target preparation needed by ACPX's public local runtime.
 *
 * This intentionally has no ACPX registry, argv, executable-probe, transport,
 * or subprocess-starter input. ACPX resolves and launches its selected local
 * frontend itself; Paperclip only creates request-scoped MCP support files.
 */
interface PrepareAcpxRuntimeInvocationInput {
  /** ACPX's public runtime can only launch a locally installed frontend. */
  readonly target: AcpxLocalWorkspaceTarget;
  /** Exact local workspace passed to ACPX as its session cwd. */
  readonly targetCwd: string;
  /** Request-scoped files consumed by Paperclip-owned MCP helpers. */
  readonly invocationFiles?: readonly AcpxInvocationTextFile[];
}

/**
 * Local files and facts that an ACPX runtime invocation needs. No provider
 * launch information is present because it remains ACPX-owned.
 */
interface PreparedAcpxRuntimeInvocation {
  readonly targetCwd: string;
  readonly invocationFilePaths: Readonly<Record<string, string>>;
  readonly targetNodeExecutable: string;
  /** Releases every invocation-scoped local file; safe to call repeatedly. */
  cleanup(): Promise<void>;
}

function requireLocalTarget(target: AcpxLocalWorkspaceTarget): void {
  if (target.kind !== "local") {
    throw new Error(
      "ACPX public runtime supports only a local execution target",
    );
  }
  if (target.leaseId.length === 0 || target.leaseId !== target.leaseId.trim()) {
    throw new Error("ACPX runtime target requires an exact local workspace lease");
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
  const invocationFiles = input.invocationFiles ?? [];

  if (invocationFiles.length === 0) {
    return Object.freeze({
      targetCwd,
      targetNodeExecutable: process.execPath,
      invocationFilePaths: Object.freeze({}),
      async cleanup() {},
    });
  }

  const materialized = await materializeAcpxInvocationFiles({
    files: invocationFiles,
  });
  return Object.freeze({
    targetCwd,
    targetNodeExecutable: process.execPath,
    invocationFilePaths: materialized.filePaths,
    cleanup: materialized.cleanup,
  });
}
