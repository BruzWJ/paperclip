import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import {
  buildWorkspaceRuntimeDesiredStatePatch,
  cleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable,
  ensureServerWorkspaceLinksCurrent,
  ensureRuntimeServicesForRun,
  listConfiguredRuntimeServiceEntries,
  normalizeAdapterManagedRuntimeServices,
  reconcilePersistedRuntimeServicesOnStartup,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  resetRuntimeServicesForTests,
  resolveWorkspaceRuntimeReadinessTimeoutSec,
  resolveShell,
  sanitizeRuntimeServiceBaseEnv,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import {
  findAdoptableLocalService,
  isLocalServiceRegistryCwdCompatible,
  isLocalServiceProcessInWorkspace,
  readLocalServicePortOwner,
  writeLocalServiceRegistryRecord,
} from "../services/local-service-supervisor.ts";
import type { WorkspaceOperation } from "@paperclipai/shared";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.ts";

const workspaceRuntimeDependencyMocks = vi.hoisted(() => ({
  appendCanonicalControlNotice: vi.fn(),
  findGitWorktreeContention: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/execution-workspaces.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/execution-workspaces.js")>();
  return {
    ...actual,
    executionWorkspaceService: (...args: Parameters<typeof actual.executionWorkspaceService>) => ({
      ...actual.executionWorkspaceService(...args),
      findGitWorktreeContention: workspaceRuntimeDependencyMocks.findGitWorktreeContention,
    }),
  };
});

vi.mock("../services/activity-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/activity-log.js")>()),
  logActivity: workspaceRuntimeDependencyMocks.logActivity,
}));

vi.mock("../services/issue-session-producers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-session-producers.js")>()),
  appendCanonicalControlNotice: workspaceRuntimeDependencyMocks.appendCanonicalControlNotice,
}));

const execFileAsync = promisify(execFile);

