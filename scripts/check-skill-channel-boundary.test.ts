import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { skillChannelBoundaryViolations } from "./check-skill-channel-boundary.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-skill-channel-"));
  roots.add(root);
  write(
    root,
    "packages/adapter-utils/src/selected-company-skills.ts",
    "export function selectedCompanySkillRuntimeName() {}\n",
  );
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts a repository with no Paperclip skill-channel discriminator", () => {
  assert.deepEqual(skillChannelBoundaryViolations(fixtureRoot()), []);
});

for (const token of [
  "skillChannel",
  "isolated_skills_home",
  "SelectedCompanySkillLaunchChannel",
  "prepareSelectedCompanySkillTargetHome",
  "ReapedCompanySkillMaterialization",
] as const) {
  test(`rejects retired skill execution token ${token}`, () => {
    const root = fixtureRoot();
    write(root, "apps/server/src/retired-skill-channel.ts", `const retired = ${JSON.stringify(token)};\n`);
    assert.ok(
      skillChannelBoundaryViolations(root).some((entry) =>
        entry.includes(token),
      ),
    );
  });
}

test("rejects the retired materialization lifecycle owner", () => {
  const root = fixtureRoot();
  const path =
    "apps/server/src/services/company-skill-materialization-lifecycle.ts";
  write(root, path, "export {};\n");
  assert.ok(
    skillChannelBoundaryViolations(root).some((entry) => entry.includes(path)),
  );
});
