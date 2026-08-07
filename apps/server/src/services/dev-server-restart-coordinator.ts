import { companies, type Db } from "@paperclipai/db";
import {
  readDevServerRestartRequest,
  readPersistedDevServerStatus,
  writeDevServerRestartRequest,
  type DevServerRestartRequest,
  type PersistedDevServerStatus,
} from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import {
  listIssueExecutionRunsForActivity,
  type IssueExecutionRunListCursor,
} from "./issue-execution-run-service.js";
import { instanceSettingsService } from "./instance-settings.js";

const DEFAULT_CHECK_INTERVAL_MS = 2_500;
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

type DevServerRestartCoordinatorDependencies = {
  readStatus: () => PersistedDevServerStatus | null;
  readRequest: () => DevServerRestartRequest | null;
  writeRequest: (request: DevServerRestartRequest) => boolean;
  getAutoRestartEnabled: () => Promise<boolean>;
  getActiveRunCount: () => Promise<number>;
  now: () => Date;
};

export type DevServerRestartCoordinator = {
  checkNow(): Promise<boolean>;
  start(): void;
  stop(): void;
};

export function createDevServerRestartCoordinator(
  db: Db,
  opts: {
    env?: NodeJS.ProcessEnv;
    intervalMs?: number;
    dependencies?: Partial<DevServerRestartCoordinatorDependencies>;
  } = {},
): DevServerRestartCoordinator {
  const env = opts.env ?? process.env;
  const log = logger.child({ service: "dev-server-restart-coordinator" });
  const dependencies: DevServerRestartCoordinatorDependencies = {
    readStatus: () => readPersistedDevServerStatus(env),
    readRequest: () => readDevServerRestartRequest(env),
    writeRequest: (request) =>
      writeDevServerRestartRequest(request, env, { preserveExisting: true }),
    getAutoRestartEnabled: async () =>
      (await instanceSettingsService(db).getGeneral())
        .autoRestartDevServerWhenIdle === true,
    getActiveRunCount: () => countActiveIssueExecutionRuns(db),
    now: () => new Date(),
    ...opts.dependencies,
  };
  const intervalMs = Math.max(250, opts.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS);

  let interval: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<boolean> | null = null;

  function restartRequired(status: PersistedDevServerStatus) {
    return status.dirty || status.changedPathCount > 0;
  }

  async function performCheck(): Promise<boolean> {
    const initialStatus = dependencies.readStatus();
    if (!initialStatus || !restartRequired(initialStatus)) return false;
    if (dependencies.readRequest()) return false;
    if (!(await dependencies.getAutoRestartEnabled())) return false;
    if ((await dependencies.getActiveRunCount()) > 0) return false;

    const currentStatus = dependencies.readStatus();
    if (!currentStatus || !restartRequired(currentStatus)) return false;
    if (dependencies.readRequest()) return false;

    return dependencies.writeRequest({
      requestedAt: dependencies.now().toISOString(),
      reason: "auto_restart_when_idle",
    });
  }

  function checkNow(): Promise<boolean> {
    if (inFlight) return inFlight;
    inFlight = performCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function scheduleCheck() {
    void checkNow().catch((error) => {
      log.error({ err: error }, "automatic dev-server restart check failed");
    });
  }

  return {
    checkNow,
    start() {
      if (interval || !env.PAPERCLIP_DEV_SERVER_STATUS_FILE?.trim()) return;
      scheduleCheck();
      interval = setInterval(scheduleCheck, intervalMs);
      interval.unref?.();
    },
    stop() {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
    },
  };
}
