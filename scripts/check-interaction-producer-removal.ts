import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  literalRemovalViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const FORBIDDEN_TOKENS = [
  "approvalRequiredInstructions",
  "approvedActionRequestId",
  ["buildExecutionStage", "Wakeup"].join(""),
  ["queueResolvedInteractionContinuation", "Wakeup"].join(""),
  ["accepted", "InteractionId"].join(""),
  ["accepted", "_interaction_id"].join(""),
  "buildCaseContextMarkdown",
] as const;

const IGNORED_PATHS = [
  "scripts/check-interaction-producer-removal.ts",
  "scripts/check-interaction-producer-removal.test.ts",
] as const;

const TOOL_GATEWAY_OWNER = "apps/server/src/services/tool-gateway.ts";
const PIPELINE_OWNER = "apps/server/src/routes/pipelines.ts";

function requireOrderedTokens(
  repositoryRoot: string,
  path: string,
  tokens: readonly string[],
): string[] {
  const absolutePath = resolve(repositoryRoot, path);
  if (!existsSync(absolutePath)) return [];
  const source = readFileSync(absolutePath, "utf8");
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    if (next === -1) {
      return [`${path}: canonical approval claim/check/execute order changed`];
    }
    cursor = next;
  }
  return [];
}

export function interactionProducerRemovalViolations(
  repositoryRoot: string,
): string[] {
  const violations = literalRemovalViolations(repositoryRoot, {
    forbiddenTokens: FORBIDDEN_TOKENS,
    ignoredPaths: IGNORED_PATHS,
  });

  const claimExecuteTokens = [
    "executeApprovedAgentInvocation",
    'eq(toolActionRequests.status, "approved")',
    "dispatchIdempotencyKey",
    "approvalSnapshotsMatch",
    "const parameters = claimed.canonicalArguments",
    "resolveInvocationToolBinding",
  ] as const;
  violations.push(
    ...requireFileTokens(
      repositoryRoot,
      TOOL_GATEWAY_OWNER,
      claimExecuteTokens,
    ),
    ...requireOrderedTokens(repositoryRoot, TOOL_GATEWAY_OWNER, [
      'eq(toolActionRequests.status, "approved")',
      "resolveInvocationToolBinding",
      "approvalSnapshotsMatch",
      "const parameters = claimed.canonicalArguments",
    ]),
    ...requireFileTokens(repositoryRoot, PIPELINE_OWNER, [
      'router.post(\n    "/cases/:caseId/open-conversation"',
      "assertBoard(req)",
      "req.actor.userId.trim()",
      "ordinaryIssues.create",
      "request: req.body.request",
      "ownerAgentId: req.body.ownerAgentId",
      'creator: { kind: "user/board", userId }',
    ]),
  );

  return [...new Set(violations)].sort();
}

export function assertInteractionProducerRemoval(
  repositoryRoot: string,
): void {
  assertNoGateViolations(
    "Interaction-producer removal check",
    interactionProducerRemovalViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertInteractionProducerRemoval(resolve(import.meta.dirname, ".."));
    console.log("Interaction-producer removal check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
