import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  issueExecutionWorkspaceBindings,
  issueSessionContextEpochs,
  issueSessions,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import type {
  ExecutionWorkspace,
  GitWorktreeBranchAncestryVerdict,
} from "@paperclipai/shared";
import * as IssueSession from "@paperclipai/shared/issue-session";
import { resolvePaperclipInstanceRoot } from "@paperclipai/shared/home-paths";
import { conflict, notFound, unprocessable } from "../errors.js";
import { appendCanonicalControlNotice } from "./issue-session-producers.js";
import { resolveCurrentIssueOwnerRunLinkages } from "./productive-run-linkage.js";
import { createIssueSessionRootInTx } from "./issue-session-root-postgres.js";
import {
  reserveIssueSessionEventSequence,
  type IssueSessionDbTransaction,
} from "./issue-session/event-store.js";
import { publishIssueSessionEventInTx } from "./issue-session/publication.js";

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
const execFileAsync = promisify(execFile);
const WORKSPACE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";

export type ExecutionWorkspaceBranchReconcileMode = "forward";

export type ExecutionWorkspaceBranchReconcileActor = {
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

type ExecutionWorkspaceCurrentBinding = {
  id: string;
  companyId: string;
  issueId: string;
  sessionId: string;
  ownershipEpoch: number;
  executionWorkspaceId: string;
  absoluteCwd: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueStatus: string;
  issueUpdatedAt: Date;
};

function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  workspace: Pick<ExecutionWorkspace, "id" | "cwd" | "branchName">,
  issueId: string,
): Promise<ExecutionWorkspaceBranchReconcileInspection> {
  const fromBranch = readNullableString(workspace.branchName);
  if (!fromBranch) {
    throw unprocessable("Execution workspace has no recorded branch to reconcile");
  }

  // Ordinary shared folders leave branchName null. A non-null recorded branch
  // is the explicit opt-in metadata for the retained reconciliation safeguard.
  const worktreePath = workspace.cwd;

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
    ...(input.reason ? [`- Operator reason: ${input.reason}`] : []),
  ].join("\n");
}

function assertBranchReconcileWorkspaceIsSafe(input: {
  inspection: ExecutionWorkspaceBranchReconcileInspection;
}) {
  if (input.inspection.cleanliness !== "clean") {
    throw unprocessable("Execution workspace branch reconciliation requires a clean worktree", {
      inspection: input.inspection,
    });
  }

}

function assertLockedBranchReconcileWorkspaceStillMatchesInspection(input: {
  lockedRow: ExecutionWorkspaceRow;
  inspectedRow: ExecutionWorkspaceRow;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
}) {
  const lockedPath = readNullableString(input.lockedRow.cwd);
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
        projectWorkspaceId: input.inspectedRow.projectWorkspaceId,
        branchName: input.inspection.fromBranch,
        worktreePath: input.inspection.worktreePath,
      },
      current: {
        projectWorkspaceId: input.lockedRow.projectWorkspaceId,
        branchName: lockedBranch,
        worktreePath: currentPath,
      },
    });
  }
}