function stableStringifyForTest(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyForTest(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringifyForTest(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function workspaceBranchIncoherenceFingerprintForTest(input: {
  sourceIssueId: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: "clean" | "dirty" | "unknown";
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(stableStringifyForTest({
      version: 1,
      reason: "git_worktree_branch_incoherence",
      sourceIssueId: input.sourceIssueId,
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

const leasedRunIds = new Set<string>();
const provisionWorktreeScriptPath = new URL("../../../../scripts/provision-worktree.sh", import.meta.url);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function readGit(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function createTempRepo(defaultBranch = "main") {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", defaultBranch]);
  return repoRoot;
}

async function createProvisionScriptFixtureWorktree(
  baseRoot: string,
  worktreeRoot: string,
) {
  await fs.mkdir(baseRoot, { recursive: true });
  await runGit(baseRoot, ["init"]);
  await runGit(baseRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(baseRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(baseRoot, "README.md"), "fixture\n", "utf8");
  await runGit(baseRoot, ["add", "README.md"]);
  await runGit(baseRoot, ["commit", "-m", "Initial provision fixture"]);
  await runGit(baseRoot, [
    "worktree",
    "add",
    "-b",
    "provision-fixture",
    worktreeRoot,
  ]);
}

async function prepareWorktreeProvisionFixture(tempRoot: string) {
  const baseRoot = path.join(tempRoot, "base");
  const worktreeRoot = path.join(tempRoot, "worktree");
  const scriptPath = path.join(worktreeRoot, "provision-worktree.sh");
  const parentPaperclipDir = path.join(baseRoot, ".paperclip");
  const parentConfigPath = path.join(parentPaperclipDir, "config.json");

  await createProvisionScriptFixtureWorktree(baseRoot, worktreeRoot);
  await fs.copyFile(provisionWorktreeScriptPath, scriptPath);
  await fs.chmod(scriptPath, 0o755);
  await fs.mkdir(parentPaperclipDir, { recursive: true });
  await fs.writeFile(parentConfigPath, "{}\n", "utf8");
  await fs.writeFile(
    path.join(parentPaperclipDir, ".env"),
    [
      "DATABASE_URL=postgresql://parent.example.test/paperclip_parent",
      "BETTER_AUTH_SECRET=parent-secret",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    baseRoot,
    worktreeRoot,
    scriptPath,
    parentConfigPath,
  };
}

async function expectPersistedBranchMismatchRejected(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string;
  issueId: string;
  executionWorkspaceId: string;
  expectedAncestryVerdict: "diverged" | "unknown";
  expectedReason?: string;
}) {
  let error: unknown = null;
  try {
    await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: input.repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: input.executionWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: input.worktreePath,
        providerRef: input.worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: input.expectedBranch,
      },
      issue: {
        id: input.issueId,
        identifier: "PAP-459",
        title: "Reject unsafe forward branch reconciliation",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      enableWorkspaceBranchReconcileForward: true,
    });
  } catch (err) {
    error = err;
  }

  expect(error).toMatchObject({
    code: "workspace_validation_failed",
    resultJson: {
      workspaceValidation: expect.objectContaining({
        reason: "git_worktree_branch_incoherence",
        sourceIssueId: input.issueId,
        executionWorkspaceId: input.executionWorkspaceId,
        expectedBranch: input.expectedBranch,
        actualBranch: input.actualBranch,
        provenance: expect.objectContaining({
          ancestryVerdict: input.expectedAncestryVerdict,
        }),
        safeRepair: expect.objectContaining({
          eligible: false,
          attempted: false,
          succeeded: false,
          ...(input.expectedReason ? { reason: input.expectedReason } : {}),
        }),
      }),
    },
  });
}

async function createClonedRepoWithRemote() {
  const sourceRepo = await createTempRepo("master");
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-remote-"));
  const remotePath = path.join(remoteDir, "paperclip.git");
  await execFileAsync("git", ["clone", "--bare", sourceRepo, remotePath]);

  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-clone-"));
  const repoRoot = path.join(cloneRoot, "paperclip");
  await execFileAsync("git", ["clone", remotePath, repoRoot]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  return { sourceRepo, remotePath, repoRoot };
}

async function advanceRemoteMaster(sourceRepo: string, remotePath: string, fileName: string) {
  await fs.writeFile(path.join(sourceRepo, fileName), `${fileName}\n`, "utf8");
  await runGit(sourceRepo, ["add", fileName]);
  await runGit(sourceRepo, ["commit", "-m", `Add ${fileName}`]);
  await runGit(sourceRepo, ["push", remotePath, "master"]);
  return readGit(sourceRepo, ["rev-parse", "master"]);
}

function realizeWorktreeForTest(repoRoot: string, repoRef: string | null) {
  return realizeExecutionWorkspace({
    base: {
      baseCwd: repoRoot,
      source: "project_primary",
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef,
    },
    config: {
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
      },
    },
    issue: {
      id: "issue-1",
      identifier: "PAP-447",
      title: "Add Worktree Support",
    },
    agent: {
      id: "agent-1",
      name: "Codex Coder",
      companyId: "company-1",
    },
  });
}

function buildWorkspace(cwd: string): RealizedExecutionWorkspace {
  return {
    baseCwd: cwd,
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: "HEAD",
    strategy: "project_primary",
    cwd,
    branchName: null,
    worktreePath: null,
    warnings: [],
    created: false,
  };
}

function createWorkspaceOperationRecorderDouble() {
  const operations: Array<{
    phase: string;
    command: string | null;
    cwd: string | null;
    metadata: Record<string, unknown> | null;
    result: {
      status?: string;
      exitCode?: number | null;
      stdout?: string | null;
      stderr?: string | null;
      system?: string | null;
      metadata?: Record<string, unknown> | null;
    };
  }> = [];
  let executionWorkspaceId: string | null = null;

  const recorder: WorkspaceOperationRecorder = {
    attachExecutionWorkspaceId: async (nextExecutionWorkspaceId) => {
      executionWorkspaceId = nextExecutionWorkspaceId;
    },
    recordOperation: async (input) => {
      const result = await input.run();
      operations.push({
        phase: input.phase,
        command: input.command ?? null,
        cwd: input.cwd ?? null,
        metadata: {
          ...(input.metadata ?? {}),
          ...(executionWorkspaceId ? { executionWorkspaceId } : {}),
        },
        result,
      });
      return {
        id: `op-${operations.length}`,
        companyId: "company-1",
        executionWorkspaceId,
        runId: "run-1",
        issueId: null,
        phase: input.phase,
        command: input.command ?? null,
        cwd: input.cwd ?? null,
        status: (result.status ?? "succeeded") as WorkspaceOperation["status"],
        exitCode: result.exitCode ?? null,
        logStore: "local_file",
        logRef: `op-${operations.length}.ndjson`,
        logBytes: 0,
        logSha256: null,
        logCompressed: false,
        stdoutExcerpt: result.stdout ?? null,
        stderrExcerpt: result.stderr ?? null,
        metadata: input.metadata ?? null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  };

  return { recorder, operations };
}

beforeEach(() => {
  workspaceRuntimeDependencyMocks.findGitWorktreeContention.mockReset().mockResolvedValue(null);
  workspaceRuntimeDependencyMocks.appendCanonicalControlNotice.mockReset().mockResolvedValue({
    comment: { id: "comment-dirty-quarantine" },
  });
  workspaceRuntimeDependencyMocks.logActivity.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await Promise.all(
    Array.from(leasedRunIds).map(async (runId) => {
      await releaseRuntimeServicesForRun(runId);
      leasedRunIds.delete(runId);
    }),
  );
  delete process.env.PAPERCLIP_CONFIG;
  delete process.env.PAPERCLIP_HOME;
  delete process.env.PAPERCLIP_INSTANCE_ID;
  delete process.env.PAPERCLIP_WORKTREES_DIR;
  delete process.env.DATABASE_URL;
  await resetRuntimeServicesForTests();
});

describe("sanitizeRuntimeServiceBaseEnv", () => {
  it("removes inherited Paperclip and pnpm auth flags before spawning runtime services", () => {
    const sanitized = sanitizeRuntimeServiceBaseEnv({
      PATH: process.env.PATH,
      DATABASE_URL: "postgres://example.test/paperclip",
      PAPERCLIP_HOME: "/tmp/paperclip-home",
      PAPERCLIP_INSTANCE_ID: "runtime-instance",
      npm_config_tailscale_auth: "true",
      npm_config_authenticated_private: "true",
      HOST: "0.0.0.0",
    });

    expect(sanitized.PAPERCLIP_HOME).toBeUndefined();
    expect(sanitized.PAPERCLIP_INSTANCE_ID).toBeUndefined();
    expect(sanitized.DATABASE_URL).toBeUndefined();
    expect(sanitized.npm_config_tailscale_auth).toBeUndefined();
    expect(sanitized.npm_config_authenticated_private).toBeUndefined();
    expect(sanitized.HOST).toBe("0.0.0.0");
  });
});

describe("ensureServerWorkspaceLinksCurrent", () => {
  it("relinks stale server workspace dependencies inside the current repo root", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-links-"));
    const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-links-stale-"));
    const serverNodeModulesScopeDir = path.join(repoRoot, "apps", "server", "node_modules", "@paperclipai");
    const expectedPackageDir = path.join(repoRoot, "packages", "db");
    const stalePackageDir = path.join(staleRoot, "db");

    await fs.mkdir(path.join(repoRoot, "apps", "server"), { recursive: true });
    await fs.mkdir(expectedPackageDir, { recursive: true });
    await fs.mkdir(stalePackageDir, { recursive: true });
    await fs.mkdir(serverNodeModulesScopeDir, { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: /tmp/paperclip-main/.git/worktrees/runtime-links\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, "apps", "server", "package.json"),
      JSON.stringify({
        name: "@paperclipai/server",
        dependencies: {
          "@paperclipai/db": "workspace:*",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(expectedPackageDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/db" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stalePackageDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/db" }),
      "utf8",
    );
    await fs.symlink(stalePackageDir, path.join(serverNodeModulesScopeDir, "db"));

    await ensureServerWorkspaceLinksCurrent(path.join(repoRoot, "apps", "server"));
    expect(await fs.realpath(path.join(serverNodeModulesScopeDir, "db"))).toBe(await fs.realpath(expectedPackageDir));
  });

  it("skips relinking when server workspace dependencies already point at the repo", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-links-current-"));
    const serverNodeModulesScopeDir = path.join(repoRoot, "apps", "server", "node_modules", "@paperclipai");
    const expectedPackageDir = path.join(repoRoot, "packages", "db");

    await fs.mkdir(path.join(repoRoot, "apps", "server"), { recursive: true });
    await fs.mkdir(expectedPackageDir, { recursive: true });
    await fs.mkdir(serverNodeModulesScopeDir, { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: /tmp/paperclip-main/.git/worktrees/runtime-links-current\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, "apps", "server", "package.json"),
      JSON.stringify({
        name: "@paperclipai/server",
        dependencies: {
          "@paperclipai/db": "workspace:*",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(expectedPackageDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/db" }),
      "utf8",
    );
    await fs.symlink(expectedPackageDir, path.join(serverNodeModulesScopeDir, "db"));

    await ensureServerWorkspaceLinksCurrent(path.join(repoRoot, "apps", "server"));
  });

  it("skips relinking outside linked git worktrees", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-links-non-worktree-"));
    const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-links-non-worktree-stale-"));
    const serverNodeModulesScopeDir = path.join(repoRoot, "apps", "server", "node_modules", "@paperclipai");
    const expectedPackageDir = path.join(repoRoot, "packages", "db");
    const stalePackageDir = path.join(staleRoot, "db");

    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "apps", "server"), { recursive: true });
    await fs.mkdir(expectedPackageDir, { recursive: true });
    await fs.mkdir(stalePackageDir, { recursive: true });
    await fs.mkdir(serverNodeModulesScopeDir, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, "apps", "server", "package.json"),
      JSON.stringify({
        name: "@paperclipai/server",
        dependencies: {
          "@paperclipai/db": "workspace:*",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(expectedPackageDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/db" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stalePackageDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/db" }),
      "utf8",
    );
    await fs.symlink(stalePackageDir, path.join(serverNodeModulesScopeDir, "db"));

    await ensureServerWorkspaceLinksCurrent(path.join(repoRoot, "apps", "server"));
    expect(await fs.realpath(path.join(serverNodeModulesScopeDir, "db"))).toBe(await fs.realpath(stalePackageDir));
  });
});

describe("realizeExecutionWorkspace", () => {
  it("defaults new git worktrees to freshly fetched origin/master", async () => {
    const sourceRepo = await createTempRepo("master");
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-remote-"));
    const remotePath = path.join(remoteDir, "paperclip.git");
    await execFileAsync("git", ["clone", "--bare", sourceRepo, remotePath]);

    const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-clone-"));
    const repoRoot = path.join(cloneRoot, "paperclip");
    await execFileAsync("git", ["clone", remotePath, repoRoot]);
    await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);

    await fs.writeFile(path.join(sourceRepo, "auth-fix.txt"), "cookie fix\n", "utf8");
    await runGit(sourceRepo, ["add", "auth-fix.txt"]);
    await runGit(sourceRepo, ["commit", "-m", "Add auth fix"]);
    await runGit(sourceRepo, ["push", remotePath, "master"]);
    const expectedRemoteHead = await readGit(sourceRepo, ["rev-parse", "master"]);
    expect(await readGit(repoRoot, ["rev-parse", "origin/master"])).not.toBe(expectedRemoteHead);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: null,
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(workspace.baseRefSha).toBe(expectedRemoteHead);
    expect(await readGit(repoRoot, ["rev-parse", "origin/master"])).toBe(expectedRemoteHead);
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(expectedRemoteHead);
  });

  it("creates and reuses a git worktree for an issue-scoped branch", async () => {
    const repoRoot = await createTempRepo();

    const first = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(first.strategy).toBe("git_worktree");
    expect(first.created).toBe(true);
    expect(first.branchName).toBe("PAP-447-add-worktree-support");
    expect(first.cwd).toContain(path.join(".paperclip", "worktrees"));
    await expect(fs.stat(path.join(first.cwd, ".git"))).resolves.toBeTruthy();

    const second = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(second.created).toBe(false);
    expect(second.cwd).toBe(first.cwd);
    expect(second.branchName).toBe(first.branchName);
  });

  it("warns when reusing a git worktree whose base ref has advanced", async () => {
    const repoRoot = await createTempRepo();

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "main",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });
    expect(initial.baseRefSha).toMatch(/^[0-9a-f]{40}$/);

    await fs.writeFile(path.join(repoRoot, "server-auth-fix.txt"), "cookie fix\n", "utf8");
    await runGit(repoRoot, ["add", "server-auth-fix.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add auth runtime fix"]);

    const reused = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "main",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(reused.created).toBe(false);
    expect(reused.cwd).toBe(initial.cwd);
    expect(reused.warnings).toEqual([
      expect.stringContaining("is behind main by 1 commit"),
    ]);
  });

  it("bases a fresh worktree on origin/master even when local master has unpushed commits", async () => {
    const { repoRoot } = await createClonedRepoWithRemote();
    const originHead = await readGit(repoRoot, ["rev-parse", "origin/master"]);

    await fs.writeFile(path.join(repoRoot, "unpushed.txt"), "local only\n", "utf8");
    await runGit(repoRoot, ["add", "unpushed.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Unpushed local work"]);
    const localHead = await readGit(repoRoot, ["rev-parse", "master"]);
    expect(localHead).not.toBe(originHead);

    const workspace = await realizeWorktreeForTest(repoRoot, null);

    expect(workspace.baseRefSha).toBe(originHead);
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(originHead);
  });

  it("maps a configured local branch base ref to origin/<branch> for fresh worktrees", async () => {
    const { repoRoot } = await createClonedRepoWithRemote();
    const originHead = await readGit(repoRoot, ["rev-parse", "origin/master"]);

    await fs.writeFile(path.join(repoRoot, "unpushed.txt"), "local only\n", "utf8");
    await runGit(repoRoot, ["add", "unpushed.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Unpushed local work"]);
    const localHead = await readGit(repoRoot, ["rev-parse", "master"]);
    expect(localHead).not.toBe(originHead);

    const workspace = await realizeWorktreeForTest(repoRoot, "master");

    expect(workspace.repoRef).toBe("origin/master");
    expect(workspace.baseRefSha).toBe(originHead);
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(originHead);
  });

  it("fast-forwards an unstarted reused worktree to the advanced origin/master", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();

    const initial = await realizeWorktreeForTest(repoRoot, null);
    const initialHead = await readGit(initial.cwd, ["rev-parse", "HEAD"]);

    const advancedHead = await advanceRemoteMaster(sourceRepo, remotePath, "auth-fix.txt");
    expect(advancedHead).not.toBe(initialHead);

    const reused = await realizeWorktreeForTest(repoRoot, null);

    expect(reused.created).toBe(false);
    expect(reused.cwd).toBe(initial.cwd);
    expect(await readGit(reused.cwd, ["rev-parse", "HEAD"])).toBe(advancedHead);
    expect(reused.baseRefSha).toBe(advancedHead);
    expect(reused.warnings).toEqual([]);
  });

  it("does not reset a reused worktree that already has task commits", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();

    const initial = await realizeWorktreeForTest(repoRoot, null);
    await fs.writeFile(path.join(initial.cwd, "task-work.txt"), "in progress\n", "utf8");
    await runGit(initial.cwd, ["add", "task-work.txt"]);
    await runGit(initial.cwd, ["commit", "-m", "Task work in progress"]);
    const taskHead = await readGit(initial.cwd, ["rev-parse", "HEAD"]);

    await advanceRemoteMaster(sourceRepo, remotePath, "auth-fix.txt");

    const reused = await realizeWorktreeForTest(repoRoot, null);

    expect(reused.created).toBe(false);
    expect(await readGit(reused.cwd, ["rev-parse", "HEAD"])).toBe(taskHead);
    expect(reused.warnings).toEqual([
      expect.stringContaining("is behind origin/master by 1 commit"),
    ]);
  });

  it("does not reset a reused worktree with untracked changes", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();

    const initial = await realizeWorktreeForTest(repoRoot, null);
    const initialHead = await readGit(initial.cwd, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(initial.cwd, "scratch.txt"), "uncommitted scratch\n", "utf8");

    await advanceRemoteMaster(sourceRepo, remotePath, "auth-fix.txt");

    const reused = await realizeWorktreeForTest(repoRoot, null);

    expect(reused.created).toBe(false);
    expect(await readGit(reused.cwd, ["rev-parse", "HEAD"])).toBe(initialHead);
    await expect(fs.readFile(path.join(reused.cwd, "scratch.txt"), "utf8")).resolves.toBe(
      "uncommitted scratch\n",
    );
    expect(reused.warnings).toEqual([
      expect.stringContaining("is behind origin/master by 1 commit"),
    ]);
  });

  it("does not reset a reused worktree with untracked changes when status.showUntrackedFiles=no", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();

    const initial = await realizeWorktreeForTest(repoRoot, null);
    const initialHead = await readGit(initial.cwd, ["rev-parse", "HEAD"]);
    // Without `--untracked-files=all`, this config hides untracked files from
    // `git status --porcelain`, which would let the clean-tree guard pass and a
    // `reset --hard` destroy the scratch file below.
    await readGit(initial.cwd, ["config", "status.showUntrackedFiles", "no"]);
    await fs.writeFile(path.join(initial.cwd, "scratch.txt"), "uncommitted scratch\n", "utf8");

    await advanceRemoteMaster(sourceRepo, remotePath, "auth-fix.txt");

    const reused = await realizeWorktreeForTest(repoRoot, null);

    expect(reused.created).toBe(false);
    expect(await readGit(reused.cwd, ["rev-parse", "HEAD"])).toBe(initialHead);
    await expect(fs.readFile(path.join(reused.cwd, "scratch.txt"), "utf8")).resolves.toBe(
      "uncommitted scratch\n",
    );
    expect(reused.warnings).toEqual([
      expect.stringContaining("is behind origin/master by 1 commit"),
    ]);
  });

  it("rejects reusing an empty directory that only looks like a worktree because it sits inside the repo", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-447-add-worktree-support";
    const poisonedPath = path.join(repoRoot, ".paperclip", "worktrees", branchName);
    await fs.mkdir(poisonedPath, { recursive: true });

    await expect(
      realizeExecutionWorkspace({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        config: {
          workspaceStrategy: {
            type: "git_worktree",
            branchTemplate: "{{issue.identifier}}-{{slug}}",
          },
        },
        issue: {
          id: "issue-1",
          identifier: "PAP-447",
          title: "Add Worktree Support",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
      }),
    ).rejects.toThrow(/not a reusable git worktree \(path is not registered in `git worktree list`\)\./);
  });

  it("reuses the current linked worktree instead of nesting another worktree inside it", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-1355-worktree-reuse";
    const currentWorktree = path.join(repoRoot, ".paperclip", "worktrees", branchName);

    await fs.mkdir(path.dirname(currentWorktree), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", branchName, currentWorktree, "HEAD"], { cwd: repoRoot });

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: currentWorktree,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-1355",
        title: "worktree reuse",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    const expectedWorktreePath = await fs.realpath(currentWorktree);
    expect(realized.created).toBe(false);
    await expect(fs.realpath(realized.cwd)).resolves.toBe(expectedWorktreePath);
    await expect(fs.realpath(realized.worktreePath ?? "")).resolves.toBe(expectedWorktreePath);
  });

  it("repairs a clean linked worktree whose branch drifted from the expected issue branch", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await runGit(initial.cwd, ["checkout", "-b", "unexpected-branch"]);

    const repaired = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(repaired.created).toBe(false);
    expect(repaired.cwd).toBe(initial.cwd);
    await expect(readGit(initial.cwd, ["branch", "--show-current"])).resolves.toBe("PAP-447-add-worktree-support");
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "worktree_prepare",
          command: "git checkout PAP-447-add-worktree-support",
          metadata: expect.objectContaining({
            branchIncoherenceRepair: true,
            expectedBranchName: "PAP-447-add-worktree-support",
            actualBranchName: "unexpected-branch",
            sourceIssueId: "issue-1",
            fingerprint: expect.stringMatching(/^workspace_incoherence:v1:sha256:/),
          }),
        }),
      ]),
    );
  });

  it("reuses an already checked out branch from git worktree metadata even when the target path differs", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-1355-worktree-reuse";
    const existingWorktree = path.join(repoRoot, ".paperclip", "worktrees", branchName);
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    await fs.mkdir(path.dirname(existingWorktree), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", branchName, existingWorktree, "HEAD"], { cwd: repoRoot });

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: existingWorktree,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          worktreeParentDir: ".paperclip/other-worktrees",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-1355",
        title: "worktree reuse",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    const expectedWorktreePath = await fs.realpath(existingWorktree);
    expect(realized.created).toBe(false);
    await expect(fs.realpath(realized.cwd)).resolves.toBe(expectedWorktreePath);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.phase).toBe("worktree_prepare");
    expect(operations[0]?.command).toBeNull();
    expect(operations[0]?.metadata).toMatchObject({
      branchName,
      created: false,
      reused: true,
      worktreePath: expectedWorktreePath,
    });
  });

  it("slugifies unsafe issue titles for branch names and worktree folders", async () => {
    const repoRoot = await createTempRepo();

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-unsafe",
        identifier: "PAP-991",
        title: "there should be a setting for the allowance of thumbs up / thumbs down data; `rm -rf`",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(realized.branchName).toBe(
      "PAP-991-there-should-be-a-setting-for-the-allowance-of-thumbs-up-thumbs-down-data-rm-rf",
    );
    expect(realized.branchName?.includes("/")).toBe(false);
    expect(path.basename(realized.cwd)).toBe(realized.branchName);
  });

  it("preserves intentional slashes and dots from the branch template", async () => {
    const repoRoot = await createTempRepo();

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "release/{{issue.identifier}}.{{slug}}",
        },
      },
      issue: {
        id: "issue-template-safe",
        identifier: "PAP-992",
        title: "Hotfix / April.1",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(realized.branchName).toBe("release/PAP-992.hotfix-april-1");
    expect(path.basename(realized.cwd)).toBe("PAP-992.hotfix-april-1");
  });

  it("runs a configured provision command inside the derived worktree", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "git branch --show-current > .paperclip-provision-branch",
        "dirname \"$(git rev-parse --path-format=absolute --git-common-dir)\" > .paperclip-provision-base",
        "pwd -P > .paperclip-provision-cwd",
        "if env | grep -q '^PAPERCLIP_WORKSPACE_'; then exit 90; fi",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add worktree provision script"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-448",
        title: "Run provision command",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(workspace.cwd, ".paperclip-provision-branch"), "utf8")).resolves.toBe(
      "PAP-448-run-provision-command\n",
    );
    await expect(fs.readFile(path.join(workspace.cwd, ".paperclip-provision-base"), "utf8")).resolves.toBe(
      `${repoRoot}\n`,
    );
    await expect(fs.readFile(path.join(workspace.cwd, ".paperclip-provision-cwd"), "utf8")).resolves.toBe(
      `${workspace.cwd}\n`,
    );

    const reused = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-448",
        title: "Run provision command",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(reused.created).toBe(false);
    await expect(
      fs.readFile(path.join(reused.cwd, ".paperclip-provision-cwd"), "utf8"),
    ).resolves.toBe(`${reused.cwd}\n`);
  });

  it("uses the latest repo-managed provision script when reusing an existing worktree", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'v1\\n' > .paperclip-provision-version",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add initial provision script"]);

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-449",
        title: "Reuse latest provision script",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(initial.cwd, ".paperclip-provision-version"), "utf8")).resolves.toBe("v1\n");

    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'v2\\n' > .paperclip-provision-version",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Update provision script"]);

    await expect(fs.readFile(path.join(initial.cwd, "scripts", "provision.sh"), "utf8")).resolves.toContain("v1");

    const reused = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-449",
        title: "Reuse latest provision script",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(reused.cwd, ".paperclip-provision-version"), "utf8")).resolves.toBe("v2\n");
  }, 30_000);

  it("requires an explicit external database before worktree creation", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-worktree-create-target-"),
    );
    try {
      const fixture = await prepareWorktreeProvisionFixture(tempRoot);
      const env = {
        ...process.env,
        PAPERCLIP_CONFIG: fixture.parentConfigPath,
      };
      delete env.PAPERCLIP_WORKTREE_DATABASE_URL;

      let caught: (Error & { stderr?: string }) | null = null;
      try {
        await execFileAsync(fixture.scriptPath, [], {
          cwd: fixture.worktreeRoot,
          env,
        });
      } catch (error) {
        caught = error as Error & { stderr?: string };
      }

      expect(caught).not.toBeNull();
      expect(caught?.stderr ?? String(caught)).toContain(
        "PAPERCLIP_WORKTREE_DATABASE_URL must name an explicit external PostgreSQL database.",
      );
      await expect(
        fs.stat(path.join(fixture.worktreeRoot, ".paperclip")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("delegates exactly one creation request with the explicit target", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-worktree-create-delegate-"),
    );
    try {
      const fixture = await prepareWorktreeProvisionFixture(tempRoot);
      const fakeBin = path.join(tempRoot, "bin");
      const fakePnpm = path.join(fakeBin, "pnpm");
      const argsLog = path.join(tempRoot, "args.log");
      const cwdLog = path.join(tempRoot, "cwd.log");
      const configLog = path.join(tempRoot, "config.log");
      const targetUrl =
        "postgresql://worktree.example.test/paperclip_target";

      await fs.mkdir(fakeBin, { recursive: true });
      await fs.writeFile(
        path.join(fixture.worktreeRoot, "package.json"),
        "{}\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(fixture.worktreeRoot, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n",
        "utf8",
      );
      await fs.writeFile(
        fakePnpm,
        [
          "#!/bin/sh",
          "set -eu",
          'printf "%s\\n" "$*" > "$PROVISION_ARGS_LOG"',
          'printf "%s\\n" "$PWD" > "$PROVISION_CWD_LOG"',
          'printf "%s\\n" "$PAPERCLIP_CONFIG" > "$PROVISION_CONFIG_LOG"',
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(fakePnpm, 0o755);

      const result = await execFileAsync(fixture.scriptPath, [], {
        cwd: fixture.worktreeRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PAPERCLIP_CONFIG: fixture.parentConfigPath,
          PAPERCLIP_WORKTREE_DATABASE_URL: targetUrl,
          PROVISION_ARGS_LOG: argsLog,
          PROVISION_CWD_LOG: cwdLog,
          PROVISION_CONFIG_LOG: configLog,
        },
      });

      await expect(fs.readFile(argsLog, "utf8")).resolves.toBe(
        `paperclipai worktree init --name provision-fixture --database-url ${targetUrl}\n`,
      );
      await expect(fs.readFile(cwdLog, "utf8")).resolves.toBe(
        `${fixture.worktreeRoot}\n`,
      );
      await expect(fs.readFile(configLog, "utf8")).resolves.toBe(
        `${fixture.parentConfigPath}\n`,
      );
      expect(result.stdout).toContain(
        "Configured Paperclip worktree state for its external database.",
      );
      await expect(
        fs.stat(path.join(fixture.worktreeRoot, ".paperclip")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("leaves existing worktree bytes unchanged when creation rejects them", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-worktree-create-reject-"),
    );
    try {
      const fixture = await prepareWorktreeProvisionFixture(tempRoot);
      const fakeBin = path.join(tempRoot, "bin");
      const fakePnpm = path.join(fakeBin, "pnpm");
      const paperclipDir = path.join(fixture.worktreeRoot, ".paperclip");
      const configPath = path.join(paperclipDir, "config.json");
      const envPath = path.join(paperclipDir, ".env");
      const markerPath = path.join(
        paperclipDir,
        "worktree-instance.json",
      );
      const configBytes = '{"partial":true}\n';
      const envBytes = "DATABASE_URL=stale\n";
      const markerBytes = '{"partial":true}\n';

      await fs.mkdir(fakeBin, { recursive: true });
      await fs.mkdir(paperclipDir, { recursive: true });
      await fs.writeFile(
        path.join(fixture.worktreeRoot, "package.json"),
        "{}\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(fixture.worktreeRoot, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n",
        "utf8",
      );
      await fs.writeFile(configPath, configBytes, "utf8");
      await fs.writeFile(envPath, envBytes, "utf8");
      await fs.writeFile(markerPath, markerBytes, "utf8");
      await fs.writeFile(
        fakePnpm,
        [
          "#!/bin/sh",
          'echo "creation rejected existing state" >&2',
          "exit 42",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(fakePnpm, 0o755);

      let caught: (Error & { stderr?: string }) | null = null;
      try {
        await execFileAsync(fixture.scriptPath, [], {
          cwd: fixture.worktreeRoot,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            PAPERCLIP_CONFIG: fixture.parentConfigPath,
            PAPERCLIP_WORKTREE_DATABASE_URL:
              "postgresql://worktree.example.test/paperclip_target",
          },
        });
      } catch (error) {
        caught = error as Error & { stderr?: string };
      }

      expect(caught).not.toBeNull();
      expect(caught?.stderr ?? String(caught)).toContain(
        "creation rejected existing state",
      );
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(
        configBytes,
      );
      await expect(fs.readFile(envPath, "utf8")).resolves.toBe(
        envBytes,
      );
      await expect(fs.readFile(markerPath, "utf8")).resolves.toBe(
        markerBytes,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records worktree setup and provision operations when a recorder is provided", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'provisioned\\n'",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add recorder provision script"]);

    await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-540",
        title: "Record workspace operations",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(operations.map((operation) => operation.phase)).toEqual([
      "worktree_prepare",
      "workspace_provision",
    ]);
    expect(operations[0]?.command).toContain("git worktree add");
    expect(operations[0]?.metadata).toMatchObject({
      branchName: "PAP-540-record-workspace-operations",
      created: true,
    });
    expect(operations[1]?.command).toBe("bash ./scripts/provision.sh");
  });

  it("truncates oversized provision command output before storing it in memory", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "noisy.js"),
      'process.stdout.write("x".repeat(400000));\n',
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/noisy.js"]);
    await runGit(repoRoot, ["commit", "-m", "Add noisy provision script"]);

    await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "node ./scripts/noisy.js",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-1142",
        title: "Limit noisy provision output",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    const provisionOperation = operations.find((operation) => operation.phase === "workspace_provision");
    expect(provisionOperation?.result.metadata).toMatchObject({
      stdoutTruncated: true,
      stderrTruncated: false,
    });
    expect(provisionOperation?.result.stdout).toContain("[output truncated to last");
    expect(provisionOperation?.result.stdout?.length ?? 0).toBeLessThan(300000);
  }, 10_000);

  it("reuses an existing branch without resetting it when recreating a missing worktree", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-450-recreate-missing-worktree";

    await runGit(repoRoot, ["checkout", "-b", branchName]);
    await fs.writeFile(path.join(repoRoot, "feature.txt"), "preserve me\n", "utf8");
    await runGit(repoRoot, ["add", "feature.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add preserved feature"]);
    const expectedHead = (await execFileAsync("git", ["rev-parse", branchName], { cwd: repoRoot })).stdout.trim();
    await runGit(repoRoot, ["checkout", "main"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-450",
        title: "Recreate missing worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(workspace.branchName).toBe(branchName);
    await expect(fs.readFile(path.join(workspace.cwd, "feature.txt"), "utf8")).resolves.toBe("preserve me\n");
    const actualHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace.cwd })).stdout.trim();
    expect(actualHead).toBe(expectedHead);
  });

  it("reattaches a missing persisted git worktree before manual control starts it", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-451-restore-persisted-worktree";
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "restore.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "git branch --show-current > .paperclip-restored-branch",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(path.join(repoRoot, "scripts", "restore.sh"), 0o755);
    await runGit(repoRoot, ["add", "scripts/restore.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add restore script"]);

    await runGit(repoRoot, ["checkout", "-b", branchName]);
    await fs.writeFile(path.join(repoRoot, "feature.txt"), "persisted\n", "utf8");
    await runGit(repoRoot, ["add", "feature.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add persisted feature"]);
    const expectedHead = (await execFileAsync("git", ["rev-parse", branchName], { cwd: repoRoot })).stdout.trim();
    await runGit(repoRoot, ["checkout", "main"]);

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/restore.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-451",
        title: "Restore persisted worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await fs.rm(initial.cwd, { recursive: true, force: true });

    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: initial.cwd,
        providerRef: initial.worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName,
        config: {
          provisionCommand: "bash ./scripts/restore.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-451",
        title: "Restore persisted worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(restored).not.toBeNull();
    expect(restored?.cwd).toBe(initial.cwd);
    await expect(fs.readFile(path.join(initial.cwd, "feature.txt"), "utf8")).resolves.toBe("persisted\n");
    await expect(fs.readFile(path.join(initial.cwd, ".paperclip-restored-branch"), "utf8")).resolves.toBe(`${branchName}\n`);
    const actualHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: initial.cwd })).stdout.trim();
    expect(actualHead).toBe(expectedHead);
  }, 15_000);

  it("repairs a clean persisted git worktree branch mismatch when both branches point at the same commit", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-454-repair-clean-branch-mismatch";
    const actualBranch = "PAP-454-publish-head";
    const realWorktreeRoot = path.join(repoRoot, ".paperclip", "real-worktrees");
    const symlinkedWorktreeRoot = path.join(repoRoot, ".paperclip", "worktrees");
    const realWorktreePath = path.join(realWorktreeRoot, expectedBranch);
    const worktreePath = path.join(symlinkedWorktreeRoot, expectedBranch);
    await fs.mkdir(realWorktreeRoot, { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, realWorktreePath, "HEAD"]);
    await fs.symlink(realWorktreeRoot, symlinkedWorktreeRoot, "dir");
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: "execution-workspace-1",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: worktreePath,
        providerRef: worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: expectedBranch,
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-454",
        title: "Repair clean branch mismatch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(restored?.cwd).toBe(worktreePath);
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "worktree_prepare",
          command: "git checkout PAP-454-repair-clean-branch-mismatch",
          metadata: expect.objectContaining({
            branchIncoherenceRepair: true,
            expectedBranchName: expectedBranch,
            actualBranchName: actualBranch,
            sourceIssueId: "issue-1",
            executionWorkspaceId: "execution-workspace-1",
            fingerprint: expect.stringMatching(/^workspace_incoherence:v1:sha256:/),
          }),
        }),
      ]),
    );
  }, 15_000);

  it("reattaches a clean forward detached HEAD to the recorded persisted git worktree branch", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-454-reattach-detached-head";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", branchName);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", branchName]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);
    await runGit(worktreePath, ["checkout", "--detach"]);
    await fs.writeFile(path.join(worktreePath, "detached.txt"), "detached work\n", "utf8");
    await runGit(worktreePath, ["add", "detached.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Add detached work"]);
    const detachedHead = await readGit(worktreePath, ["rev-parse", "HEAD"]);

    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: "execution-workspace-detached",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: worktreePath,
        providerRef: worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName,
      },
      issue: {
        id: "issue-detached",
        identifier: "PAP-454",
        title: "Repair detached branch mismatch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(restored?.branchName).toBe(branchName);
    expect(restored?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("moved the recorded branch to that HEAD"),
    ]));
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(branchName);
    await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(detachedHead);
  }, 15_000);

  it("rejects dirty persisted git worktree branch incoherence with bounded recovery evidence", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-455-reject-dirty-branch-mismatch";
    const actualBranch = "PAP-455-publish-head";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "HEAD"]);
    await fs.writeFile(path.join(worktreePath, "untracked.txt"), "not safe to switch\n", "utf8");

    await expect(ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: "execution-workspace-2",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: worktreePath,
        providerRef: worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: expectedBranch,
      },
      issue: {
        id: "issue-2",
        identifier: "PAP-455",
        title: "Reject dirty branch mismatch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      enableWorkspaceDirtyQuarantineRepair: false,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          fingerprint: expect.stringMatching(/^workspace_incoherence:v1:sha256:/),
          sourceIssueId: "issue-2",
          sourceIdentifier: "PAP-455",
          executionWorkspaceId: "execution-workspace-2",
          expectedBranch,
          actualBranch,
          cleanliness: "dirty",
          dirtyPathSample: ["untracked.txt"],
          provenance: expect.objectContaining({
            expectedBranchExists: true,
            actualBranchExists: true,
            sameHead: true,
            ancestryVerdict: "ancestor",
            plainLanguageReason: expect.stringContaining("same commit"),
          }),
          safeRepair: expect.objectContaining({
            eligible: false,
            attempted: false,
            succeeded: false,
            reason: "worktree is not clean",
          }),
        }),
      },
    });
  }, 15_000);

  it("routes non-reusable persisted git worktrees through workspace validation recovery", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-455-not-registered-worktree";
    const detachedWorktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
    await fs.mkdir(path.dirname(detachedWorktreePath), { recursive: true });
    await execFileAsync("git", ["clone", repoRoot, detachedWorktreePath]);
    await runGit(detachedWorktreePath, ["checkout", "-B", expectedBranch]);

    await expect(ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: "execution-workspace-not-registered",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: detachedWorktreePath,
        providerRef: detachedWorktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: expectedBranch,
      },
      issue: {
        id: "issue-not-registered",
        identifier: "PAP-455",
        title: "Reject unregistered persisted worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: {
          reason: "git_worktree_not_reusable",
          reasonCode: "not_registered",
          worktreePath: detachedWorktreePath,
          executionWorkspaceId: "execution-workspace-not-registered",
        },
      },
    });
  }, 15_000);

  it("adopts an existing persisted git worktree when the checked-out branch is forward of the recorded branch", async () => {
    const repoRoot = await createTempRepo();

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-456",
        title: "Keep persisted branch coherent",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    const actualBranch = "PAP-456-push-pr-head";
    await runGit(initial.cwd, ["checkout", "-b", actualBranch]);
    await fs.writeFile(path.join(initial.cwd, "publish.txt"), "publish\n", "utf8");
    await runGit(initial.cwd, ["add", "publish.txt"]);
    await runGit(initial.cwd, ["commit", "-m", "Add publish branch work"]);

    if (!initial.branchName) throw new Error("expected realized worktree branch name");
    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: "execution-workspace-3",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: initial.cwd,
        providerRef: initial.worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: initial.branchName,
      },
      issue: {
        id: "issue-3",
        identifier: "PAP-456",
        title: "Keep persisted branch coherent",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(restored?.branchName).toBe(actualBranch);
    expect(restored?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("adopted it for subsequent runs"),
    ]));
    await expect(readGit(initial.cwd, ["branch", "--show-current"])).resolves.toBe(actualBranch);
  }, 15_000);

  it("classifies persisted git worktree branch incoherence as diverged when the checked-out branch is not forward", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-457-recorded-work";
    const actualBranch = "PAP-457-sibling-work";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "HEAD"]);

    await runGit(repoRoot, ["checkout", expectedBranch]);
    await fs.writeFile(path.join(repoRoot, "recorded.txt"), "recorded branch work\n", "utf8");
    await runGit(repoRoot, ["add", "recorded.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add recorded branch work"]);

    await fs.writeFile(path.join(worktreePath, "actual.txt"), "actual branch work\n", "utf8");
    await runGit(worktreePath, ["add", "actual.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Add actual branch work"]);

    let error: unknown = null;
    try {
      await ensurePersistedExecutionWorkspaceAvailable({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        workspace: {
          id: "execution-workspace-diverged",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: worktreePath,
          providerRef: worktreePath,
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
          repoUrl: null,
          baseRef: "HEAD",
          branchName: expectedBranch,
        },
        issue: {
          id: "issue-diverged",
          identifier: "PAP-457",
          title: "Classify diverged branch incoherence",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
        enableWorkspaceBranchReconcileForward: true,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          sourceIssueId: "issue-diverged",
          sourceIdentifier: "PAP-457",
          executionWorkspaceId: "execution-workspace-diverged",
          expectedBranch,
          actualBranch,
          cleanliness: "clean",
          provenance: expect.objectContaining({
            expectedBranchExists: true,
            actualBranchExists: true,
            sameHead: false,
            ancestryVerdict: "diverged",
            plainLanguageReason: expect.stringContaining("cannot prove a forward-only reconciliation"),
          }),
        }),
      },
    });
  }, 15_000);

  it("classifies persisted git worktree branch incoherence as unknown when the recorded branch was deleted", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-458-deleted-recorded-branch";
    const actualBranch = "PAP-458-actual-work";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "HEAD"]);
    await runGit(repoRoot, ["branch", "-D", expectedBranch]);

    let error: unknown = null;
    try {
      await ensurePersistedExecutionWorkspaceAvailable({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        workspace: {
          id: "execution-workspace-deleted-branch",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: worktreePath,
          providerRef: worktreePath,
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
          repoUrl: null,
          baseRef: "HEAD",
          branchName: expectedBranch,
        },
        issue: {
          id: "issue-deleted-branch",
          identifier: "PAP-458",
          title: "Classify deleted branch ancestry",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
        enableWorkspaceBranchReconcileForward: true,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          sourceIssueId: "issue-deleted-branch",
          sourceIdentifier: "PAP-458",
          executionWorkspaceId: "execution-workspace-deleted-branch",
          expectedBranch,
          actualBranch,
          cleanliness: "clean",
          provenance: expect.objectContaining({
            expectedBranchExists: false,
            actualBranchExists: true,
            expectedHeadSha: null,
            sameHead: false,
            ancestryVerdict: "unknown",
            plainLanguageReason: expect.stringContaining("missing a resolvable HEAD commit"),
          }),
          safeRepair: expect.objectContaining({
            eligible: false,
            attempted: false,
            succeeded: false,
            reason: "expected branch does not exist",
          }),
        }),
      },
    });
  }, 15_000);

  it("keeps forward reconciliation fail-closed for same-content rewritten history", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-459-recorded-content";
    const actualBranch = "PAP-459-rewritten-content";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);

    await runGit(repoRoot, ["checkout", "-b", expectedBranch]);
    await fs.writeFile(path.join(repoRoot, "same-content.txt"), "same content\n", "utf8");
    await runGit(repoRoot, ["add", "same-content.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add content on recorded branch"]);
    await runGit(repoRoot, ["checkout", "main"]);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "main"]);
    await fs.writeFile(path.join(worktreePath, "same-content.txt"), "same content\n", "utf8");
    await runGit(worktreePath, ["add", "same-content.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Add content on rewritten branch"]);

    await expectPersistedBranchMismatchRejected({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      issueId: "issue-rewritten-history",
      executionWorkspaceId: "execution-workspace-rewritten-history",
      expectedAncestryVerdict: "diverged",
      expectedReason: "expected branch and current HEAD differ",
    });
  }, 15_000);

  it("keeps forward reconciliation fail-closed for an unrelated task branch", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-459-recorded-task";
    const actualBranch = "PAP-999-unrelated-task";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);

    await runGit(repoRoot, ["checkout", "-b", expectedBranch]);
    await fs.writeFile(path.join(repoRoot, "recorded-task.txt"), "recorded task work\n", "utf8");
    await runGit(repoRoot, ["add", "recorded-task.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add recorded task work"]);
    await runGit(repoRoot, ["checkout", "main"]);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "main"]);
    await fs.writeFile(path.join(worktreePath, "unrelated-task.txt"), "unrelated task work\n", "utf8");
    await runGit(worktreePath, ["add", "unrelated-task.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Add unrelated task work"]);

    await expectPersistedBranchMismatchRejected({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      issueId: "issue-unrelated-task",
      executionWorkspaceId: "execution-workspace-unrelated-task",
      expectedAncestryVerdict: "diverged",
      expectedReason: "expected branch and current HEAD differ",
    });
  }, 15_000);

  it("keeps forward reconciliation fail-closed when the live branch is behind the recorded branch", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-459-recorded-ahead";
    const actualBranch = "PAP-459-live-behind";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, expectedBranch]);

    await runGit(repoRoot, ["checkout", expectedBranch]);
    await fs.writeFile(path.join(repoRoot, "recorded-ahead.txt"), "recorded branch moved ahead\n", "utf8");
    await runGit(repoRoot, ["add", "recorded-ahead.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Move recorded branch ahead"]);

    await expectPersistedBranchMismatchRejected({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      issueId: "issue-live-behind",
      executionWorkspaceId: "execution-workspace-live-behind",
      expectedAncestryVerdict: "diverged",
      expectedReason: "expected branch and current HEAD differ",
    });
  }, 15_000);

  it("does not reuse a missing persisted local filesystem workspace", async () => {
    const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-base-"));
    const missingCwd = path.join(baseCwd, "missing-workspace");

    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
      workspace: {
        mode: "shared_workspace",
        strategyType: "project_primary",
        cwd: missingCwd,
        providerRef: null,
        projectId: "project-1",
        projectWorkspaceId: null,
        repoUrl: null,
        baseRef: null,
        branchName: null,
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-453",
        title: "Missing local workspace",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(restored).toBeNull();
  });

  it("reprovisions an existing persisted git worktree before manual control starts it", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "restore.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'reprovisioned\\n' > .paperclip-restored-state",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(path.join(repoRoot, "scripts", "restore.sh"), 0o755);
    await runGit(repoRoot, ["add", "scripts/restore.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add reprovision script"]);

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/restore.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-452",
        title: "Reprovision persisted worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await fs.rm(path.join(initial.cwd, ".paperclip-restored-state"), { force: true });

    await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: initial.cwd,
        providerRef: initial.worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: initial.branchName,
        config: {
          provisionCommand: "bash ./scripts/restore.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-452",
        title: "Reprovision persisted worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(initial.cwd, ".paperclip-restored-state"), "utf8")).resolves.toBe("reprovisioned\n");
  }, 15_000);

  it("auto-detects the default branch when baseRef is not configured", async () => {
    // Create a repo with "master" as default branch (not "main")
    const repoRoot = await createTempRepo("master");

    // Set up a bare remote and push master so refs/remotes/origin/master
    // exists locally. Note: refs/remotes/origin/HEAD is NOT set by a manual
    // fetch — that requires git clone or git remote set-head. This test
    // exercises the heuristic fallback path in detectDefaultBranch.
    const bareRemote = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-bare-"));
    await runGit(bareRemote, ["init", "--bare"]);
    await runGit(repoRoot, ["remote", "add", "origin", bareRemote]);
    await runGit(repoRoot, ["push", "-u", "origin", "master"]);
    await runGit(repoRoot, ["fetch", "origin"]);

    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: null,
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          // No baseRef configured — should default to origin/master.
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-460",
        title: "Auto detect default branch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(workspace.strategy).toBe("git_worktree");
    expect(workspace.created).toBe(true);
    // The worktree should have been created successfully from the canonical remote base.
    const worktreeOp = operations.find(op => op.phase === "worktree_prepare" && op.metadata?.created);
    expect(worktreeOp).toBeDefined();
    expect(worktreeOp!.metadata!.baseRef).toBe("origin/master");
  }, 10_000);

  it("auto-detects the default branch via symbolic-ref when origin/HEAD is set", async () => {
    const repoRoot = await createTempRepo("main");
    await runGit(repoRoot, ["branch", "-f", "master", "main"]);

    const bareRemote = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-bare-symref-"));
    await runGit(bareRemote, ["init", "--bare"]);
    await runGit(repoRoot, ["remote", "add", "origin", bareRemote]);
    await runGit(repoRoot, ["branch", "-f", "master"]);
    await runGit(repoRoot, ["push", "-u", "origin", "main", "master"]);
    await runGit(repoRoot, ["fetch", "origin"]);
    // Explicitly set refs/remotes/origin/HEAD to exercise the symbolic-ref path
    // (git remote set-head -a requires the remote to advertise HEAD, so we set it manually)
    await runGit(repoRoot, ["remote", "set-head", "origin", "main"]);

    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: null,
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          // No baseRef configured — origin/master is preferred over the symbolic-ref.
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-461",
        title: "Auto detect default branch via symref",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(workspace.strategy).toBe("git_worktree");
    expect(workspace.created).toBe(true);
    const worktreeOp = operations.find(op => op.phase === "worktree_prepare" && op.metadata?.created);
    expect(worktreeOp).toBeDefined();
    expect(worktreeOp!.metadata!.baseRef).toBe("origin/master");
  }, 10_000);

  it("removes a created git worktree and branch during cleanup", async () => {
    const repoRoot = await createTempRepo();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-449",
        title: "Cleanup workspace",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toEqual([]);
    await expect(fs.stat(workspace.cwd)).rejects.toThrow();
    await expect(
      execFileAsync("git", ["branch", "--list", workspace.branchName!], { cwd: repoRoot }),
    ).resolves.toMatchObject({
      stdout: "",
    });
  });

  it("keeps an unmerged runtime-created branch and warns instead of force deleting it", async () => {
    const repoRoot = await createTempRepo();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-451",
        title: "Keep unmerged branch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await fs.writeFile(path.join(workspace.cwd, "unmerged.txt"), "still here\n", "utf8");
    await runGit(workspace.cwd, ["add", "unmerged.txt"]);
    await runGit(workspace.cwd, ["commit", "-m", "Keep unmerged work"]);

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toHaveLength(1);
    expect(cleanup.warnings[0]).toContain(`Skipped deleting branch "${workspace.branchName}"`);
    await expect(
      execFileAsync("git", ["branch", "--list", workspace.branchName!], { cwd: repoRoot }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining(workspace.branchName!),
    });
  }, 10_000);

  it("records teardown and cleanup operations when a recorder is provided", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-541",
        title: "Cleanup recorder",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: "printf 'cleanup ok\\n'",
      },
      recorder,
    });

    expect(operations.map((operation) => operation.phase)).toEqual([
      "workspace_teardown",
      "worktree_cleanup",
      "worktree_cleanup",
    ]);
    expect(operations[0]?.command).toBe("printf 'cleanup ok\\n'");
    expect(operations[1]?.metadata).toMatchObject({
      cleanupAction: "worktree_remove",
    });
    expect(operations[2]?.metadata).toMatchObject({
      cleanupAction: "branch_delete",
    });
  });
});

