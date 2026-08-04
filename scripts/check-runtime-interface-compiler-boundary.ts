import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const COMPILER = "apps/server/src/services/runtime-interface-compiler.ts";
const DATABASE_OWNER =
  "apps/server/src/services/runtime-interface-compiler-db.ts";
const CAPABILITY_GATEWAY =
  "apps/server/src/services/prompt-capability-gateway.ts";
const RUN_TOOLS_ROUTE = "apps/server/src/routes/run-tools.ts";

const COMPILER_REQUIRED = [
  "export interface RuntimeInterfaceCompileInput",
  "mode: IssueExecutionRefMode",
  "contextDial: ContextDial",
  "actionGrants:",
  "isCurrentOwner: boolean",
  "issueCreateDirectChildren:",
  "issueAssignTargets:",
  "creatorUpdateTargets:",
  "mentionTargets:",
  "configureTargets:",
  "agentHireCompanyToolOptions:",
  "selectedCompanyTools:",
  "input.actionGrants.agent_configure === true",
  "compileRuntimeInterface",
  "compiledRuntimeInterfaceDigest",
  "runtimeInterfaceDigest",
] as const;

const DATABASE_REQUIRED = [
  "function explicitConfigureTargets(",
  "configureGrants: readonly ConfigureGrant[]",
  "actionGrants.agent_configure === true",
  "explicitConfigureTargets(",
  ": []",
  "selectedCompanyTools(",
] as const;

const CAPABILITY_REQUIRED = [
  "compileRuntimeInterface",
  "grantSnapshot",
] as const;

const RUN_TOOLS_REQUIRED = [
  'method: "initialize" | "tools/list" | "tools/call"',
  "gateway.listTools(token)",
  "gateway.callTool({",
] as const;

function read(repositoryRoot: string, path: string): string | null {
  const absolutePath = resolve(repositoryRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null;
}

function between(
  source: string,
  start: string,
  end: string,
): string | null {
  const startOffset = source.indexOf(start);
  if (startOffset < 0) return null;
  const endOffset = source.indexOf(end, startOffset + start.length);
  return endOffset < 0
    ? source.slice(startOffset)
    : source.slice(startOffset, endOffset);
}

function rejectPattern(
  violations: string[],
  path: string,
  source: string,
  label: string,
  pattern: RegExp,
): void {
  if (pattern.test(source)) {
    violations.push(`${path}: ${label}`);
  }
}

/**
 * Protects the provider-visible request compiler as one closed authority
 * boundary. Company skills have a separate immutable target channel and can
 * never become descriptors, digest input, capability rows, or gateway data.
 * Management grants may only narrow the id catalog after the Paperclip
 * `agent_configure` action grant is present.
 */
export function runtimeInterfaceCompilerBoundaryViolations(
  repositoryRoot: string,
): string[] {
  const violations = [
    ...requireFileTokens(repositoryRoot, COMPILER, COMPILER_REQUIRED),
    ...requireFileTokens(repositoryRoot, DATABASE_OWNER, DATABASE_REQUIRED),
    ...requireFileTokens(
      repositoryRoot,
      CAPABILITY_GATEWAY,
      CAPABILITY_REQUIRED,
    ),
    ...requireFileTokens(repositoryRoot, RUN_TOOLS_ROUTE, RUN_TOOLS_REQUIRED),
  ];

  const compiler = read(repositoryRoot, COMPILER);
  if (compiler !== null) {
    const input = between(
      compiler,
      "export interface RuntimeInterfaceCompileInput",
      "export interface CompiledRuntimeInterface",
    );
    if (input === null) {
      violations.push(`${COMPILER}: RuntimeInterfaceCompileInput is missing`);
    } else {
      rejectPattern(
        violations,
        COMPILER,
        input,
        "company skills entered RuntimeInterfaceCompileInput",
        /\b(?:skill|skills|companySkill|companySkills|companySkillPins|selectedCompanySkills|skillChannel|skillPins)\b/i,
      );
      rejectPattern(
        violations,
        COMPILER,
        input,
        "raw management permission rows entered RuntimeInterfaceCompileInput",
        /\b(?:principalPermission|permissionGrants|configureGrants|managementPermission)\b/,
      );
    }

    const digest = between(
      compiler,
      "export function compiledRuntimeInterfaceDigest",
      "export function runtimeInterfaceDigest",
    );
    if (digest === null) {
      violations.push(`${COMPILER}: canonical descriptor digest is missing`);
    } else {
      rejectPattern(
        violations,
        COMPILER,
        digest,
        "company skills entered the descriptor/audit digest",
        /\b(?:skill|skills|companySkill|companySkillPins|selectedCompanySkills|skillChannel|skillPins)\b/i,
      );
      rejectPattern(
        violations,
        COMPILER,
        digest,
        "raw management rows entered the descriptor/audit digest",
        /\b(?:principalPermission|permissionGrants|configureGrants|managementPermission)\b/,
      );
    }

    const configureGuard = compiler.indexOf(
      "input.actionGrants.agent_configure === true",
    );
    const configureDescriptor = compiler.indexOf(
      "descriptors.push(configureDescriptor(input.configureTargets))",
    );
    if (
      configureGuard < 0 ||
      configureDescriptor < 0 ||
      configureGuard > configureDescriptor
    ) {
      violations.push(
        `${COMPILER}: agent_configure descriptor is not subordinate to its Paperclip action grant`,
      );
    }
  }

  const database = read(repositoryRoot, DATABASE_OWNER);
  if (database !== null) {
    rejectPattern(
      violations,
      DATABASE_OWNER,
      database,
      "company-skill storage entered the runtime-interface database compiler",
      /\b(?:companySkills|companySkillVersions|companySkillPins|runtimeSkillSelections|selectedCompanySkills|skillChannel)\b/,
    );
    rejectPattern(
      violations,
      DATABASE_OWNER,
      database,
      "runtime-interface compiler imports a skill owner",
      /from\s+["'][^"']*(?:skill|skills)[^"']*["']/i,
    );

    const guardOffset = database.indexOf(
      "actionGrants.agent_configure === true",
    );
    const managementOffset = database.indexOf(
      "explicitConfigureTargets(",
      guardOffset,
    );
    const emptyOffset = database.indexOf(": [];", managementOffset);
    if (
      guardOffset < 0 ||
      managementOffset < 0 ||
      emptyOffset < managementOffset
    ) {
      violations.push(
        `${DATABASE_OWNER}: configureGrants are not confined to explicitConfigureTargets behind actionGrants.agent_configure`,
      );
    }
  }

  for (const path of [CAPABILITY_GATEWAY, RUN_TOOLS_ROUTE]) {
    const source = read(repositoryRoot, path);
    if (source === null) continue;
    rejectPattern(
      violations,
      path,
      source,
      "company-skill data entered the run capability surface",
      /\b(?:companySkill|companySkills|companySkillPins|selectedCompanySkills|skillChannel|skillPins)\b/i,
    );
    rejectPattern(
      violations,
      path,
      source,
      "raw management permission rows entered the run capability surface",
      /\b(?:principalPermissionGrants|configureGrants|managementPermission)\b/,
    );
  }

  return [...new Set(violations)].sort();
}

export function assertRuntimeInterfaceCompilerBoundary(
  repositoryRoot: string,
): void {
  assertNoGateViolations(
    "Runtime-interface compiler boundary check",
    runtimeInterfaceCompilerBoundaryViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertRuntimeInterfaceCompilerBoundary(
      resolve(import.meta.dirname, ".."),
    );
    console.log("Runtime-interface compiler boundary check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
