import { and, eq, inArray, not } from "drizzle-orm";
import { type Db, agents, approvals } from "@paperclipai/db";
import type { SidebarBadges } from "@paperclipai/shared";
import {
  listTaskExecutionRunsForActivity,
  type TaskExecutionRunEnvelope,
  type TaskExecutionRunListCursor,
} from "./task-execution-run-service.js";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_RUN_STATUSES = ["failed", "timed_out"];

function normalizeTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: Date | string | null | undefined,
) {
  const dismissedAt = dismissedAtByKey.get(itemKey);
  if (dismissedAt == null) return false;
  return dismissedAt >= normalizeTimestamp(activityAt);
}

export function sidebarBadgeService(db: Db) {
  return {
    get: async (
      companyId: string,
      extra?: {
        dismissals?: ReadonlyMap<string, number>;
        joinRequests?: Array<{
          id: string;
          updatedAt: Date | string | null;
          createdAt: Date | string;
        }>;
        unreadTouchedTasks?: number;
      },
    ): Promise<SidebarBadges> => {
      const actionableApprovals = await db
        .select({ id: approvals.id, updatedAt: approvals.updatedAt })
        .from(approvals)
        .where(
          and(eq(approvals.companyId, companyId), inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES)),
        )
        .then(
          (rows) =>
            rows.filter(
              (row) => !isDismissed(extra?.dismissals ?? new Map(), `approval:${row.id}`, row.updatedAt),
            ).length,
        );

      const activeAgentIds = new Set(
        await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), not(eq(agents.status, "terminated"))))
          .then((rows) => rows.map((row) => row.id)),
      );
      const latestRunByAgent = new Map<string, TaskExecutionRunEnvelope>();
      let cursor: TaskExecutionRunListCursor | null = null;
      do {
        const page = await listTaskExecutionRunsForActivity(db, {
          companyId,
          cursor,
          limit: 200,
        });
        for (const run of page.items) {
          if (activeAgentIds.has(run.targetAgentId) && !latestRunByAgent.has(run.targetAgentId)) {
            latestRunByAgent.set(run.targetAgentId, run);
          }
        }
        cursor = page.nextCursor;
      } while (cursor !== null);

      const failedRuns = [...latestRunByAgent.values()].filter(
        (run) =>
          FAILED_RUN_STATUSES.includes(run.status) &&
          !isDismissed(extra?.dismissals ?? new Map(), `run:${run.runId}`, run.createdAt),
      ).length;

      const joinRequests = (extra?.joinRequests ?? []).filter(
        (row) =>
          !isDismissed(extra?.dismissals ?? new Map(), `join:${row.id}`, row.updatedAt ?? row.createdAt),
      ).length;
      const unreadTouchedTasks = extra?.unreadTouchedTasks ?? 0;
      return {
        inbox: actionableApprovals + failedRuns + joinRequests + unreadTouchedTasks,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
      };
    },
  };
}
