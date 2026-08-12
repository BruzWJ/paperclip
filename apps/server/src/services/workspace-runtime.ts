import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { tasks } from "@paperclipai/db";
import {
  type GitWorktreeBranchAncestryVerdict,
  type GitWorktreeBranchIncoherenceEvidence as SharedGitWorktreeBranchIncoherenceEvidence,
  type GitWorktreeInProgressOperation,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { logActivity } from "./activity-log.js";
import { appendCanonicalControlNotice } from "./task-session-producers.js";

export interface ExecutionWorkspaceTaskRef {
  id: string;
  identifier: string;
}

export class WorkspaceRuntimeValidationFailure extends Error {
  code = "workspace_validation_failed" as const;
  resultJson: Record<string, unknown>;

  constructor(message: string, resultJson: Record<string, unknown>) {
    super(message);
    this.name = "WorkspaceRuntimeValidationFailure";
    this.resultJson = resultJson;
  }
}

const DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES = 256 * 1024;

type ProcessOutputCapture = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

type ProcessOutputAccumulator = {
  append(chunk: string): void;
  finish(): ProcessOutputCapture;
};

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

function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 120) || "paperclip-work";
}

function trimToLastBytes(value: string, limit: number) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= limit) return value;
  return Buffer.from(value, "utf8").subarray(byteLength - limit).toString("utf8");
}

function createProcessOutputCapture(maxBytes: number): ProcessOutputAccumulator {
  const limit = Math.max(1, Math.trunc(maxBytes));
  let text = "";
  let truncated = false;
  let totalBytes = 0;

  return {
    append(chunk: string) {
      if (!chunk) return;
      totalBytes += Buffer.byteLength(chunk, "utf8");

      const combined = text + chunk;
      if (Buffer.byteLength(combined, "utf8") <= limit) {
        text = combined;
        return;
      }

      text = trimToLastBytes(combined, limit);
      truncated = true;
    },
    finish(): ProcessOutputCapture {
      if (!truncated) {
        return {
          text,
          truncated: false,
          totalBytes,
        };
      }
      return {
        text: `[output truncated to last ${limit} bytes; total ${totalBytes} bytes]\n${text}`,
        truncated: true,
        totalBytes,
      };
    },
  };
}

