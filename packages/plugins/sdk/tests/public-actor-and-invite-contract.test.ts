import { describe, expectTypeOf, it } from "vitest";
import type { InviteSource } from "@paperclipai/shared";

import type { PluginApiRequestInput } from "../src/define-plugin.js";
import type { PluginAccessInvite } from "../src/types.js";

describe("plugin public actor and invite contracts", () => {
  it("exposes only canonical board identity on generic plugin API requests", () => {
    expectTypeOf<PluginApiRequestInput["actor"]>().toEqualTypeOf<{
      type: "user";
      userId: string;
    }>();
  });

  it("requires shared canonical creation provenance on access invites", () => {
    expectTypeOf<Pick<PluginAccessInvite, "source">>().toEqualTypeOf<{
      source: InviteSource;
    }>();
  });
});
