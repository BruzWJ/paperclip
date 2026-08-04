import { describe, expect, it } from "vitest";
import { requireSecretMutationActor } from "./secrets.js";

describe("requireSecretMutationActor", () => {
  it("derives one exhaustive attribution shape for user, agent, and system actors", () => {
    expect(
      requireSecretMutationActor({ type: "user", userId: "user-1" }),
    ).toEqual({ userId: "user-1", agentId: null });
    expect(
      requireSecretMutationActor({ type: "agent", agentId: "agent-1" }),
    ).toEqual({ userId: null, agentId: "agent-1" });
    expect(requireSecretMutationActor({ type: "system" })).toEqual({
      userId: null,
      agentId: null,
    });
  });

  it.each([
    ["missing", undefined],
    ["legacy user", { userId: "user-1" }],
    ["legacy agent", { agentId: "agent-1" }],
    [
      "both identities",
      { type: "user", userId: "user-1", agentId: "agent-1" },
    ],
    ["blank user", { type: "user", userId: " " }],
    ["blank agent", { type: "agent", agentId: "" }],
    ["wrong kind", { type: "plugin", actorId: "plugin-1" }],
    ["system identity", { type: "system", userId: "user-1" }],
    [
      "extra identity",
      { type: "agent", agentId: "agent-1", actorId: "agent-1" },
    ],
    [
      "inherited identity",
      Object.assign(Object.create({ agentId: "agent-1" }), {
        type: "user",
        userId: "user-1",
      }),
    ],
    [
      "symbol identity",
      { type: "system", [Symbol("agentId")]: "agent-1" },
    ],
    [
      "accessor identity",
      {
        get type() {
          throw new Error("must not execute actor accessors");
        },
        userId: "user-1",
      },
    ],
  ])("rejects %s with the stable 422 contract", (_label, actor) => {
    expect(() => requireSecretMutationActor(actor)).toThrowError(
      expect.objectContaining({
        status: 422,
        details: { code: "invalid_secret_mutation_actor" },
      }),
    );
  });
});
