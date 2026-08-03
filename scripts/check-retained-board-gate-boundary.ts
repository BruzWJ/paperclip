import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  listRepositoryTextFiles,
  literalRemovalViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const TOOL_SCHEMA = "packages/db/schema/tool_access.ts";
const TOOL_GATEWAY = "server/src/services/tool-gateway.ts";
const TOOL_GATEWAY_ROUTE = "server/src/routes/tool-gateway.ts";
const TOOL_POLICY = "server/src/services/tool-access-policy.ts";
const TOOL_ACCESS = "server/src/services/tool-access.ts";
const APPROVAL_SCHEMA = "packages/db/schema/approvals.ts";
const ISSUE_APPROVAL_SCHEMA = "packages/db/schema/issue_approvals.ts";
const EXECUTION_DECISION_SCHEMA =
  "packages/db/schema/issue_execution_decisions.ts";
const EXECUTION_POLICY = "server/src/services/issue-execution-policy.ts";
const CONSENT_SCHEMA = "packages/db/schema/change_consents.ts";
const CONSENT_OWNER = "server/src/services/change-consent-gate.ts";

const TOOL_ACTION_WRITERS = new Set([
  TOOL_GATEWAY,
  TOOL_POLICY,
  TOOL_ACCESS,
]);

const RETIRED_INTERACTION_OR_WAKE_SYMBOLS = [
  ["issueThread", "Interactions"].join(""),
  ["issue_thread", "_interactions"].join(""),
  ["accepted", "InteractionId"].join(""),
  ["accepted_", "interaction_id"].join(""),
  ["queueResolved", "InteractionContinuationWakeup"].join(""),
  ["buildExecution", "StageWakeup"].join(""),
  ["enqueue", "Wakeup"].join(""),
  ["request", "Wakeup"].join(""),
] as const;

function read(repositoryRoot: string, path: string): string | null {
  const absolute = resolve(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function normalizedRelative(repositoryRoot: string, absolute: string): string {
  return relative(repositoryRoot, absolute).replaceAll("\\", "/");
}

function writerViolation(
  source: string,
  table: string,
): boolean {
  return new RegExp(`\\.(?:insert|update|delete)\\(${table}\\)`).test(source);
}

function replacementGateTableViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  for (const absolute of listRepositoryTextFiles(repositoryRoot, [
    "packages/db/schema",
  ])) {
    const path = normalizedRelative(repositoryRoot, absolute);
    const source = readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/pgTable\(\s*["']([^"']+)["']/g)) {
      const table = match[1]!;
      if (
        /^(?:generic|board|interaction)_(?:gate|gates|gate_requests|gate_decisions)$/.test(
          table,
        ) ||
        /^(?:gate|gates)_(?:requests|decisions|approvals)$/.test(table)
      ) {
        violations.push(`${path}: replacement generic board-gate table ${table}`);
      }
    }
  }
  return violations;
}

/**
 * Proves that the retained board gates stay separate and keep their existing
 * exact state owners: company-tool approval, OAuth/connection state,
 * append-only execution-policy decisions, and one-shot change consent.
 */
