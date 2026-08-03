import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, desc, eq, exists, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
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
  ExecutionWorkspaceCloseAction,
  ExecutionWorkspaceCloseGitReadiness,
  ExecutionWorkspaceCloseReadiness,
  ExecutionWorkspaceConfig,
  WorkspaceOverviewResponse,
  WorkspaceOverviewItem,
  WorkspaceOverviewLinkedIssue,
  WorkspaceRuntimeDesiredState,
  WorkspaceRuntimeService,
  WorkspaceOverviewPrimaryService,
  WorkspaceOverviewQuery,
  GitWorktreeBranchAncestryVerdict,
  ExecutionWorkspaceMode,
  IssueExecutionWorkspaceSettings,
} from "@paperclipai/shared";
import * as IssueSession from "@paperclipai/shared/issue-session";
import { deriveProjectUrlKey, WORKSPACE_OVERVIEW_LINKED_ISSUE_LIMIT } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "@paperclipai/shared/home-paths";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import {
  isUnrunnableWorktreeCombo,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
  type ParsedExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";
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

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
type RuntimeServiceReadDb = Pick<Db, "select">;
const execFileAsync = promisify(execFile);
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const WORKSPACE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";
const REUSABLE_WORKSPACE_STATUSES = ["active", "idle", "in_review"] as const;
const ISSUE_WORKSPACE_MODES = new Set<ExecutionWorkspaceMode>([
  "inherit",
  "shared_workspace",
  "isolated_workspace",
  "operator_branch",
  "reuse_existing",
  "agent_default",
]);

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

async function pathExists(value: string | null | undefined) {
  if (!value) return false;
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
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
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: true,
      persistForwardReconcile: false,
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

async function inspectGitCloseReadiness(workspace: ExecutionWorkspace): Promise<{
  git: ExecutionWorkspaceCloseGitReadiness | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const workspacePath = readNullableString(workspace.providerRef) ?? readNullableString(workspace.cwd);
  const createdByRuntime = workspace.metadata?.createdByRuntime === true;
  const expectsGitInspection =
    workspace.providerType === "git_worktree" ||
    Boolean(workspace.repoUrl || workspace.baseRef || workspace.branchName || workspacePath);

  if (!expectsGitInspection) {
    return { git: null, warnings };
  }

  if (!workspacePath) {
    warnings.push("Workspace has no local path, so Paperclip cannot inspect git status before close.");
    return { git: null, warnings };
  }

  if (!(await pathExists(workspacePath))) {
    warnings.push(`Workspace path "${workspacePath}" does not exist, so Paperclip cannot inspect git status before close.`);
    return {
      git: {
        repoRoot: null,
        workspacePath,
        branchName: workspace.branchName,
        baseRef: workspace.baseRef,
        hasDirtyTrackedFiles: false,
        hasUntrackedFiles: false,
        dirtyEntryCount: 0,
        untrackedEntryCount: 0,
        aheadCount: null,
        behindCount: null,
        isMergedIntoBase: null,
        createdByRuntime,
      },
      warnings,
    };
  }

  let repoRoot: string | null = null;
  try {
    repoRoot = (await runGit(["rev-parse", "--show-toplevel"], workspacePath)).stdout.trim() || null;
  } catch (error) {
    warnings.push(
      `Could not inspect git status for "${workspacePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let branchName = workspace.branchName;
  if (repoRoot && !branchName) {
    try {
      branchName = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)).stdout.trim() || null;
    } catch {
      branchName = workspace.branchName;
    }
  }

  let dirtyEntryCount = 0;
  let untrackedEntryCount = 0;
  if (repoRoot) {
    try {
      const statusOutput = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], workspacePath)).stdout;
      for (const line of statusOutput.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith("??")) {
          untrackedEntryCount += 1;
          continue;
        }
        dirtyEntryCount += 1;
      }
    } catch (error) {
      warnings.push(
        `Could not read git working tree status for "${workspacePath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let aheadCount: number | null = null;
  let behindCount: number | null = null;
  let isMergedIntoBase: boolean | null = null;
  const baseRef = workspace.baseRef;

  if (repoRoot && baseRef) {
    try {
      const counts = (await runGit(["rev-list", "--left-right", "--count", `${baseRef}...HEAD`], workspacePath)).stdout.trim();
      const [behindRaw, aheadRaw] = counts.split(/\s+/);
      behindCount = behindRaw ? Number.parseInt(behindRaw, 10) : 0;
      aheadCount = aheadRaw ? Number.parseInt(aheadRaw, 10) : 0;
    } catch (error) {
      warnings.push(
        `Could not compare this workspace against ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await runGit(["merge-base", "--is-ancestor", "HEAD", baseRef], workspacePath);
      isMergedIntoBase = true;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : null;
      if (code === 1) isMergedIntoBase = false;
      else {
        warnings.push(
          `Could not determine whether this workspace is merged into ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    git: {
      repoRoot,
      workspacePath,
      branchName,
      baseRef,
      hasDirtyTrackedFiles: dirtyEntryCount > 0,
      hasUntrackedFiles: untrackedEntryCount > 0,
      dirtyEntryCount,
      untrackedEntryCount,
      aheadCount,
      behindCount,
      isMergedIntoBase,
      createdByRuntime,
    },
    warnings,
  };
}

export function readExecutionWorkspaceConfig(metadata: Record<string, unknown> | null | undefined): ExecutionWorkspaceConfig | null {
  const raw = isRecord(metadata?.config) ? metadata.config : null;
  if (!raw) return null;

  const config: ExecutionWorkspaceConfig = {
    environmentId: readNullableString(raw.environmentId),
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
    environmentId: null,
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
    environmentId: patch.environmentId !== undefined ? readNullableString(patch.environmentId) : current.environmentId,
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
      environmentId: nextConfig.environmentId,
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

function maxDate(...values: Array<Date | string | null | undefined>): Date {
  let latest = new Date(0);
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime()) && date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

function toWorkspaceOverviewPrimaryService(
  service: WorkspaceRuntimeService | null,
): WorkspaceOverviewPrimaryService | null {
  if (!service) return null;
  return {
    id: service.id,
    serviceName: service.serviceName,
    status: service.status,
    url: service.url,
    port: service.port,
    healthStatus: service.healthStatus,
    updatedAt: service.updatedAt,
  };
}

function selectPrimaryOverviewService(services: WorkspaceRuntimeService[]) {
  return services.find((service) => service.status === "running" && service.url)
    ?? services.find((service) => service.url)
    ?? services.find((service) => service.status === "running")
    ?? services[0]
    ?? null;
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
  | "projectWorkspaceId"
  | "title"
  | "identifier"
  | "ownershipEpoch"
  | "ownerAgentId"
  | "executionWorkspacePreference"
  | "executionWorkspaceSettings"
>;

export interface ReserveIssueExecutionWorkspaceBindingInput {
  issue: WorkspaceReservationIssue;
  session: {
    id: string;
    parentSessionId?: string | null;
    now: Date;
  };
  explicitReusableWorkspaceId?: string | null;
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

function normalizedIssueWorkspacePreference(
  value: string | null,
): ExecutionWorkspaceMode | null {
  if (value === null || value === "") return null;
  if (!ISSUE_WORKSPACE_MODES.has(value as ExecutionWorkspaceMode)) {
    rejectWorkspaceReservation(
      "Issue execution workspace preference is invalid",
      "workspace_preference_invalid",
    );
  }
  return value as ExecutionWorkspaceMode;
}

function effectiveWorkspaceStrategy(
  mode: ParsedExecutionWorkspaceMode,
  issueSettings: IssueExecutionWorkspaceSettings | null,
  projectPolicy: ReturnType<typeof parseProjectExecutionWorkspacePolicy>,
  reuseRequested = false,
) {
  if (!reuseRequested && mode === "shared_workspace") {
    return "project_primary" as const;
  }
  if (!reuseRequested && mode === "agent_default") {
    return "adapter_managed" as const;
  }
  return resolveEffectiveWorkspaceStrategyType(mode, {
    workspaceStrategy:
      issueSettings?.workspaceStrategy ??
      projectPolicy?.workspaceStrategy ??
      undefined,
  });
}

function persistedStrategyMatches(
  persisted: string,
  expected: ReturnType<typeof effectiveWorkspaceStrategy>,
): boolean {
  if (expected === "project_primary") {
    return persisted === "local_fs" || persisted === "project_primary";
  }
  return persisted === expected;
}

function persistedModeForReservation(
  mode: ParsedExecutionWorkspaceMode,
): string {
  return mode === "agent_default" ? "adapter_managed" : mode;
}

function persistedStrategyForReservation(
  strategy: ReturnType<typeof effectiveWorkspaceStrategy>,
): string {
  return strategy === "project_primary" ? "local_fs" : strategy;
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

async function assertReusableWorkspaceLaunchable(
  workspace: ExecutionWorkspaceRow,
): Promise<void> {
  if (!workspace.cwd || !path.isAbsolute(workspace.cwd)) {
    rejectWorkspaceReservation(
      "Reusable execution workspace cwd must be absolute",
      "execution_workspace_cwd_invalid",
    );
  }
  const absoluteCwd = path.resolve(workspace.cwd);
  if (
    workspace.providerType === "adapter_managed" ||
    workspace.providerType === "cloud_sandbox"
  ) {
    await fs.mkdir(absoluteCwd, { recursive: true });
    return;
  }
  let directory = false;
  try {
    directory = (await fs.stat(absoluteCwd)).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) {
    rejectWorkspaceReservation(
      "Reusable execution workspace cwd is not an available directory",
      "execution_workspace_cwd_unavailable",
    );
  }
  if (workspace.strategyType !== "git_worktree") return;
  const insideWorktree = await readGitStdout(
    ["rev-parse", "--is-inside-work-tree"],
    absoluteCwd,
  ).catch(() => null);
  if (insideWorktree !== "true") {
    rejectWorkspaceReservation(
      "Reusable git-worktree workspace is not a valid Git checkout",
      "execution_workspace_git_invalid",
    );
  }
  if (workspace.branchName) {
    const currentBranch = await readGitStdout(
      ["branch", "--show-current"],
      absoluteCwd,
    ).catch(() => null);
    if (currentBranch !== workspace.branchName) {
      rejectWorkspaceReservation(
        "Reusable git-worktree workspace branch does not match its persisted branch",
        "execution_workspace_git_invalid",
      );
    }
  }
}

async function realizeReservationGitWorktree(
  tx: IssueSessionDbTransaction,
  input: ReserveIssueExecutionWorkspaceBindingInput,
  selectedProjectWorkspace: typeof projectWorkspaces.$inferSelect,
  workspaceStrategy: NonNullable<
    IssueExecutionWorkspaceSettings["workspaceStrategy"]
  >,
  mode: ParsedExecutionWorkspaceMode,
) {
  const baseCwd = absoluteProjectWorkspaceCwd(
    selectedProjectWorkspace.cwd,
  );
  if (!baseCwd) {
    rejectWorkspaceReservation(
      "Git worktree selection requires a project workspace with an absolute repository cwd",
      "workspace_worktree_base_missing",
    );
  }
  const owner = input.issue.ownerAgentId
    ? await tx
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, input.issue.companyId),
            eq(agents.id, input.issue.ownerAgentId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  const configuredBranchTemplate =
    workspaceStrategy.branchTemplate?.trim() ||
    "{{issue.identifier}}-{{slug}}";
  const epochScopedBranchTemplate =
    mode === "isolated_workspace"
      ? `${configuredBranchTemplate}-epoch-${input.issue.ownershipEpoch}`
      : configuredBranchTemplate;

  try {
    // workspace-runtime owns the existing, thoroughly validated git
    // realization primitive. The import stays dynamic because that module
    // consumes the execution-workspace read/service surface in this module;
    // reservation remains the sole mutating issue-binding owner.
    const { realizeExecutionWorkspace } =
      await import("./workspace-runtime.js");
    return await realizeExecutionWorkspace({
      db: tx as unknown as Db,
      base: {
        baseCwd,
        source: "project_primary",
        projectId: input.issue.projectId,
        workspaceId: selectedProjectWorkspace.id,
        repoUrl: selectedProjectWorkspace.repoUrl ?? null,
        repoRef:
          selectedProjectWorkspace.repoRef ??
          selectedProjectWorkspace.defaultRef ??
          null,
      },
      config: {
        workspaceStrategy: {
          ...workspaceStrategy,
          type: "git_worktree",
          branchTemplate: epochScopedBranchTemplate,
        },
      },
      issue: {
        id: input.issue.id,
        identifier: input.issue.identifier,
        title: input.issue.title,
      },
      agent: {
        id: owner?.id ?? input.issue.ownerAgentId,
        name: owner?.name ?? "Agent",
        companyId: input.issue.companyId,
      },
    });
  } catch (error) {
    rejectWorkspaceReservation(
      `Git worktree realization failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "execution_workspace_realization_failed",
    );
  }
}

function reservationWorkspaceMetadata(input: {
  issueSettings: IssueExecutionWorkspaceSettings | null;
  projectPolicy: ReturnType<
    typeof parseProjectExecutionWorkspacePolicy
  >;
  resolvedBaseRefSha?: string | null;
}): Record<string, unknown> | null {
  const strategy =
    input.issueSettings?.workspaceStrategy ??
    input.projectPolicy?.workspaceStrategy ??
    null;
  const seed = input.resolvedBaseRefSha
    ? {
        baseRefSnapshot: {
          resolvedSha: input.resolvedBaseRefSha,
        },
      }
    : null;
  return mergeExecutionWorkspaceConfig(seed, {
    environmentId:
      input.issueSettings?.environmentId ??
      input.projectPolicy?.environmentId ??
      null,
    provisionCommand: strategy?.provisionCommand ?? null,
    teardownCommand: strategy?.teardownCommand ?? null,
    cleanupCommand: null,
    workspaceRuntime:
      input.issueSettings?.workspaceRuntime ??
      input.projectPolicy?.workspaceRuntime ??
      null,
    desiredState: null,
    serviceStates: null,
  });
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
 * Selection is resolved from the issue's persisted intent on every ownership
 * epoch. Parent Sessions supply lineage only: neither a parent binding nor a
 * prior epoch cwd is an implicit workspace source.
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
    if (
      existingBinding.sessionId !== input.session.id ||
      (input.explicitReusableWorkspaceId &&
        existingBinding.executionWorkspaceId !==
          input.explicitReusableWorkspaceId)
    ) {
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

  const issueSettings = parseIssueExecutionWorkspaceSettings(
    input.issue.executionWorkspaceSettings,
    { includeEnvironmentId: true },
  );
  const issuePreference = normalizedIssueWorkspacePreference(
    input.issue.executionWorkspacePreference,
  );
  const reuseRequested =
    issuePreference === "reuse_existing" ||
    issueSettings?.mode === "reuse_existing";
  if (Boolean(input.explicitReusableWorkspaceId) !== reuseRequested) {
    rejectWorkspaceReservation(
      reuseRequested
        ? "reuse_existing requires an explicit execution workspace"
        : "An explicit execution workspace requires reuse_existing",
      reuseRequested
        ? "execution_workspace_missing"
        : "execution_workspace_preference_invalid",
    );
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
  const parsedProjectPolicy = parseProjectExecutionWorkspacePolicy(
    project?.executionWorkspacePolicy,
  );
  const projectPolicy = parsedProjectPolicy?.enabled
    ? parsedProjectPolicy
    : null;
  const mode = resolveExecutionWorkspaceMode({
    projectPolicy,
    issueSettings,
    issuePreference,
  });
  const strategy = effectiveWorkspaceStrategy(
    mode,
    issueSettings,
    projectPolicy,
    reuseRequested,
  );

  const selectedProjectWorkspaceId =
    input.issue.projectWorkspaceId ??
    projectPolicy?.defaultProjectWorkspaceId ??
    null;
  const selectedProjectWorkspace = input.issue.projectId
    ? await tx
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, input.issue.companyId),
            eq(projectWorkspaces.projectId, input.issue.projectId),
            selectedProjectWorkspaceId
              ? eq(projectWorkspaces.id, selectedProjectWorkspaceId)
              : sql`true`,
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
  if (selectedProjectWorkspaceId && !selectedProjectWorkspace) {
    rejectWorkspaceReservation(
      "Selected project workspace is not in the issue project",
      "project_workspace_invalid",
    );
  }

  let workspace: ExecutionWorkspaceRow;
  if (input.explicitReusableWorkspaceId) {
    const reusable = await tx
      .select()
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, input.issue.companyId),
          eq(
            executionWorkspaces.id,
            input.explicitReusableWorkspaceId,
          ),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !reusable ||
      !REUSABLE_WORKSPACE_STATUSES.includes(
        reusable.status as (typeof REUSABLE_WORKSPACE_STATUSES)[number],
      ) ||
      reusable.closedAt !== null ||
      reusable.projectId !== input.issue.projectId ||
      reusable.projectWorkspaceId !==
        (selectedProjectWorkspace?.id ?? null) ||
      !persistedStrategyMatches(reusable.strategyType, strategy) ||
      !reusable.cwd ||
      !path.isAbsolute(reusable.cwd)
    ) {
      rejectWorkspaceReservation(
        "Reusable execution workspace is not compatible with the issue selection",
        "execution_workspace_invalid",
      );
    }
    await assertReusableWorkspaceLaunchable(reusable);
    const refreshed = await tx
      .update(executionWorkspaces)
      .set({
        status: "active",
        lastUsedAt: input.session.now,
        updatedAt: input.session.now,
      })
      .where(eq(executionWorkspaces.id, reusable.id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!refreshed) {
      rejectWorkspaceReservation(
        "Reusable execution workspace could not be reserved",
        "execution_workspace_reservation_failed",
      );
    }
    workspace = refreshed;
  } else {
    if (
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: input.issue.projectId,
          projectWorkspaceId: selectedProjectWorkspace?.id ?? null,
        },
        resolvedMode: mode,
        resolvedStrategy: strategy,
        reusableExecutionWorkspaceAvailable: false,
      })
    ) {
      rejectWorkspaceReservation(
        "Projectless git worktree selection requires an explicit compatible reusable workspace",
        "workspace_worktree_requires_project",
      );
    }

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
    let absoluteCwd: string;
    let realizedBaseRef =
      issueSettings?.workspaceStrategy?.baseRef ??
      projectPolicy?.workspaceStrategy?.baseRef ??
      selectedProjectWorkspace?.repoRef ??
      selectedProjectWorkspace?.defaultRef ??
      null;
    let realizedBranchName: string | null = null;
    let realizedProviderRef: string | null = null;
    let metadata = reservationWorkspaceMetadata({
      issueSettings,
      projectPolicy,
    });
    if (strategy === "git_worktree") {
      const workspaceStrategy =
        issueSettings?.workspaceStrategy ??
        projectPolicy?.workspaceStrategy;
      if (
        !selectedProjectWorkspace ||
        workspaceStrategy?.type !== "git_worktree"
      ) {
        rejectWorkspaceReservation(
          "Git worktree selection has no explicit project workspace strategy",
          "workspace_worktree_base_missing",
        );
      }
      const realized = await realizeReservationGitWorktree(
        tx,
        input,
        selectedProjectWorkspace,
        workspaceStrategy,
        mode,
      );
      if (!path.isAbsolute(realized.cwd)) {
        rejectWorkspaceReservation(
          "Git worktree realization returned a non-absolute cwd",
          "execution_workspace_cwd_invalid",
        );
      }
      absoluteCwd = path.resolve(realized.cwd);
      realizedBaseRef = realized.repoRef;
      realizedBranchName = realized.branchName;
      realizedProviderRef = realized.worktreePath;
      metadata = reservationWorkspaceMetadata({
        issueSettings,
        projectPolicy,
        resolvedBaseRefSha: realized.baseRefSha,
      });
    } else {
      absoluteCwd =
        mode === "shared_workspace" && projectWorkspaceCwd
          ? projectWorkspaceCwd
          : perEpochRoot;
      await fs.mkdir(absoluteCwd, { recursive: true });
    }

    if (mode === "shared_workspace") {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${[
          "shared-execution-workspace",
          input.issue.companyId,
          input.issue.projectId ?? "global",
          selectedProjectWorkspace?.id ?? "projectless",
          absoluteCwd,
        ].join(":")}, 0))`,
      );
    }
    const reusableShared =
      mode === "shared_workspace"
        ? await tx
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
            .then((rows) => rows[0] ?? null)
        : null;
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
          mode: persistedModeForReservation(mode),
          strategyType: persistedStrategyForReservation(strategy),
          name:
            input.issue.title?.trim() ||
            input.issue.identifier?.trim() ||
            `Issue ${input.issue.id}`,
          status: "active",
          cwd: absoluteCwd,
          repoUrl: selectedProjectWorkspace?.repoUrl ?? null,
          baseRef: realizedBaseRef,
          branchName: realizedBranchName,
          providerType:
            strategy === "git_worktree"
              ? "git_worktree"
              : strategy === "adapter_managed"
                ? "adapter_managed"
                : strategy === "cloud_sandbox"
                  ? "cloud_sandbox"
                  : "local_fs",
          providerRef: realizedProviderRef,
          metadata,
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
      environmentSelector: issueSettings?.environmentId ?? null,
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

type WorkspaceOverviewPageRow = ExecutionWorkspaceRow & {
  projectName: string | null;
  projectWorkspaceMetadata: Record<string, unknown> | null;
};

type WorkspaceOverviewIssueRow = WorkspaceOverviewLinkedIssue & {
  executionWorkspaceId: string;
};

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
      conditions.push(inArray(executionWorkspaces.mode, ["isolated_workspace", "operator_branch", "adapter_managed", "cloud_sandbox"]));
    }
    return conditions;
  }

  function buildOverviewConditions(companyId: string, filters: WorkspaceOverviewQuery) {
    const conditions = [
      eq(executionWorkspaces.companyId, companyId),
      or(
        isNull(executionWorkspaces.projectId),
        exists(
          db
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.companyId, companyId),
                eq(projects.id, executionWorkspaces.projectId),
              ),
            ),
        ),
      )!,
    ];
    if (filters.projectId) conditions.push(eq(executionWorkspaces.projectId, filters.projectId));
    if (filters.status && filters.status.length > 0) {
      if (filters.status.length === 1) conditions.push(eq(executionWorkspaces.status, filters.status[0]!));
      else conditions.push(inArray(executionWorkspaces.status, filters.status));
    } else {
      conditions.push(ne(executionWorkspaces.status, "archived"));
    }
    return conditions;
  }

  return {
    listOverview: async (
      companyId: string,
      filters: WorkspaceOverviewQuery,
    ): Promise<WorkspaceOverviewResponse> => {
      const conditions = buildOverviewConditions(companyId, filters);
      const whereClause = and(...conditions);

      const [totalRow, rows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(executionWorkspaces)
          .leftJoin(
            projects,
            and(
              eq(projects.id, executionWorkspaces.projectId),
              eq(projects.companyId, companyId),
            ),
          )
          .where(whereClause)
          .then((result) => result[0] ?? { count: 0 }),
        db
          .select({
            id: executionWorkspaces.id,
            companyId: executionWorkspaces.companyId,
            projectId: executionWorkspaces.projectId,
            projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
            sourceIssueId: executionWorkspaces.sourceIssueId,
            mode: executionWorkspaces.mode,
            strategyType: executionWorkspaces.strategyType,
            name: executionWorkspaces.name,
            status: executionWorkspaces.status,
            cwd: executionWorkspaces.cwd,
            repoUrl: executionWorkspaces.repoUrl,
            baseRef: executionWorkspaces.baseRef,
            branchName: executionWorkspaces.branchName,
            providerType: executionWorkspaces.providerType,
            providerRef: executionWorkspaces.providerRef,
            derivedFromExecutionWorkspaceId: executionWorkspaces.derivedFromExecutionWorkspaceId,
            lastUsedAt: executionWorkspaces.lastUsedAt,
            openedAt: executionWorkspaces.openedAt,
            closedAt: executionWorkspaces.closedAt,
            cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
            cleanupReason: executionWorkspaces.cleanupReason,
            metadata: executionWorkspaces.metadata,
            createdAt: executionWorkspaces.createdAt,
            updatedAt: executionWorkspaces.updatedAt,
            projectName: projects.name,
            projectWorkspaceMetadata: projectWorkspaces.metadata,
          })
          .from(executionWorkspaces)
          .leftJoin(
            projects,
            and(
              eq(projects.id, executionWorkspaces.projectId),
              eq(projects.companyId, companyId),
            ),
          )
          .leftJoin(
            projectWorkspaces,
            and(
              eq(projectWorkspaces.id, executionWorkspaces.projectWorkspaceId),
              eq(projectWorkspaces.companyId, companyId),
            ),
          )
          .where(whereClause)
          .orderBy(
            desc(executionWorkspaces.lastUsedAt),
            desc(executionWorkspaces.updatedAt),
            asc(executionWorkspaces.id),
          )
          .limit(filters.limit)
          .offset(filters.offset),
      ]);

      const pageRows = rows as WorkspaceOverviewPageRow[];
      if (pageRows.length === 0) {
        return {
          items: [],
          total: totalRow.count,
          limit: filters.limit,
          offset: filters.offset,
          hasMore: false,
          nextOffset: null,
        };
      }

      const workspaceIds = pageRows.map((row) => row.id);
      const [runtimeServicesByWorkspaceId, linkedIssueCountRows, linkedIssueRows] = await Promise.all([
        loadEffectiveRuntimeServicesByExecutionWorkspace(db, companyId, pageRows),
        db
          .select({
            executionWorkspaceId: issueExecutionWorkspaceBindings.executionWorkspaceId,
            count: sql<number>`count(*)::int`,
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
              eq(issues.companyId, companyId),
              visibleIssueCondition(),
              inArray(issueExecutionWorkspaceBindings.executionWorkspaceId, workspaceIds),
            ),
          )
          .groupBy(issueExecutionWorkspaceBindings.executionWorkspaceId),
        db.execute(sql`
          select
            ranked.execution_workspace_id as "executionWorkspaceId",
            ranked.id,
            ranked.identifier,
            ranked.title,
            ranked.board_presentation_status as "boardPresentationStatus",
            ranked.priority,
            ranked.updated_at as "updatedAt"
          from (
            select
              ${issueExecutionWorkspaceBindings.executionWorkspaceId} as execution_workspace_id,
              ${issues.id} as id,
              ${issues.identifier} as identifier,
              ${issues.title} as title,
              ${issues.boardPresentationStatus} as board_presentation_status,
              ${issues.priority} as priority,
              ${issues.updatedAt} as updated_at,
              row_number() over (
                partition by ${issueExecutionWorkspaceBindings.executionWorkspaceId}
                order by ${issues.updatedAt} desc, ${issues.id} asc
              ) as row_number
            from ${issueExecutionWorkspaceBindings}
            inner join ${issues}
              on ${issues.companyId} = ${issueExecutionWorkspaceBindings.companyId}
             and ${issues.id} = ${issueExecutionWorkspaceBindings.issueId}
             and ${issues.ownershipEpoch} = ${issueExecutionWorkspaceBindings.ownershipEpoch}
            where ${issueExecutionWorkspaceBindings.companyId} = ${companyId}
              and ${issues.hiddenAt} is null
              and ${issueExecutionWorkspaceBindings.executionWorkspaceId} in (${sql.join(workspaceIds.map((id) => sql`${id}`), sql`, `)})
          ) ranked
          where ranked.row_number <= ${WORKSPACE_OVERVIEW_LINKED_ISSUE_LIMIT}
          order by ranked.execution_workspace_id asc, ranked.row_number asc
        `),
      ]);

      const linkedIssueCountByWorkspaceId = new Map(
        linkedIssueCountRows
          .filter((row) => row.executionWorkspaceId)
          .map((row) => [row.executionWorkspaceId!, row.count]),
      );
      const linkedIssuesByWorkspaceId = new Map<string, WorkspaceOverviewLinkedIssue[]>();
      for (const issue of linkedIssueRows as unknown as WorkspaceOverviewIssueRow[]) {
        const existing = linkedIssuesByWorkspaceId.get(issue.executionWorkspaceId) ?? [];
        existing.push({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          boardPresentationStatus: issue.boardPresentationStatus,
          priority: issue.priority,
          updatedAt: issue.updatedAt,
        });
        linkedIssuesByWorkspaceId.set(issue.executionWorkspaceId, existing);
      }

      const items: WorkspaceOverviewItem[] = pageRows.map((row) => {
        const runtimeServices = (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService);
        const runningServiceCount = runtimeServices.filter((service) => service.status === "running").length;
        const primaryService = selectPrimaryOverviewService(runtimeServices);
        const config = readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null);
        const inheritedProjectRuntimeConfig = usesInheritedProjectRuntimeServices(row)
          ? readProjectWorkspaceRuntimeConfig(row.projectWorkspaceMetadata)
          : null;
        const linkedIssues = linkedIssuesByWorkspaceId.get(row.id) ?? [];
        const primaryServiceSummary = toWorkspaceOverviewPrimaryService(primaryService);

        return {
          key: `execution:${row.id}`,
          kind: "execution_workspace",
          workspaceId: row.id,
          workspaceName: row.name,
          projectId: row.projectId,
          projectUrlKey:
            row.projectId && row.projectName
              ? deriveProjectUrlKey(row.projectName, row.projectId)
              : null,
          projectName: row.projectName,
          mode: row.mode as WorkspaceOverviewItem["mode"],
          strategyType: row.strategyType as WorkspaceOverviewItem["strategyType"],
          cwd: row.cwd ?? null,
          branchName: row.branchName ?? row.baseRef ?? null,
          lastUpdatedAt: maxDate(
            row.lastUsedAt,
            row.updatedAt,
            linkedIssues[0]?.updatedAt,
            primaryServiceSummary?.updatedAt,
          ),
          projectWorkspaceId: row.projectWorkspaceId ?? null,
          executionWorkspaceId: row.id,
          executionWorkspaceStatus: row.status as WorkspaceOverviewItem["executionWorkspaceStatus"],
          serviceCount: runtimeServices.length,
          runningServiceCount,
          primaryServiceUrl: primaryService?.url ?? null,
          primaryServiceUrlRunning: primaryService?.status === "running",
          primaryService: primaryServiceSummary,
          hasRuntimeConfig: Boolean(config?.workspaceRuntime ?? inheritedProjectRuntimeConfig?.workspaceRuntime),
          linkedIssueCount: linkedIssueCountByWorkspaceId.get(row.id) ?? 0,
          linkedIssues,
        };
      });

      const nextOffset = filters.offset + items.length;
      const total = totalRow.count;
      return {
        items,
        total,
        limit: filters.limit,
        offset: filters.offset,
        hasMore: nextOffset < total,
        nextOffset: nextOffset < total ? nextOffset : null,
      };
    },

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

    getCloseReadiness: async (id: string): Promise<ExecutionWorkspaceCloseReadiness | null> => {
      const workspace = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!workspace) return null;

      const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, workspace.companyId, [workspace]);
      const runtimeServices = (runtimeServicesByWorkspaceId.get(workspace.id) ?? []).map(toRuntimeService);

      const [linkedIssues, bindingCountRow] = await Promise.all([
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            boardPresentationStatus: issues.boardPresentationStatus,
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
              eq(issueExecutionWorkspaceBindings.companyId, workspace.companyId),
              eq(issueExecutionWorkspaceBindings.executionWorkspaceId, workspace.id),
            ),
          ),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(issueExecutionWorkspaceBindings)
          .where(
            and(
              eq(issueExecutionWorkspaceBindings.companyId, workspace.companyId),
              eq(issueExecutionWorkspaceBindings.executionWorkspaceId, workspace.id),
            ),
          )
          .then((rows) => rows[0] ?? { count: 0 }),
      ]);

      const projectWorkspace = workspace.projectWorkspaceId
        ? await db
            .select({
              id: projectWorkspaces.id,
              cwd: projectWorkspaces.cwd,
              cleanupCommand: projectWorkspaces.cleanupCommand,
              isPrimary: projectWorkspaces.isPrimary,
            })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, workspace.companyId),
                eq(projectWorkspaces.id, workspace.projectWorkspaceId),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;

      const primaryProjectWorkspace = workspace.projectId
        ? await db
            .select({
              id: projectWorkspaces.id,
            })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, workspace.companyId),
                eq(projectWorkspaces.projectId, workspace.projectId),
                eq(projectWorkspaces.isPrimary, true),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;

      const projectPolicy = workspace.projectId
        ? await db
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, workspace.projectId), eq(projects.companyId, workspace.companyId)))
            .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
        : null;

      const executionWorkspace = toExecutionWorkspace(workspace, runtimeServices);
      const config = readExecutionWorkspaceConfig((workspace.metadata as Record<string, unknown> | null) ?? null);
      const { git, warnings: gitWarnings } = await inspectGitCloseReadiness(executionWorkspace);
      const warnings = [...gitWarnings];
      const blockingReasons: string[] = [];
      const isSharedWorkspace = executionWorkspace.mode === "shared_workspace";
      const workspacePath = readNullableString(executionWorkspace.providerRef) ?? readNullableString(executionWorkspace.cwd);
      const resolvedWorkspacePath = workspacePath ? path.resolve(workspacePath) : null;
      const resolvedPrimaryWorkspacePath = projectWorkspace?.cwd ? path.resolve(projectWorkspace.cwd) : null;
      const isProjectPrimaryWorkspace =
        workspace.projectWorkspaceId != null
        && workspace.projectWorkspaceId === primaryProjectWorkspace?.id
        && resolvedWorkspacePath != null
        && resolvedPrimaryWorkspacePath != null
        && resolvedWorkspacePath === resolvedPrimaryWorkspacePath;

      const linkedIssueSummaries = linkedIssues.map((issue) => ({
        ...issue,
        isTerminal: TERMINAL_ISSUE_STATUSES.has(issue.boardPresentationStatus),
      }));

      const blockingIssues = linkedIssueSummaries.filter((issue) => !issue.isTerminal);
      if (isSharedWorkspace && bindingCountRow.count > 0) {
        blockingReasons.push(
          bindingCountRow.count === 1
            ? "This shared workspace still has an ownership-epoch binding and cannot be archived or cleaned up."
            : `This shared workspace still has ${bindingCountRow.count} ownership-epoch bindings and cannot be archived or cleaned up.`,
        );
      } else if (blockingIssues.length > 0) {
        const linkedIssueMessage =
          blockingIssues.length === 1
            ? "This workspace is still linked to an open issue."
            : `This workspace is still linked to ${blockingIssues.length} open issues.`;
        blockingReasons.push(linkedIssueMessage);
      }

      if (isSharedWorkspace && bindingCountRow.count === 0) {
        warnings.push("This shared workspace session points at project workspace infrastructure. Archiving it only removes the session record.");
      }

      if (runtimeServices.some((service) => service.status !== "stopped")) {
        warnings.push(
          runtimeServices.length === 1
            ? "Closing this workspace will stop 1 attached runtime service."
            : `Closing this workspace will stop ${runtimeServices.length} attached runtime services.`,
        );
      }

      if (git?.hasDirtyTrackedFiles) {
        warnings.push(
          git.dirtyEntryCount === 1
            ? "The workspace has 1 modified tracked file."
            : `The workspace has ${git.dirtyEntryCount} modified tracked files.`,
        );
      }
      if (git?.hasUntrackedFiles) {
        warnings.push(
          git.untrackedEntryCount === 1
            ? "The workspace has 1 untracked file."
            : `The workspace has ${git.untrackedEntryCount} untracked files.`,
        );
      }
      if (git?.aheadCount && git.aheadCount > 0 && git.isMergedIntoBase === false) {
        warnings.push(
          git.aheadCount === 1
            ? `This workspace is 1 commit ahead of ${git.baseRef ?? "the base ref"} and is not merged.`
            : `This workspace is ${git.aheadCount} commits ahead of ${git.baseRef ?? "the base ref"} and is not merged.`,
        );
      }
      if (git?.behindCount && git.behindCount > 0) {
        warnings.push(
          git.behindCount === 1
            ? `This workspace is 1 commit behind ${git.baseRef ?? "the base ref"}.`
            : `This workspace is ${git.behindCount} commits behind ${git.baseRef ?? "the base ref"}.`,
        );
      }

      const plannedActions: ExecutionWorkspaceCloseAction[] = [
        {
          kind: "archive_record",
          label: "Archive workspace record",
          description: "Keep the execution workspace history and issue linkage, but remove it from active workspace lists.",
          command: null,
        },
      ];

      if (runtimeServices.some((service) => service.status !== "stopped")) {
        plannedActions.push({
          kind: "stop_runtime_services",
          label: runtimeServices.length === 1 ? "Stop attached runtime service" : "Stop attached runtime services",
          description:
            runtimeServices.length === 1
              ? `${runtimeServices[0]?.serviceName ?? "A runtime service"} will be stopped before cleanup.`
              : `${runtimeServices.length} runtime services will be stopped before cleanup.`,
          command: null,
        });
      }

      const configuredCleanupCommands = [
        {
          kind: "cleanup_command" as const,
          label: "Run workspace cleanup command",
          description: "Workspace-specific cleanup runs before teardown.",
          command: config?.cleanupCommand ?? null,
        },
        {
          kind: "cleanup_command" as const,
          label: "Run project workspace cleanup command",
          description: "Project workspace cleanup runs before execution workspace teardown.",
          command: projectWorkspace?.cleanupCommand ?? null,
        },
      ];
      for (const action of configuredCleanupCommands) {
        if (!action.command) continue;
        plannedActions.push(action);
      }

      const teardownCommand = config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null;
      if (teardownCommand) {
        plannedActions.push({
          kind: "teardown_command",
          label: "Run teardown command",
          description: "Teardown runs after cleanup commands during workspace close.",
          command: teardownCommand,
        });
      }

      if (executionWorkspace.providerType === "git_worktree" && workspacePath) {
        plannedActions.push({
          kind: "git_worktree_remove",
          label: "Remove git worktree",
          description: `Paperclip will run git worktree cleanup for ${workspacePath}.`,
          command: `git worktree remove --force ${workspacePath}`,
        });
      }

      if (git?.createdByRuntime && executionWorkspace.branchName) {
        plannedActions.push({
          kind: "git_branch_delete",
          label: "Delete runtime-created branch",
          description: "Paperclip will try to delete the runtime-created branch after removing the worktree.",
          command: `git branch -d ${executionWorkspace.branchName}`,
        });
      }

      if (executionWorkspace.providerType === "local_fs" && git?.createdByRuntime && workspacePath) {
        const resolvedWorkspacePath = path.resolve(workspacePath);
        const resolvedProjectWorkspacePath = projectWorkspace?.cwd ? path.resolve(projectWorkspace.cwd) : null;
        const containsProjectWorkspace = resolvedProjectWorkspacePath
          ? (
              resolvedWorkspacePath === resolvedProjectWorkspacePath ||
              resolvedProjectWorkspacePath.startsWith(`${resolvedWorkspacePath}${path.sep}`)
            )
          : false;
        if (containsProjectWorkspace) {
          warnings.push(`Paperclip will archive this workspace but keep "${workspacePath}" because it contains the project workspace.`);
        } else {
          plannedActions.push({
            kind: "remove_local_directory",
            label: "Remove runtime-created directory",
            description: `Paperclip will remove the runtime-created directory at ${workspacePath}.`,
            command: `rm -rf ${workspacePath}`,
          });
        }
      }

      const state =
        blockingReasons.length > 0
          ? "blocked"
          : warnings.length > 0
            ? "ready_with_warnings"
            : "ready";

      return {
        workspaceId: workspace.id,
        state,
        blockingReasons,
        warnings,
        linkedIssues: linkedIssueSummaries,
        plannedActions,
        isDestructiveCloseAllowed: blockingReasons.length === 0,
        isSharedWorkspace,
        isProjectPrimaryWorkspace,
        git,
        runtimeServices,
      };
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
              monitorNextCheckAt: issues.monitorNextCheckAt,
              monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
              monitorAttemptCount: issues.monitorAttemptCount,
              monitorNotes: issues.monitorNotes,
              monitorScheduledBy: issues.monitorScheduledBy,
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
            previousPolicy: policy,
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

    clearEnvironmentSelection: async (companyId: string, environmentId: string) => {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: executionWorkspaces.id,
            metadata: executionWorkspaces.metadata,
          })
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.companyId, companyId));

        let cleared = 0;
        const updatedAt = new Date();
        for (const row of rows) {
          const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
          const config = readExecutionWorkspaceConfig(metadata);
          if (config?.environmentId !== environmentId) continue;

          await tx
            .update(executionWorkspaces)
            .set({
              metadata: mergeExecutionWorkspaceConfig(metadata, { environmentId: null }),
              updatedAt,
            })
            .where(eq(executionWorkspaces.id, row.id));
          cleared += 1;
        }

        return cleared;
      });
    },
  };
}

export { toExecutionWorkspace };
