import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  literalRemovalViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const RUNTIME_NAME_OWNER =
  "packages/adapter-utils/src/selected-company-skills.ts";
const RETIRED_MATERIALIZATION_OWNERS = [
  "apps/server/src/services/company-skill-materialization-lifecycle.ts",
  "apps/server/src/services/company-skill-materialization-lifecycle.test.ts",
] as const;

const RETIRED_SKILL_CHANNEL_TOKENS = [
  "skillChannel",
  "CompanySkillChannel",
  "companySkillChannelSchema",
  "COMPANY_SKILL_CHANNELS",
  "isolated_skills_home",
  "SelectedCompanySkillLaunchChannel",
  "SelectedCompanySkillMaterializationIdentity",
  "PreparedSelectedCompanySkillTargetHome",
  "CollectedSelectedCompanySkillTargetHome",
  "MATERIALIZED_COMPANY_SKILL_SENTINEL",
  "selectedCompanySkillMaterializationKey",
  "prepareSelectedCompanySkillTargetHome",
  "CompanySkillMaterializationLifecycleRejected",
  "ReapedCompanySkillMaterialization",
  "fenceCompanySkillMaterializationReferenceInTransaction",
  "collectCompanySkillMaterializationIfUnreferencedInTransaction",
  "hasActiveIssueExecutionAttemptForMaterializationInTransaction",
] as const;

/** Proves Paperclip has no skill-channel discriminator or materialization path. */
export function skillChannelBoundaryViolations(
  repositoryRoot: string,
): string[] {
  const violations = literalRemovalViolations(repositoryRoot, {
    forbiddenTokens: RETIRED_SKILL_CHANNEL_TOKENS,
    ignoredPaths: [
      "scripts/check-skill-channel-boundary.ts",
      "scripts/check-skill-channel-boundary.test.ts",
    ],
    roots: [
      "apps/docs",
      "apps/server/src",
      "apps/ui/src",
      "doc",
      "packages/adapter-utils/src",
      "packages/cli/src",
      "packages/db/schema",
      "packages/shared/src",
    ],
  });
  violations.push(
    ...requireFileTokens(repositoryRoot, RUNTIME_NAME_OWNER, [
      "selectedCompanySkillRuntimeName",
    ]),
  );
  for (const path of RETIRED_MATERIALIZATION_OWNERS) {
    if (existsSync(resolve(repositoryRoot, path))) {
      violations.push(`${path}: retired materialization owner still exists`);
    }
  }
  return [...new Set(violations)].sort();
}

export function assertSkillChannelBoundary(repositoryRoot: string): void {
  assertNoGateViolations(
    "Skill-channel boundary check",
    skillChannelBoundaryViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertSkillChannelBoundary(resolve(import.meta.dirname, ".."));
    console.log("Skill-channel removal check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
