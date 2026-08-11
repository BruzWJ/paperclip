import { describe, expect, it } from "vitest";
import {
  InvalidSelectedCompanySkillSet,
  selectedCompanySkillRuntimeName,
} from "./selected-company-skills.js";

describe("selected company skill runtime names", () => {
  it("derives one canonical provider-visible name without execution suffixes", () => {
    expect(
      selectedCompanySkillRuntimeName(
        "paperclipai/paperclip/review",
        "review",
      ),
    ).toBe("review");
    expect(
      selectedCompanySkillRuntimeName("company/example/review", "review"),
    ).toMatch(/^review--[0-9a-f]{10}$/);
    expect(
      selectedCompanySkillRuntimeName(
        "company/example/review",
        "renamed-display-slug",
      ),
    ).toBe(
      selectedCompanySkillRuntimeName("company/example/review", "review"),
    );
  });

  it("rejects unsafe immutable keys and display slugs", () => {
    expect(() =>
      selectedCompanySkillRuntimeName("company/example/review", "../review"),
    ).toThrow(InvalidSelectedCompanySkillSet);
    expect(() => selectedCompanySkillRuntimeName(" review", "review"))
      .toThrow(InvalidSelectedCompanySkillSet);
  });
});
