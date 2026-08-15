import * as p from "@clack/prompts";
import { validateExternalPostgresConnectionString } from "@paperclipai/db";
import type { DatabaseConfig } from "../config/schema.js";

export async function promptDatabase(
  current?: DatabaseConfig,
): Promise<DatabaseConfig & { connectionString: string }> {
  const base: DatabaseConfig = current ?? {};

  const value = await p.text({
    message: "External PostgreSQL connection string",
    defaultValue: base.connectionString ?? process.env.DATABASE_URL ?? "",
    placeholder:
      "postgresql://user:password@database.example.com:5432/paperclip",
    validate: (candidate) => {
      try {
        validateExternalPostgresConnectionString(candidate, "Database URL");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return undefined;
    },
  });

  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    connectionString: value,
  };
}
