import postgres from "postgres";

/**
 * Connection-verified identity for one physical PostgreSQL database.
 *
 * URLs, hosts, ports, credentials, socket paths, and proxy endpoints are
 * intentionally absent. They are locators, not database identity.
 */
export type VerifiedDatabaseIdentity = Readonly<{
  clusterSystemIdentifier: string;
  databaseOid: string;
  databaseName: string;
}>;

type DatabaseIdentityProbeRow = {
  clusterSystemIdentifier: string;
  databaseOid: string;
  databaseName: string;
};

export type DatabaseIdentitySql =
  | postgres.Sql
  | postgres.TransactionSql;

function isUnsignedIntegerText(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function validateProbeRow(
  row: DatabaseIdentityProbeRow | undefined,
): VerifiedDatabaseIdentity {
  if (
    !row ||
    !isUnsignedIntegerText(row.clusterSystemIdentifier) ||
    !isUnsignedIntegerText(row.databaseOid) ||
    typeof row.databaseName !== "string" ||
    row.databaseName.length === 0
  ) {
    throw new Error(
      "PostgreSQL did not return a complete cluster system identifier and database OID/name.",
    );
  }

  return Object.freeze({
    clusterSystemIdentifier: row.clusterSystemIdentifier,
    databaseOid: row.databaseOid,
    databaseName: row.databaseName,
  });
}

/**
 * Probes identity through the connected server. Failure is intentionally
 * fail-closed because locator text is never an identity fallback.
 */
export async function probeConnectedDatabaseIdentity(
  sql: DatabaseIdentitySql,
): Promise<VerifiedDatabaseIdentity> {
  try {
    const rows = await sql<DatabaseIdentityProbeRow[]>`
      SELECT
        control.system_identifier::text AS "clusterSystemIdentifier",
        database.oid::text AS "databaseOid",
        current_database() AS "databaseName"
      FROM pg_control_system() AS control
      JOIN pg_database AS database
        ON database.datname = current_database()
    `;
    return validateProbeRow(rows[0]);
  } catch (error) {
    const detail = error instanceof Error && error.message
      ? ` ${error.message}`
      : "";
    throw new Error(
      `Unable to verify PostgreSQL physical database identity.${detail}`,
      { cause: error },
    );
  }
}

export async function probeDatabaseIdentity(
  connectionString: string,
): Promise<VerifiedDatabaseIdentity> {
  const sql = postgres(connectionString, {
    max: 1,
    onnotice: () => {},
  });

  try {
    return await probeConnectedDatabaseIdentity(sql);
  } finally {
    await sql.end();
  }
}

export function databaseIdentitiesEqual(
  left: VerifiedDatabaseIdentity,
  right: VerifiedDatabaseIdentity,
): boolean {
  return (
    left.clusterSystemIdentifier === right.clusterSystemIdentifier &&
    left.databaseOid === right.databaseOid &&
    left.databaseName === right.databaseName
  );
}

export function assertSameDatabaseIdentity(
  expected: VerifiedDatabaseIdentity,
  actual: VerifiedDatabaseIdentity,
  context = "PostgreSQL target",
): void {
  if (!databaseIdentitiesEqual(expected, actual)) {
    throw new Error(
      `${context} no longer resolves to the verified physical database.`,
    );
  }
}

export function assertDistinctDatabaseIdentities(
  left: VerifiedDatabaseIdentity,
  right: VerifiedDatabaseIdentity,
  context = "PostgreSQL targets",
): void {
  if (databaseIdentitiesEqual(left, right)) {
    throw new Error(`${context} resolve to the same physical database.`);
  }
}

/**
 * Re-probes immediately before sensitive work and returns the fresh verified
 * value so callers do not continue with stale connection facts.
 */
export async function revalidateDatabaseIdentity(
  connectionString: string,
  expected: VerifiedDatabaseIdentity,
  context = "PostgreSQL target",
): Promise<VerifiedDatabaseIdentity> {
  const actual = await probeDatabaseIdentity(connectionString);
  assertSameDatabaseIdentity(expected, actual, context);
  return actual;
}