function toExecutionWorkspace(
  row: ExecutionWorkspaceRow,
): ExecutionWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    cwd: row.cwd,
    repoUrl: row.repoUrl ?? null,
    branchName: row.branchName ?? null,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
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
  const selectedProjectWorkspaceId = input.issue.projectWorkspaceId ?? null;
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
                eq(executionWorkspaces.cwd, absoluteCwd),
              ),
            )
            .orderBy(asc(executionWorkspaces.createdAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);
    if (reusableShared) {
      workspace = await tx
        .update(executionWorkspaces)
        .set({
          lastUsedAt: input.session.now,
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
          cwd: absoluteCwd,
          repoUrl: selectedProjectWorkspace?.repoUrl ?? null,
          branchName: null,
          lastUsedAt: input.session.now,
          createdAt: input.session.now,
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
      absoluteCwd,
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
    options: { companyId?: string; issueId?: string } = {},
  ): Promise<ExecutionWorkspaceCurrentBinding[]> {
    const conditions = [
      eq(
        issueExecutionWorkspaceBindings.executionWorkspaceId,
        executionWorkspaceId,
      ),
      eq(issueExecutionWorkspaceBindings.companyId, issues.companyId),
      eq(issueExecutionWorkspaceBindings.issueId, issues.id),
      eq(
        issueExecutionWorkspaceBindings.ownershipEpoch,
        issues.ownershipEpoch,
      ),
    ];
    if (options.companyId) {
      conditions.push(
        eq(issueExecutionWorkspaceBindings.companyId, options.companyId),
      );
    }
    if (options.issueId) {
      conditions.push(
        eq(issueExecutionWorkspaceBindings.issueId, options.issueId),
      );
    }

    return db
      .select({
        id: issueExecutionWorkspaceBindings.id,
        companyId: issueExecutionWorkspaceBindings.companyId,
        issueId: issueExecutionWorkspaceBindings.issueId,
        sessionId: issueExecutionWorkspaceBindings.sessionId,
        ownershipEpoch: issueExecutionWorkspaceBindings.ownershipEpoch,
        executionWorkspaceId:
          issueExecutionWorkspaceBindings.executionWorkspaceId,
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
          eq(
            issues.ownershipEpoch,
            issueExecutionWorkspaceBindings.ownershipEpoch,
          ),
        ),
      )
      .where(and(...conditions))
      .orderBy(
        desc(issues.updatedAt),
        desc(issueExecutionWorkspaceBindings.createdAt),
      );
  }

  async function resolveCurrentBindingForWorkspace(
    executionWorkspaceId: string,
    companyId: string,
    issueId?: string | null,
  ): Promise<ExecutionWorkspaceCurrentBinding> {
    const bindings = await listCurrentBindingsForWorkspace(
      executionWorkspaceId,
      {
        companyId,
        ...(issueId ? { issueId } : {}),
      },
    );
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

  return {
    findGitWorktreeContention: async (input: {
      companyId: string;
      worktreePath: string;
      liveBranchName: string | null;
      excludingExecutionWorkspaceId?: string | null;
    }): Promise<ExecutionWorkspaceGitWorktreeContention> => {
      const resolvedWorktreePath = path.resolve(input.worktreePath);
      const pathOrBranchConditions = [
        eq(executionWorkspaces.cwd, input.worktreePath),
      ];
      if (input.liveBranchName) {
        pathOrBranchConditions.push(
          eq(executionWorkspaces.branchName, input.liveBranchName),
        );
      }

      const candidates = await db
        .select({
          id: executionWorkspaces.id,
          cwd: executionWorkspaces.cwd,
          branchName: executionWorkspaces.branchName,
        })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.companyId, input.companyId),
            input.excludingExecutionWorkspaceId
              ? ne(
                  executionWorkspaces.id,
                  input.excludingExecutionWorkspaceId,
                )
              : sql`true`,
            or(...pathOrBranchConditions),
          ),
        )
        .orderBy(
          desc(executionWorkspaces.lastUsedAt),
          desc(executionWorkspaces.createdAt),
        )
        .limit(20);

      for (const candidate of candidates) {
        const matchesPath = path.resolve(candidate.cwd) === resolvedWorktreePath;
        const matchesBranch = Boolean(
          input.liveBranchName &&
            candidate.branchName === input.liveBranchName,
        );
        if (!matchesPath && !matchesBranch) continue;

        const linkedIssues = await listCurrentBindingsForWorkspace(
          candidate.id,
          { companyId: input.companyId },
        );
        if (linkedIssues.length === 0) continue;

        const linkages = await resolveCurrentIssueOwnerRunLinkages(db, {
          companyId: input.companyId,
          issueIds: linkedIssues.map((issue) => issue.issueId),
        });
        const linkage =
          [...linkages.values()].sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime(),
          )[0] ?? null;
        const activeIssue = linkage
          ? linkedIssues.find((issue) => issue.issueId === linkage.issueId) ??
            null
          : null;
        const claimedIssue = activeIssue ?? linkedIssues[0]!;

        return {
          claimedByWorkspaceId: candidate.id,
          claimedByIssueId: claimedIssue.issueId,
          claimedByIssueIdentifier: claimedIssue.issueIdentifier,
          activeRun: linkage
            ? {
                id: linkage.runId,
                status: "running",
                issueId: activeIssue?.issueId ?? null,
                issueIdentifier: activeIssue?.issueIdentifier ?? null,
              }
            : null,
        };
      }

      return null;
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
        .limit(1)
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
      if (inspection.fromBranch === inspection.toBranch) {
        throw unprocessable(
          "Execution workspace already records the checked-out branch",
          { inspection },
        );
      }
      if (inspection.ancestryVerdict !== "ancestor") {
        throw unprocessable(
          "Forward branch reconciliation requires the recorded branch to be an ancestor of the checked-out branch",
          { inspection },
        );
      }
      assertBranchReconcileWorkspaceIsSafe({ inspection });

      const reason = readNullableString(input.reason);
      return db.transaction(async (tx) => {
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
            executionWorkspaceId:
              issueExecutionWorkspaceBindings.executionWorkspaceId,
          })
          .from(issueExecutionWorkspaceBindings)
          .innerJoin(
            issues,
            and(
              eq(issues.companyId, issueExecutionWorkspaceBindings.companyId),
              eq(issues.id, issueExecutionWorkspaceBindings.issueId),
              eq(
                issues.ownershipEpoch,
                issueExecutionWorkspaceBindings.ownershipEpoch,
              ),
            ),
          )
          .where(
            and(
              eq(issueExecutionWorkspaceBindings.id, currentBinding.id),
              eq(
                issueExecutionWorkspaceBindings.companyId,
                lockedRow.companyId,
              ),
              eq(
                issueExecutionWorkspaceBindings.issueId,
                currentBinding.issueId,
              ),
              eq(
                issueExecutionWorkspaceBindings.executionWorkspaceId,
                lockedRow.id,
              ),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !lockedBinding ||
          lockedBinding.sessionId !== currentBinding.sessionId ||
          lockedBinding.ownershipEpoch !== currentBinding.ownershipEpoch
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

        const updatedRow = await tx
          .update(executionWorkspaces)
          .set({ branchName: inspection.toBranch })
          .where(
            and(
              eq(executionWorkspaces.id, lockedRow.id),
              eq(executionWorkspaces.companyId, lockedRow.companyId),
              eq(executionWorkspaces.branchName, inspection.fromBranch),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updatedRow) {
          throw conflict(
            "Execution workspace branch changed during reconciliation; retry with a fresh inspection",
            { inspection },
          );
        }

        const auditNotice = await appendCanonicalControlNotice(
          db,
          {
            companyId: lockedRow.companyId,
            issueId: lockedBinding.issueId,
            sourceKind: "workspace_branch_reconciled",
            immutableSourceKey: [inspection.fingerprint, input.mode].join(":"),
            sourceRecordId: inspection.fingerprint,
            exactText: formatBranchReconcileAuditComment({
              mode: input.mode,
              reason,
              workspaceId: existing.id,
              inspection,
            }),
            comment: {
              author: { kind: "system", source: "control" },
              producingRun: null,
            },
            allowTerminal: true,
          },
          tx,
        );

        return {
          workspace: toExecutionWorkspace(updatedRow),
          boundIssueId: lockedBinding.issueId,
          boundOwnershipEpoch: lockedBinding.ownershipEpoch,
          inspection,
          auditCommentId: auditNotice.comment?.id ?? null,
        };
      });
    },
  };
}
