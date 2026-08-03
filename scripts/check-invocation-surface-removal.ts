import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  listRepositoryTextFiles,
  literalRemovalViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const FORBIDDEN_TOKENS = [
  "testEnvironment",
  "Respond with hello.",
  "onHireApproved",
  "HireApprovedPayload",
  "HireApprovedHookResult",
  "hire-hook.ts",
  "notifyHireApproved",
  "AdapterRuntimeConfigurationPreflight",
  "preflightRegisteredAdapterRuntimeConfiguration",
  "preflightExplicitAdapterConfiguration",
  "useAdapterRuntimeConfigurationPreflight",
  "useExplicitAdapterConfiguration",
  "/configuration-preflight",
] as const;

const IGNORED_PATHS = [
  "scripts/check-invocation-surface-removal.ts",
  "scripts/check-invocation-surface-removal.test.ts",
] as const;

const PREFLIGHT_OWNER =
  "server/src/services/adapter-configuration-preflight.ts";
const PREFLIGHT_REQUIRED_TOKENS = [
  "createPostgresAdapterConfigurationPreflightService",
  "loadExactBinding",
  "currentAdapterConfigRevisionId",
  "executionWorkspaceBindingId",
  "resolveApprovedAcpNativeAuthentication",
  "resolveAdapterExecutionTargetNativeIdentityEnvironment",
  "resolveCompanySkillMaterializationRevisionInTransaction",
  "createIssueExecutionTargetAcquirer",
  "prepareAcpExecutionTargetSubprocess",
  "runTargetProcess",
  "targetNativeExecutable",
  "createInitializeOnlyClient",
  ".initialize()",
  "closeAndReap",
  "disposeBeforeStart",
  ".release(",
  'status: "ready"',
  'status: "incomplete"',
] as const;
const PREFLIGHT_FORBIDDEN_EFFECTS = [
  ".insert(",
  ".update(",
  ".delete(",
  "issueExecutionRefs",
  "issueSession",
  "nativeCorrelation",
  "transcript",
  "executeAcpSubprocessPrompt",
  "startSession",
  "newSession",
  "resumeSession",
  "promptSession",
  "session/new",
  "session/resume",
  "session/prompt",
  "createIssueExecutionRun",
  "modelProbe",
  "model probe",
  "Respond with",
] as const;

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function invocationSurfaceRemovalViolations(
  repositoryRoot: string,
): string[] {
  const violations = literalRemovalViolations(repositoryRoot, {
    forbiddenTokens: FORBIDDEN_TOKENS,
    ignoredPaths: IGNORED_PATHS,
  });

  for (const absolutePath of listRepositoryTextFiles(repositoryRoot, [
    "packages/adapters",
  ])) {
    const path = normalizePath(relative(repositoryRoot, absolutePath));
    if (/^packages\/adapters\/[^/]+\/src\/server\/test\.[^.]+$/.test(path)) {
      violations.push(
        `${path}: retired model-producing adapter readiness module exists`,
      );
    }
  }

  violations.push(
    ...requireFileTokens(
      repositoryRoot,
      PREFLIGHT_OWNER,
      PREFLIGHT_REQUIRED_TOKENS,
    ),
  );

  const preflightPath = resolve(repositoryRoot, PREFLIGHT_OWNER);
  if (existsSync(preflightPath)) {
    const source = readFileSync(preflightPath, "utf8");
    for (const effect of PREFLIGHT_FORBIDDEN_EFFECTS) {
      if (source.includes(effect)) {
        violations.push(
          `${PREFLIGHT_OWNER}: live readiness owns forbidden productive effect ${effect}`,
        );
      }
    }
  }

  return [...new Set(violations)].sort();
}

export function assertInvocationSurfaceRemoval(
  repositoryRoot: string,
): void {
  assertNoGateViolations(
    "Invocation-surface removal check",
    invocationSurfaceRemovalViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertInvocationSurfaceRemoval(resolve(import.meta.dirname, ".."));
    console.log("Invocation-surface removal check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
