import { describe, expect, it } from "vitest";
import {
  applyAgentCompanySkillPins,
  sameSkillSelection,
  shouldScheduleSkillAutosave,
} from "./agent-skills-state";

describe("sameSkillSelection", () => {
  it("treats selections as order-independent sets", () => {
    expect(sameSkillSelection(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
  });

  it("detects added or removed keys", () => {
    expect(sameSkillSelection(["a", "b"], ["a"])).toBe(false);
    expect(sameSkillSelection(["a"], ["a", "b"])).toBe(false);
  });
});

describe("shouldScheduleSkillAutosave", () => {
  it("does not re-save when the server returns the same set in a different order", () => {
    // Server preserves stale keys but groups them at the end; the draft keeps the
    // user's order. Same set → already saved, no re-fire (would loop otherwise).
    expect(
      shouldScheduleSkillAutosave({
        draft: ["code-review", "stale/removed/skill", "ascii-art"],
        lastSaved: ["code-review", "ascii-art", "stale/removed/skill"],
        failedDraft: null,
      }),
    ).toBe(false);
  });

  it("does not save when the draft already matches what was saved", () => {
    expect(
      shouldScheduleSkillAutosave({
        draft: ["code-review"],
        lastSaved: ["code-review"],
        failedDraft: null,
      }),
    ).toBe(false);
  });

  it("saves when the draft diverges from the last saved state", () => {
    expect(
      shouldScheduleSkillAutosave({
        draft: ["code-review", "ascii-art"],
        lastSaved: ["code-review"],
        failedDraft: null,
      }),
    ).toBe(true);
  });

  it("holds a payload that just failed to prevent a retry storm (PAP-13222)", () => {
    const draft = ["code-review", "stale/removed/skill"];
    expect(
      shouldScheduleSkillAutosave({
        draft,
        lastSaved: ["code-review"],
        failedDraft: [...draft],
      }),
    ).toBe(false);
  });

  it("resumes saving once the user edits the draft after a failure", () => {
    expect(
      shouldScheduleSkillAutosave({
        draft: ["code-review", "ascii-art"],
        lastSaved: ["code-review"],
        failedDraft: ["code-review", "stale/removed/skill"],
      }),
    ).toBe(true);
  });
});

describe("applyAgentCompanySkillPins", () => {
  it("hydrates the initial selection without arming autosave", () => {
    const result = applyAgentCompanySkillPins(
      {
        draft: [],
        lastSaved: [],
        hasHydratedSnapshot: false,
      },
      ["code-review", "incident-triage"],
    );

    expect(result).toEqual({
      draft: ["code-review", "incident-triage"],
      lastSaved: ["code-review", "incident-triage"],
      hasHydratedSnapshot: true,
      shouldSkipAutosave: true,
    });
  });

  it("keeps unsaved local edits when a fresh selection arrives", () => {
    const result = applyAgentCompanySkillPins(
      {
        draft: ["code-review", "custom-skill"],
        lastSaved: ["code-review"],
        hasHydratedSnapshot: true,
      },
      ["code-review"],
    );

    expect(result).toEqual({
      draft: ["code-review", "custom-skill"],
      lastSaved: ["code-review"],
      hasHydratedSnapshot: true,
      shouldSkipAutosave: false,
    });
  });

  it("adopts server state after a successful save and skips the follow-up autosave pass", () => {
    const result = applyAgentCompanySkillPins(
      {
        draft: ["code-review", "custom-skill"],
        lastSaved: ["code-review", "custom-skill"],
        hasHydratedSnapshot: true,
      },
      ["code-review", "custom-skill"],
    );

    expect(result).toEqual({
      draft: ["code-review", "custom-skill"],
      lastSaved: ["code-review", "custom-skill"],
      hasHydratedSnapshot: true,
      shouldSkipAutosave: true,
    });
  });

});
