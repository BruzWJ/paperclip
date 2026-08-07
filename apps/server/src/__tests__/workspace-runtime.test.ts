import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  ensureGitWorktreeBranchCoherent,
  ensureServerWorkspaceLinksCurrent,
  ensureRuntimeServicesForRun,
  listConfiguredRuntimeServiceEntries,
  normalizeAdapterManagedRuntimeServices,
  reconcilePersistedRuntimeServicesOnStartup,
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

const leasedRunIds = new Set<string>();

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
    const executionWorkspaceRoot = path.join(primaryWorkspaceRoot, ".paperclip", "execution", "PAP-874-chat-speed-issues");
    await fs.mkdir(executionWorkspaceRoot, { recursive: true });

    const primaryWorkspace = buildWorkspace(primaryWorkspaceRoot);
    const executionWorkspace: RealizedExecutionWorkspace = {
      ...buildWorkspace(executionWorkspaceRoot),
      source: "issue_execution",
      cwd: executionWorkspaceRoot,
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
    expect(executionServices[0]?.cwd).toBe(executionWorkspaceRoot);
    expect(executionServices[0]?.url).not.toBe(primaryServices[0]?.url);

    const primaryResponse = await fetch(primaryServices[0]!.url!);
    expect(await primaryResponse.text()).toBe(path.join(primaryWorkspaceRoot, ".paperclip", "runtime-services"));

    const executionResponse = await fetch(executionServices[0]!.url!);
    expect(await executionResponse.text()).toBe(path.join(executionWorkspaceRoot, ".paperclip", "runtime-services"));
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
          mode: "shared_workspace",
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
    enableWorkspaceBranchReconcileForward?: boolean;
    enableWorkspaceDirtyQuarantineRepair?: boolean;
  }) {
    const ids = input.fixture.ids;
    return ensureGitWorktreeBranchCoherent({
      db: input.fixture.database.db,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      expectedBranchName: input.expectedBranch,
      sourceIssue: {
        id: ids.sourceIssueId,
        identifier: ids.sourceIdentifier,
        title: "Repair dirty branch mismatch",
      },
      executionWorkspaceId: ids.sourceWorkspaceId,
      runId: ids.runId,
      enableWorkspaceBranchReconcileForward:
        input.enableWorkspaceBranchReconcileForward ?? true,
      enableWorkspaceDirtyQuarantineRepair:
        input.enableWorkspaceDirtyQuarantineRepair ?? true,
      reconcileOperationPhase: "worktree_prepare",
      recorder: input.recorder ?? null,
    });
  }

  it("does not advance a clean forward branch when the General safeguard is disabled", async () => {
    const expectedBranch = "PAP-453-recorded";
    const actualBranch = "PAP-453-live";
    const repoRoot = await createTempRepo();
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, [
      "worktree",
      "add",
      "-b",
      actualBranch,
      worktreePath,
      expectedBranch,
    ]);
    await fs.appendFile(path.join(worktreePath, "README.md"), "forward commit\\n", "utf8");
    await runGit(worktreePath, ["commit", "-am", "Forward commit"]);

    await expect(ensureGitWorktreeBranchCoherent({
      repoRoot,
      worktreePath,
      expectedBranchName: expectedBranch,
      sourceIssue: null,
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: true,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          cleanliness: "clean",
          provenance: expect.objectContaining({ ancestryVerdict: "ancestor" }),
          safeRepair: expect.objectContaining({
            attempted: false,
            succeeded: false,
            reason: "forward branch reconciliation is disabled in General settings",
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
  }, 20_000);

  it("does not quarantine a dirty workspace when the General safeguard is disabled", async () => {
    const expectedBranch = "PAP-454-recorded";
    const actualBranch = "PAP-454-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const fixture = createDirtyQuarantineFixture({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      claimant: "none",
    });

    await expect(restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      fixture,
      enableWorkspaceDirtyQuarantineRepair: false,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          safeRepair: expect.objectContaining({
            attempted: false,
            succeeded: false,
            reason: "dirty workspace quarantine repair is disabled in General settings",
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.not.toBe("");
    expect(fixture.database.remaining("select")).toBe(4);
  }, 20_000);

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
        strategy: "project_primary",
        cwd: workspaceRoot,
        branchName: "feature/runtime-control",
        worktreePath: null,
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
