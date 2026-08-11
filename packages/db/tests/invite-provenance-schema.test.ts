import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { INVITE_SOURCES as SHARED_INVITE_SOURCES } from "@paperclipai/shared";
import {
  invites,
  INVITE_SOURCES,
} from "../schema/invites.js";

function renderedCheck(name: string): string {
  const constraint = getTableConfig(invites).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint).toBeDefined();
  return new PgDialect().sqlToQuery(constraint!.value).sql;
}

describe("invite provenance schema", () => {
  it("requires one closed, explicit creation source", () => {
    expect(INVITE_SOURCES).toBe(SHARED_INVITE_SOURCES);
    expect(INVITE_SOURCES).toEqual([
      "board_api",
      "plugin_host",
      "bootstrap_admin_cli",
    ]);

    const source = getTableConfig(invites).columns.find(
      (column) => column.name === "source",
    );
    expect(source?.notNull).toBe(true);
    expect(renderedCheck("invites_source_check")).toContain(
      "'bootstrap_admin_cli'",
    );
  });

  it("keeps bootstrap creation principal-free and structurally distinct", () => {
    const principalCheck = renderedCheck("invites_source_principal_check");
    expect(principalCheck).toContain(
      `"invites"."source" = 'board_api' AND "invites"."invited_by_user_id" IS NOT NULL`,
    );
    expect(principalCheck).toContain(
      `"invites"."source" IN ('plugin_host', 'bootstrap_admin_cli') AND "invites"."invited_by_user_id" IS NULL`,
    );

    const bootstrapCheck = renderedCheck("invites_bootstrap_shape_check");
    expect(bootstrapCheck).toContain(
      `"invites"."source" = 'bootstrap_admin_cli'`,
    );
    expect(bootstrapCheck).toContain(
      `"invites"."invite_type" = 'bootstrap_admin'`,
    );
    expect(bootstrapCheck).toContain(`"invites"."company_id" IS NULL`);
    expect(bootstrapCheck).toContain(
      `"invites"."allowed_join_types" = 'human'`,
    );
  });

  it("references a real Better Auth user for human inviter attribution", () => {
    const inviterForeignKey = getTableConfig(invites).foreignKeys.find(
      (foreignKey) =>
        foreignKey.reference().columns.some(
          (column) => column.name === "invited_by_user_id",
        ),
    );

    expect(inviterForeignKey).toBeDefined();
    expect(
      inviterForeignKey?.reference().foreignColumns.map(
        (column) => column.name,
      ),
    ).toEqual(["id"]);
    expect(inviterForeignKey?.getName()).toBe(
      "invites_invited_by_user_id_user_id_fk",
    );
  });
});
