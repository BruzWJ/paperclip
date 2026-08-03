import { createDb, resolveDatabaseTarget } from "@paperclipai/db";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveConfigPath } from "../config/store.js";

export async function databaseCheck(_config: PaperclipConfig, configPath?: string): Promise<CheckResult> {
  try {
    const target = resolveDatabaseTarget({ configPath: resolveConfigPath(configPath) });
    const db = createDb(target.connectionString);
    try {
      await db.execute("SELECT 1");
      return {
        name: "Database",
        status: "pass",
        message: `External PostgreSQL connection successful (${target.source})`,
      };
    } finally {
      await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
    }
  } catch (err) {
    return {
      name: "Database",
      status: "fail",
      message: `Cannot connect to PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
      guidance:
        "Set a valid DATABASE_URL or database.connectionString for an already-running PostgreSQL server",
    };
  }
}
