import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, desc, eq, exists, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  issueExecutionWorkspaceBindings,
  issueSessionContextEpochs,
  issueSessions,
  issues,
  projects,
  projectWorkspaces,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import type {
  ExecutionWorkspace,
  ExecutionWorkspaceSummary,
  ExecutionWorkspaceConfig,
  WorkspaceRuntimeDesiredState,
  WorkspaceRuntimeService,
  GitWorktreeBranchAncestryVerdict,
} from "@paperclipai/shared";
import * as IssueSession from "@paperclipai/shared/issue-session";
import { resolvePaperclipInstanceRoot } from "@paperclipai/shared/home-paths";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import {
  listCurrentRuntimeServicesForExecutionWorkspaces,
  listCurrentRuntimeServicesForProjectWorkspaces,
} from "./workspace-runtime-read-model.js";
import { appendCanonicalControlNotice } from "./issue-session-producers.js";
import { resolveCurrentIssueOwnerRunLinkages } from "./productive-run-linkage.js";
import { createIssueSessionRootInTx } from "./issue-session-root-postgres.js";
import {
  reserveIssueSessionEventSequence,
  type IssueSessionDbTransaction,
} from "./issue-session/event-store.js";
import { publishIssueSessionEventInTx } from "./issue-session/publication.js";
import { instanceSettingsService } from "./instance-settings.js";

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
type RuntimeServiceReadDb = Pick<Db, "select">;
const execFileAsync = promisify(execFile);
const WORKSPACE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";
const REUSABLE_WORKSPACE_STATUSES = ["active", "idle", "in_review"] as const;

export type ExecutionWorkspaceBranchReconcileMode = "forward" | "override" | "quarantine_restore";

export type ExecutionWorkspaceBranchReconcileActor =
  | {
      actorType: "user";
      actorId: string;
    }
  | {
      actorType: "system";
      actorId: string;
      runId: string | null;
    };

export type ExecutionWorkspaceBranchReconcileInspection = {
  fingerprint: string;
  worktreePath: string;
  repoRoot: string;
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  cleanliness: "clean" | "dirty" | "unknown";
  statusEntryCount: number | null;
  plainLanguageReason: string;
};

export type ExecutionWorkspaceBranchReconcileResult = {
  workspace: ExecutionWorkspace;
  boundIssueId: string;
  boundOwnershipEpoch: number;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  auditCommentId: string | null;
  rescueRef: {
    branchName: string;
    commitSha: string;
    fileCount: number;
    sourceAuditCommentId: string | null;
    claimantAuditCommentId: string | null;
  } | null;
  restoredSourceIssue: {
    id: string;
    companyId: string;
    boardPresentationStatus: string;
    ownerAgentId: string | null;
  } | null;
  sourceIssueBoardPresentationStatusChanged: boolean;
};

export type ExecutionWorkspaceGitWorktreeContention = {
  claimedByWorkspaceId: string;
  claimedByIssueId: string | null;
  claimedByIssueIdentifier: string | null;
  activeRun: {
    id: string;
    status: "queued" | "running";
    issueId: string | null;
    issueIdentifier: string | null;
  } | null;
} | null;

export type ExecutionWorkspaceCurrentBinding = {
  id: string;
  companyId: string;
  issueId: string;
  sessionId: string;
  ownershipEpoch: number;
  executionWorkspaceId: string;
  bindingMode: string;
  absoluteCwd: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueStatus: string;
  issueUpdatedAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return { ...value };
}

function quarantineRestoreRequestedSourceStatus(input: {
  boardPresentationStatus: string;
  executionState: unknown;
}): "todo" | undefined {
  const state = parseIssueExecutionState(input.executionState);
  if (
    state?.status === "pending" &&
    input.boardPresentationStatus === "in_review" &&
    state.currentParticipant !== null
  ) {
    return undefined;
  }
  return "todo";
}

function readDesiredState(value: unknown): WorkspaceRuntimeDesiredState | null {
  return value === "running" || value === "stopped" || value === "manual" ? value : null;
}

function readServiceStates(value: unknown): ExecutionWorkspaceConfig["serviceStates"] {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter(([, state]) =>
    state === "running" || state === "stopped" || state === "manual"
  );
  return entries.length > 0
    ? Object.fromEntries(entries) as ExecutionWorkspaceConfig["serviceStates"]
    : null;
}

