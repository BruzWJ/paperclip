import { describe, expect, it, vi } from "vitest";

const postgresClientMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected PostgreSQL client construction in a unit test");
  }),
);

vi.mock("postgres", () => ({ default: postgresClientMock }));

import {
  assertDistinctDatabaseIdentities,
  assertSameDatabaseIdentity,
  databaseIdentitiesEqual,
  type VerifiedDatabaseIdentity,
} from "../database-identity.js";

function identity(
  overrides: Partial<VerifiedDatabaseIdentity> = {},
): VerifiedDatabaseIdentity {
  return {
    clusterSystemIdentifier: "7421095543785198401",
    databaseOid: "16401",
    databaseName: "paperclip",
    ...overrides,
  };
}

describe("verified PostgreSQL database identity", () => {
  it("compares the connected cluster identifier and exact database OID/name", () => {
    expect(databaseIdentitiesEqual(identity(), identity())).toBe(true);
    expect(
      databaseIdentitiesEqual(
        identity(),
        identity({ clusterSystemIdentifier: "7421095543785198402" }),
      ),
    ).toBe(false);
    expect(
      databaseIdentitiesEqual(identity(), identity({ databaseOid: "16402" })),
    ).toBe(false);
    expect(
      databaseIdentitiesEqual(
        identity(),
        identity({ databaseName: "paperclip_other" }),
      ),
    ).toBe(false);
  });

  it("rejects equality where distinct physical databases are required", () => {
    expect(() =>
      assertDistinctDatabaseIdentities(identity(), identity(), "Worktree targets")
    ).toThrow("same physical database");
    expect(() =>
      assertDistinctDatabaseIdentities(
        identity(),
        identity({ databaseOid: "16402" }),
      )
    ).not.toThrow();
  });

  it("rejects any changed physical identity during revalidation", () => {
    expect(() =>
      assertSameDatabaseIdentity(
        identity(),
        identity({ databaseOid: "16402" }),
        "Disposable test target",
      )
    ).toThrow("no longer resolves to the verified physical database");
  });
});