describe("ensureRuntimeServicesForRun", () => {
  it("leaves manual runtime services untouched during agent runs", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-manual-"));
    const workspace = buildWorkspace(workspaceRoot);

    const services = await ensureRuntimeServicesForRun({
      runId: "run-manual",
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config: {
        desiredState: "manual",
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command: "node -e \"throw new Error('should not start')\"",
              port: { type: "auto" },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(services).toEqual([]);
  });

  it("requires Paperclip dev runtime services to pass /api/health readiness", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-health-"));
    const workspace = buildWorkspace(workspaceRoot);
    const runId = "run-paperclip-health";
    const serviceCommand =
      "node -e \"const http=require('node:http'); http.createServer((req,res)=>{ if (req.url==='/api/health') { res.statusCode=503; res.end('database_unreachable'); return; } res.end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1')\"";

    try {
      await expect(
        ensureRuntimeServicesForRun({
          runId,
          agent: {
            id: "agent-1",
            name: "Codex Coder",
            companyId: "company-1",
          },
          issue: null,
          workspace,
          config: {
            workspaceRuntime: {
              services: [
                {
                  name: "paperclip-dev",
                  command: serviceCommand,
                  cwd: ".",
                  port: { type: "auto" },
                  readiness: {
                    type: "http",
                    urlTemplate: "http://127.0.0.1:{{port}}",
                    timeoutSec: 3,
                    intervalMs: 100,
                  },
                  expose: {
                    type: "url",
                    urlTemplate: "http://127.0.0.1:{{port}}",
                  },
                  lifecycle: "shared",
                  stopPolicy: {
                    type: "manual",
                  },
                },
              ],
            },
          },
          adapterEnv: {},
        }),
      ).rejects.toThrow(/Readiness check failed for http:\/\/127\.0\.0\.1:\d+\/api\/health: received HTTP 503/);
    } finally {
      await releaseRuntimeServicesForRun(runId);
    }
  });

  it("uses explicit readiness URL when exposed URL is not the local probe address", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-explicit-readiness-"));
    const workspace = buildWorkspace(workspaceRoot);
    const runId = "run-paperclip-explicit-readiness";
    const serviceCommand =
      "node -e \"const http=require('node:http'); http.createServer((req,res)=>{ if (req.url==='/api/health') { res.end('ok'); return; } res.statusCode=404; res.end('not found'); }).listen(Number(process.env.PORT), '127.0.0.1')\"";

    try {
      const services = await ensureRuntimeServicesForRun({
        runId,
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
        issue: null,
        workspace,
        config: {
          workspaceRuntime: {
            services: [
              {
                name: "paperclip-dev",
                command: serviceCommand,
                cwd: ".",
                port: { type: "auto" },
                readiness: {
                  type: "http",
                  urlTemplate: "http://127.0.0.1:{{port}}/api/health",
                  timeoutSec: 3,
                  intervalMs: 100,
                },
                expose: {
                  type: "url",
                  urlTemplate: "http://not-a-real-paperclip-host.invalid:{{port}}",
                },
                lifecycle: "shared",
                stopPolicy: {
                  type: "manual",
                },
              },
            ],
          },
        },
        adapterEnv: {},
      });

      expect(services).toHaveLength(1);
      expect(services[0]?.url).toMatch(/^http:\/\/not-a-real-paperclip-host\.invalid:\d+$/);
    } finally {
      await releaseRuntimeServicesForRun(runId);
    }
  });

  it("reuses shared runtime services across runs and starts a new service after release", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-workspace-"));
    const workspace = buildWorkspace(workspaceRoot);
    const serviceCommand =
      "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"";

    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "web",
            command: serviceCommand,
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            expose: {
              type: "url",
              urlTemplate: "http://127.0.0.1:{{port}}",
            },
            lifecycle: "shared",
            reuseScope: "project_workspace",
            stopPolicy: {
              type: "on_run_finish",
            },
          },
        ],
      },
    };

    const run1 = "run-1";
    const run2 = "run-2";
    leasedRunIds.add(run1);
    leasedRunIds.add(run2);

    const first = await ensureRuntimeServicesForRun({
      runId: run1,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.reused).toBe(false);
    expect(first[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(first[0]!.url!);
    expect(await response.text()).toBe("ok");

    const second = await ensureRuntimeServicesForRun({
      runId: run2,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.reused).toBe(true);
    expect(second[0]?.id).toBe(first[0]?.id);

    await releaseRuntimeServicesForRun(run1);
    leasedRunIds.delete(run1);
    await releaseRuntimeServicesForRun(run2);
    leasedRunIds.delete(run2);

    const run3 = "run-3";
    leasedRunIds.add(run3);
    const third = await ensureRuntimeServicesForRun({
      runId: run3,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(third).toHaveLength(1);
    expect(third[0]?.reused).toBe(false);
    expect(third[0]?.id).not.toBe(first[0]?.id);
  }, 10_000);

  it("does not reuse project-scoped shared services across different workspace launch contexts", async () => {
    const primaryWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-primary-"));
    const worktreeWorkspaceRoot = path.join(primaryWorkspaceRoot, ".paperclip", "worktrees", "PAP-874-chat-speed-issues");
    await fs.mkdir(worktreeWorkspaceRoot, { recursive: true });

    const primaryWorkspace = buildWorkspace(primaryWorkspaceRoot);
    const executionWorkspace: RealizedExecutionWorkspace = {
      ...buildWorkspace(worktreeWorkspaceRoot),
      source: "task_session",
      strategy: "git_worktree",
      cwd: worktreeWorkspaceRoot,
      branchName: "PAP-874-chat-speed-issues",
      worktreePath: worktreeWorkspaceRoot,
    };
    const serviceCommand =
      "node -e \"require('node:http').createServer((req,res)=>res.end(process.env.PAPERCLIP_HOME)).listen(Number(process.env.PORT), '127.0.0.1')\"";
    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "paperclip-dev",
            command: serviceCommand,
            cwd: ".",
            env: {
              PAPERCLIP_HOME: "{{workspace.cwd}}/.paperclip/runtime-services",
            },
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            expose: {
              type: "url",
              urlTemplate: "http://127.0.0.1:{{port}}",
            },
            lifecycle: "shared",
            reuseScope: "project_workspace",
            stopPolicy: {
              type: "on_run_finish",
            },
          },
        ],
      },
    };

    const primaryRunId = "run-project-workspace";
    const workspaceRunId = "run-execution-workspace";
    leasedRunIds.add(primaryRunId);
    leasedRunIds.add(workspaceRunId);

    const primaryServices = await ensureRuntimeServicesForRun({
      runId: primaryRunId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace: primaryWorkspace,
      config,
      adapterEnv: {},
    });

    const executionServices = await ensureRuntimeServicesForRun({
      runId: workspaceRunId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace: executionWorkspace,
      executionWorkspaceId: "execution-workspace-1",
      config,
      adapterEnv: {},
    });

    expect(primaryServices).toHaveLength(1);
    expect(executionServices).toHaveLength(1);
    expect(primaryServices[0]?.reused).toBe(false);
    expect(executionServices[0]?.reused).toBe(false);
    expect(executionServices[0]?.id).not.toBe(primaryServices[0]?.id);
    expect(executionServices[0]?.executionWorkspaceId).toBe("execution-workspace-1");
    expect(executionServices[0]?.cwd).toBe(worktreeWorkspaceRoot);
    expect(executionServices[0]?.url).not.toBe(primaryServices[0]?.url);

    const primaryResponse = await fetch(primaryServices[0]!.url!);
    expect(await primaryResponse.text()).toBe(path.join(primaryWorkspaceRoot, ".paperclip", "runtime-services"));

    const executionResponse = await fetch(executionServices[0]!.url!);
    expect(await executionResponse.text()).toBe(path.join(worktreeWorkspaceRoot, ".paperclip", "runtime-services"));
  });

  it("does not leak parent Paperclip instance env into runtime service commands", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-env-"));
    const workspace = buildWorkspace(workspaceRoot);
    const envCapturePath = path.join(workspaceRoot, "captured-env.json");
    const serviceCommand = [
      "node -e",
      JSON.stringify(
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(envCapturePath)}, JSON.stringify({`,
          "paperclipConfig: process.env.PAPERCLIP_CONFIG ?? null,",
          "paperclipHome: process.env.PAPERCLIP_HOME ?? null,",
          "paperclipInstanceId: process.env.PAPERCLIP_INSTANCE_ID ?? null,",
          "databaseUrl: process.env.DATABASE_URL ?? null,",
          "customEnv: process.env.RUNTIME_CUSTOM_ENV ?? null,",
          "port: process.env.PORT ?? null,",
          "}));",
          "require('node:http').createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
        ].join(" "),
      ),
    ].join(" ");

    process.env.PAPERCLIP_CONFIG = "/tmp/base-paperclip-config.json";
    process.env.PAPERCLIP_HOME = "/tmp/base-paperclip-home";
    process.env.PAPERCLIP_INSTANCE_ID = "base-instance";
    process.env.DATABASE_URL = "postgres://shared-db.example.com/paperclip";

    const runId = "run-env";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command: serviceCommand,
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "on_run_finish",
              },
            },
          ],
        },
      },
      adapterEnv: {
        RUNTIME_CUSTOM_ENV: "from-adapter",
      },
    });

    expect(services).toHaveLength(1);
    const captured = JSON.parse(await fs.readFile(envCapturePath, "utf8")) as Record<string, string | null>;
    expect(captured.paperclipConfig).toBeNull();
    expect(captured.paperclipHome).toBeNull();
    expect(captured.paperclipInstanceId).toBeNull();
    expect(captured.databaseUrl).toBeNull();
    expect(captured.customEnv).toBe("from-adapter");
    expect(captured.port).toMatch(/^\d+$/);
    expect(services[0]?.executionWorkspaceId).toBe("execution-workspace-1");
    expect(services[0]?.scopeType).toBe("execution_workspace");
    expect(services[0]?.scopeId).toBe("execution-workspace-1");
  });

  it("stops execution workspace runtime services by executionWorkspaceId", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-stop-"));
    const workspace = buildWorkspace(workspaceRoot);
    const runId = "run-stop";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-stop",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(services[0]?.url).toBeTruthy();
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-stop",
      workspaceCwd: workspace.cwd,
    });
    await releaseRuntimeServicesForRun(runId);
    leasedRunIds.delete(runId);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await expect(fetch(services[0]!.url!)).rejects.toThrow();
  });

  it("does not stop services in sibling directories when matching by workspace cwd", async () => {
    const workspaceParent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-sibling-"));
    const targetWorkspaceRoot = path.join(workspaceParent, "project");
    const siblingWorkspaceRoot = path.join(workspaceParent, "project-extended", "service");
    await fs.mkdir(targetWorkspaceRoot, { recursive: true });
    await fs.mkdir(siblingWorkspaceRoot, { recursive: true });

    const siblingWorkspace = buildWorkspace(siblingWorkspaceRoot);
    const runId = "run-sibling";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace: siblingWorkspace,
      executionWorkspaceId: "execution-workspace-sibling",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-target",
      workspaceCwd: targetWorkspaceRoot,
    });

    const response = await fetch(services[0]!.url!);
    expect(await response.text()).toBe("ok");

    await releaseRuntimeServicesForRun(runId);
    leasedRunIds.delete(runId);
  });

  it("starts only the selected workspace-controlled runtime service", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-control-start-"));
    const workspace = buildWorkspace(workspaceRoot);

    const services = await startRuntimeServicesForWorkspaceControl({
      actor: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-control-start",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('web')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
            },
            {
              name: "worker",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('worker')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
            },
          ],
        },
      },
      adapterEnv: {},
      serviceIndex: 1,
    });

    expect(services).toHaveLength(1);
    expect(services[0]?.serviceName).toBe("worker");
    await expect(fetch(services[0]!.url!)).resolves.toMatchObject({ ok: true });

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-control-start",
      workspaceCwd: workspace.cwd,
    });
  });

  it("stops only the selected execution workspace runtime service", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-control-stop-"));
    const workspace = buildWorkspace(workspaceRoot);

    const services = await startRuntimeServicesForWorkspaceControl({
      actor: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-control-stop",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('web')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
            {
              name: "worker",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('worker')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(services).toHaveLength(2);
    const web = services.find((service) => service.serviceName === "web");
    const worker = services.find((service) => service.serviceName === "worker");

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-control-stop",
      workspaceCwd: workspace.cwd,
      runtimeServiceId: web?.id ?? null,
    });

    await expect(fetch(web!.url!)).rejects.toThrow();
    await expect(fetch(worker!.url!)).resolves.toMatchObject({ ok: true });

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-control-stop",
      workspaceCwd: workspace.cwd,
      runtimeServiceId: worker?.id ?? null,
    });
  }, 10_000);
});

describe("buildWorkspaceRuntimeDesiredStatePatch", () => {
  it("derives service entries from command-first runtime config", () => {
    const services = listConfiguredRuntimeServiceEntries({
      workspaceRuntime: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
          { id: "db-migrate", name: "db:migrate", kind: "job", command: "pnpm db:migrate" },
        ],
      },
    });

    expect(services).toEqual([
      expect.objectContaining({
        id: "web",
        kind: "service",
        command: "pnpm dev",
      }),
    ]);
  });

  it("preserves sibling service state when updating a single configured runtime service", () => {
    const patch = buildWorkspaceRuntimeDesiredStatePatch({
      config: {
        workspaceRuntime: {
          services: [
            { name: "web", command: "pnpm dev" },
            { name: "worker", command: "pnpm worker" },
          ],
        },
      },
      currentDesiredState: "running",
      currentServiceStates: null,
      action: "stop",
      serviceIndex: 1,
    });

    expect(patch).toEqual({
      desiredState: "running",
      serviceStates: {
        "0": "running",
        "1": "stopped",
      },
    });
  });

  it("preserves manual service state when manually starting or stopping services", () => {
    const baseInput = {
      config: {
        workspaceRuntime: {
          services: [
            { name: "web", command: "pnpm dev" },
          ],
        },
      },
      currentDesiredState: "manual" as const,
      currentServiceStates: null,
      serviceIndex: 0,
    };

    expect(buildWorkspaceRuntimeDesiredStatePatch({
      ...baseInput,
      action: "start",
    })).toEqual({
      desiredState: "manual",
      serviceStates: {
        "0": "manual",
      },
    });

    expect(buildWorkspaceRuntimeDesiredStatePatch({
      ...baseInput,
      action: "stop",
    })).toEqual({
      desiredState: "manual",
      serviceStates: {
        "0": "manual",
      },
    });
  });
});

describe("resolveWorkspaceRuntimeReadinessTimeoutSec", () => {
  it("extends the default readiness timeout for dev-server commands", () => {
    expect(
      resolveWorkspaceRuntimeReadinessTimeoutSec({
        command: "pnpm dev",
        readiness: {
          type: "http",
          urlTemplate: "http://127.0.0.1:{{port}}",
        },
      }),
    ).toBe(90);
    expect(
      resolveWorkspaceRuntimeReadinessTimeoutSec({
        command: "npm run dev -- --host 127.0.0.1",
        readiness: {
          type: "http",
          urlTemplate: "http://127.0.0.1:{{port}}",
        },
      }),
    ).toBe(90);
  });

  it("keeps explicit readiness timeouts and non-dev defaults unchanged", () => {
    expect(
      resolveWorkspaceRuntimeReadinessTimeoutSec({
        command: "pnpm dev",
        readiness: {
          type: "http",
          timeoutSec: 12,
          urlTemplate: "http://127.0.0.1:{{port}}",
        },
      }),
    ).toBe(12);
    expect(
      resolveWorkspaceRuntimeReadinessTimeoutSec({
        command: "node server.js",
        readiness: {
          type: "http",
          urlTemplate: "http://127.0.0.1:{{port}}",
        },
      }),
    ).toBe(30);
  });
});

describe("resolveShell (shell fallback)", () => {
  const originalShell = process.env.SHELL;
  const originalPlatform = process.platform;

  afterEach(() => {
    if (originalShell !== undefined) {
      process.env.SHELL = originalShell;
    } else {
      delete process.env.SHELL;
    }
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("returns process.env.SHELL when set", () => {
    process.env.SHELL = process.execPath;
    expect(resolveShell()).toBe(process.execPath);
  });

  it("trims whitespace from SHELL env var", () => {
    process.env.SHELL = `  ${process.execPath}  `;
    expect(resolveShell()).toBe(process.execPath);
  });

  it("preserves non-absolute shell names so PATH lookup still works", () => {
    process.env.SHELL = "zsh";
    expect(resolveShell()).toBe("zsh");
  });

  it("falls back to /bin/sh on non-Windows when SHELL is unset", () => {
    delete process.env.SHELL;
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(resolveShell()).toBe("/bin/sh");
  });

  it("falls back to sh (bare) on Windows when SHELL is unset", () => {
    delete process.env.SHELL;
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(resolveShell()).toBe("sh");
  });

  it("falls back to /bin/sh on darwin when SHELL is unset", () => {
    delete process.env.SHELL;
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(resolveShell()).toBe("/bin/sh");
  });

  it("treats empty SHELL as unset and uses platform fallback", () => {
    process.env.SHELL = "";
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(resolveShell()).toBe("/bin/sh");
  });

  it("treats whitespace-only SHELL as unset and uses platform fallback", () => {
    process.env.SHELL = "   ";
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(resolveShell()).toBe("sh");
  });

  it("falls back when SHELL points to a missing absolute path", () => {
    process.env.SHELL = "/definitely/missing/zsh";
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(resolveShell()).toBe("/bin/sh");
  });
});

describe("readLocalServicePortOwner", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("detects the owner of a listening TCP port", async () => {
    try {
      await execFileAsync("lsof", ["-v"]);
    } catch {
      return;
    }

    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      expect(port).toBeTypeOf("number");

      const owner = await readLocalServicePortOwner(port!);
      expect(owner).toBe(process.pid);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it("accepts service cwd nested within the requested workspace", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-workspace-"));
    const serviceCwd = path.join(workspace, "server");
    await fs.mkdir(serviceCwd);

    await expect(isLocalServiceProcessInWorkspace(serviceCwd, workspace)).resolves.toBe(true);
  });

  it("keeps a live registry record adoptable when cwd inspection is unsupported", async () => {
    try {
      await execFileAsync("lsof", ["-v"]);
    } catch {
      return;
    }

    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    const serviceKey = `unsupported-cwd-${randomUUID()}`;
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `unsupported-cwd-${randomUUID()}`;
    expect(port).toBeTypeOf("number");

    try {
      await writeLocalServiceRegistryRecord({
        version: 1,
        serviceKey,
        profileKind: "workspace-runtime",
        serviceName: "node",
        command: "node",
        cwd: process.cwd(),
        envFingerprint: "",
        port,
        url: null,
        pid: process.pid,
        processGroupId: null,
        provider: "local_process",
        runtimeServiceId: null,
        reuseKey: null,
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        metadata: null,
      });
      Object.defineProperty(process, "platform", { value: "darwin" });

      await expect(findAdoptableLocalService({
        serviceKey,
        cwd: process.cwd(),
        port,
      })).resolves.toMatchObject({ pid: expect.any(Number), port });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  it("trusts unavailable cwd for registry records only off Linux", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    await expect(isLocalServiceRegistryCwdCompatible(null, process.cwd())).resolves.toBe(true);

    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(isLocalServiceRegistryCwdCompatible(null, process.cwd())).resolves.toBe(false);
  });

  it("refuses to adopt a listener whose real cwd belongs to another workspace", async () => {
    if (process.platform !== "linux") return;
    try {
      await execFileAsync("lsof", ["-v"]);
    } catch {
      return;
    }

    const targetWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-target-"));
    const ownerWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-owner-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `cross-workspace-${randomUUID()}`;
    const serviceKey = `cross-workspace-${randomUUID()}`;
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const server=require('node:http').createServer((req,res)=>res.end('ok')); server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
      ],
      { cwd: ownerWorkspace, stdio: ["ignore", "pipe", "inherit"] },
    );
    const port = await new Promise<number>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        const value = Number.parseInt(output.trim(), 10);
        if (Number.isInteger(value) && value > 0) resolve(value);
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Port owner exited before listening: ${code ?? "unknown"}`)));
    });

    try {
      await expect(findAdoptableLocalService({
        serviceKey,
        serviceName: "node",
        command: "node",
        cwd: targetWorkspace,
        port,
      })).resolves.toBeNull();

      await writeLocalServiceRegistryRecord({
        version: 1,
        serviceKey,
        profileKind: "workspace-runtime",
        serviceName: "node",
        command: "node",
        cwd: targetWorkspace,
        envFingerprint: "",
        port,
        url: null,
        pid: child.pid!,
        processGroupId: null,
        provider: "local_process",
        runtimeServiceId: null,
        reuseKey: null,
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        metadata: null,
      });
      await expect(findAdoptableLocalService({
        serviceKey,
        serviceName: "node",
        command: "node",
        cwd: targetWorkspace,
        port,
      })).resolves.toBeNull();

      await expect(startRuntimeServicesForWorkspaceControl({
        actor: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
        issue: null,
        workspace: buildWorkspace(targetWorkspace),
        config: {
          workspaceRuntime: {
            services: [{
              name: "web",
              command: "node",
              cwd: ".",
              port,
              lifecycle: "shared",
            }],
          },
        },
        adapterEnv: {},
      })).rejects.toThrow(new RegExp(`cross-workspace port conflict.*pid ${child.pid}.*${ownerWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });
});

describe("workspace dirty quarantine branch repair", () => {
  async function createDirtyMismatchRepo(input: {
    expectedBranch: string;
    actualBranch: string;
  }) {
    const repoRoot = await createTempRepo();
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", input.expectedBranch);
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
    const actualBranchHead = await readGit(worktreePath, ["rev-parse", input.actualBranch]);
    await fs.appendFile(path.join(worktreePath, "README.md"), "dirty tracked work\n", "utf8");
    await fs.writeFile(path.join(worktreePath, "untracked.txt"), "dirty untracked work\n", "utf8");
    return { repoRoot, worktreePath, actualBranchHead };
  }

  function createDirtyQuarantineFixture(input: {
    repoRoot: string;
    worktreePath: string;
    expectedBranch: string;
    actualBranch: string;
    sourceIdentifier?: string;
    claimant?: "idle" | "active" | "none";
    activeRuntimeService?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const sourceWorkspaceId = randomUUID();
    const runId = randomUUID();
    const claimant = input.claimant && input.claimant !== "none"
      ? {
          issueId: randomUUID(),
          workspaceId: randomUUID(),
          runId: input.claimant === "active" ? randomUUID() : null,
          identifier: "PAP-999",
        }
      : null;
    const contention = claimant
      ? {
          claimedByWorkspaceId: claimant.workspaceId,
          claimedByIssueId: claimant.issueId,
          claimedByIssueIdentifier: claimant.identifier,
          activeRun: claimant.runId
            ? {
                id: claimant.runId,
                status: "running" as const,
                issueId: claimant.issueId,
                issueIdentifier: claimant.identifier,
              }
            : null,
        }
      : null;

    workspaceRuntimeDependencyMocks.findGitWorktreeContention.mockResolvedValue(contention);

    const selectResults: unknown[] = [[{ companyId }]];
    if (!contention) {
      selectResults.push([
        {
          id: sourceWorkspaceId,
          companyId,
          projectId,
          projectWorkspaceId,
          sourceIssueId,
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: input.worktreePath,
          providerRef: input.worktreePath,
          branchName: input.expectedBranch,
          metadata: null,
        },
      ]);
      selectResults.push(
        input.activeRuntimeService
          ? [{
              id: randomUUID(),
              serviceName: "paperclip-dev",
              status: "running",
              scopeType: "execution_workspace",
            }]
          : [],
      );
      if (!input.activeRuntimeService) {
        selectResults.push([{ companyId }]);
        selectResults.push([{ companyId }]);
      }
    }

    const database = createMockDb({ select: selectResults });
    return {
      database,
      ids: {
        companyId,
        agentId,
        projectId,
        projectWorkspaceId,
        sourceIssueId,
        sourceWorkspaceId,
        runId,
        claimant,
        sourceIdentifier: input.sourceIdentifier ?? "PAP-455",
      },
    };
  }

  async function restoreDirtyQuarantine(input: {
    repoRoot: string;
    worktreePath: string;
    expectedBranch: string;
    fixture: ReturnType<typeof createDirtyQuarantineFixture>;
    recorder?: WorkspaceOperationRecorder | null;
  }) {
    const ids = input.fixture.ids;
    return ensurePersistedExecutionWorkspaceAvailable({
      db: input.fixture.database.db,
      base: {
        baseCwd: input.repoRoot,
        source: "project_primary",
        projectId: ids.projectId,
        workspaceId: ids.projectWorkspaceId,
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: ids.sourceWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: input.worktreePath,
        providerRef: input.worktreePath,
        projectId: ids.projectId,
        projectWorkspaceId: ids.projectWorkspaceId,
        repoUrl: null,
        baseRef: "HEAD",
        branchName: input.expectedBranch,
      },
      issue: {
        id: ids.sourceIssueId,
        identifier: ids.sourceIdentifier,
        title: "Repair dirty branch mismatch",
      },
      agent: {
        id: ids.agentId,
        name: "Codex Coder",
        companyId: ids.companyId,
      },
      runId: ids.runId,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      recorder: input.recorder ?? null,
    });
  }

  it("quarantines dirty foreign-branch work before restoring the recorded branch", async () => {
    const expectedBranch = "PAP-455-recorded";
    const actualBranch = "PAP-455-live";
    const { repoRoot, worktreePath, actualBranchHead } = await createDirtyMismatchRepo({
      expectedBranch,
      actualBranch,
    });
    const fixture = createDirtyQuarantineFixture({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-455",
      claimant: "none",
    });
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const restored = await restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      fixture,
      recorder,
    });

    expect(restored?.branchName).toBe(expectedBranch);
    const warning = restored?.warnings.find((entry) => entry.includes("dirty worktree state was quarantined"));
    expect(warning).toBeTruthy();
    const rescueBranch = warning?.match(/"([^"]+)"/)?.[1] ?? "";
    expect(rescueBranch).toMatch(/^paperclip\/rescue\/PAP-455\/\d{8}T\d{6}Z$/);
    const rescueCommitSha = await readGit(repoRoot, ["rev-parse", rescueBranch]);
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.toBe("");
    await expect(readGit(repoRoot, ["rev-parse", actualBranch])).resolves.toBe(actualBranchHead);
    await expect(readGit(repoRoot, ["show", rescueBranch + ":untracked.txt"])).resolves.toBe("dirty untracked work");

    const notice = workspaceRuntimeDependencyMocks.appendCanonicalControlNotice.mock.calls[0]?.[1] as {
      issueId: string;
      exactText: string;
    };
    expect(notice.issueId).toBe(fixture.ids.sourceIssueId);
    expect(notice.exactText).toContain("Rescue branch:");
    expect(notice.exactText).toContain(rescueBranch);
    expect(notice.exactText).toContain(rescueCommitSha);
    expect(notice.exactText).toContain("Dirty file count:");
    expect(notice.exactText).toContain("untracked.txt");
    expect(notice.exactText).toContain("Claimant: none");

    const activity = workspaceRuntimeDependencyMocks.logActivity.mock.calls[0]?.[1] as {
      action: string;
      entityType: string;
      entityId: string;
      details: Record<string, unknown>;
    };
    expect(activity).toMatchObject({
      action: "execution_workspace.dirty_worktree_quarantined",
      entityType: "execution_workspace",
      entityId: fixture.ids.sourceWorkspaceId,
      details: {
        rescueBranch,
        rescueCommitSha,
        fileCount: 2,
      },
    });
    expect(activity.details.dirtyPathSample).toEqual(expect.arrayContaining(["README.md", "untracked.txt"]));
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: "git checkout -b " + rescueBranch,
        metadata: expect.objectContaining({
          branchIncoherenceDirtyQuarantineRepair: true,
          rescueBranch,
          fileCount: 2,
        }),
      }),
      expect.objectContaining({
        command: null,
        metadata: expect.objectContaining({
          branchIncoherenceDirtyQuarantineRepair: true,
          rescueBranch,
          rescueCommitSha,
        }),
      }),
    ]));
    expect(fixture.database.remaining("select")).toBe(0);
  }, 20_000);

  it("quarantines a worktree wedged mid-rebase and clears the interrupted state", async () => {
    const expectedBranch = "PAP-456-recorded";
    const repoRoot = await createTempRepo("master");
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, expectedBranch]);
    await fs.writeFile(path.join(worktreePath, "README.md"), "feature change\n", "utf8");
    await runGit(worktreePath, ["commit", "-am", "Feature change"]);
    const expectedBranchHead = await readGit(worktreePath, ["rev-parse", expectedBranch]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "master change\n", "utf8");
    await runGit(repoRoot, ["commit", "-am", "Master change"]);
    await expect(runGit(worktreePath, ["rebase", "master"])).rejects.toThrow();
    const rebaseStatePath = await readGit(worktreePath, ["rev-parse", "--git-path", "rebase-merge"]);
    expect(existsSync(path.resolve(worktreePath, rebaseStatePath))).toBe(true);

    const fixture = createDirtyQuarantineFixture({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch: "PAP-456-live",
      sourceIdentifier: "PAP-456",
      claimant: "none",
    });
    const { recorder } = createWorkspaceOperationRecorderDouble();

    const restored = await restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      fixture,
      recorder,
    });

    expect(restored?.branchName).toBe(expectedBranch);
    const warning = restored?.warnings.find((entry) => entry.includes("dirty worktree state was quarantined"));
    expect(warning).toContain("An interrupted git rebase was also cleared");
    const rescueBranch = warning?.match(/"([^"]+)"/)?.[1] ?? "";
    expect(rescueBranch).toMatch(/^paperclip\/rescue\/PAP-456\/\d{8}T\d{6}Z$/);
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.toBe("");
    expect(existsSync(path.resolve(worktreePath, rebaseStatePath))).toBe(false);
    await expect(readGit(repoRoot, ["rev-parse", expectedBranch])).resolves.toBe(expectedBranchHead);
    await expect(readGit(repoRoot, ["show", rescueBranch + ":README.md"])).resolves.toContain("<<<<<<<");

    const notice = workspaceRuntimeDependencyMocks.appendCanonicalControlNotice.mock.calls[0]?.[1] as {
      exactText: string;
    };
    expect(notice.exactText).toContain("Interrupted operation:");
    expect(notice.exactText).toContain("git rebase");
    expect(fixture.database.remaining("select")).toBe(0);
  }, 20_000);

  it("refuses dirty quarantine repair when the live branch has an active claimant", async () => {
    const expectedBranch = "PAP-456-recorded";
    const actualBranch = "PAP-456-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const fixture = createDirtyQuarantineFixture({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-456",
      claimant: "active",
    });

    await expect(restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      fixture,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          cleanliness: "dirty",
          dirtyPathSample: expect.arrayContaining(["README.md", "untracked.txt"]),
          contention: expect.objectContaining({
            claimedByWorkspaceId: fixture.ids.claimant?.workspaceId,
            claimedByIssueIdentifier: fixture.ids.claimant?.identifier,
            activeRun: expect.objectContaining({
              id: fixture.ids.claimant?.runId,
              status: "running",
              issueIdentifier: fixture.ids.claimant?.identifier,
            }),
          }),
          safeRepair: expect.objectContaining({
            eligible: false,
            succeeded: false,
            reason: expect.stringContaining("active run"),
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.not.toBe("");
    expect(fixture.database.remaining("select")).toBe(0);
    expect(workspaceRuntimeDependencyMocks.appendCanonicalControlNotice).not.toHaveBeenCalled();
  }, 20_000);

  it("refuses dirty quarantine repair when the live branch has an idle claimant", async () => {
    const expectedBranch = "PAP-457-recorded";
    const actualBranch = "PAP-457-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const fixture = createDirtyQuarantineFixture({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-457",
      claimant: "idle",
    });

    await expect(restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      fixture,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          cleanliness: "dirty",
          contention: expect.objectContaining({
            claimedByWorkspaceId: fixture.ids.claimant?.workspaceId,
            claimedByIssueIdentifier: fixture.ids.claimant?.identifier,
            activeRun: null,
          }),
          safeRepair: expect.objectContaining({
            eligible: false,
            succeeded: false,
            reason: expect.stringContaining("no active run"),
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
    expect(fixture.database.remaining("select")).toBe(0);
  }, 20_000);

  it("refuses dirty quarantine repair while the workspace has an active runtime service", async () => {
    const expectedBranch = "PAP-458-recorded";
    const actualBranch = "PAP-458-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const fixture = createDirtyQuarantineFixture({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-458",
      claimant: "none",
      activeRuntimeService: true,
    });

    await expect(restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      fixture,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          cleanliness: "dirty",
          safeRepair: expect.objectContaining({
            eligible: false,
            attempted: false,
            succeeded: false,
            reason: expect.stringContaining("runtime service"),
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
    await expect(readGit(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/paperclip/rescue",
    ])).resolves.toBe("");
    expect(fixture.database.remaining("select")).toBe(0);
  }, 20_000);

  it("falls back to validation failure when git reports index-lock contention", async () => {
    const expectedBranch = "PAP-459-recorded";
    const actualBranch = "PAP-459-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const fixture = createDirtyQuarantineFixture({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-459",
      claimant: "none",
    });
    const lockPath = await readGit(worktreePath, ["rev-parse", "--git-path", "index.lock"]);
    await fs.writeFile(lockPath, "locked\n", "utf8");
    try {
      await expect(restoreDirtyQuarantine({
        repoRoot,
        worktreePath,
        expectedBranch,
        fixture,
      })).rejects.toMatchObject({
        code: "workspace_validation_failed",
        resultJson: {
          workspaceValidation: expect.objectContaining({
            cleanliness: "dirty",
            safeRepair: expect.objectContaining({
              attempted: true,
              succeeded: false,
              reason: expect.stringContaining("index contention"),
            }),
          }),
        },
      });
    } finally {
      await fs.rm(lockPath, { force: true });
    }
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
    expect(fixture.database.remaining("select")).toBe(0);
  }, 20_000);

  it("best-effort restores the recorded branch when the rescue commit fails", async () => {
    const expectedBranch = "PAP-460-recorded";
    const actualBranch = "PAP-460-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const fixture = createDirtyQuarantineFixture({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-460",
      claimant: "none",
    });
    const commonDirRaw = await readGit(worktreePath, ["rev-parse", "--git-common-dir"]);
    const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(worktreePath, commonDirRaw);
    const hookPath = path.join(commonDir, "hooks", "commit-msg");
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, "#!/bin/sh\necho rescue commit blocked >&2\nexit 1\n", { mode: 0o755 });

    await expect(restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      fixture,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          safeRepair: expect.objectContaining({
            attempted: true,
            succeeded: false,
            reason: expect.stringContaining("rescue commit blocked"),
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.not.toBe("");
    expect(fixture.database.remaining("select")).toBe(0);
  }, 20_000);
});

describe("workspace runtime service control persistence", () => {
  it("persists starting before readiness and running after readiness", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-slow-control-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-control-home-"));
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "runtime-control-" + randomUUID();

    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const markerPath = path.join(workspaceRoot, "runtime-spawned.marker");
    const serverScript = [
      "require(\"node:fs\").writeFileSync(" + JSON.stringify(markerPath) + ", \"spawned\");",
      "setTimeout(() => {",
      "  require(\"node:http\")",
      "    .createServer((_req, res) => { res.end(\"ok\"); })",
      "    .listen(Number(process.env.PORT), \"127.0.0.1\");",
      "}, 700);",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const command = JSON.stringify(process.execPath) + " -e " + JSON.stringify(serverScript);
    const database = createMockDb({
      select: [
        [{ id: executionWorkspaceId }],
        [{ id: projectWorkspaceId }],
        [],
        [],
      ],
      insert: [[], [], []],
    });
    let transactionCommitted = false;
    const transaction = database.db.transaction as unknown as {
      mockImplementation(
        implementation: (callback: (tx: typeof database.db) => Promise<unknown>) => Promise<unknown>,
      ): void;
    };
    transaction.mockImplementation(async (callback) => {
      const result = await callback(database.db);
      transactionCommitted = true;
      return result;
    });

    const startPromise = startRuntimeServicesForWorkspaceControl({
      db: database.db,
      invocationId: randomUUID(),
      actor: {
        id: null,
        name: "Board",
        companyId,
      },
      issue: {
        id: issueId,
        identifier: null,
        title: "Source task",
      },
      workspace: {
        baseCwd: workspaceRoot,
        source: "issue_execution",
        projectId,
        workspaceId: projectWorkspaceId,
        repoUrl: null,
        repoRef: "main",
        strategy: "git_worktree",
        cwd: workspaceRoot,
        branchName: "feature/runtime-control",
        worktreePath: workspaceRoot,
        warnings: [],
        created: false,
      },
      executionWorkspaceId,
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command,
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              port: { type: "auto", envKey: "PORT" },
              expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
              readiness: { type: "http", intervalMs: 50, timeoutSec: 10 },
              stopPolicy: { type: "manual" },
            },
          ],
        },
      },
      adapterEnv: {},
    });
    startPromise.catch(() => undefined);

    try {
      const deadline = Date.now() + 5_000;
      while (
        Date.now() < deadline
        && (!existsSync(markerPath) || database.remaining("insert") !== 2 || !transactionCommitted)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(existsSync(markerPath)).toBe(true);
      expect(transactionCommitted).toBe(true);
      expect(database.remaining("insert")).toBe(2);
      const startingValues = database.calls.find(
        (call) => call.operation === "insert" && call.method === "values",
      )?.args[0] as Record<string, unknown>;
      expect(startingValues).toMatchObject({
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId,
        issueId,
        serviceName: "web",
        status: "starting",
        healthStatus: "unknown",
      });
      expect(startingValues.providerRef).toMatch(/^\d+$/);
      expect(startingValues.port).toEqual(expect.any(Number));

      const services = await startPromise;
      expect(services).toHaveLength(1);
      expect(services[0]).toMatchObject({
        id: startingValues.id,
        status: "running",
        healthStatus: "healthy",
      });
      expect(database.remaining("insert")).toBe(1);
      const persistedValues = database.calls
        .filter((call) => call.operation === "insert" && call.method === "values")
        .map((call) => call.args[0] as Record<string, unknown>);
      expect(persistedValues.map((values) => values.status)).toEqual(["starting", "running"]);
      await expect(fetch(services[0]!.url!)).resolves.toMatchObject({ ok: true });
    } finally {
      await startPromise.catch(() => undefined);
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
    }

    expect(database.remaining("select")).toBe(0);
    expect(database.remaining("insert")).toBe(0);
  }, 15_000);
});

describe("workspace runtime startup reconciliation", () => {
  function persistedRuntimeServiceRow(overrides: Record<string, unknown> = {}) {
    const now = new Date("2026-04-04T17:00:00.000Z");
    return {
      id: randomUUID(),
      companyId: randomUUID(),
      projectId: randomUUID(),
      projectWorkspaceId: randomUUID(),
      executionWorkspaceId: randomUUID(),
      issueId: null,
      scopeType: "execution_workspace",
      scopeId: randomUUID(),
      serviceName: "web",
      status: "running",
      lifecycle: "shared",
      reuseKey: "execution_workspace:fixture:web",
      command: "node",
      cwd: process.cwd(),
      port: null,
      url: null,
      provider: "local_process",
      providerRef: null,
      ownerAgentId: null,
      startedByRunId: null,
      lastUsedAt: now,
      startedAt: now,
      stoppedAt: null,
      stopPolicy: { type: "manual" },
      healthStatus: "unknown",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function runtimeHttpConfig(env?: Record<string, string>) {
    return {
      workspaceRuntime: {
        services: [
          {
            name: "web",
            command:
              "node -e \"require('node:http').createServer((_req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
            ...(env ? { env } : {}),
            port: { type: "auto", envKey: "PORT" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            expose: {
              type: "url",
              urlTemplate: "http://127.0.0.1:{{port}}",
            },
            lifecycle: "shared",
            reuseScope: "execution_workspace",
            stopPolicy: { type: "manual" },
          },
        ],
      },
    };
  }

  it("returns without writes when there are no persisted local services", async () => {
    const database = createMockDb({ select: [[]] });

    await expect(reconcilePersistedRuntimeServicesOnStartup(database.db)).resolves.toEqual({
      reconciled: 0,
      adopted: 0,
      stopped: 0,
    });
    expect(database.remaining("select")).toBe(0);
    expect(database.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(database.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("adopts a live auto-port service after in-memory runtime state is reset", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-adopt-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-adopt-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "runtime-adopt-" + randomUUID();
    const companyId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const workspace = {
      ...buildWorkspace(workspaceRoot),
      source: "issue_execution" as const,
      workspaceId: null,
    };
    const config = runtimeHttpConfig();

    const first = await startRuntimeServicesForWorkspaceControl({
      actor: { id: randomUUID(), name: "Codex Coder", companyId },
      issue: null,
      workspace,
      executionWorkspaceId,
      config,
      adapterEnv: {},
    });
    expect(first).toHaveLength(1);
    await expect(fetch(first[0]!.url!)).resolves.toMatchObject({ ok: true });

    await resetRuntimeServicesForTests();
    const row = persistedRuntimeServiceRow({
      ...first[0],
      lastUsedAt: new Date(first[0]!.lastUsedAt),
      startedAt: new Date(first[0]!.startedAt),
      stoppedAt: null,
      createdAt: new Date(first[0]!.startedAt),
      updatedAt: new Date(first[0]!.lastUsedAt),
    });
    const database = createMockDb({ select: [[row]], insert: [[], []] });

    try {
      const result = await reconcilePersistedRuntimeServicesOnStartup(database.db);
      expect(result).toEqual({ reconciled: 1, adopted: 1, stopped: 0 });

      const adopted = await startRuntimeServicesForWorkspaceControl({
        actor: { id: randomUUID(), name: "Codex Coder", companyId },
        issue: null,
        workspace,
        executionWorkspaceId,
        config,
        adapterEnv: {},
      });
      expect(adopted).toHaveLength(1);
      expect(adopted[0]).toMatchObject({
        id: first[0]!.id,
        port: first[0]!.port,
        url: first[0]!.url,
        reused: true,
      });
      await expect(fetch(adopted[0]!.url!)).resolves.toMatchObject({ ok: true });

      const adoptedValues = database.calls.find(
        (call) => call.operation === "insert" && call.method === "values",
      )?.args[0] as Record<string, unknown>;
      expect(adoptedValues).toMatchObject({
        id: first[0]!.id,
        status: "running",
        healthStatus: "healthy",
        providerRef: first[0]!.providerRef,
      });
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }

    expect(database.remaining("select")).toBe(0);
    expect(database.remaining("insert")).toBe(0);
  }, 20_000);

  it("does not reuse a stopped auto-port candidate while another process owns its port", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-port-owner-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-port-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "runtime-port-owner-" + randomUUID();

    const listener = net.createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve());
    });
    const address = listener.address();
    const stalePort = typeof address === "object" && address ? address.port : null;
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    expect(stalePort).toBeTypeOf("number");

    const staleScript = [
      "require(\"node:http\")",
      "  .createServer((_req, res) => { res.statusCode = 503; res.end(\"stale\"); })",
      "  .listen(Number(process.env.PORT), \"127.0.0.1\");",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const staleProcess = spawn(process.execPath, ["-e", staleScript], {
      cwd: workspaceRoot,
      env: { ...process.env, PORT: String(stalePort) },
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    const staleUrl = "http://127.0.0.1:" + stalePort;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(staleUrl);
        if (response.status === 503) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    const stoppedServiceId = randomUUID();
    const database = createMockDb({
      select: [[{ id: stoppedServiceId, port: stalePort }]],
      insert: [[], []],
    });
    const executionWorkspaceId = randomUUID();
    const runId = randomUUID();

    try {
      const services = await ensureRuntimeServicesForRun({
        db: database.db,
        runId,
        agent: { id: randomUUID(), name: "Codex Coder", companyId: randomUUID() },
        issue: null,
        workspace: {
          ...buildWorkspace(workspaceRoot),
          workspaceId: null,
        },
        executionWorkspaceId,
        config: runtimeHttpConfig(),
        adapterEnv: {},
      });

      expect(services).toHaveLength(1);
      expect(services[0]).toMatchObject({ id: stoppedServiceId, reused: false });
      expect(services[0]?.port).not.toBe(stalePort);
      await expect(fetch(services[0]!.url!)).resolves.toMatchObject({ ok: true });
      await expect(fetch(staleUrl)).resolves.toMatchObject({ ok: false, status: 503 });
      expect(await readLocalServicePortOwner(stalePort!)).toBe(staleProcess.pid);
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
      });
      await releaseRuntimeServicesForRun(runId);
      if (staleProcess.pid) {
        try {
          process.kill(-staleProcess.pid, "SIGKILL");
        } catch {
          try {
            process.kill(staleProcess.pid, "SIGKILL");
          } catch {
            // Ignore cleanup races.
          }
        }
      }
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }

    expect(database.remaining("select")).toBe(0);
    expect(database.remaining("insert")).toBe(0);
  }, 20_000);

  it("rejects a registry record whose identity belongs to another workspace", async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-reject-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "runtime-reject-" + randomUUID();
    const runtimeServiceId = randomUUID();
    const reuseKey = "project_workspace:fixture:paperclip-dev";
    const row = persistedRuntimeServiceRow({
      id: runtimeServiceId,
      projectWorkspaceId: randomUUID(),
      executionWorkspaceId: null,
      scopeType: "project_workspace",
      scopeId: randomUUID(),
      serviceName: "paperclip-dev",
      reuseKey,
      command: "pnpm dev",
      cwd: "/tmp/paperclip-other-workspace",
      port: 49195,
      url: "http://127.0.0.1:49195",
      providerRef: "999999",
      healthStatus: "healthy",
    });
    await writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey: "workspace-runtime-paperclip-dev-stale",
      profileKind: "workspace-runtime",
      serviceName: "paperclip-dev",
      command: "pnpm dev",
      cwd: process.cwd(),
      envFingerprint: reuseKey,
      port: 49195,
      url: "http://127.0.0.1:49195",
      pid: process.pid,
      processGroupId: process.pid,
      provider: "local_process",
      runtimeServiceId,
      reuseKey,
      startedAt: (row.startedAt as Date).toISOString(),
      lastSeenAt: (row.updatedAt as Date).toISOString(),
      metadata: null,
    });
    const database = createMockDb({ select: [[row]], update: [[]] });

    try {
      await expect(reconcilePersistedRuntimeServicesOnStartup(database.db)).resolves.toEqual({
        reconciled: 1,
        adopted: 0,
        stopped: 1,
      });
      const stoppedValues = database.calls.find(
        (call) => call.operation === "update" && call.method === "set",
      )?.args[0] as Record<string, unknown>;
      expect(stoppedValues).toMatchObject({
        status: "stopped",
        healthStatus: "unknown",
      });
      expect(stoppedValues.stoppedAt).toBeInstanceOf(Date);
    } finally {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }

    expect(database.remaining("select")).toBe(0);
    expect(database.remaining("update")).toBe(0);
  });

  it("adopts a stopped persisted service when its matching registry process is alive", async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-stopped-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "runtime-stopped-" + randomUUID();
    const runtimeServiceId = randomUUID();
    const reuseKey = "execution_workspace:fixture:web";
    const stoppedAt = new Date("2026-04-04T17:10:00.000Z");
    const row = persistedRuntimeServiceRow({
      id: runtimeServiceId,
      status: "stopped",
      reuseKey,
      providerRef: "stale",
      stoppedAt,
      lastUsedAt: stoppedAt,
      updatedAt: stoppedAt,
    });
    await writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey: "workspace-runtime-web-live-stopped",
      profileKind: "workspace-runtime",
      serviceName: row.serviceName as string,
      command: row.command as string,
      cwd: row.cwd as string,
      envFingerprint: reuseKey,
      port: null,
      url: null,
      pid: process.pid,
      processGroupId: process.pid,
      provider: "local_process",
      runtimeServiceId,
      reuseKey,
      startedAt: (row.startedAt as Date).toISOString(),
      lastSeenAt: stoppedAt.toISOString(),
      metadata: null,
    });
    const database = createMockDb({ select: [[row]], insert: [[]] });

    try {
      await expect(reconcilePersistedRuntimeServicesOnStartup(database.db)).resolves.toEqual({
        reconciled: 1,
        adopted: 1,
        stopped: 0,
      });
      const adoptedValues = database.calls.find(
        (call) => call.operation === "insert" && call.method === "values",
      )?.args[0] as Record<string, unknown>;
      expect(adoptedValues).toMatchObject({
        id: runtimeServiceId,
        status: "running",
        healthStatus: "healthy",
        stoppedAt: null,
        providerRef: String(process.pid),
      });
    } finally {
      await resetRuntimeServicesForTests();
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }

    expect(database.remaining("select")).toBe(0);
    expect(database.remaining("insert")).toBe(0);
  });

  it("marks a missing running process stopped but leaves an already-stopped row untouched", async () => {
    const runningRow = persistedRuntimeServiceRow({
      id: "runtime-running-missing",
      command: null,
      cwd: null,
      status: "running",
    });
    const stoppedRow = persistedRuntimeServiceRow({
      id: "runtime-already-stopped",
      command: null,
      cwd: null,
      status: "stopped",
      stoppedAt: new Date("2026-04-04T17:20:00.000Z"),
    });
    const database = createMockDb({
      select: [[runningRow, stoppedRow]],
      update: [[]],
    });

    await expect(reconcilePersistedRuntimeServicesOnStartup(database.db)).resolves.toEqual({
      reconciled: 1,
      adopted: 0,
      stopped: 1,
    });
    const stoppedValues = database.calls.find(
      (call) => call.operation === "update" && call.method === "set",
    )?.args[0] as Record<string, unknown>;
    expect(stoppedValues).toMatchObject({
      status: "stopped",
      healthStatus: "unknown",
    });
    expect(database.remaining("select")).toBe(0);
    expect(database.remaining("update")).toBe(0);
  });

  it("persists controlled execution-workspace stops without loading a database", async () => {
    const database = createMockDb({ update: [[]] });
    const executionWorkspaceId = randomUUID();

    await stopRuntimeServicesForExecutionWorkspace({
      db: database.db,
      executionWorkspaceId,
      workspaceCwd: process.cwd(),
    });

    const stoppedValues = database.calls.find(
      (call) => call.operation === "update" && call.method === "set",
    )?.args[0] as Record<string, unknown>;
    expect(stoppedValues).toMatchObject({
      status: "stopped",
      healthStatus: "unknown",
    });
    expect(stoppedValues.stoppedAt).toBeInstanceOf(Date);
    expect(database.remaining("update")).toBe(0);
  });

  it("restarts an available stopped auto-port candidate after rendered env changes", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-port-reuse-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-reuse-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "runtime-reuse-" + randomUUID();
    const companyId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const workspace = {
      ...buildWorkspace(workspaceRoot),
      workspaceId: null,
    };

    const first = await startRuntimeServicesForWorkspaceControl({
      actor: { id: randomUUID(), name: "Codex Coder", companyId },
      issue: null,
      workspace,
      executionWorkspaceId,
      config: runtimeHttpConfig({ PAPERCLIP_TEST_RUNTIME_FLAG: "before" }),
      adapterEnv: {},
    });
    expect(first).toHaveLength(1);
    await expect(fetch(first[0]!.url!)).resolves.toMatchObject({ ok: true });
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId,
      workspaceCwd: workspaceRoot,
    });
    await expect(fetch(first[0]!.url!)).rejects.toThrow();

    const database = createMockDb({
      select: [
        [],
        [{ id: first[0]!.id, port: first[0]!.port }],
      ],
      insert: [[], []],
    });
    const runId = randomUUID();

    try {
      const second = await ensureRuntimeServicesForRun({
        db: database.db,
        runId,
        agent: { id: randomUUID(), name: "Codex Coder", companyId },
        issue: null,
        workspace,
        executionWorkspaceId,
        config: runtimeHttpConfig({ PAPERCLIP_TEST_RUNTIME_FLAG: "after" }),
        adapterEnv: {},
      });

      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({
        id: first[0]!.id,
        port: first[0]!.port,
        url: first[0]!.url,
        reused: false,
      });
      await expect(fetch(second[0]!.url!)).resolves.toMatchObject({ ok: true });
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
      });
      await releaseRuntimeServicesForRun(runId);
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }

    expect(database.remaining("select")).toBe(0);
    expect(database.remaining("insert")).toBe(0);
  }, 20_000);
});

describe("normalizeAdapterManagedRuntimeServices", () => {
  it("fills workspace defaults and derives stable ids for adapter-managed services", () => {
    const workspace = buildWorkspace("/tmp/project");
    const now = new Date("2026-03-09T12:00:00.000Z");

    const first = normalizeAdapterManagedRuntimeServices({
      adapterType: "codex",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Worktree support",
      },
      workspace,
      reports: [
        {
          serviceName: "preview",
          url: "https://preview.example/run-1",
          providerRef: "sandbox-123",
          scopeType: "run",
        },
      ],
      now,
    });

    const second = normalizeAdapterManagedRuntimeServices({
      adapterType: "codex",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Worktree support",
      },
      workspace,
      reports: [
        {
          serviceName: "preview",
          url: "https://preview.example/run-1",
          providerRef: "sandbox-123",
          scopeType: "run",
        },
      ],
      now,
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
      executionWorkspaceId: null,
      issueId: "issue-1",
      serviceName: "preview",
      provider: "adapter_managed",
      status: "running",
      healthStatus: "healthy",
      startedByRunId: "run-1",
    });
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("prefers execution workspace ids over cwd for execution-scoped adapter services", () => {
    const workspace = buildWorkspace("/tmp/project");

    const refs = normalizeAdapterManagedRuntimeServices({
      adapterType: "codex",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      reports: [
        {
          serviceName: "preview",
          scopeType: "execution_workspace",
        },
      ],
    });

    expect(refs[0]).toMatchObject({
      scopeType: "execution_workspace",
      scopeId: "execution-workspace-1",
      executionWorkspaceId: "execution-workspace-1",
    });
  });
});