export function retainedBoardGateBoundaryViolations(
  repositoryRoot: string,
): string[] {
  const violations: string[] = [
    ...literalRemovalViolations(repositoryRoot, {
      roots: [
        ".env.example",
        "server",
        "packages",
        "ui",
        "tests",
        "doc",
        "docs",
        "docker",
        "Dockerfile",
      ],
      forbiddenTokens: [
        ["PAPERCLIP_TOOL_ACTION", "_SIGNING_SECRET"].join(""),
        ["toolAction", "SigningSecret"].join(""),
        ["signed", "Arguments"].join(""),
        ["signed", "_arguments"].join(""),
        ["signTool", "Arguments"].join(""),
        ["readSigned", "ToolArguments"].join(""),
        ["verifyToolArguments", "Signature"].join(""),
        "approval_path_missing",
      ],
      ignoredPaths: [
        "scripts/check-retained-board-gate-boundary.ts",
        "scripts/check-retained-board-gate-boundary.test.ts",
      ],
    }),
    ...requireFileTokens(repositoryRoot, TOOL_SCHEMA, [
      'export const toolInvocations = pgTable(',
      '"tool_invocations"',
      "runId: uuid(\"run_id\").references(() => issueExecutionRuns.id",
      'export const toolActionRequests = pgTable(',
      '"tool_action_requests"',
      "invocationId: uuid(\"invocation_id\").notNull().references(() => toolInvocations.id",
      "approvalId: uuid(\"approval_id\").references(() => approvals.id",
      "canonicalArguments",
      "canonicalArgumentsHash",
      "policySnapshot",
      "approvalSnapshot",
      "dispatchIdempotencyKey",
      '"tool_action_requests_company_dispatch_uq"',
      '"tool_invocations_company_idempotency_uq"',
    ]),
    ...requireFileTokens(repositoryRoot, TOOL_POLICY, [
      "async function recordInvocation",
      "return db.transaction(async (tx) =>",
      "tx.insert(toolInvocations)",
      "tx.insert(toolActionRequests)",
      'accessDecision.decision === "require_approval"',
      "canonicalArguments: input.request.arguments ?? {}",
      "canonicalArgumentsHash",
      "gatewayPublicId: input.runContext?.gatewayPublicId ?? null",
      "gatewayTokenId: input.runContext?.gatewayTokenId ?? null",
      "mcpSessionId: input.runContext?.mcpSessionId ?? null",
      ".insert(approvals)",
      ".insert(issueApprovals)",
      "policySnapshot",
    ]),
    ...requireFileTokens(repositoryRoot, TOOL_GATEWAY, [
      "requestApprovalForRecordedToolCall",
      "executeApprovedAgentInvocation",
      'eq(toolActionRequests.status, "pending")',
      'status: "approved"',
      'eq(toolActionRequests.status, "approved")',
      'status: "executing"',
      "dispatchIdempotencyKey",
      "const parameters = claimed.canonicalArguments",
      "approvalSnapshotsMatch(",
      "const namedGatewayBound = Boolean(",
      "clientSubjectType: invocation.clientSubjectType",
      "claimed.canonicalArgumentsHash !== argumentsHash",
      'formalApproval.status !== "approved"',
      'status: "executed"',
    ]),
    ...requireFileTokens(repositoryRoot, TOOL_GATEWAY_ROUTE, [
      'router.post("/companies/:companyId/tools/action-requests/:id/approve"',
      "assertBoard(req)",
      "assertBoardMutationAccess(req, companyId)",
      "actor: { userId: req.actor.userId }",
    ]),
    ...requireFileTokens(repositoryRoot, APPROVAL_SCHEMA, [
      'export const approvals = pgTable(',
      '"approvals"',
    ]),
    ...requireFileTokens(repositoryRoot, ISSUE_APPROVAL_SCHEMA, [
      'export const issueApprovals = pgTable(',
      '"issue_approvals"',
      "approvalId: uuid(\"approval_id\").notNull().references(() => approvals.id",
    ]),
    ...requireFileTokens(repositoryRoot, TOOL_ACCESS, [
      "async function startOAuth",
      ".insert(toolOauthStates)",
      ".from(toolOauthStates)",
      ".delete(toolOauthStates)",
      ".update(toolConnections)",
    ]),
    ...requireFileTokens(repositoryRoot, EXECUTION_DECISION_SCHEMA, [
      'export const issueExecutionDecisions = pgTable(',
      '"issue_execution_decisions"',
      "createdByRunId: uuid(\"created_by_run_id\").references(() => issueExecutionRuns.id",
    ]),
    ...requireFileTokens(repositoryRoot, EXECUTION_POLICY, [
      "export function issueExecutionPolicyControlService",
      ".insert(issueExecutionDecisions)",
      "deterministicExecutionPolicyDecisionId",
      "issueExecutionPolicyPersistencePatch",
    ]),
    ...requireFileTokens(repositoryRoot, CONSENT_SCHEMA, [
      'export const changeConsents = pgTable(',
      '"change_consents"',
      "sourceRunId: uuid(\"source_run_id\").notNull().references(() => issueExecutionRuns.id",
      "consumedByRunId: uuid(\"consumed_by_run_id\").references(() => issueExecutionRuns.id",
      '"change_consents_consumption_check"',
      '"change_consents_expiry_check"',
    ]),
    ...requireFileTokens(repositoryRoot, CONSENT_OWNER, [
      "consumeAcceptedChangeConsentInTransaction",
      "eq(changeConsents.companyId, input.companyId)",
      "eq(changeConsents.requestedByAgentId, actorAgentId)",
      "inArray(changeConsents.targetKey, targetKeys)",
      "eq(changeConsents.displayedDiff, displayedDiff)",
      'eq(changeConsents.status, "accepted")',
      "ne(changeConsents.sourceRunId, actorRunId)",
      "gt(changeConsents.expiresAt, now)",
      "isNull(changeConsents.consumedAt)",
      "isNull(changeConsents.consumedByRunId)",
      "consumedByRunId: actorRunId",
      ".insert(changeConsents)",
      'eq(changeConsents.status, "pending")',
    ]),
    ...replacementGateTableViolations(repositoryRoot),
  ];

  for (const absolute of listRepositoryTextFiles(repositoryRoot, [
    "server/src/services",
    "server/src/routes",
  ])) {
    const path = normalizedRelative(repositoryRoot, absolute);
    if (/\.(?:test|spec)\.tsx?$/.test(path)) continue;
    const source = readFileSync(absolute, "utf8");
    if (
      path !== CONSENT_OWNER &&
      writerViolation(source, "changeConsents")
    ) {
      violations.push(`${path}: alternate change-consent writer`);
    }
    if (
      path !== EXECUTION_POLICY &&
      writerViolation(source, "issueExecutionDecisions")
    ) {
      violations.push(`${path}: alternate execution-policy decision writer`);
    }
    if (
      !TOOL_ACTION_WRITERS.has(path) &&
      (writerViolation(source, "toolInvocations") ||
        writerViolation(source, "toolActionRequests"))
    ) {
      violations.push(`${path}: alternate company-tool approval writer`);
    }
  }

  for (const path of [
    TOOL_GATEWAY,
    TOOL_POLICY,
    TOOL_ACCESS,
    EXECUTION_POLICY,
    CONSENT_OWNER,
  ]) {
    const source = read(repositoryRoot, path);
    if (source === null) continue;
    for (const symbol of RETIRED_INTERACTION_OR_WAKE_SYMBOLS) {
      if (source.includes(symbol)) {
        violations.push(
          `${path}: retained board gate is coupled to retired interaction/wake symbol ${symbol}`,
        );
      }
    }
  }

  const toolGateway = read(repositoryRoot, TOOL_GATEWAY);
  if (toolGateway !== null) {
    const approvalCas =
      /\.update\(toolActionRequests\)[\s\S]{0,500}?status:\s*["']approved["'][\s\S]{0,800}?eq\(toolActionRequests\.status,\s*["']pending["']\)/.test(
        toolGateway,
      );
    const executionClaim =
      /\.update\(toolActionRequests\)[\s\S]{0,500}?status:\s*["']executing["'][\s\S]{0,500}?eq\(toolActionRequests\.status,\s*["']approved["']\)/.test(
        toolGateway,
      );
    if (!approvalCas || !executionClaim) {
      violations.push(
        `${TOOL_GATEWAY}: board approval does not CAS pending → approved → executing before dispatch`,
      );
    }
  }

  return [...new Set(violations)].sort();
}

export function assertRetainedBoardGateBoundary(repositoryRoot: string): void {
  assertNoGateViolations(
    "Retained board-gate boundary check",
    retainedBoardGateBoundaryViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertRetainedBoardGateBoundary(resolve(import.meta.dirname, ".."));
    console.log("Retained board-gate boundary check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
