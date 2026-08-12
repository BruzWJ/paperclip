import { describe, expect, expectTypeOf, it } from "vitest";
import type { InviteSource } from "@paperclipai/shared";

import type { PluginApiRequestInput } from "../src/define-plugin.js";
import type { PluginAccessInvite } from "../src/types.js";
import { decodePluginPerformActionActorContext } from "../src/protocol.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

  it("decodes exact actor identities without accepting UUID aliases", () => {
    expect(decodePluginPerformActionActorContext({
      type: "user",
      userId: "board-user",
      companyId: COMPANY_ID,
    })).toEqual({
      type: "user",
      userId: "board-user",
      companyId: COMPANY_ID,
    });
    expect(decodePluginPerformActionActorContext({
      type: "agent",
      agentId: AGENT_ID,
      runId: RUN_ID,
      companyId: COMPANY_ID,
    })).toEqual({
      type: "agent",
      agentId: AGENT_ID,
      runId: RUN_ID,
      companyId: COMPANY_ID,
    });
    expect(() => decodePluginPerformActionActorContext({
      type: "user",
      userId: " board-user ",
      companyId: COMPANY_ID,
    })).toThrow("exact non-blank string");
    expect(() => decodePluginPerformActionActorContext({
      type: "agent",
      agentId: AGENT_ID.toUpperCase(),
      runId: RUN_ID,
      companyId: COMPANY_ID,
    })).toThrow("exact canonical UUIDs");
  });
});