async function runGit(args: string[], cwd: string) {
  return await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function readGitStdout(args: string[], cwd: string): Promise<string | null> {
  const output = await runGit(args, cwd);
  return output.stdout.trim() || null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatBranchForMessage(branch: string | null | undefined) {
  return branch && branch.length > 0 ? branch : "<detached>";
}

function fingerprintWorkspaceBranchIncoherence(input: {
  issueId: string;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: "clean" | "dirty" | "unknown";
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(stableStringify({
      version: 1,
      reason: WORKSPACE_BRANCH_INCOHERENCE_REASON,
      issueId: input.issueId,
      executionWorkspaceId: input.executionWorkspaceId,
      worktreePath: path.resolve(input.worktreePath),
      expectedBranch: input.expectedBranch,
      actualBranch: input.actualBranch,
      cleanliness: input.cleanliness,
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha: input.actualHeadSha,
    }))
    .digest("hex");
  return `workspace_incoherence:v1:sha256:${digest}`;
}

async function getGitWorktreeBranchAncestryVerdict(input: {
  repoRoot: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}): Promise<GitWorktreeBranchAncestryVerdict> {
  if (!input.expectedHeadSha || !input.actualHeadSha) return "unknown";

  try {
    await runGit(["merge-base", "--is-ancestor", input.expectedHeadSha, input.actualHeadSha], input.repoRoot);
    return "ancestor";
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? (error as { code?: unknown }).code
      : null;
    return code === 1 ? "diverged" : "unknown";
  }
}

function explainGitWorktreeBranchReconcileInspection(input: {
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
}) {
  if (!input.fromSha || !input.toSha) {
    return `Paperclip could not determine branch ancestry because "${input.fromBranch}" or "${input.toBranch}" is missing a resolvable HEAD commit.`;
  }
  if (input.fromSha === input.toSha) {
    return `The recorded branch "${input.fromBranch}" and checked-out branch "${input.toBranch}" resolve to the same commit.`;
  }
  if (input.ancestryVerdict === "ancestor") {
    return `The recorded branch "${input.fromBranch}" is an ancestor of the checked-out branch "${input.toBranch}".`;
  }
  if (input.ancestryVerdict === "diverged") {
    return `The recorded branch "${input.fromBranch}" is not an ancestor of the checked-out branch "${input.toBranch}".`;
  }
  return `Paperclip could not determine whether "${input.toBranch}" is forward of "${input.fromBranch}".`;
}

async function inspectExecutionWorkspaceBranchForReconcile(
  workspace: Pick<ExecutionWorkspace, "id" | "cwd" | "providerRef" | "branchName">,
  issueId: string,
): Promise<ExecutionWorkspaceBranchReconcileInspection> {
  const fromBranch = readNullableString(workspace.branchName);
  if (!fromBranch) {
    throw unprocessable("Execution workspace has no recorded branch to reconcile");
  }

  const worktreePath = readNullableString(workspace.providerRef) ?? readNullableString(workspace.cwd);
  if (!worktreePath) {
    throw unprocessable("Execution workspace needs a local worktree path before Paperclip can reconcile its branch record");
  }

  const repoRoot = await readGitStdout(["rev-parse", "--show-toplevel"], worktreePath).catch(() => null);
  if (!repoRoot) {
    throw unprocessable("Execution workspace path is not inside a git repository");
  }

  const toBranch = await readGitStdout(["symbolic-ref", "--quiet", "--short", "HEAD"], worktreePath).catch(() => null);
  if (!toBranch) {
    throw unprocessable("Execution workspace is detached; Paperclip cannot reconcile it to a branch name");
  }

  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], worktreePath)
    .then((output) => output.stdout)
    .catch(() => null);
  const statusLines = status === null
    ? null
    : status.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const cleanliness: ExecutionWorkspaceBranchReconcileInspection["cleanliness"] =
    status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";

  const fromSha = await readGitStdout(["rev-parse", "--verify", `refs/heads/${fromBranch}^{commit}`], repoRoot)
    .catch(() => null);
  const toSha = await readGitStdout(["rev-parse", "HEAD"], worktreePath).catch(() => null);
  const ancestryVerdict = await getGitWorktreeBranchAncestryVerdict({
    repoRoot,
    expectedHeadSha: fromSha,
    actualHeadSha: toSha,
  });

  return {
    fingerprint: fingerprintWorkspaceBranchIncoherence({
      issueId,
      executionWorkspaceId: workspace.id,
      worktreePath,
      expectedBranch: fromBranch,
      actualBranch: toBranch,
      cleanliness,
      expectedHeadSha: fromSha,
      actualHeadSha: toSha,
    }),
    worktreePath: path.resolve(worktreePath),
    repoRoot: path.resolve(repoRoot),
    fromBranch,
    toBranch,
    fromSha,
    toSha,
    ancestryVerdict,
    cleanliness,
    statusEntryCount: statusLines?.length ?? null,
    plainLanguageReason: explainGitWorktreeBranchReconcileInspection({
      fromBranch,
      toBranch,
      fromSha,
      toSha,
      ancestryVerdict,
    }),
  };
}

function formatBranchReconcileAuditComment(input: {
  mode: ExecutionWorkspaceBranchReconcileMode;
  reason: string | null;
  workspaceId: string;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  rescueRef: ExecutionWorkspaceBranchReconcileResult["rescueRef"];
}) {
  return [
    "Execution workspace branch reconciled.",
    "",
    `- Workspace: \`${input.workspaceId}\``,
    `- Mode: \`${input.mode}\``,
    `- From branch: \`${formatBranchForMessage(input.inspection.fromBranch)}\``,
    `- To branch: \`${formatBranchForMessage(input.inspection.toBranch)}\``,
    `- From SHA: \`${input.inspection.fromSha ?? "unknown"}\``,
    `- To SHA: \`${input.inspection.toSha ?? "unknown"}\``,
    `- Verdict: \`${input.inspection.ancestryVerdict}\``,
    `- Fingerprint: \`${input.inspection.fingerprint}\``,
    ...(input.rescueRef
      ? [
          `- Rescue ref: \`${input.rescueRef.branchName}\``,
          `- Rescue commit: \`${input.rescueRef.commitSha}\``,
          `- Rescued file count: \`${input.rescueRef.fileCount}\``,
        ]
      : []),
    ...(input.reason ? [`- Operator reason: ${input.reason}`] : []),
  ].join("\n");
}

function isWorkspaceRuntimeValidationFailure(error: unknown): error is {
  code: "workspace_validation_failed";
  message: string;
  resultJson: Record<string, unknown>;
} {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: unknown; resultJson?: unknown; message?: unknown };
  return maybe.code === "workspace_validation_failed" &&
    typeof maybe.message === "string" &&
    Boolean(maybe.resultJson) &&
    typeof maybe.resultJson === "object" &&
    !Array.isArray(maybe.resultJson);
}

function assertBranchReconcileWorkspaceIsSafe(input: {
  workspaceStatus: ExecutionWorkspace["status"];
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  runtimeServices: WorkspaceRuntimeService[];
  allowActiveWorkspace?: boolean;
}) {
  const allowedStatuses = input.allowActiveWorkspace ? ["idle", "active"] : ["idle"];
  if (!allowedStatuses.includes(input.workspaceStatus)) {
    throw unprocessable("Execution workspace branch reconciliation requires the workspace to be idle", {
      workspaceStatus: input.workspaceStatus,
      inspection: input.inspection,
    });
  }

  if (input.inspection.cleanliness !== "clean") {
    throw unprocessable("Execution workspace branch reconciliation requires a clean worktree", {
      inspection: input.inspection,
    });
  }

  assertBranchReconcileRuntimeServicesStopped({
    inspection: input.inspection,
    runtimeServices: input.runtimeServices,
  });
}

function assertBranchReconcileRuntimeServicesStopped(input: {
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  runtimeServices: WorkspaceRuntimeService[];
}) {
  const activeRuntimeServices = input.runtimeServices.filter((service) => service.status !== "stopped");
  if (activeRuntimeServices.length > 0) {
    throw unprocessable("Execution workspace branch reconciliation requires all runtime services to be stopped", {
      inspection: input.inspection,
      runtimeServices: activeRuntimeServices.map((service) => ({
        id: service.id,
        serviceName: service.serviceName,
        status: service.status,
      })),
    });
  }
}

function assertLockedBranchReconcileWorkspaceStillMatchesInspection(input: {
  lockedRow: ExecutionWorkspaceRow;
  inspectedRow: ExecutionWorkspaceRow;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
}) {
  const lockedPath = readNullableString(input.lockedRow.providerRef) ?? readNullableString(input.lockedRow.cwd);
  const lockedBranch = readNullableString(input.lockedRow.branchName);
  const currentPath = lockedPath ? path.resolve(lockedPath) : null;

  if (
    input.lockedRow.projectWorkspaceId !== input.inspectedRow.projectWorkspaceId ||
    lockedBranch !== input.inspection.fromBranch ||
    currentPath !== input.inspection.worktreePath
  ) {
    throw conflict("Execution workspace changed during branch reconciliation; retry with the latest workspace state", {
      workspaceId: input.lockedRow.id,
      expected: {
        status: input.inspectedRow.status,
        projectWorkspaceId: input.inspectedRow.projectWorkspaceId,
        branchName: input.inspection.fromBranch,
        worktreePath: input.inspection.worktreePath,
      },
      current: {
        status: input.lockedRow.status,
        projectWorkspaceId: input.lockedRow.projectWorkspaceId,
        branchName: lockedBranch,
        worktreePath: currentPath,
      },
    });
  }
}

