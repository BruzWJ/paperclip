import { describe, expect, it } from "vitest";
import { deriveOriginatingActor, deriveResponsibleUser } from "./task-attribution.js";

describe("deriveResponsibleUser", () => {
  it("prefers an explicit responsible user", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: "user-responsible",
        creatorKind: "user/board",
        creatorUserId: "user-creator",
      }),
    ).toEqual({
      userId: "user-responsible",
      source: "explicit",
      isAutoDerived: false,
    });
  });

  it("falls back to the creator user as an auto-derived responsible user", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: null,
        creatorKind: "user/board",
        creatorUserId: "user-creator",
      }),
    ).toEqual({
      userId: "user-creator",
      source: "creator",
      isAutoDerived: true,
    });
  });

  it("returns none when no human is available", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: null,
        creatorKind: "system",
        creatorUserId: null,
      }),
    ).toEqual({
      userId: null,
      source: "none",
      isAutoDerived: false,
    });
  });
});

describe("deriveOriginatingActor", () => {
  it("prefers the human creator over an explicit responsible user", () => {
    expect(
      deriveOriginatingActor({
        creatorKind: "user/board",
        creatorUserId: "user-creator",
        creatorAuthorityId: null,
        responsibleUserId: "user-responsible",
      }),
    ).toEqual({ kind: "user", id: "user-creator" });
  });

  it("attributes an agent-created task to the transitive responsible user via the agent", () => {
    expect(
      deriveOriginatingActor({
        creatorKind: "agent-execution",
        creatorUserId: null,
        creatorAuthorityId: "agent-claude",
        responsibleUserId: "user-responsible",
      }),
    ).toEqual({ kind: "user", id: "user-responsible", viaAgentId: "agent-claude" });
  });

  it("falls back to the creating agent when no responsible user is known", () => {
    expect(
      deriveOriginatingActor({
        creatorKind: "agent-execution",
        creatorUserId: null,
        creatorAuthorityId: "agent-claude",
        responsibleUserId: null,
      }),
    ).toEqual({ kind: "agent", id: "agent-claude" });
  });

  it("surfaces the responsible user for routine executions with no creator", () => {
    expect(
      deriveOriginatingActor({
        creatorKind: "routine",
        creatorUserId: null,
        creatorAuthorityId: null,
        responsibleUserId: "user-responsible",
      }),
    ).toEqual({ kind: "user", id: "user-responsible" });
  });

  it("returns null when nothing is attributable", () => {
    expect(
      deriveOriginatingActor({
        creatorKind: "system",
        creatorUserId: null,
        creatorAuthorityId: null,
        responsibleUserId: null,
      }),
    ).toBeNull();
  });
});
