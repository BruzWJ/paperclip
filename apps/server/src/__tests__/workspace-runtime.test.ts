import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { ensureGitWorktreeBranchCoherent } from "../services/workspace-runtime.js";

const dependencies = vi.hoisted(() => ({
  appendCanonicalControlNotice: vi.fn(),
  findGitWorktreeContention: vi.fn(),
  reconcileExecutionWorkspaceBranch: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({
    findGitWorktreeContention: dependencies.findGitWorktreeContention,
    reconcileExecutionWorkspaceBranch:
      dependencies.reconcileExecutionWorkspaceBranch,
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: dependencies.logActivity,
}));

vi.mock("../services/issue-session-producers.js", () => ({
  appendCanonicalControlNotice: dependencies.appendCanonicalControlNotice,
}));

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function readGit(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function createTempRepo(defaultBranch = "main") {
  const repoRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-branch-safeguard-"),
  );
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", defaultBranch]);
  return repoRoot;
}

async function createForeignWorktree(input: {
  expectedBranch: string;
  actualBranch: string;
  committedForward?: boolean;
  dirty?: boolean;
}) {
  const repoRoot = await createTempRepo();
  const worktreePath = path.join(repoRoot, "worktrees", input.actualBranch);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(repoRoot, ["branch", input.expectedBranch]);
  await runGit(repoRoot, [
    "worktree",
    "add",
    "-b",
    input.actualBranch,
    worktreePath,
    input.expectedBranch,
  ]);
  if (input.committedForward) {
    await fs.appendFile(path.join(worktreePath, "README.md"), "forward\n");
    await runGit(worktreePath, ["commit", "-am", "Forward commit"]);
  }
  if (input.dirty) {
    await fs.appendFile(path.join(worktreePath, "README.md"), "dirty tracked\n");
    await fs.writeFile(
      path.join(worktreePath, "untracked.txt"),
      "dirty untracked\n",
    );
  }
  return { repoRoot, worktreePath };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.findGitWorktreeContention.mockResolvedValue(null);
  dependencies.appendCanonicalControlNotice.mockResolvedValue({
    comment: { id: "audit-comment" },
  });
  dependencies.logActivity.mockResolvedValue(undefined);
});

describe("workspace branch reconciliation safeguards", () => {
  it("leaves a clean forward branch untouched when forward reconciliation is disabled", async () => {
    const expectedBranch = "recorded";
    const actualBranch = "forward";
    const { repoRoot, worktreePath } = await createForeignWorktree({
      expectedBranch,
      actualBranch,
      committedForward: true,
    });

    await expect(
      ensureGitWorktreeBranchCoherent({
        repoRoot,
        worktreePath,
        expectedBranchName: expectedBranch,
        sourceIssue: null,
        enableWorkspaceBranchReconcileForward: false,
        enableWorkspaceDirtyQuarantineRepair: true,
      }),
    ).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          cleanliness: "clean",
          provenance: expect.objectContaining({ ancestryVerdict: "ancestor" }),
          safeRepair: expect.objectContaining({
            attempted: false,
            succeeded: false,
            reason:
              "forward branch reconciliation is disabled in General settings",
          }),
        }),
      },
    });
    await expect(
      readGit(worktreePath, ["branch", "--show-current"]),
    ).resolves.toBe(actualBranch);
  }, 20_000);

  it("persists a proven clean forward branch when the safeguard is enabled", async () => {
    const expectedBranch = "recorded";
    const actualBranch = "forward";
    const { repoRoot, worktreePath } = await createForeignWorktree({
      expectedBranch,
      actualBranch,
      committedForward: true,
    });
    const database = createMockDb();
    const now = new Date();
    dependencies.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: "codebase-1",
        cwd: worktreePath,
        repoUrl: null,
        branchName: actualBranch,
        lastUsedAt: now,
        createdAt: now,
      },
      boundIssueId: "issue-1",
      boundOwnershipEpoch: 1,
      inspection: {
        fingerprint: "fingerprint",
        worktreePath,
        repoRoot,
        fromBranch: expectedBranch,
        toBranch: actualBranch,
        fromSha: "from-sha",
        toSha: "to-sha",
        ancestryVerdict: "ancestor",
        cleanliness: "clean",
        statusEntryCount: 0,
        plainLanguageReason: "forward",
      },
      auditCommentId: "audit-comment",
    });

    await expect(
      ensureGitWorktreeBranchCoherent({
        db: database.db,
        repoRoot,
        worktreePath,
        expectedBranchName: expectedBranch,
        sourceIssue: null,
        executionWorkspaceId: "workspace-1",
        runId: "run-1",
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: true,
      }),
    ).resolves.toMatchObject({
      branchName: actualBranch,
      reconciledForward: true,
    });
    expect(
      dependencies.reconcileExecutionWorkspaceBranch,
    ).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ mode: "forward" }),
    );
  }, 20_000);

  it("leaves dirty work untouched when quarantine repair is disabled", async () => {
    const expectedBranch = "recorded";
    const actualBranch = "dirty";
    const { repoRoot, worktreePath } = await createForeignWorktree({
      expectedBranch,
      actualBranch,
      dirty: true,
    });

    await expect(
      ensureGitWorktreeBranchCoherent({
        repoRoot,
        worktreePath,
        expectedBranchName: expectedBranch,
        sourceIssue: null,
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: false,
      }),
    ).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          safeRepair: expect.objectContaining({
            attempted: false,
            succeeded: false,
            reason:
              "dirty workspace quarantine repair is disabled in General settings",
          }),
        }),
      },
    });
    await expect(
      readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"]),
    ).resolves.not.toBe("");
  }, 20_000);

  it("quarantines dirty work on a rescue branch before restoring the recorded branch", async () => {
    const expectedBranch = "recorded";
    const actualBranch = "dirty";
    const { repoRoot, worktreePath } = await createForeignWorktree({
      expectedBranch,
      actualBranch,
      dirty: true,
    });
    const database = createMockDb({
      select: [
        [{ companyId: "company-1" }],
        [{ companyId: "company-1" }],
        [{ companyId: "company-1" }],
      ],
    });

    const result = await ensureGitWorktreeBranchCoherent({
      db: database.db,
      repoRoot,
      worktreePath,
      expectedBranchName: expectedBranch,
      sourceIssue: {
        id: "issue-1",
        identifier: "PAP-1",
      },
      executionWorkspaceId: "workspace-1",
      runId: "run-1",
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
    });

    expect(result.branchName).toBe(expectedBranch);
    expect(result.dirtyQuarantineRepair?.rescueBranch).toMatch(
      /^paperclip\/rescue\/PAP-1\//,
    );
    await expect(
      readGit(worktreePath, ["branch", "--show-current"]),
    ).resolves.toBe(expectedBranch);
    await expect(
      readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"]),
    ).resolves.toBe("");
    await expect(
      readGit(
        repoRoot,
        ["show", `${result.dirtyQuarantineRepair?.rescueBranch}:untracked.txt`],
      ),
    ).resolves.toBe("dirty untracked");
    expect(dependencies.appendCanonicalControlNotice).toHaveBeenCalled();
    expect(dependencies.logActivity).toHaveBeenCalled();
  }, 20_000);
});
