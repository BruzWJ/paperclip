import { describe, expect, it } from "vitest";
import { catalogTeamEnvInputSummarySchema } from "./teams-catalog.js";

describe("catalog team environment input summaries", () => {
  it("accepts project-scoped declarations", () => {
    expect(
      catalogTeamEnvInputSummarySchema.parse({
        key: "PROJECT_API_KEY",
        projectSlug: "launch",
        kind: "secret",
        requirement: "required",
      }),
    ).toEqual({
      key: "PROJECT_API_KEY",
      projectSlug: "launch",
      kind: "secret",
      requirement: "required",
    });
  });

  it("rejects the retired agent-scoped declaration shape", () => {
    expect(
      catalogTeamEnvInputSummarySchema.safeParse({
        key: "PROVIDER_API_KEY",
        agentSlug: "engineering-lead",
        projectSlug: null,
        kind: "secret",
        requirement: "required",
      }).success,
    ).toBe(false);
  });
});