async function executeProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}> {
  const proc = await new Promise<{
    stdout: ProcessOutputAccumulator;
    stderr: ProcessOutputAccumulator;
    code: number | null;
  }>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: input.env ?? process.env,
    });
    const stdout = createProcessOutputCapture(input.maxStdoutBytes ?? DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES);
    const stderr = createProcessOutputCapture(input.maxStderrBytes ?? DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES);
    child.stdout?.on("data", (chunk) => {
      stdout.append(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr.append(String(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
  const stdout = proc.stdout.finish();
  const stderr = proc.stderr.finish();
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: proc.code,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
  };
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = await executeProcess({
    command: "git",
    args,
    cwd,
  });
  if (proc.code !== 0) {
    throw new Error(proc.stderr.trim() || proc.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return proc.stdout.trim();
}

async function runSafeguardGitOperation(input: {
  args: string[];
  cwd: string;
  [key: string]: unknown;
}) {
  return runGit(input.args, input.cwd);
}

function formatShortSha(value: string | null | undefined) {
  return value ? value.slice(0, 12) : "unknown";
}

function gitErrorIncludes(error: unknown, needle: string) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(needle.toLowerCase());
}

async function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  return runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot)
    .then(() => true)
    .catch(() => false);
}

const GIT_WORKTREE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";

type GitWorktreeCleanliness = SharedGitWorktreeBranchIncoherenceEvidence["cleanliness"];

type GitWorktreeBranchIncoherenceEvidence = SharedGitWorktreeBranchIncoherenceEvidence;

type GitWorktreeBranchContention = NonNullable<GitWorktreeBranchIncoherenceEvidence["contention"]>;

type GitWorktreeBranchCoherenceResult = {
  branchName: string | null;
  reconciledForward: boolean;
  dirtyQuarantineRepair?: DirtyQuarantineRepairResult | null;
  warnings: string[];
};

type DirtyQuarantineRepairResult = {
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  clearedInProgressOperation: GitWorktreeInProgressOperation | null;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
};

function formatBranchForMessage(branch: string | null | undefined) {
  return branch && branch.length > 0 ? branch : "<detached>";
}

const GIT_IN_PROGRESS_OPERATION_MARKERS: ReadonlyArray<{
  operation: GitWorktreeInProgressOperation;
  marker: string;
}> = [
  { operation: "rebase", marker: "rebase-merge" },
  { operation: "rebase", marker: "rebase-apply" },
  { operation: "merge", marker: "MERGE_HEAD" },
  { operation: "cherry_pick", marker: "CHERRY_PICK_HEAD" },
  { operation: "revert", marker: "REVERT_HEAD" },
  { operation: "bisect", marker: "BISECT_LOG" },
];

const GIT_IN_PROGRESS_OPERATION_LABELS: Record<GitWorktreeInProgressOperation, string> = {
  rebase: "rebase",
  merge: "merge",
  cherry_pick: "cherry-pick",
  revert: "revert",
  bisect: "bisect",
};

// `--quit` clears the interrupted operation's state directory without touching
// the working tree or moving HEAD, unlike `--abort` which resets both.
const GIT_IN_PROGRESS_OPERATION_QUIT_ARGS: Record<GitWorktreeInProgressOperation, string[]> = {
  rebase: ["rebase", "--quit"],
  merge: ["merge", "--quit"],
  cherry_pick: ["cherry-pick", "--quit"],
  revert: ["revert", "--quit"],
  bisect: ["bisect", "reset", "HEAD"],
};

async function detectGitWorktreeInProgressOperation(
  worktreePath: string,
): Promise<GitWorktreeInProgressOperation | null> {
  for (const { operation, marker } of GIT_IN_PROGRESS_OPERATION_MARKERS) {
    const markerPath = await runGit(["rev-parse", "--git-path", marker], worktreePath).catch(() => null);
    if (!markerPath) continue;
    if (existsSync(path.resolve(worktreePath, markerPath))) return operation;
  }
  return null;
}

const DIRTY_PATH_SAMPLE_LIMIT = 5;

function parseGitPorcelainPath(line: string) {
  const raw = line.trimEnd();
  if (raw.trim().length <= 3) return raw.trim();
  if (raw[1] === " " && raw[2] !== " ") return raw.slice(2).trim();
  return raw.slice(3).trim();
}

function sampleDirtyStatusPaths(statusLines: string[] | null) {
  return (statusLines ?? [])
    .map(parseGitPorcelainPath)
    .filter((value) => value.length > 0)
    .slice(0, DIRTY_PATH_SAMPLE_LIMIT);
}

function formatUtcBranchTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildDirtyQuarantineRescueBranch(sourceTask: ExecutionWorkspaceTaskRef | null) {
  const taskComponent = sanitizeBranchName(sourceTask?.identifier ?? "task");
  return sanitizeBranchName(`paperclip/rescue/${taskComponent}/${formatUtcBranchTimestamp()}`);
}

function formatTaskReference(identifier: string | null | undefined) {
  if (!identifier) return "`unavailable task`";
  return `\`${identifier}\``;
}

async function readTaskCompanyId(db: Db, taskId: string | null | undefined): Promise<string | null> {
  if (!taskId) return null;
  return db
    .select({ companyId: tasks.companyId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .then((rows) => rows[0]?.companyId ?? null);
}

async function findGitWorktreeBranchContention(input: {
  db: Db | null | undefined;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  actualBranchName: string | null;
}): Promise<GitWorktreeBranchContention | null> {
  if (!input.db) return null;
  const companyId = await readTaskCompanyId(input.db, input.sourceTask?.id);
  if (!companyId) return null;
  return executionWorkspaceService(input.db).findGitWorktreeContention({
    companyId,
    worktreePath: input.worktreePath,
    liveBranchName: input.actualBranchName,
    excludingExecutionWorkspaceId: input.executionWorkspaceId,
  });
}

async function assertGitIndexIsUnlocked(worktreePath: string) {
  const indexLockPath = await runGit(["rev-parse", "--git-path", "index.lock"], worktreePath)
    .catch(() => null);
  if (indexLockPath && existsSync(indexLockPath)) {
    throw new Error(`git index lock exists at ${indexLockPath}`);
  }
}

function fingerprintWorkspaceBranchIncoherence(input: {
  taskId: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: GitWorktreeCleanliness;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(stableStringify({
      version: 1,
      reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
      taskId: input.taskId,
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

  const proc = await executeProcess({
    command: "git",
    args: ["merge-base", "--is-ancestor", input.expectedHeadSha, input.actualHeadSha],
    cwd: input.repoRoot,
  }).catch(() => null);
  if (!proc) return "unknown";
  if (proc.code === 0) return "ancestor";
  if (proc.code === 1) return "diverged";
  return "unknown";
}

function explainGitWorktreeBranchIncoherence(input: {
  expectedBranchName: string;
  actualBranchName: string | null;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
  sameHead: boolean;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
}) {
  const actualBranch = formatBranchForMessage(input.actualBranchName);
  if (!input.expectedHeadSha || !input.actualHeadSha) {
    return `Paperclip could not determine branch ancestry because the recorded branch "${input.expectedBranchName}" or checked-out branch "${actualBranch}" is missing a resolvable HEAD commit.`;
  }
  if (input.sameHead) {
    return `The recorded branch "${input.expectedBranchName}" and checked-out branch "${actualBranch}" resolve to the same commit, so the mismatch is branch metadata rather than commit divergence.`;
  }
  if (input.ancestryVerdict === "ancestor") {
    return `The recorded branch "${input.expectedBranchName}" is an ancestor of the checked-out branch "${actualBranch}", so the checked-out branch is forward of the recorded branch.`;
  }
  if (input.ancestryVerdict === "diverged") {
    return `The recorded branch "${input.expectedBranchName}" is not an ancestor of the checked-out branch "${actualBranch}", so Paperclip cannot prove a forward-only reconciliation.`;
  }
  return `Paperclip could not determine whether the checked-out branch "${actualBranch}" is forward of the recorded branch "${input.expectedBranchName}".`;
}

async function inspectGitWorktreeBranchIncoherence(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  actualBranchName: string | null;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  executionWorkspaceId?: string | null;
}): Promise<GitWorktreeBranchIncoherenceEvidence> {
  const status = await runGit(
    ["status", "--porcelain", "--untracked-files=all"],
    input.worktreePath,
  ).catch(() => null);
  const statusLines = status === null
    ? null
    : status.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  const dirtyPathSample = sampleDirtyStatusPaths(statusLines);
  const cleanliness: GitWorktreeCleanliness =
    status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";
  const inProgressOperation = await detectGitWorktreeInProgressOperation(input.worktreePath);
  const expectedHeadSha = await runGit(
    ["rev-parse", "--verify", `refs/heads/${input.expectedBranchName}^{commit}`],
    input.repoRoot,
  ).catch(() => null);
  const actualHeadSha = await runGit(["rev-parse", "HEAD"], input.worktreePath).catch(() => null);
  const actualBranchExists = input.actualBranchName
    ? await localBranchExists(input.repoRoot, input.actualBranchName)
    : null;
  const registered = await findRegisteredGitWorktreeByPath(input.repoRoot, input.worktreePath);
  const actualBranchRef = input.actualBranchName ? `refs/heads/${input.actualBranchName}` : null;
  const registeredBranchRef = registered?.branch ?? null;
  const registeredBranchMatchesHead = Boolean(registered && registeredBranchRef === actualBranchRef);
  const sameHead = Boolean(expectedHeadSha && actualHeadSha && expectedHeadSha === actualHeadSha);
  const expectedBranchExists = Boolean(expectedHeadSha);
  const ancestryVerdict = await getGitWorktreeBranchAncestryVerdict({
    repoRoot: input.repoRoot,
    expectedHeadSha,
    actualHeadSha,
  });
  const basePlainLanguageReason = explainGitWorktreeBranchIncoherence({
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.actualBranchName,
    expectedHeadSha,
    actualHeadSha,
    sameHead,
    ancestryVerdict,
  });
  const plainLanguageReason = inProgressOperation
    ? `${basePlainLanguageReason} An interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[inProgressOperation]} is still in progress in this worktree.`
    : basePlainLanguageReason;
  const canCheckoutRecordedBranch =
    cleanliness === "clean" && expectedBranchExists && sameHead && registeredBranchMatchesHead;
  const canAdoptForwardActualBranch =
    cleanliness === "clean" &&
    expectedBranchExists &&
    actualBranchExists === true &&
    ancestryVerdict === "ancestor" &&
    !sameHead &&
    registeredBranchMatchesHead;
  const canAttachRecordedBranchToDetachedHead =
    cleanliness === "clean" &&
    expectedBranchExists &&
    input.actualBranchName === null &&
    ancestryVerdict === "ancestor" &&
    !sameHead &&
    registeredBranchMatchesHead;
  const eligible =
    canCheckoutRecordedBranch || canAdoptForwardActualBranch || canAttachRecordedBranchToDetachedHead;
  const safeRepairReason = eligible
    ? canCheckoutRecordedBranch
      ? "clean worktree and expected branch points at the current HEAD"
      : canAdoptForwardActualBranch
        ? "clean worktree and checked-out branch is forward of the recorded branch"
        : "clean detached worktree HEAD is forward of the recorded branch"
    : cleanliness !== "clean"
      ? inProgressOperation
        ? `worktree is not clean and a git ${GIT_IN_PROGRESS_OPERATION_LABELS[inProgressOperation]} is in progress`
        : "worktree is not clean"
      : !registered
        ? "worktree path is not registered"
      : !registeredBranchMatchesHead
        ? "registered worktree branch does not match HEAD"
      : !expectedBranchExists
        ? "expected branch does not exist"
        : !sameHead
          ? "expected branch and current HEAD differ"
          : "safe repair could not be proven";
  const fingerprint = fingerprintWorkspaceBranchIncoherence({
    taskId: input.sourceTask?.id ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    expectedHeadSha,
    actualHeadSha,
  });
  const contention = await findGitWorktreeBranchContention({
    db: input.db ?? null,
    sourceTask: input.sourceTask,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    actualBranchName: input.actualBranchName,
  });

  return {
    reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
    fingerprint,
    ...(input.sourceTask
      ? {
          sourceTaskId: input.sourceTask.id,
          sourceIdentifier: input.sourceTask.identifier,
        }
      : { sourceTaskId: null, sourceIdentifier: null }),
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: path.resolve(input.worktreePath),
    repoRoot: path.resolve(input.repoRoot),
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    inProgressOperation,
    statusEntryCount: statusLines?.length ?? null,
    dirtyPathSample,
    contention,
    provenance: {
      expectedBranchRef: `refs/heads/${input.expectedBranchName}`,
      actualBranchRef,
      registeredBranchRef,
      registeredPathFound: Boolean(registered),
      registeredBranchMatchesHead,
      expectedBranchExists,
      actualBranchExists,
      expectedHeadSha,
      actualHeadSha,
      sameHead,
      ancestryVerdict,
      plainLanguageReason,
    },
    safeRepair: {
      eligible,
      attempted: false,
      succeeded: false,
      reason: safeRepairReason,
    },
  };
}

function branchIncoherenceValidationFailure(evidence: GitWorktreeBranchIncoherenceEvidence) {
  return new WorkspaceRuntimeValidationFailure(
    `Execution workspace git worktree expected branch "${evidence.expectedBranch}" but found "${formatBranchForMessage(evidence.actualBranch)}" at "${evidence.worktreePath}". Safe repair ${evidence.safeRepair.succeeded ? "succeeded" : "was not completed"}: ${evidence.safeRepair.reason}.`,
    {
      workspaceValidation: evidence,
    },
  );
}

function formatDirtyQuarantineContentionRefusal(contention: GitWorktreeBranchContention) {
  const activeRunText = contention.activeRun
    ? ` with active run ${contention.activeRun.id}`
    : " with no active run";
  return `dirty quarantine repair refused because workspace ${contention.claimedByWorkspaceId} already claims the live branch${activeRunText}`;
}

function formatDirtyQuarantineFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    gitErrorIncludes(error, "index.lock") ||
    gitErrorIncludes(error, "index lock") ||
    gitErrorIncludes(error, "another git process") ||
    gitErrorIncludes(error, "Unable to create")
  ) {
    return `dirty quarantine repair aborted because git reported index contention: ${message}`;
  }
  return `dirty quarantine repair failed: ${message}`;
}

function formatDirtyQuarantineAuditComment(input: {
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  claimant: GitWorktreeBranchContention | null;
}) {
  const dirtySample = input.evidence.dirtyPathSample.length > 0
    ? input.evidence.dirtyPathSample.map((entry) => `\`${entry}\``).join(", ")
    : "`none captured`";
  return [
    "Execution workspace dirty worktree quarantined before restore.",
    "",
    `- Source task: ${formatTaskReference(input.evidence.sourceIdentifier ?? input.sourceTask?.identifier ?? null)}`,
    `- Workspace: \`${input.evidence.executionWorkspaceId ?? "unpersisted"}\``,
    `- Worktree: \`${input.evidence.worktreePath}\``,
    `- Recorded branch: \`${input.evidence.expectedBranch}\``,
    `- Live branch: \`${formatBranchForMessage(input.evidence.actualBranch)}\``,
    `- Rescue branch: \`${input.rescueBranch}\``,
    `- Rescue commit: \`${input.rescueCommitSha}\``,
    `- Dirty file count: \`${input.fileCount}\``,
    `- Dirty path sample: ${dirtySample}`,
    ...(input.evidence.inProgressOperation
      ? [`- Interrupted operation: \`git ${GIT_IN_PROGRESS_OPERATION_LABELS[input.evidence.inProgressOperation]}\` (state cleared after rescue; resolution preserved on the rescue branch)`]
      : []),
    `- Fingerprint: \`${input.evidence.fingerprint}\``,
    input.claimant
      ? `- Claimant: workspace \`${input.claimant.claimedByWorkspaceId}\` on task ${formatTaskReference(input.claimant.claimedByTaskIdentifier)}${input.claimant.activeRun ? ` with active run \`${input.claimant.activeRun.id}\`` : " with no active run"}`
      : "- Claimant: none",
  ].join("\n");
}

async function writeDirtyQuarantineAuditComments(input: {
  db: Db;
  companyId: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  runId: string | null;
}): Promise<{ sourceAuditCommentId: string | null; claimantAuditCommentId: string | null }> {
  const body = formatDirtyQuarantineAuditComment({
    evidence: input.evidence,
    rescueBranch: input.rescueBranch,
    rescueCommitSha: input.rescueCommitSha,
    fileCount: input.fileCount,
    sourceTask: input.sourceTask,
    claimant: input.evidence.contention,
  });
  let sourceAuditCommentId: string | null = null;
  let claimantAuditCommentId: string | null = null;
  if (input.evidence.sourceTaskId) {
    const sourceNotice = await appendCanonicalControlNotice(input.db, {
      companyId: input.companyId,
      taskId: input.evidence.sourceTaskId,
      sourceKind: "workspace_dirty_quarantine",
      immutableSourceKey:
        `${input.evidence.fingerprint}:source:${input.rescueCommitSha}`,
      sourceRecordId: input.evidence.fingerprint,
      exactText: body,
      comment: {
        author: { kind: "system", source: "recovery" },
        producingRun: null,
      },
      allowTerminal: true,
    });
    sourceAuditCommentId = sourceNotice.comment?.id ?? null;
  }

  const claimantTaskId = input.evidence.contention?.claimedByTaskId ?? null;
  if (claimantTaskId && claimantTaskId !== input.evidence.sourceTaskId) {
    const claimantNotice = await appendCanonicalControlNotice(input.db, {
      companyId: input.companyId,
      taskId: claimantTaskId,
      sourceKind: "workspace_dirty_quarantine",
      immutableSourceKey:
        `${input.evidence.fingerprint}:claimant:${claimantTaskId}:${input.rescueCommitSha}`,
      sourceRecordId: input.evidence.fingerprint,
      exactText: body,
      comment: {
        author: { kind: "system", source: "recovery" },
        producingRun: null,
      },
      allowTerminal: true,
    });
    claimantAuditCommentId = claimantNotice.comment?.id ?? null;
  }

  return { sourceAuditCommentId, claimantAuditCommentId };
}

async function logDirtyQuarantineActivity(input: {
  db: Db;
  companyId: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  runId: string | null;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
}) {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workspace_runtime",
    runId: input.runId,
    action: "execution_workspace.dirty_worktree_quarantined",
    entityType: input.evidence.executionWorkspaceId ? "execution_workspace" : "task",
    entityId: input.evidence.executionWorkspaceId ?? input.evidence.sourceTaskId ?? input.companyId,
    details: {
      reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
      sourceTaskId: input.evidence.sourceTaskId,
      executionWorkspaceId: input.evidence.executionWorkspaceId,
      worktreePath: input.evidence.worktreePath,
      expectedBranch: input.evidence.expectedBranch,
      actualBranch: input.evidence.actualBranch,
      rescueBranch: input.rescueBranch,
      rescueCommitSha: input.rescueCommitSha,
      fileCount: input.fileCount,
      dirtyPathSample: input.evidence.dirtyPathSample,
      fingerprint: input.evidence.fingerprint,
      contention: input.evidence.contention,
      sourceAuditCommentId: input.sourceAuditCommentId,
      claimantAuditCommentId: input.claimantAuditCommentId,
      actor: {
        type: "system",
        id: "workspace_runtime",
        source: "workspace_runtime",
      },
    },
  });
}

async function quarantineDirtyWorktreeBranchIncoherence(input: {
  db: Db;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  executionWorkspaceId: string | null;
  runId: string | null;
  evidence: GitWorktreeBranchIncoherenceEvidence;
}): Promise<DirtyQuarantineRepairResult> {
  const companyId = await readTaskCompanyId(input.db, input.evidence.sourceTaskId);
  if (!companyId) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires a source task company for audit";
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const freshContention = await findGitWorktreeBranchContention({
    db: input.db,
    sourceTask: input.sourceTask,
    executionWorkspaceId: input.executionWorkspaceId,
    worktreePath: input.worktreePath,
    actualBranchName: input.evidence.actualBranch,
  });
  input.evidence.contention = freshContention;
  if (freshContention) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = formatDirtyQuarantineContentionRefusal(freshContention);
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const rescueBranch = buildDirtyQuarantineRescueBranch(input.sourceTask);
  const fileCount = input.evidence.statusEntryCount ?? input.evidence.dirtyPathSample.length;
  const baseMetadata = {
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.evidence.actualBranch,
    branchIncoherenceDirtyQuarantineRepair: true,
    rescueBranch,
    fingerprint: input.evidence.fingerprint,
    sourceTaskId: input.evidence.sourceTaskId,
    executionWorkspaceId: input.evidence.executionWorkspaceId,
    fileCount,
    dirtyPathSample: input.evidence.dirtyPathSample,
    contention: input.evidence.contention,
  };

  let rescueBranchCreated = false;
  let expectedBranchRestored = false;
  try {
    await assertGitIndexIsUnlocked(input.worktreePath);
    await runSafeguardGitOperation({
      args: ["checkout", "-b", rescueBranch],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Created rescue branch ${rescueBranch} for dirty git worktree state at ${input.worktreePath}\n`,
      failureLabel: `git checkout -b ${rescueBranch}`,
    });
    rescueBranchCreated = true;
    await runSafeguardGitOperation({
      args: ["add", "-A"],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Staged dirty git worktree state for rescue branch ${rescueBranch}\n`,
      failureLabel: "git add -A",
    });
    await runSafeguardGitOperation({
      args: [
        "commit",
        "-m",
        "Paperclip dirty workspace rescue",
        "-m",
        [
          `Source-Task: ${input.evidence.sourceIdentifier ?? "unidentified-task"}`,
          `Run-Id: ${input.runId ?? "unknown"}`,
          `Recorded-Branch: ${input.expectedBranchName}`,
          `Live-Branch: ${formatBranchForMessage(input.evidence.actualBranch)}`,
          `Fingerprint: ${input.evidence.fingerprint}`,
        ].join("\n"),
      ],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Committed dirty git worktree state to rescue branch ${rescueBranch}\n`,
      failureLabel: "git commit dirty workspace rescue",
    });
    const rescueCommitSha = await runGit(["rev-parse", "HEAD"], input.worktreePath);
    await runSafeguardGitOperation({
      args: ["checkout", input.expectedBranchName],
      cwd: input.worktreePath,
      metadata: {
        ...baseMetadata,
        rescueCommitSha,
      },
      successMessage: `Restored recorded branch ${input.expectedBranchName} after dirty workspace rescue ${rescueBranch}\n`,
      failureLabel: `git checkout ${input.expectedBranchName}`,
    });
    expectedBranchRestored = true;

    // A run that died mid-rebase (or mid-merge/cherry-pick/revert/bisect)
    // leaves the operation's state directory behind even after the recorded
    // branch is checked out, which wedges the next git command in the
    // worktree. The rescue commit above already preserved the in-flight
    // resolution, so clearing the state metadata here loses nothing.
    let clearedInProgressOperation: GitWorktreeInProgressOperation | null = null;
    const lingeringOperation = await detectGitWorktreeInProgressOperation(input.worktreePath);
    if (lingeringOperation) {
      const operationLabel = GIT_IN_PROGRESS_OPERATION_LABELS[lingeringOperation];
      const quitArgs = GIT_IN_PROGRESS_OPERATION_QUIT_ARGS[lingeringOperation];
      await runSafeguardGitOperation({
        args: quitArgs,
        cwd: input.worktreePath,
        metadata: {
          ...baseMetadata,
          clearedInProgressOperation: lingeringOperation,
        },
        successMessage: `Cleared interrupted git ${operationLabel} state after dirty workspace rescue ${rescueBranch}\n`,
        failureLabel: `git ${quitArgs.join(" ")}`,
      });
      const stillInProgress = await detectGitWorktreeInProgressOperation(input.worktreePath);
      if (stillInProgress) {
        input.evidence.safeRepair.succeeded = false;
        input.evidence.safeRepair.reason =
          `dirty quarantine repair could not clear the interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[stillInProgress]} state`;
        throw branchIncoherenceValidationFailure(input.evidence);
      }
      clearedInProgressOperation = lingeringOperation;
    }

    const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
      .catch(() => null);
    if (repairedBranch !== input.expectedBranchName) {
      input.evidence.safeRepair.succeeded = false;
      input.evidence.safeRepair.reason =
        `dirty quarantine repair checked out ${formatBranchForMessage(repairedBranch)} instead of ${input.expectedBranchName}`;
      throw branchIncoherenceValidationFailure(input.evidence);
    }
    const repairedStatus = await runGit(["status", "--porcelain", "--untracked-files=all"], input.worktreePath);
    if (repairedStatus.trim().length > 0) {
      input.evidence.safeRepair.succeeded = false;
      input.evidence.safeRepair.reason = "dirty quarantine repair completed but the worktree is still dirty";
      throw branchIncoherenceValidationFailure(input.evidence);
    }

    const comments = await writeDirtyQuarantineAuditComments({
      db: input.db,
      companyId,
      evidence: input.evidence,
      sourceTask: input.sourceTask,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      runId: input.runId,
    });
    await logDirtyQuarantineActivity({
      db: input.db,
      companyId,
      evidence: input.evidence,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      runId: input.runId,
      sourceAuditCommentId: comments.sourceAuditCommentId,
      claimantAuditCommentId: comments.claimantAuditCommentId,
    });
    return {
      rescueBranch,
      rescueCommitSha,
      fileCount,
      clearedInProgressOperation,
      ...comments,
    };
  } catch (error) {
    if (rescueBranchCreated && !expectedBranchRestored) {
      await runGit(["checkout", input.expectedBranchName], input.worktreePath).catch(() => null);
    }
    if (error instanceof WorkspaceRuntimeValidationFailure) throw error;
    input.evidence.safeRepair.succeeded = false;
    input.evidence.safeRepair.reason = formatDirtyQuarantineFailure(error);
    throw branchIncoherenceValidationFailure(input.evidence);
  }
}

async function logForwardBranchReconcileActivity(input: {
  db: Db;
  companyId: string;
  executionWorkspaceId: string;
  sourceTaskId: string | null;
  runId: string | null;
  mode: "forward";
  reason: string | null;
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  fingerprint: string;
  auditCommentId: string | null;
}) {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workspace_runtime",
    runId: input.runId,
    action: "execution_workspace.branch_reconciled",
    entityType: "execution_workspace",
    entityId: input.executionWorkspaceId,
    details: {
      mode: input.mode,
      reason: input.reason,
      fromBranch: input.fromBranch,
      toBranch: input.toBranch,
      fromSha: input.fromSha,
      toSha: input.toSha,
      ancestryVerdict: input.ancestryVerdict,
      fingerprint: input.fingerprint,
      sourceTaskId: input.sourceTaskId,
      auditCommentId: input.auditCommentId,
      actor: {
        type: "system",
        id: "workspace_runtime",
        source: "workspace_runtime",
      },
    },
  });
}