async function quarantineRestoreDirtyWorkspaceBranch(input: {
  db: Db;
  workspace: Pick<ExecutionWorkspace, "id">;
  issueId: string;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  actor: ExecutionWorkspaceBranchReconcileActor;
}): Promise<NonNullable<ExecutionWorkspaceBranchReconcileResult["rescueRef"]>> {
  const sourceIssue = await input.db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      workMode: issues.workMode,
    })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .then((rows) => rows[0] ?? null);
  if (!sourceIssue) throw notFound("Source issue not found");
  const safeguards = await instanceSettingsService(input.db).getGeneral();

  const { ensureGitWorktreeBranchCoherent } = await import("./workspace-runtime.js");
  try {
    const result = await ensureGitWorktreeBranchCoherent({
      db: input.db,
      repoRoot: input.inspection.repoRoot,
      worktreePath: input.inspection.worktreePath,
      expectedBranchName: input.inspection.fromBranch,
      actualBranchName: input.inspection.toBranch,
      sourceIssue,
      executionWorkspaceId: input.workspace.id,
      runId:
        input.actor.actorType === "user" ? null : input.actor.runId,
      enableWorkspaceBranchReconcileForward:
        safeguards.enableWorkspaceBranchReconcileForward,
      enableWorkspaceDirtyQuarantineRepair:
        safeguards.enableWorkspaceDirtyQuarantineRepair,
      reconcileOperationPhase: "worktree_prepare",
      recorder: null,
    });

    if (!result.dirtyQuarantineRepair) {
      throw unprocessable("Quarantine restore requires a dirty foreign-branch worktree to repair", {
        inspection: input.inspection,
      });
    }

    return {
      branchName: result.dirtyQuarantineRepair.rescueBranch,
      commitSha: result.dirtyQuarantineRepair.rescueCommitSha,
      fileCount: result.dirtyQuarantineRepair.fileCount,
      sourceAuditCommentId: result.dirtyQuarantineRepair.sourceAuditCommentId,
      claimantAuditCommentId: result.dirtyQuarantineRepair.claimantAuditCommentId,
    };
  } catch (error) {
    if (isWorkspaceRuntimeValidationFailure(error)) {
      throw unprocessable(error.message, {
        code: error.code,
        ...error.resultJson,
      });
    }
    throw error;
  }
}

export function readExecutionWorkspaceConfig(metadata: Record<string, unknown> | null | undefined): ExecutionWorkspaceConfig | null {
  const raw = isRecord(metadata?.config) ? metadata.config : null;
  if (!raw) return null;

  const config: ExecutionWorkspaceConfig = {
    provisionCommand: readNullableString(raw.provisionCommand),
    teardownCommand: readNullableString(raw.teardownCommand),
    cleanupCommand: readNullableString(raw.cleanupCommand),
    workspaceRuntime: cloneRecord(raw.workspaceRuntime),
    desiredState: readDesiredState(raw.desiredState),
    serviceStates: readServiceStates(raw.serviceStates),
  };

  const hasConfig = Object.values(config).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });

  return hasConfig ? config : null;
}

export function mergeExecutionWorkspaceConfig(
  metadata: Record<string, unknown> | null | undefined,
  patch: Partial<ExecutionWorkspaceConfig> | null,
): Record<string, unknown> | null {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const current = readExecutionWorkspaceConfig(metadata) ?? {
    provisionCommand: null,
    teardownCommand: null,
    cleanupCommand: null,
    workspaceRuntime: null,
    desiredState: null,
    serviceStates: null,
  };

  if (patch === null) {
    delete nextMetadata.config;
    return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
  }

  const nextConfig: ExecutionWorkspaceConfig = {
    provisionCommand: patch.provisionCommand !== undefined ? readNullableString(patch.provisionCommand) : current.provisionCommand,
    teardownCommand: patch.teardownCommand !== undefined ? readNullableString(patch.teardownCommand) : current.teardownCommand,
    cleanupCommand: patch.cleanupCommand !== undefined ? readNullableString(patch.cleanupCommand) : current.cleanupCommand,
    workspaceRuntime: patch.workspaceRuntime !== undefined ? cloneRecord(patch.workspaceRuntime) : current.workspaceRuntime,
    desiredState:
      patch.desiredState !== undefined
        ? readDesiredState(patch.desiredState)
        : current.desiredState,
    serviceStates:
      patch.serviceStates !== undefined ? readServiceStates(patch.serviceStates) : current.serviceStates,
  };

  const hasConfig = Object.values(nextConfig).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });

  if (hasConfig) {
    nextMetadata.config = {
      provisionCommand: nextConfig.provisionCommand,
      teardownCommand: nextConfig.teardownCommand,
      cleanupCommand: nextConfig.cleanupCommand,
      workspaceRuntime: nextConfig.workspaceRuntime,
      desiredState: nextConfig.desiredState,
      serviceStates: nextConfig.serviceStates ?? null,
    };
  } else {
    delete nextMetadata.config;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
}

function toRuntimeService(row: WorkspaceRuntimeServiceRow): WorkspaceRuntimeService {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    scopeType: row.scopeType as WorkspaceRuntimeService["scopeType"],
    scopeId: row.scopeId ?? null,
    serviceName: row.serviceName,
    status: row.status as WorkspaceRuntimeService["status"],
    lifecycle: row.lifecycle as WorkspaceRuntimeService["lifecycle"],
    reuseKey: row.reuseKey ?? null,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    port: row.port ?? null,
    url: row.url ?? null,
    provider: row.provider as WorkspaceRuntimeService["provider"],
    providerRef: row.providerRef ?? null,
    ownerAgentId: row.ownerAgentId ?? null,
    startedByRunId: row.startedByRunId ?? null,
    lastUsedAt: row.lastUsedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt ?? null,
    stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
    healthStatus: row.healthStatus as WorkspaceRuntimeService["healthStatus"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecutionWorkspace(
  row: ExecutionWorkspaceRow,
  runtimeServices: WorkspaceRuntimeService[] = [],
): ExecutionWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    sourceIssueId: row.sourceIssueId ?? null,
    mode: row.mode as ExecutionWorkspace["mode"],
    strategyType: row.strategyType as ExecutionWorkspace["strategyType"],
    name: row.name,
    status: row.status as ExecutionWorkspace["status"],
    cwd: row.cwd ?? null,
    repoUrl: row.repoUrl ?? null,
    baseRef: row.baseRef ?? null,
    branchName: row.branchName ?? null,
    providerType: row.providerType as ExecutionWorkspace["providerType"],
    providerRef: row.providerRef ?? null,
    derivedFromExecutionWorkspaceId: row.derivedFromExecutionWorkspaceId ?? null,
    lastUsedAt: row.lastUsedAt,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? null,
    cleanupEligibleAt: row.cleanupEligibleAt ?? null,
    cleanupReason: row.cleanupReason ?? null,
    config: readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    runtimeServices,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecutionWorkspaceSummary(
  row: Pick<ExecutionWorkspaceRow, "id" | "name" | "mode" | "status" | "cwd" | "branchName" | "projectWorkspaceId" | "lastUsedAt">,
): ExecutionWorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode as ExecutionWorkspaceSummary["mode"],
    status: row.status as ExecutionWorkspaceSummary["status"],
    cwd: row.cwd ?? null,
    branchName: row.branchName ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    lastUsedAt: row.lastUsedAt,
  };
}

function usesInheritedProjectRuntimeServices(row: ExecutionWorkspaceRow) {
  if (row.mode !== "shared_workspace" || !row.projectWorkspaceId) return false;
  return !readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null)?.workspaceRuntime;
}

function noActiveRuntimeServicesForWorkspaceCondition(row: ExecutionWorkspaceRow) {
  const inheritedProjectWorkspaceId = usesInheritedProjectRuntimeServices(row) ? row.projectWorkspaceId : null;
  const activeServiceConditions = inheritedProjectWorkspaceId
    ? and(
        eq(workspaceRuntimeServices.companyId, row.companyId),
        eq(workspaceRuntimeServices.projectWorkspaceId, inheritedProjectWorkspaceId),
        eq(workspaceRuntimeServices.scopeType, "project_workspace"),
        ne(workspaceRuntimeServices.status, "stopped"),
      )
    : and(
        eq(workspaceRuntimeServices.companyId, row.companyId),
        eq(workspaceRuntimeServices.executionWorkspaceId, row.id),
        ne(workspaceRuntimeServices.status, "stopped"),
      );
  return sql`not exists (select 1 from ${workspaceRuntimeServices} where ${activeServiceConditions})`;
}

