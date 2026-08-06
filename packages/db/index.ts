import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(url: string) {
  const sql = postgres(url);
  return drizzlePg(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;

export {
  assertDistinctDatabaseIdentities,
  assertSameDatabaseIdentity,
  databaseIdentitiesEqual,
  probeDatabaseIdentity,
  revalidateDatabaseIdentity,
  type VerifiedDatabaseIdentity,
} from "./database-identity.js";
export {
  parseExternalPostgresDatabaseTarget,
  redactExternalPostgresConnectionString,
  resolveDatabaseTarget,
  resolveOptionalExternalPostgresConnectionString,
  validateExternalPostgresConnectionString,
  type ExternalDatabaseTargetSource,
  type ParsedExternalPostgresDatabaseTarget,
  type ResolvedDatabaseTarget,
  type ResolveDatabaseTargetOptions,
} from "./runtime-config.js";
export * from "./schema.js";
