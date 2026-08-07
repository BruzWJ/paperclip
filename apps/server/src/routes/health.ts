import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { companies, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus, writeDevServerRestartRequest } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { getServerInfoSnapshot, type ServerInfoSnapshot } from "../server-info.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  listIssueExecutionRunsForActivity,
  type IssueExecutionRunListCursor,
} from "../services/issue-execution-run-service.js";
import { serverVersion } from "../version.js";
import { isBoardActor } from "../http/request-actor.js";
import { assertBoard } from "./authz.js";

const ACTIVE_RUN_STATUSES = [
  "queued",
  "scheduled_retry",
  "running",
] as const;

async function countActiveIssueExecutionRuns(db: Db): Promise<number> {
  const companyRows = await db.select({ id: companies.id }).from(companies);
  let total = 0;
  for (const company of companyRows) {
    let cursor: IssueExecutionRunListCursor | null = null;
    do {
      const page = await listIssueExecutionRunsForActivity(db, {
        companyId: company.id,
        statuses: ACTIVE_RUN_STATUSES,
        cursor,
        limit: 200,
      });
      total += page.items.length;
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
  return total;
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
  const router = Router();

  router.post("/dev-server/restart", async (req, res) => {
    assertBoard(req);

    const persistedDevServerStatus = readPersistedDevServerStatus();
    if (!persistedDevServerStatus) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    const restartRequired =
      persistedDevServerStatus.dirty ||
      persistedDevServerStatus.changedPathCount > 0;
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
        countActiveIssueExecutionRuns(db),
      ]);

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled:
          generalSettings.autoRestartDevServerWhenIdle === true,
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