async function loadEffectiveRuntimeServicesByExecutionWorkspace(
  db: RuntimeServiceReadDb,
  companyId: string,
  rows: ExecutionWorkspaceRow[],
) {
  const executionRuntimeServices = await listCurrentRuntimeServicesForExecutionWorkspaces(
    db,
    companyId,
    rows.map((row) => row.id),
  );
  const projectWorkspaceIds = rows
    .filter((row) => usesInheritedProjectRuntimeServices(row))
    .map((row) => row.projectWorkspaceId)
    .filter((value): value is string => Boolean(value));
  const projectRuntimeServices = await listCurrentRuntimeServicesForProjectWorkspaces(
    db,
    companyId,
    [...new Set(projectWorkspaceIds)],
  );

  return new Map(
    rows.map((row) => [
      row.id,
      usesInheritedProjectRuntimeServices(row)
        ? (projectRuntimeServices.get(row.projectWorkspaceId!) ?? [])
        : (executionRuntimeServices.get(row.id) ?? []),
    ]),
  );
}

type WorkspaceReservationIssue = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "companyId"
  | "parentId"
  | "projectId"
  | "title"
  | "identifier"
  | "ownershipEpoch"
  | "ownerAgentId"
>;

export interface ReserveIssueExecutionWorkspaceBindingInput {
  issue: WorkspaceReservationIssue;
  session: {
    id: string;
    parentSessionId?: string | null;
    now: Date;
  };
  provenance?: {
    agentId?: string | null;
    userId?: string | null;
  };
}

export class IssueExecutionWorkspaceReservationRejected extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "IssueExecutionWorkspaceReservationRejected";
  }
}

function rejectWorkspaceReservation(message: string, reason: string): never {
  throw new IssueExecutionWorkspaceReservationRejected(message, reason);
}

function deterministicWorkspaceUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${key}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function workspaceReservationDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function absoluteProjectWorkspaceCwd(
  cwd: string | null | undefined,
): string | null {
  if (!cwd) return null;
  if (!path.isAbsolute(cwd)) {
    rejectWorkspaceReservation(
      "Selected project workspace cwd must be absolute",
      "project_workspace_cwd_invalid",
    );
  }
  return path.resolve(cwd);
}