export async function ensureGitWorktreeBranchCoherent(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string | null;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  executionWorkspaceId?: string | null;
  actualBranchName?: string | null;
  runId?: string | null;
  enableWorkspaceBranchReconcileForward: boolean;
  enableWorkspaceDirtyQuarantineRepair: boolean;
}): Promise<GitWorktreeBranchCoherenceResult> {
  const expectedBranchName = input.expectedBranchName?.trim();
  if (!expectedBranchName) return { branchName: null, reconciledForward: false, warnings: [] };

  const currentBranch = input.actualBranchName !== undefined
    ? input.actualBranchName
    : await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath).catch(() => null);
  if (currentBranch === expectedBranchName) {
    return { branchName: expectedBranchName, reconciledForward: false, warnings: [] };
  }

  const evidence = await inspectGitWorktreeBranchIncoherence({
    db: input.db ?? null,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName,
    actualBranchName: currentBranch,
    sourceTask: input.sourceTask,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
  });

  if (evidence.cleanliness === "dirty") {
    if (!input.enableWorkspaceDirtyQuarantineRepair) {
      evidence.safeRepair.eligible = false;
      evidence.safeRepair.reason = "dirty workspace quarantine repair is disabled in General settings";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!input.db) {
      evidence.safeRepair.reason = "dirty quarantine repair requires database access for claimant checks and audit";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!evidence.provenance.registeredPathFound) {
      evidence.safeRepair.reason = "dirty quarantine repair requires a registered git worktree path";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!evidence.provenance.expectedBranchExists) {
      evidence.safeRepair.reason = "dirty quarantine repair requires the recorded branch to exist";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (evidence.contention) {
      evidence.safeRepair.eligible = false;
      evidence.safeRepair.reason = formatDirtyQuarantineContentionRefusal(evidence.contention);
      throw branchIncoherenceValidationFailure(evidence);
    }
    evidence.safeRepair.eligible = true;
    evidence.safeRepair.attempted = true;
    evidence.safeRepair.reason = "dirty worktree can be quarantined on a rescue branch before restoring the recorded branch";
    const result = await quarantineDirtyWorktreeBranchIncoherence({
      db: input.db,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      expectedBranchName,
      sourceTask: input.sourceTask,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      runId: input.runId ?? null,
      evidence,
    });
    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = result.clearedInProgressOperation
      ? `dirty worktree quarantined on ${result.rescueBranch} at ${formatShortSha(result.rescueCommitSha)}; interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[result.clearedInProgressOperation]} state cleared`
      : `dirty worktree quarantined on ${result.rescueBranch} at ${formatShortSha(result.rescueCommitSha)}`;
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      dirtyQuarantineRepair: result,
      warnings: [
        `Execution workspace dirty worktree state was quarantined on rescue branch "${result.rescueBranch}" (${formatShortSha(result.rescueCommitSha)}; ${result.fileCount} ${result.fileCount === 1 ? "file" : "files"}) before restoring recorded branch "${expectedBranchName}".${result.clearedInProgressOperation ? ` An interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[result.clearedInProgressOperation]} was also cleared; its in-flight state is preserved on the rescue branch.` : ""}`,
      ],
    };
  }

  if (
    !input.enableWorkspaceBranchReconcileForward &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead
  ) {
    evidence.safeRepair.eligible = false;
    evidence.safeRepair.reason = "forward branch reconciliation is disabled in General settings";
    throw branchIncoherenceValidationFailure(evidence);
  }

  if (
    input.enableWorkspaceBranchReconcileForward &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead &&
    evidence.cleanliness === "clean" &&
    currentBranch
  ) {
    const reason = "Automatic forward reconciliation: recorded branch is an ancestor of the checked-out branch.";
    if (!input.executionWorkspaceId) {
      evidence.safeRepair.reason = "forward reconciliation requires a persisted execution workspace id";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!input.db) {
      evidence.safeRepair.reason = "forward reconciliation requires database access to update the execution workspace record";
      throw branchIncoherenceValidationFailure(evidence);
    }
    try {
      const result = await executionWorkspaceService(input.db).reconcileExecutionWorkspaceBranch(
        input.executionWorkspaceId,
        {
          mode: "forward",
          taskId: evidence.sourceTaskId,
          reason,
          actor: {
            actorType: "system",
            actorId: "workspace_runtime",
            runId: input.runId ?? null,
          },
        },
      );
      await logForwardBranchReconcileActivity({
        db: input.db,
        companyId: result.workspace.companyId,
        executionWorkspaceId: result.workspace.id,
        sourceTaskId: result.boundTaskId,
        runId: input.runId ?? null,
        mode: "forward",
        reason,
        fromBranch: result.inspection.fromBranch,
        toBranch: result.inspection.toBranch,
        fromSha: result.inspection.fromSha,
        toSha: result.inspection.toSha,
        ancestryVerdict: result.inspection.ancestryVerdict,
        fingerprint: result.inspection.fingerprint,
        auditCommentId: result.auditCommentId,
      });
      return { branchName: result.inspection.toBranch, reconciledForward: true, warnings: [] };
    } catch (error) {
      evidence.safeRepair.reason =
        `forward reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }
  }

  if (!evidence.safeRepair.eligible) {
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.attempted = true;
  const warningPrefix =
    `Execution workspace branch metadata was self-healed from "${expectedBranchName}" to "${formatBranchForMessage(currentBranch)}" at ${input.worktreePath}.`;
  if (
    currentBranch &&
    evidence.provenance.actualBranchExists === true &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead
  ) {
    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = "clean worktree adopted the checked-out branch because it is forward of the recorded branch";
    return {
      branchName: currentBranch,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The checked-out branch contains the recorded branch plus newer commits, so Paperclip adopted it for subsequent runs.`,
      ],
    };
  }

  if (
    currentBranch === null &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead &&
    evidence.provenance.actualHeadSha
  ) {
    try {
      await runSafeguardGitOperation({
        args: ["checkout", "-B", expectedBranchName, evidence.provenance.actualHeadSha],
        cwd: input.worktreePath,
        metadata: {
          repoRoot: input.repoRoot,
          worktreePath: input.worktreePath,
          expectedBranchName,
          actualBranchName: currentBranch,
          branchIncoherenceRepair: true,
          detachedHeadRepair: true,
          fingerprint: evidence.fingerprint,
          sourceTaskId: evidence.sourceTaskId,
          executionWorkspaceId: evidence.executionWorkspaceId,
        },
        successMessage: `Reattached detached git worktree HEAD at ${input.worktreePath} to ${expectedBranchName}\n`,
        failureLabel: `git checkout -B ${expectedBranchName} ${formatShortSha(evidence.provenance.actualHeadSha)}`,
      });
    } catch (error) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason = `safe detached HEAD reattachment failed: ${error instanceof Error ? error.message : String(error)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }

    const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
      .catch(() => null);
    if (repairedBranch !== expectedBranchName) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason = `reattach completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }

    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = "clean detached worktree HEAD was reattached to the recorded branch";
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The detached HEAD contained the recorded branch plus newer commits, so Paperclip moved the recorded branch to that HEAD.`,
      ],
    };
  }

  try {
    await runSafeguardGitOperation({
      args: ["checkout", expectedBranchName],
      cwd: input.worktreePath,
      metadata: {
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        expectedBranchName,
        actualBranchName: currentBranch,
        branchIncoherenceRepair: true,
        fingerprint: evidence.fingerprint,
        sourceTaskId: evidence.sourceTaskId,
        executionWorkspaceId: evidence.executionWorkspaceId,
      },
      successMessage: `Repaired clean git worktree branch mismatch at ${input.worktreePath}: checked out ${expectedBranchName}\n`,
      failureLabel: `git checkout ${expectedBranchName}`,
    });
  } catch (error) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `safe checkout failed: ${error instanceof Error ? error.message : String(error)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
    .catch(() => null);
  if (repairedBranch !== expectedBranchName) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `checkout completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.succeeded = true;
  evidence.safeRepair.reason = "clean worktree checked out the recorded branch";
  return {
    branchName: expectedBranchName,
    reconciledForward: false,
    warnings: [
      `Execution workspace branch metadata was self-healed by checking out recorded branch "${expectedBranchName}" at ${input.worktreePath}.`,
    ],
  };
}

type GitWorktreeListEntry = {
  worktree: string;
  branch: string | null;
};

function parseGitWorktreeListPorcelain(raw: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> = {};

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length) };
      continue;
    }
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
      continue;
    }
    if (line === "" && current.worktree) {
      entries.push({
        worktree: current.worktree,
        branch: current.branch ?? null,
      });
      current = {};
    }
  }

  if (current.worktree) {
    entries.push({
      worktree: current.worktree,
      branch: current.branch ?? null,
    });
  }

  return entries;
}

async function findRegisteredGitWorktreeByPath(repoRoot: string, worktreePath: string): Promise<GitWorktreeListEntry | null> {
  const raw = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => null);
  if (!raw) return null;

  const expectedPath = await resolvePathForWorktreeComparison(worktreePath);
  for (const entry of parseGitWorktreeListPorcelain(raw)) {
    if (await resolvePathForWorktreeComparison(entry.worktree) === expectedPath) {
      return entry;
    }
  }
  return null;
}

async function resolvePathForWorktreeComparison(value: string): Promise<string> {
  const resolved = path.resolve(value);
  return fs.realpath(resolved).then((realPath) => path.resolve(realPath)).catch(() => resolved);
}
