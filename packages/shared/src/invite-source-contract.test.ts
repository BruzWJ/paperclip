import { describe, expect, expectTypeOf, it } from "vitest";

import {
  INVITE_SOURCES,
  type Invite,
  type InviteSource,
} from "./index.js";

describe("invite source contract", () => {
  it("owns the exact canonical issuance-source tuple", () => {
    expect(INVITE_SOURCES).toEqual([
      "board_api",
      "plugin_host",
      "bootstrap_admin_cli",
    ]);
  });

  it("requires canonical provenance on every shared invite", () => {
    expectTypeOf<Pick<Invite, "source">>().toEqualTypeOf<{
      source: InviteSource;
    }>();
  });
});