async function currentContextGeneration(
  tx: IssueSessionDbTransaction,
  input: { companyId: string; issueId: string; sessionId: string },
): Promise<number> {
  const row = await tx
    .select({ generation: issueSessionContextEpochs.generation })
    .from(issueSessionContextEpochs)
    .where(
      and(
        eq(issueSessionContextEpochs.companyId, input.companyId),
        eq(issueSessionContextEpochs.issueId, input.issueId),
        eq(issueSessionContextEpochs.sessionId, input.sessionId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) {
    rejectWorkspaceReservation(
      "Issue Session context epoch is missing",
      "session_context_epoch_missing",
    );
  }
  return row.generation;
}

async function resolveReservationParentSession(
  tx: IssueSessionDbTransaction,
  input: ReserveIssueExecutionWorkspaceBindingInput,
): Promise<string | null> {
  if (!input.issue.parentId) {
    if (input.session.parentSessionId) {
      rejectWorkspaceReservation(
        "Root issue cannot have a parent Session",
        "parent_session_invalid",
      );
    }
    return null;
  }
  const parent = await tx
    .select({ id: issueSessions.id })
    .from(issueSessions)
    .where(
      and(
        eq(issueSessions.companyId, input.issue.companyId),
        eq(issueSessions.issueId, input.issue.parentId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!parent) {
    rejectWorkspaceReservation(
      "Parent issue has no canonical Session",
      "parent_session_missing",
    );
  }
  if (
    input.session.parentSessionId !== undefined &&
    input.session.parentSessionId !== parent.id
  ) {
    rejectWorkspaceReservation(
      "Parent Session does not match the parent issue",
      "parent_session_mismatch",
    );
  }
  return parent.id;
}

async function publishSessionMovedForWorkspaceInTx(
  tx: IssueSessionDbTransaction,
  input: ReserveIssueExecutionWorkspaceBindingInput,
  absoluteCwd: string,
): Promise<void> {
  const { seq } = await reserveIssueSessionEventSequence(tx, {
    companyId: input.issue.companyId,
    issueId: input.issue.id,
    sessionId: input.session.id,
  });
  const sourceKey = [
    "workspace-binding",
    input.issue.id,
    input.issue.ownershipEpoch,
    absoluteCwd,
  ].join(":");
  const eventId = `evt_${workspaceReservationDigest(sourceKey).slice(0, 40)}`;
  await publishIssueSessionEventInTx(tx, {
    event: {
      id: eventId,
      sessionId: input.session.id,
      seq,
      type: IssueSession.Event.Moved.type,
      data: {
        sessionID: input.session.id,
        timestamp: input.session.now.getTime(),
        location: { directory: absoluteCwd },
      },
    },
    envelope: {
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      runId: null,
      ownershipEpoch: input.issue.ownershipEpoch,
      agentId: input.issue.ownerAgentId,
      adapterConfigRevisionId: null,
      sourceKind: "workspace_binding_moved",
      sourceId: eventId,
      immutableSourceKey: sourceKey,
      sourceRecordId: input.issue.id,
      sourceIdentityDigest: workspaceReservationDigest(
        `${sourceKey}:${eventId}`,
      ),
      createdAt: input.session.now,
    },
  });
}

/**
 * Sole production mutating owner for an issue-execution workspace binding.
 *
 * The workspace is resolved automatically from the issue's project on every
 * ownership epoch. Parent Sessions supply lineage only: neither a parent
 * binding nor a prior epoch cwd is an implicit workspace source.
 */
export async function reserveIssueExecutionWorkspaceBinding(
  tx: IssueSessionDbTransaction,
  input: ReserveIssueExecutionWorkspaceBindingInput,
) {
  if (
    !Number.isSafeInteger(input.issue.ownershipEpoch) ||
    input.issue.ownershipEpoch < 1
  ) {
    rejectWorkspaceReservation(
      "Issue ownership epoch must be positive",
      "ownership_epoch_invalid",
    );
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${[
      "issue-workspace-reservation",
      input.issue.companyId,
      input.issue.id,
      input.issue.ownershipEpoch,
    ].join(":")}, 0))`,
  );

  const existingBinding = await tx
    .select()
    .from(issueExecutionWorkspaceBindings)
    .where(
      and(
        eq(
          issueExecutionWorkspaceBindings.companyId,
          input.issue.companyId,
        ),
        eq(issueExecutionWorkspaceBindings.issueId, input.issue.id),
        eq(
          issueExecutionWorkspaceBindings.ownershipEpoch,
          input.issue.ownershipEpoch,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existingBinding) {
    if (existingBinding.sessionId !== input.session.id) {
      rejectWorkspaceReservation(
        "Issue workspace reservation was retried with different immutable identity",
        "workspace_binding_conflict",
      );
    }
    const existingSession = await tx
      .select()
      .from(issueSessions)
      .where(
        and(
          eq(issueSessions.companyId, input.issue.companyId),
          eq(issueSessions.issueId, input.issue.id),
          eq(issueSessions.id, input.session.id),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!existingSession) {
      rejectWorkspaceReservation(
        "Persisted workspace binding has no canonical Session",
        "workspace_session_missing",
      );
    }
    const existingWorkspace = await tx
      .select({
        projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
      })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, input.issue.companyId),
          eq(
            executionWorkspaces.id,
            existingBinding.executionWorkspaceId,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!existingWorkspace) {
      rejectWorkspaceReservation(
        "Persisted workspace binding has no execution workspace",
        "execution_workspace_missing",
      );
    }
    return {
      binding: existingBinding,
      session: existingSession,
      contextEpochGeneration: await currentContextGeneration(tx, {
        companyId: input.issue.companyId,
        issueId: input.issue.id,
        sessionId: input.session.id,
      }),
      projectWorkspaceId: existingWorkspace.projectWorkspaceId,
      moved: false,
    };
  }

  const project = input.issue.projectId
    ? await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.companyId, input.issue.companyId),
            eq(projects.id, input.issue.projectId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  if (input.issue.projectId && !project) {
    rejectWorkspaceReservation(
      "Issue project is not in this company",
      "project_invalid",
    );
  }
  const selectedProjectWorkspace = input.issue.projectId
    ? await tx
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, input.issue.companyId),
            eq(projectWorkspaces.projectId, input.issue.projectId),
          ),
        )
        .orderBy(
          sql`${projectWorkspaces.isPrimary} desc`,
          asc(projectWorkspaces.createdAt),
          asc(projectWorkspaces.id),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  let workspace: ExecutionWorkspaceRow;
  {
    const projectWorkspaceCwd = absoluteProjectWorkspaceCwd(
      selectedProjectWorkspace?.cwd,
    );
    const perEpochRoot = path.join(
      resolvePaperclipInstanceRoot(),
      "issue-workspaces",
      input.issue.companyId,
      input.issue.id,
      String(input.issue.ownershipEpoch),
    );
    const absoluteCwd = projectWorkspaceCwd ?? perEpochRoot;
    const realizedBaseRef =
      selectedProjectWorkspace?.repoRef ??
      selectedProjectWorkspace?.defaultRef ??
      null;
    await fs.mkdir(absoluteCwd, { recursive: true });
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${[
        "shared-execution-workspace",
        input.issue.companyId,
        input.issue.projectId ?? "global",
        selectedProjectWorkspace?.id ?? "projectless",
        absoluteCwd,
      ].join(":")}, 0))`,
    );
    const reusableShared = await tx
            .select()
            .from(executionWorkspaces)
            .where(
              and(
                eq(executionWorkspaces.companyId, input.issue.companyId),
                input.issue.projectId
                  ? eq(executionWorkspaces.projectId, input.issue.projectId)
                  : isNull(executionWorkspaces.projectId),
                selectedProjectWorkspace?.id
                  ? eq(
                      executionWorkspaces.projectWorkspaceId,
                      selectedProjectWorkspace.id,
                    )
                  : isNull(executionWorkspaces.projectWorkspaceId),
                eq(executionWorkspaces.mode, "shared_workspace"),
                eq(executionWorkspaces.cwd, absoluteCwd),
                inArray(
                  executionWorkspaces.status,
                  [...REUSABLE_WORKSPACE_STATUSES],
                ),
                isNull(executionWorkspaces.closedAt),
              ),
            )
            .orderBy(asc(executionWorkspaces.createdAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);
    if (reusableShared) {
      workspace = await tx
        .update(executionWorkspaces)
        .set({
          status: "active",
          lastUsedAt: input.session.now,
          updatedAt: input.session.now,
        })
        .where(eq(executionWorkspaces.id, reusableShared.id))
        .returning()
        .then((rows) => rows[0] ?? reusableShared);
    } else {
      const inserted = await tx
        .insert(executionWorkspaces)
        .values({
          companyId: input.issue.companyId,
          projectId: input.issue.projectId,
          projectWorkspaceId: selectedProjectWorkspace?.id ?? null,
          workspaceClass: input.issue.projectId
            ? "project"
            : "projectless",
          sourceIssueId: null,
          mode: "shared_workspace",
          strategyType: "local_fs",
          name:
            input.issue.title?.trim() ||
            input.issue.identifier?.trim() ||
            `Issue ${input.issue.id}`,
          status: "active",
          cwd: absoluteCwd,
          repoUrl: selectedProjectWorkspace?.repoUrl ?? null,
          baseRef: realizedBaseRef,
          branchName: null,
          providerType: "local_fs",
          providerRef: null,
          metadata: null,
          openedAt: input.session.now,
          lastUsedAt: input.session.now,
          createdAt: input.session.now,
          updatedAt: input.session.now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!inserted) {
        rejectWorkspaceReservation(
          "Execution workspace was not persisted",
          "execution_workspace_reservation_failed",
        );
      }
      workspace = inserted;
    }
  }

  if (!workspace.cwd || !path.isAbsolute(workspace.cwd)) {
    rejectWorkspaceReservation(
      "Reserved execution workspace has no valid absolute cwd",
      "execution_workspace_cwd_invalid",
    );
  }
  const absoluteCwd = path.resolve(workspace.cwd);
  const parentSessionId = await resolveReservationParentSession(tx, input);
  const existingSession = await tx
    .select()
    .from(issueSessions)
    .where(
      and(
        eq(issueSessions.companyId, input.issue.companyId),
        eq(issueSessions.issueId, input.issue.id),
        eq(issueSessions.id, input.session.id),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);

  let session: typeof issueSessions.$inferSelect;
  let contextEpochGeneration: number;
  let moved = false;
  if (!existingSession) {
    const root = await createIssueSessionRootInTx(tx, {
      id: input.session.id,
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      parentSessionId,
      projectId: input.issue.projectId ?? "global",
      title: input.issue.title?.trim() || `Issue ${input.issue.id}`,
      directory: absoluteCwd,
      now: input.session.now,
    });
    session = root.session;
    contextEpochGeneration = root.contextEpoch.generation;
  } else {
    if (existingSession.parentSessionId !== parentSessionId) {
      rejectWorkspaceReservation(
        "Existing Session parent does not match issue lineage",
        "parent_session_mismatch",
      );
    }
    if (path.resolve(existingSession.directory) !== absoluteCwd) {
      await publishSessionMovedForWorkspaceInTx(tx, input, absoluteCwd);
      moved = true;
      const movedSession = await tx
        .select()
        .from(issueSessions)
        .where(eq(issueSessions.id, input.session.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!movedSession) {
        rejectWorkspaceReservation(
          "Moved Session projection is missing",
          "workspace_session_missing",
        );
      }
      session = movedSession;
    } else {
      session = existingSession;
    }
    contextEpochGeneration = await currentContextGeneration(tx, {
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      sessionId: input.session.id,
    });
  }

  const binding = await tx
    .insert(issueExecutionWorkspaceBindings)
    .values({
      id: deterministicWorkspaceUuid(
        "issue-workspace-binding",
        `${input.issue.companyId}:${input.issue.id}:${input.issue.ownershipEpoch}`,
      ),
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      sessionId: input.session.id,
      ownershipEpoch: input.issue.ownershipEpoch,
      executionWorkspaceId: workspace.id,
      bindingMode: workspace.mode,
      absoluteCwd,
      repositoryLocator: workspace.repoUrl,
      repositoryRef: workspace.branchName ?? workspace.baseRef,
      pullRequestSelector: null,
      boundByAgentId: input.provenance?.agentId ?? null,
      boundByUserId: input.provenance?.userId ?? null,
      createdAt: input.session.now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!binding) {
    rejectWorkspaceReservation(
      "Issue execution workspace binding was not persisted",
      "workspace_binding_missing",
    );
  }
  return {
    binding,
    session,
    contextEpochGeneration,
    projectWorkspaceId: workspace.projectWorkspaceId,
    moved,
  };
}

export function executionWorkspaceService(db: Db) {
  async function listCurrentBindingsForWorkspace(
    executionWorkspaceId: string,
    options: {
      companyId?: string;
      issueId?: string;
      queryDb?: Db;
    } = {},
  ): Promise<ExecutionWorkspaceCurrentBinding[]> {
    const queryDb = options.queryDb ?? db;
    const conditions = [
      eq(issueExecutionWorkspaceBindings.executionWorkspaceId, executionWorkspaceId),
      eq(issueExecutionWorkspaceBindings.companyId, issues.companyId),
      eq(issueExecutionWorkspaceBindings.issueId, issues.id),
      eq(issueExecutionWorkspaceBindings.ownershipEpoch, issues.ownershipEpoch),
    ];
    if (options.companyId) {
      conditions.push(eq(issueExecutionWorkspaceBindings.companyId, options.companyId));
    }
    if (options.issueId) {
      conditions.push(eq(issueExecutionWorkspaceBindings.issueId, options.issueId));
    }

    return queryDb
      .select({
        id: issueExecutionWorkspaceBindings.id,
        companyId: issueExecutionWorkspaceBindings.companyId,
        issueId: issueExecutionWorkspaceBindings.issueId,
        sessionId: issueExecutionWorkspaceBindings.sessionId,
        ownershipEpoch: issueExecutionWorkspaceBindings.ownershipEpoch,
        executionWorkspaceId: issueExecutionWorkspaceBindings.executionWorkspaceId,
        bindingMode: issueExecutionWorkspaceBindings.bindingMode,
        absoluteCwd: issueExecutionWorkspaceBindings.absoluteCwd,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.boardPresentationStatus,
        issueUpdatedAt: issues.updatedAt,
      })
      .from(issueExecutionWorkspaceBindings)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, issueExecutionWorkspaceBindings.companyId),
          eq(issues.id, issueExecutionWorkspaceBindings.issueId),
          eq(issues.ownershipEpoch, issueExecutionWorkspaceBindings.ownershipEpoch),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(issues.updatedAt), desc(issueExecutionWorkspaceBindings.createdAt));
  }

  async function resolveCurrentBindingForWorkspace(
    executionWorkspaceId: string,
    companyId: string,
    issueId?: string | null,
  ): Promise<ExecutionWorkspaceCurrentBinding> {
    const bindings = await listCurrentBindingsForWorkspace(executionWorkspaceId, {
      companyId,
      ...(issueId ? { issueId } : {}),
    });
    if (bindings.length === 0) {
      throw unprocessable(
        issueId
          ? "Execution workspace is not bound to the issue's current ownership epoch"
          : "Execution workspace has no current ownership-epoch binding",
      );
    }
    if (!issueId && bindings.length > 1) {
      throw conflict(
        "Execution workspace has multiple current issue bindings; select the issue whose ownership epoch should be reconciled",
        {
          executionWorkspaceId,
          issueIds: bindings.map((binding) => binding.issueId),
        },
      );
    }
    return bindings[0]!;
  }

  function buildListConditions(
    companyId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) {
    const conditions = [eq(executionWorkspaces.companyId, companyId)];
    if (filters?.projectId) conditions.push(eq(executionWorkspaces.projectId, filters.projectId));
    if (filters?.projectWorkspaceId) {
      conditions.push(eq(executionWorkspaces.projectWorkspaceId, filters.projectWorkspaceId));
    }
    if (filters?.issueId) {
      conditions.push(
        exists(
          db
            .select({ id: issueExecutionWorkspaceBindings.id })
            .from(issueExecutionWorkspaceBindings)
            .innerJoin(
              issues,
              and(
                eq(issues.companyId, issueExecutionWorkspaceBindings.companyId),
                eq(issues.id, issueExecutionWorkspaceBindings.issueId),
                eq(issues.ownershipEpoch, issueExecutionWorkspaceBindings.ownershipEpoch),
              ),
            )
            .where(
              and(
                eq(issueExecutionWorkspaceBindings.companyId, companyId),
                eq(issueExecutionWorkspaceBindings.issueId, filters.issueId),
                eq(
                  issueExecutionWorkspaceBindings.executionWorkspaceId,
                  executionWorkspaces.id,
                ),
              ),
            ),
        ),
      );
    }
    if (filters?.status) {
      const statuses = filters.status.split(",").map((value) => value.trim()).filter(Boolean);
      if (statuses.length === 1) conditions.push(eq(executionWorkspaces.status, statuses[0]!));
      else if (statuses.length > 1) conditions.push(inArray(executionWorkspaces.status, statuses));
    }
    if (filters?.reuseEligible) {
      conditions.push(inArray(executionWorkspaces.status, ["active", "idle", "in_review"]));
      conditions.push(isNull(executionWorkspaces.closedAt));
    }
    return conditions;
  }

  return {
    list: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    }) => {
      const conditions = buildListConditions(companyId, filters);
      const rows = await db
        .select()
        .from(executionWorkspaces)
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
      const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, companyId, rows);
      return rows.map((row) =>
        toExecutionWorkspace(
          row,
          (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
        ),
      );
    },

    listSummaries: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    }) => {
      const conditions = buildListConditions(companyId, filters);
      const rows = await db
        .select({
          id: executionWorkspaces.id,
          name: executionWorkspaces.name,
          mode: executionWorkspaces.mode,
          status: executionWorkspaces.status,
          cwd: executionWorkspaces.cwd,
          branchName: executionWorkspaces.branchName,
          projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
          lastUsedAt: executionWorkspaces.lastUsedAt,
        })
        .from(executionWorkspaces)
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
      return rows.map((row) => toExecutionWorkspaceSummary(row));
    },

    findGitWorktreeContention: async (input: {
      companyId: string;
      worktreePath: string;
      liveBranchName: string | null;
      excludingExecutionWorkspaceId?: string | null;
    }): Promise<ExecutionWorkspaceGitWorktreeContention> => {
      const resolvedWorktreePath = path.resolve(input.worktreePath);
      const pathOrBranchConditions = [
        eq(executionWorkspaces.providerRef, input.worktreePath),
        eq(executionWorkspaces.cwd, input.worktreePath),
      ];
      if (input.liveBranchName) {
        pathOrBranchConditions.push(eq(executionWorkspaces.branchName, input.liveBranchName));
      }

      const candidates = await db
        .select({
          id: executionWorkspaces.id,
          cwd: executionWorkspaces.cwd,
          providerRef: executionWorkspaces.providerRef,
          branchName: executionWorkspaces.branchName,
        })
        .from(executionWorkspaces)
        .where(and(
          eq(executionWorkspaces.companyId, input.companyId),
          isNull(executionWorkspaces.closedAt),
          ne(executionWorkspaces.status, "archived"),
          input.excludingExecutionWorkspaceId
            ? ne(executionWorkspaces.id, input.excludingExecutionWorkspaceId)
            : sql`true`,
          or(...pathOrBranchConditions),
        ))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.updatedAt))
        .limit(20);

      for (const candidate of candidates) {
        const candidatePath = readNullableString(candidate.providerRef) ?? readNullableString(candidate.cwd);
        const matchesPath = candidatePath ? path.resolve(candidatePath) === resolvedWorktreePath : false;
        const matchesBranch = Boolean(input.liveBranchName && candidate.branchName === input.liveBranchName);
        if (!matchesPath && !matchesBranch) continue;

        const linkedIssueRows = await listCurrentBindingsForWorkspace(candidate.id, {
          companyId: input.companyId,
        });

        let activeRun: NonNullable<ExecutionWorkspaceGitWorktreeContention>["activeRun"] = null;
        const linkages = await resolveCurrentIssueOwnerRunLinkages(db, {
          companyId: input.companyId,
          issueIds: linkedIssueRows.map((issue) => issue.issueId),
        });
        const linkage = [...linkages.values()]
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
        if (linkage) {
          const issue = linkedIssueRows.find((row) => row.issueId === linkage.issueId) ?? null;
          activeRun = {
            id: linkage.runId,
            status: "running",
            issueId: issue?.issueId ?? null,
            issueIdentifier: issue?.issueIdentifier ?? null,
          };
        }

        const claimedIssue = activeRun?.issueId
          ? linkedIssueRows.find((issue) => issue.issueId === activeRun.issueId) ?? linkedIssueRows[0] ?? null
          : linkedIssueRows[0] ?? null;

        return {
          claimedByWorkspaceId: candidate.id,
          claimedByIssueId: claimedIssue?.issueId ?? null,
          claimedByIssueIdentifier: claimedIssue?.issueIdentifier ?? null,
          activeRun,
        };
      }

      return null;
    },

    listCurrentBindings: async (
      executionWorkspaceId: string,
      companyId?: string,
    ): Promise<ExecutionWorkspaceCurrentBinding[]> =>
      listCurrentBindingsForWorkspace(executionWorkspaceId, { companyId }),

    getCurrentForIssue: async (companyId: string, issueId: string) => {
      const binding = await db
        .select({
          executionWorkspaceId: issueExecutionWorkspaceBindings.executionWorkspaceId,
        })
        .from(issueExecutionWorkspaceBindings)
        .innerJoin(
          issues,
          and(
            eq(issues.companyId, issueExecutionWorkspaceBindings.companyId),
            eq(issues.id, issueExecutionWorkspaceBindings.issueId),
            eq(issues.ownershipEpoch, issueExecutionWorkspaceBindings.ownershipEpoch),
          ),
        )
        .where(
          and(
            eq(issueExecutionWorkspaceBindings.companyId, companyId),
            eq(issueExecutionWorkspaceBindings.issueId, issueId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!binding) return null;

      const row = await db
        .select()
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.companyId, companyId),
            eq(executionWorkspaces.id, binding.executionWorkspaceId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const runtimeServicesByWorkspaceId =
        await loadEffectiveRuntimeServicesByExecutionWorkspace(db, companyId, [row]);
      return toExecutionWorkspace(
        row,
        (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
      );
    },


    getById: async (id: string) => {
      const row = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, row.companyId, [row]);
      return toExecutionWorkspace(
        row,
        (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
      );
    },

    create: async (data: typeof executionWorkspaces.$inferInsert) => {
      const row = await db
        .insert(executionWorkspaces)
        .values(data)
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspace(row) : null;
    },

    update: async (id: string, patch: Partial<typeof executionWorkspaces.$inferInsert>) => {
      const row = await db
        .update(executionWorkspaces)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(executionWorkspaces.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspace(row) : null;
    },

    reconcileExecutionWorkspaceBranch: async (
      id: string,
      input: {
        mode: ExecutionWorkspaceBranchReconcileMode;
        issueId?: string | null;
        reason?: string | null;
        actor: ExecutionWorkspaceBranchReconcileActor;
      },
    ): Promise<ExecutionWorkspaceBranchReconcileResult> => {
      const existingRow = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existingRow) throw notFound("Execution workspace not found");

      const existing = toExecutionWorkspace(existingRow);
      const currentBinding = await resolveCurrentBindingForWorkspace(
        existing.id,
        existing.companyId,
        input.issueId,
      );

      const inspection = await inspectExecutionWorkspaceBranchForReconcile(
        existing,
        currentBinding.issueId,
      );
      if (input.mode === "forward" && inspection.ancestryVerdict !== "ancestor") {
        throw unprocessable(
          "Forward branch reconciliation requires the recorded branch to be an ancestor of the checked-out branch",
          { inspection },
        );
      }

      const reason = readNullableString(input.reason);
      const rescueRef = input.mode === "quarantine_restore"
        ? await (async () => {
            const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(
              db,
              existing.companyId,
              [existingRow],
            );
            assertBranchReconcileRuntimeServicesStopped({
              inspection,
              runtimeServices: (runtimeServicesByWorkspaceId.get(existing.id) ?? []).map(toRuntimeService),
            });
            // The git rescue has to happen before the DB transaction because the
            // transaction may be retried/rolled back, while git side effects cannot.
            // The preflight runtime-service guard above keeps known local services
            // from holding files open during the non-transactional git sequence.
            return quarantineRestoreDirtyWorkspaceBranch({
              db,
              workspace: existing,
              issueId: currentBinding.issueId,
              inspection,
              actor: input.actor,
            });
          })()
        : null;
      const now = new Date();
      const allowActiveWorkspace =
        input.mode === "forward" &&
        input.actor.actorType === "system" &&
        input.actor.actorId === "workspace_runtime" &&
        Boolean(input.actor.runId);
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        // Runtime-service activation takes this same row lock before spawning
        // local services and persists a `starting` row before releasing it.
        const lockedRow = await tx
          .select()
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.id, existing.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedRow) throw notFound("Execution workspace not found");

        const lockedBinding = await tx
          .select({
            id: issueExecutionWorkspaceBindings.id,
            companyId: issueExecutionWorkspaceBindings.companyId,
            issueId: issueExecutionWorkspaceBindings.issueId,
            sessionId: issueExecutionWorkspaceBindings.sessionId,
            ownershipEpoch: issueExecutionWorkspaceBindings.ownershipEpoch,
            executionWorkspaceId: issueExecutionWorkspaceBindings.executionWorkspaceId,
          })
          .from(issueExecutionWorkspaceBindings)
          .innerJoin(
            issues,
            and(
              eq(issues.companyId, issueExecutionWorkspaceBindings.companyId),
              eq(issues.id, issueExecutionWorkspaceBindings.issueId),
              eq(issues.ownershipEpoch, issueExecutionWorkspaceBindings.ownershipEpoch),
            ),
          )
          .where(
            and(
              eq(issueExecutionWorkspaceBindings.id, currentBinding.id),
              eq(issueExecutionWorkspaceBindings.companyId, lockedRow.companyId),
              eq(issueExecutionWorkspaceBindings.issueId, currentBinding.issueId),
              eq(issueExecutionWorkspaceBindings.executionWorkspaceId, lockedRow.id),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !lockedBinding
          || lockedBinding.sessionId !== currentBinding.sessionId
          || lockedBinding.ownershipEpoch !== currentBinding.ownershipEpoch
        ) {
          throw conflict(
            "Execution workspace ownership binding changed during branch reconciliation; retry with the current issue epoch",
            {
              executionWorkspaceId: lockedRow.id,
              issueId: currentBinding.issueId,
              ownershipEpoch: currentBinding.ownershipEpoch,
            },
          );
        }

        assertLockedBranchReconcileWorkspaceStillMatchesInspection({
          lockedRow,
          inspectedRow: existingRow,
          inspection,
        });

        if (usesInheritedProjectRuntimeServices(lockedRow)) {
          await tx
            .select({ id: projectWorkspaces.id })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, lockedRow.companyId),
                eq(projectWorkspaces.id, lockedRow.projectWorkspaceId!),
              ),
            )
            .for("update");
        }

        await tx
          .select({ id: workspaceRuntimeServices.id })
          .from(workspaceRuntimeServices)
          .where(
            usesInheritedProjectRuntimeServices(lockedRow)
              ? and(
                  eq(workspaceRuntimeServices.companyId, lockedRow.companyId),
                  eq(workspaceRuntimeServices.projectWorkspaceId, lockedRow.projectWorkspaceId!),
                  eq(workspaceRuntimeServices.scopeType, "project_workspace"),
                )
              : and(
                  eq(workspaceRuntimeServices.companyId, lockedRow.companyId),
                  eq(workspaceRuntimeServices.executionWorkspaceId, lockedRow.id),
                ),
          )
          .for("update");

        const lockedRuntimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(
          txDb,
          lockedRow.companyId,
          [lockedRow],
        );
        const lockedRuntimeServices = (lockedRuntimeServicesByWorkspaceId.get(lockedRow.id) ?? []).map(toRuntimeService);
        const lockedWorkspace = toExecutionWorkspace(lockedRow, lockedRuntimeServices);

        let updatedRow: ExecutionWorkspaceRow = lockedRow;
        if (input.mode !== "quarantine_restore") {
          assertBranchReconcileWorkspaceIsSafe({
            workspaceStatus: lockedWorkspace.status,
            inspection,
            runtimeServices: lockedRuntimeServices,
            allowActiveWorkspace,
          });
          if (lockedWorkspace.branchName !== inspection.fromBranch) {
            throw unprocessable("Execution workspace branch changed during reconciliation; retry with a fresh inspection", {
              workspaceBranch: lockedWorkspace.branchName,
              inspection,
            });
          }

          const updatePatch: Partial<typeof executionWorkspaces.$inferInsert> = {
            branchName: inspection.toBranch,
            updatedAt: now,
          };
          if (lockedWorkspace.name === inspection.fromBranch) {
            updatePatch.name = inspection.toBranch;
          }

          const [branchUpdatedRow] = await tx
            .update(executionWorkspaces)
            .set(updatePatch)
            .where(
              and(
                eq(executionWorkspaces.id, lockedWorkspace.id),
                allowActiveWorkspace
                  ? inArray(executionWorkspaces.status, ["idle", "active"])
                  : eq(executionWorkspaces.status, "idle"),
                eq(executionWorkspaces.branchName, inspection.fromBranch),
                noActiveRuntimeServicesForWorkspaceCondition(lockedRow),
              ),
            )
            .returning();
          if (!branchUpdatedRow) {
            const latestRuntimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(
              txDb,
              lockedRow.companyId,
              [lockedRow],
            );
            const latestRuntimeServices = (latestRuntimeServicesByWorkspaceId.get(lockedRow.id) ?? []).map(toRuntimeService);
            assertBranchReconcileWorkspaceIsSafe({
              workspaceStatus: lockedWorkspace.status,
              inspection,
              runtimeServices: latestRuntimeServices,
              allowActiveWorkspace,
            });
            throw unprocessable("Execution workspace branch reconciliation requires the workspace to stay idle with stopped runtime services during the update", {
              inspection,
            });
          }
          updatedRow = branchUpdatedRow;
        }

        let restoredSourceIssue: ExecutionWorkspaceBranchReconcileResult["restoredSourceIssue"] = null;
        let sourceIssueBoardPresentationStatusChanged = false;
        if (input.mode === "quarantine_restore") {
          const [sourceBefore] = await tx
            .select({
              id: issues.id,
              companyId: issues.companyId,
              boardPresentationStatus: issues.boardPresentationStatus,
              ownerKind: issues.ownerKind,
              ownerAgentId: issues.ownerAgentId,
              ownerUserId: issues.ownerUserId,
              executionPolicy: issues.executionPolicy,
              executionState: issues.executionState,
            })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, lockedBinding.companyId),
                eq(issues.id, lockedBinding.issueId),
                eq(issues.ownershipEpoch, lockedBinding.ownershipEpoch),
              ),
            )
            .for("update");
          if (!sourceBefore) throw notFound("Source issue not found");

          const requestedStatus = quarantineRestoreRequestedSourceStatus(sourceBefore);
          const policy = normalizeIssueExecutionPolicy(sourceBefore.executionPolicy ?? null);
          const transition = applyIssueExecutionPolicyTransition({
            issue: sourceBefore,
            policy,
            requestedStatus,
            requestedOwnerPatch: {},
            actor: {
              agentId: null,
              userId: input.actor.actorType === "user" ? input.actor.actorId : null,
            },
            commentBody: null,
          });
          const { issueService } = await import("./issues.js");
          const updatedIssue = await issueService(db).updateControlState(
            lockedBinding.issueId,
            {
              ...(requestedStatus
                ? { boardPresentationStatus: requestedStatus }
                : {}),
              ...transition.patch,
              actorAgentId: null,
              actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
            },
            tx,
          );
          if (!updatedIssue) throw notFound("Source issue not found");
          restoredSourceIssue = {
            id: updatedIssue.id,
            companyId: updatedIssue.companyId,
            boardPresentationStatus:
              updatedIssue.boardPresentationStatus,
            ownerAgentId: updatedIssue.ownerAgentId,
          };
          sourceIssueBoardPresentationStatusChanged =
            sourceBefore.boardPresentationStatus !==
            updatedIssue.boardPresentationStatus;
        }

        const auditNotice = await appendCanonicalControlNotice(db, {
          companyId: lockedWorkspace.companyId,
          issueId: lockedBinding.issueId,
          sourceKind: "workspace_branch_reconciled",
          immutableSourceKey: [inspection.fingerprint, input.mode].join(":"),
          sourceRecordId: inspection.fingerprint,
          exactText: formatBranchReconcileAuditComment({
            mode: input.mode,
            reason,
            workspaceId: existing.id,
            inspection,
            rescueRef,
          }),
          comment: input.actor.actorType === "user"
            ? {
                author: { kind: "user", userId: input.actor.actorId },
                producingRun: null,
              }
            : {
                author: { kind: "system", source: "control" },
                producingRun: null,
              },
          allowTerminal: true,
        }, tx);

        return {
          workspace: toExecutionWorkspace(updatedRow, lockedRuntimeServices),
          boundIssueId: lockedBinding.issueId,
          boundOwnershipEpoch: lockedBinding.ownershipEpoch,
          inspection,
          auditCommentId: auditNotice.comment?.id ?? null,
          rescueRef,
          restoredSourceIssue,
          sourceIssueBoardPresentationStatusChanged,
        };
      });
    },

  };
}

export { toExecutionWorkspace };
