import { Command } from "commander";
import pc from "picocolors";
import {
  createDb,
  resolveDatabaseTarget,
  routines,
} from "@paperclipai/db";
import { eq, inArray } from "drizzle-orm";
import { isCanonicalUuid } from "@paperclipai/shared";
import { loadPaperclipEnvironmentFiles } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";

type RoutinesDisableAllOptions = {
  config?: string;
  dataDir?: string;
  companyId?: string;
  json?: boolean;
};

type DisableAllRoutinesResult = {
  companyId: string;
  totalRoutines: number;
  pausedCount: number;
  alreadyPausedCount: number;
  archivedCount: number;
};

type ClosableDb = ReturnType<typeof createDb> & {
  $client?: {
    end?: (options?: { timeout?: number }) => Promise<void>;
  };
};

async function closeDb(db: ClosableDb): Promise<void> {
  await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
}

async function openConfiguredDb(configPath: string): Promise<{
  db: ClosableDb;
  stop: () => Promise<void>;
}> {
  const config = readConfig(configPath);
  if (!config) {
    throw new Error(`Config not found at ${configPath}.`);
  }

  const target = resolveDatabaseTarget({ configPath: resolveConfigPath(configPath) });
  const db = createDb(target.connectionString) as ClosableDb;
  return {
    db,
    stop: async () => {
      await closeDb(db);
    },
  };
}

export async function disableAllRoutinesInConfig(
  options: Pick<RoutinesDisableAllOptions, "config" | "companyId">,
): Promise<DisableAllRoutinesResult> {
  const configPath = resolveConfigPath(options.config);
  loadPaperclipEnvironmentFiles(configPath);
  const selectedCompanyId = options.companyId !== undefined
    ? { source: "--company-id", value: options.companyId }
    : process.env.PAPERCLIP_BOARD_COMPANY_ID !== undefined
      ? { source: "PAPERCLIP_BOARD_COMPANY_ID", value: process.env.PAPERCLIP_BOARD_COMPANY_ID }
      : null;
  if (!selectedCompanyId) {
    throw new Error("Company ID is required. Pass --company-id or set PAPERCLIP_BOARD_COMPANY_ID.");
  }
  if (!isCanonicalUuid(selectedCompanyId.value)) {
    throw new Error(`${selectedCompanyId.source} must be an exact canonical company UUID.`);
  }
  const companyId = selectedCompanyId.value;

  const handle = await openConfiguredDb(configPath);
  try {
    const existing = await handle.db
      .select({
        id: routines.id,
        status: routines.status,
      })
      .from(routines)
      .where(eq(routines.companyId, companyId));

    const alreadyPausedCount = existing.filter((routine) => routine.status === "paused").length;
    const archivedCount = existing.filter((routine) => routine.status === "archived").length;
    const idsToPause = existing
      .filter((routine) => routine.status !== "paused" && routine.status !== "archived")
      .map((routine) => routine.id);

    if (idsToPause.length > 0) {
      await handle.db
        .update(routines)
        .set({
          status: "paused",
          updatedAt: new Date(),
        })
        .where(inArray(routines.id, idsToPause));
    }

    return {
      companyId,
      totalRoutines: existing.length,
      pausedCount: idsToPause.length,
      alreadyPausedCount,
      archivedCount,
    };
  } finally {
    await handle.stop();
  }
}

export async function disableAllRoutinesCommand(options: RoutinesDisableAllOptions): Promise<void> {
  const result = await disableAllRoutinesInConfig(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.totalRoutines === 0) {
    console.log(pc.dim(`No routines found for company ${result.companyId}.`));
    return;
  }

  console.log(
    `Paused ${result.pausedCount} routine(s) for company ${result.companyId} ` +
      `(${result.alreadyPausedCount} already paused, ${result.archivedCount} archived).`,
  );
}

export function registerRoutineCommands(program: Command): void {
  const routinesCommand = program.command("routines").description("Local routine maintenance commands");

  routinesCommand
    .command("disable-all")
    .description("Pause all non-archived routines in the configured local instance for one company")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("-C, --company-id <id>", "Company ID")
    .option("--json", "Output raw JSON")
    .action(async (opts: RoutinesDisableAllOptions) => {
      try {
        await disableAllRoutinesCommand(opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(pc.red(message));
        process.exit(1);
      }
    });
}
