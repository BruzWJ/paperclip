// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: PAPERCLIP_API_KEY, PAPERCLIP_API_URL, PAPERCLIP_RUN_ID
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepoFile(path: string) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

describe("release-content compiled-interface contract", () => {
  const release = readRepoFile(".agents/skills/release/SKILL.md");
  const changelog = readRepoFile(".agents/skills/release-changelog/SKILL.md");
  const discord = readRepoFile(".agents/skills/release-changelog-discord-message/SKILL.md");
  const announcement = readRepoFile(
    "packages/skills-catalog/catalog/optional/content/release-announcement/SKILL.md",
  );
  const skills = { release, changelog, discord, announcement };

  it("does not instruct agents to use generic Paperclip REST or Cases wiring", () => {
    for (const [name, content] of Object.entries(skills)) {
      expect(content, name).not.toMatch(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\//);

      for (const forbidden of [
        "/api/cases",
        "X-Paperclip-Run-Id",
        "PAPERCLIP_API_URL",
        "PAPERCLIP_API_KEY",
        "PAPERCLIP_RUN_ID",
        "\"caseType\"",
        "\"parentCaseId\"",
        "experimental.enableCases",
        "skills/paperclip/references/cases.md",
      ]) {
        expect(content, `${name}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("retains the actual release and announcement workflows", () => {
    expect(release).toContain("stable changelog drafting via `release-changelog`");
    expect(release).toContain(
      "artifact-only release validation via `pnpm run test:release-smoke` and the canonical root `Dockerfile`",
    );
    expect(release).toContain("manual stable promotion from a chosen source ref");
    expect(release).toContain("GitHub Release creation");
    expect(release).toContain("use only tools exposed in the current compiled interface");

    expect(changelog).toContain("- `releases/vYYYY.MDD.P.md`");
    expect(changelog).toContain("## Step 3 — Detect Breaking Changes");
    expect(changelog).toContain("present the draft for human sign-off");

    expect(discord).toContain("A single fenced markdown code block, ready to paste into Discord.");
    expect(discord).toContain("Read the matching `releases/vYYYY.MDD.P.md`");
    expect(discord).toContain("Do not publish to Discord.");
    expect(discord).toContain("Use only tools exposed in the current");

    expect(announcement).toContain("## Determine the audience and channel first");
    expect(announcement).toContain("1. **What changed.**");
    expect(announcement).toContain("## Post-publish checklist");
  });
});
