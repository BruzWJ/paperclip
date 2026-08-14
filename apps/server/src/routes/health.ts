import { execFileSync } from "node:child_process";
import { Router } from "express";
import { type Db, instanceUserRoles, invites } from "@paperclipai/db";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import type {
  DeploymentExposure,
  ServerGitInfo,
  ServerGitLocalChanges,
  ServerInfoSnapshot,
} from "@paperclipai/shared";
import { parseBuildCommit, readBuildCommit } from "../build-commit.js";
import {
  readPersistedDevServerStatus,
  toDevServerHealthStatus,
  writeDevServerRestartRequest,
} from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { countActiveTaskExecutionRuns } from "../services/task-execution-run-service.js";
import { serverVersion } from "../version.js";
import { isBoardActor } from "../http/request-actor.js";
import { assertBoard } from "./authz.js";

type GitCommand = () => string;
type BuildCommitCommand = () => string | null;

const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/i;

function runGitInfoCommand() {
  return execFileSync("git", ["show", "-s", "--format=%H%n%h%n%s%n%cI", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1500,
  });
}

function runGitStatusCommand() {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1500,
  });
}

function runGitBranchCommand() {
  return execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1500,
  });
}

function parseGitLocalChanges(output: string): ServerGitLocalChanges {
  let stagedFileCount = 0;
  let unstagedFileCount = 0;
  let untrackedFileCount = 0;

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    if (indexStatus === "?" && worktreeStatus === "?") {
      untrackedFileCount += 1;
      continue;
    }
    if (indexStatus !== " " && indexStatus !== "?") stagedFileCount += 1;
    if (worktreeStatus !== " " && worktreeStatus !== "?") {
      unstagedFileCount += 1;
    }
  }

  return {
    available: true,
    hasLocalChanges: stagedFileCount + unstagedFileCount + untrackedFileCount > 0,
    stagedFileCount,
    unstagedFileCount,
    untrackedFileCount,
  };
}

function readGitLocalChanges(command: GitCommand): ServerGitLocalChanges {
  try {
    return parseGitLocalChanges(command());
  } catch {
    return { available: false, unavailableReason: "git_status_unavailable" };
  }
}

function parseGitInfo(
  output: string,
  branchName: string | null,
  localChanges: ServerGitLocalChanges,
): ServerGitInfo {
  const [fullSha = "", shortSha = "", subject = "", committedAt = ""] = output.trimEnd().split("\n");
  const parsedFullSha = parseBuildCommit(fullSha);
  const committedAtTime = Date.parse(committedAt);
  if (!parsedFullSha || !SHORT_SHA_RE.test(shortSha)) {
    return { available: false, unavailableReason: "invalid_git_metadata" };
  }
  return {
    available: true,
    fullSha: parsedFullSha,
    shortSha,
    branchName,
    subject: subject.trim() || "No commit subject",
    committedAt: Number.isNaN(committedAtTime) ? null : new Date(committedAtTime).toISOString(),
    localChanges,
  };
}

const GIT_INFO_CACHE_TTL_MS = 3000;
const processStartedAt = new Date().toISOString();
let gitInfoCache: { value: ServerGitInfo; expiresAt: number } | null = null;

function getServerInfoSnapshot(
  options: {
    now?: number;
    gitCommand?: GitCommand;
    gitStatusCommand?: GitCommand;
    gitBranchCommand?: GitCommand;
    buildCommitCommand?: BuildCommitCommand;
  } = {},
): ServerInfoSnapshot {
  const now = options.now ?? Date.now();
  if (!gitInfoCache || now >= gitInfoCache.expiresAt) {
    let git: ServerGitInfo;
    try {
      const branchName = (() => {
        try {
          return (options.gitBranchCommand ?? runGitBranchCommand)().trim() || null;
        } catch {
          return null;
        }
      })();
      git = parseGitInfo(
        (options.gitCommand ?? runGitInfoCommand)(),
        branchName,
        readGitLocalChanges(options.gitStatusCommand ?? runGitStatusCommand),
      );
    } catch {
      const buildCommit = parseBuildCommit((options.buildCommitCommand ?? readBuildCommit)());
      git = buildCommit
        ? {
            available: true,
            fullSha: buildCommit,
            shortSha: buildCommit.slice(0, 7),
            branchName: null,
            subject: "Source build",
            committedAt: null,
            localChanges: {
              available: false,
              unavailableReason: "git_status_unavailable",
            },
          }
        : { available: false, unavailableReason: "git_unavailable" };
    }
    gitInfoCache = { value: git, expiresAt: now + GIT_INFO_CACHE_TTL_MS };
  }
  return { processStartedAt, git: gitInfoCache.value };
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    serverInfo?: ServerInfoSnapshot;
  } = {
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router({ caseSensitive: true, strict: true });

  router.post("/dev-server/restart", async (req, res) => {
    assertBoard(req);

    const persistedDevServerStatus = readPersistedDevServerStatus();
    if (!persistedDevServerStatus) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    const restartRequired = persistedDevServerStatus.dirty || persistedDevServerStatus.changedPathCount > 0;
    if (!restartRequired) {
      res.status(409).json({ error: "restart_not_required" });
      return;
    }

    const written = writeDevServerRestartRequest({
      requestedAt: new Date().toISOString(),
      reason: "manual_restart_now",
    });
    if (!written) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    res.status(202).json({ status: "restart_requested" });
  });

  router.get("/", async (req, res) => {
    const exposeFullDetails = isBoardActor(req.actor);
    // This data is only returned to authenticated board actors. The General
    // setting controls whether the account-menu debug view renders it.
    const serverInfo = opts.serverInfo ?? getServerInfoSnapshot();

    if (!db) {
      res.json(
        exposeFullDetails
          ? {
              status: "ok",
              version: serverVersion,
              serverVersion: serverVersion,
              serverInfo,
            }
          : {
              status: "ok",
              deploymentExposure: opts.deploymentExposure,
              bootstrapStatus: "bootstrap_pending",
              bootstrapInviteActive: false,
            },
      );
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      res.status(503).json(
        exposeFullDetails
          ? {
              status: "unhealthy",
              version: serverVersion,
              serverVersion,
              error: "database_unreachable",
              serverInfo,
            }
          : {
              status: "unhealthy",
              error: "database_unreachable",
            },
      );
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    const roleCount = await db
      .select({ count: count() })
      .from(instanceUserRoles)
      .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
      .then((rows) => Number(rows[0]?.count ?? 0));
    bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

    if (bootstrapStatus === "bootstrap_pending") {
      const now = new Date();
      const inviteCount = await db
        .select({ count: count() })
        .from(invites)
        .where(
          and(
            eq(invites.inviteType, "bootstrap_admin"),
            isNull(invites.revokedAt),
            isNull(invites.acceptedAt),
            gt(invites.expiresAt, now),
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapInviteActive = inviteCount > 0;
    }

    if (!exposeFullDetails) {
      res.json({
        status: "ok",
        deploymentExposure: opts.deploymentExposure,
        bootstrapStatus,
        bootstrapInviteActive,
      });
      return;
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      const [generalSettings, activeRunCount] = await Promise.all([
        instanceSettingsService(db).getGeneral(),
        countActiveTaskExecutionRuns(db),
      ]);

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: generalSettings.autoRestartDevServerWhenIdle === true,
        activeRunCount,
      });
    }

    res.json({
      status: "ok",
      version: serverVersion,
      serverVersion,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      serverInfo,
      ...(devServer ? { devServer } : {}),
    });
  });

  return router;
}
