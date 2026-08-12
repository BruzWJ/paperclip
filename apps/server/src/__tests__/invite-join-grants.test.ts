import { describe, expect, it } from "vitest";
import { grantsForUserRole } from "@paperclipai/shared";
import { userJoinGrantsFromDefaults } from "../services/invite-grants.js";
import {
  requireUserRole,
  resolveUserInviteRole,
} from "../services/company-member-roles.js";

describe("user invite roles", () => {
  it("maps owner to the full management grant set", () => {
    expect(grantsForUserRole("owner")).toEqual([
      { permissionKey: "agents:create", scope: null },
      { permissionKey: "agents:configure", scope: null },
      { permissionKey: "users:invite", scope: null },
      { permissionKey: "users:manage_permissions", scope: null },
      { permissionKey: "joins:approve", scope: null },
    ]);
  });

  it("maps admin to the management grant set", () => {
    expect(grantsForUserRole("admin")).toEqual([
      { permissionKey: "agents:create", scope: null },
      { permissionKey: "agents:configure", scope: null },
      { permissionKey: "users:invite", scope: null },
      { permissionKey: "joins:approve", scope: null },
    ]);
  });

  it("rejects legacy or missing roles", () => {
    expect(() => requireUserRole("member")).toThrow(/Invalid user/);
    expect(() => resolveUserInviteRole(null)).toThrow(/missing/);
  });

  it("reads the configured user invite role from defaults", () => {
    expect(
      resolveUserInviteRole({
        user: {
          role: "viewer",
        },
      }),
    ).toBe("viewer");
  });

  it("requires explicit user grants", () => {
    expect(() => userJoinGrantsFromDefaults(null)).toThrow(/missing/);
  });

  it("preserves explicit user invite grants", () => {
    expect(
      userJoinGrantsFromDefaults({
        user: {
          grants: [
            {
              permissionKey: "users:invite",
              scope: { companyId: "company-1" },
            },
          ],
        },
      }),
    ).toEqual([
      {
        permissionKey: "users:invite",
        scope: { companyId: "company-1" },
      },
    ]);
  });
});
