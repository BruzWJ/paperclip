import { describe, expect, it } from "vitest";
import {
  agentCompanySkillPinsResponseSchema,
  agentCompanySkillPinsUpdateSchema,
  companySkillChannelSchema,
  companySkillPinSchema,
  companySkillPinsSchema,
  parseCompanySkillPins,
} from "./company-skill-pins.js";

const REVIEW_VERSION = "00000000-0000-4000-8000-000000000001";
const RESEARCH_VERSION = "00000000-0000-4000-8000-000000000002";

describe("company skill pins", () => {
  it("accepts exact immutable pins and returns deterministic key order", () => {
    expect(parseCompanySkillPins([
      { key: "research", versionId: RESEARCH_VERSION },
      { key: "code-review", versionId: REVIEW_VERSION },
    ])).toEqual([
      { key: "code-review", versionId: REVIEW_VERSION },
      { key: "research", versionId: RESEARCH_VERSION },
    ]);
  });

  it("rejects malformed, permissive, and duplicate pin shapes", () => {
    const malformed = [
      "code-review",
      { key: "code-review" },
      { key: " code-review", versionId: REVIEW_VERSION },
      { key: "code-review", versionId: "latest" },
      {
        key: "code-review",
        versionId: REVIEW_VERSION,
        name: "ignored-extra-field",
      },
    ];

    for (const value of malformed) {
      expect(companySkillPinSchema.safeParse(value).success).toBe(false);
    }

    expect(companySkillPinsSchema.safeParse([
      { key: "code-review", versionId: REVIEW_VERSION },
      { key: "code-review", versionId: RESEARCH_VERSION },
    ]).success).toBe(false);
  });

  it("accepts only the two canonical skill channels", () => {
    expect(companySkillChannelSchema.parse("isolated_skills_home")).toBe(
      "isolated_skills_home",
    );
    expect(companySkillChannelSchema.parse("operator_native")).toBe(
      "operator_native",
    );
    expect(companySkillChannelSchema.safeParse("workspace").success).toBe(
      false,
    );
  });

  it("defines closed request and response contracts for the agent operation", () => {
    const exact = {
      entries: [
        { key: "code-review", versionId: REVIEW_VERSION },
      ],
      skillChannel: "isolated_skills_home" as const,
    };
    expect(agentCompanySkillPinsUpdateSchema.parse(exact)).toEqual(exact);
    expect(agentCompanySkillPinsResponseSchema.parse(exact)).toEqual(exact);

    for (const schema of [
      agentCompanySkillPinsUpdateSchema,
      agentCompanySkillPinsResponseSchema,
    ]) {
      expect(schema.safeParse({ ...exact, mode: "latest" }).success).toBe(
        false,
      );
      expect(schema.safeParse({
        entries: [
          exact.entries[0],
          { key: "code-review", versionId: RESEARCH_VERSION },
        ],
      }).success).toBe(false);
    }
  });

  it("requires an explicit channel even for an empty selection", () => {
    expect(agentCompanySkillPinsUpdateSchema.safeParse({
      entries: [],
    }).success).toBe(false);
    expect(agentCompanySkillPinsUpdateSchema.parse({
      entries: [],
      skillChannel: "operator_native",
    })).toEqual({
      entries: [],
      skillChannel: "operator_native",
    });
  });
});
