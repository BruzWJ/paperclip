// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: enqueueWakeup, issueThreadInteractions
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { retainedBoardGateBoundaryViolations } from "./check-retained-board-gate-boundary.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-board-gate-"));
  roots.add(root);
  write(root, "packages/db/schema/tool_access.ts", [
    'export const toolInvocations = pgTable("tool_invocations", {',
    'runId: uuid("run_id").references(() => issueExecutionRuns.id),',
    '}); "tool_invocations_company_idempotency_uq";',
    'export const toolActionRequests = pgTable("tool_action_requests", {',
    'invocationId: uuid("invocation_id").notNull().references(() => toolInvocations.id),',
    'approvalId: uuid("approval_id").references(() => approvals.id),',
    'canonicalArguments: jsonb(); canonicalArgumentsHash: text();',
    'policySnapshot: jsonb(); approvalSnapshot: jsonb(); dispatchIdempotencyKey: text();',
    '"tool_action_requests_company_dispatch_uq";',
    '});',
  ].join("\n"));
  write(root, "packages/db/schema/approvals.ts", 'export const approvals = pgTable("approvals", {});\n');
  write(root, "packages/db/schema/issue_approvals.ts", [
    'export const issueApprovals = pgTable("issue_approvals", {',
    'approvalId: uuid("approval_id").notNull().references(() => approvals.id),',
    '});',
  ].join("\n"));
  write(root, "packages/db/schema/issue_execution_decisions.ts", [
    'export const issueExecutionDecisions = pgTable("issue_execution_decisions", {',
    'createdByRunId: uuid("created_by_run_id").references(() => issueExecutionRuns.id),',
    '});',
  ].join("\n"));
  write(root, "packages/db/schema/change_consents.ts", [
    'export const changeConsents = pgTable("change_consents", {',
    'sourceRunId: uuid("source_run_id").notNull().references(() => issueExecutionRuns.id),',
    'consumedByRunId: uuid("consumed_by_run_id").references(() => issueExecutionRuns.id),',
    '});',
    'check("change_consents_consumption_check");',
    'check("change_consents_expiry_check");',
  ].join("\n"));
  write(root, "server/src/services/tool-access-policy.ts", [
    "async function recordInvocation() {",
    "return db.transaction(async (tx) => {",
    "tx.insert(toolInvocations);",
    'if (accessDecision.decision === "require_approval") tx.insert(toolActionRequests).values({ canonicalArguments: input.request.arguments ?? {}, canonicalArgumentsHash, policySnapshot });',
    'gatewayPublicId: input.runContext?.gatewayPublicId ?? null; gatewayTokenId: input.runContext?.gatewayTokenId ?? null; mcpSessionId: input.runContext?.mcpSessionId ?? null;',
    "tx.insert(approvals); tx.insert(issueApprovals);",
    "});",
    "}",
  ].join("\n"));
  write(root, "server/src/services/tool-gateway.ts", [
    "requestApprovalForRecordedToolCall;",
    "dispatchIdempotencyKey; const parameters = claimed.canonicalArguments; approvalSnapshotsMatch();",
    'if (formalApproval.status !== "approved") throw new Error();',
    "const argumentsHash = summarizeToolValue(parameters).sha256; claimed.canonicalArgumentsHash !== argumentsHash;",
    "executeApprovedAgentInvocation;",
    "const namedGatewayBound = Boolean(invocation.gatewayId); clientSubjectType: invocation.clientSubjectType;",
    'db.update(toolActionRequests).set({ status: "approved" }).where(eq(toolActionRequests.status, "pending"));',
    'db.update(toolActionRequests).set({ status: "executing" }).where(eq(toolActionRequests.status, "approved"));',
    'status: "executed";',
  ].join("\n"));
  write(root, "server/src/routes/tool-gateway.ts", [
    'router.post("/companies/:companyId/tools/action-requests/:id/approve", async (req) => {',
    "assertBoard(req); assertBoardMutationAccess(req, companyId);",
    "approveActionRequest({ actor: { userId: req.actor.userId } });",
    "});",
  ].join("\n"));
  write(root, "server/src/services/tool-access.ts", [
    "async function startOAuth() {}",
    "db.insert(toolOauthStates); db.from(toolOauthStates); db.delete(toolOauthStates);",
    "db.update(toolConnections);",
  ].join("\n"));
  write(root, "server/src/services/issue-execution-policy.ts", [
    "export function issueExecutionPolicyControlService() {}",
    "deterministicExecutionPolicyDecisionId; issueExecutionPolicyPersistencePatch;",
    "db.insert(issueExecutionDecisions);",
  ].join("\n"));
  write(root, "server/src/services/change-consent-gate.ts", [
    "consumeAcceptedChangeConsentInTransaction;",
    "eq(changeConsents.companyId, input.companyId);",
    "eq(changeConsents.requestedByAgentId, actorAgentId);",
    "inArray(changeConsents.targetKey, targetKeys);",
    "eq(changeConsents.displayedDiff, displayedDiff);",
    'eq(changeConsents.status, "accepted");',
    "ne(changeConsents.sourceRunId, actorRunId);",
    "gt(changeConsents.expiresAt, now);",
    "isNull(changeConsents.consumedAt); isNull(changeConsents.consumedByRunId);",
    "consumedByRunId: actorRunId;",
    "db.insert(changeConsents);",
    'eq(changeConsents.status, "pending");',
  ].join("\n"));
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts the four separate retained board-gate owners", () => {
  assert.deepEqual(retainedBoardGateBoundaryViolations(fixtureRoot()), []);
});

test("rejects a separate company-tool approval signing credential", () => {
  const root = fixtureRoot();
  write(
    root,
    "server/src/services/retired-tool-action-signing.ts",
    `export const legacy = process.env.${["PAPERCLIP_TOOL_ACTION", "_SIGNING_SECRET"].join("")};\n`,
  );
  assert.ok(
    retainedBoardGateBoundaryViolations(root).some((entry) =>
      entry.includes("forbidden retired token"),
    ),
  );
});

test("rejects the retired issue-only approval fallback", () => {
  const root = fixtureRoot();
  write(
    root,
    "server/src/services/retired-issue-only-approval.ts",
    'export const reasonCode = "approval_path_missing";\n',
  );
  assert.ok(
    retainedBoardGateBoundaryViolations(root).some((entry) =>
      entry.includes("forbidden retired token"),
    ),
  );
});

test("rejects non-atomic invocation and action-request admission", () => {
  const root = fixtureRoot();
  const path = "server/src/services/tool-access-policy.ts";
  write(root, path, readFileSync(join(root, path), "utf8").replace("return db.transaction(async (tx) => {", "{"));
  assert.ok(retainedBoardGateBoundaryViolations(root).some((entry) => entry.includes("transaction")));
});

test("rejects approval execution without the approved-state claim", () => {
  const root = fixtureRoot();
  const path = "server/src/services/tool-gateway.ts";
  write(root, path, readFileSync(join(root, path), "utf8").replace('eq(toolActionRequests.status, "approved")', "true"));
  assert.ok(retainedBoardGateBoundaryViolations(root).some((entry) => entry.includes("pending → approved → executing")));
});

test("rejects a weakened exact-diff consent predicate", () => {
  const root = fixtureRoot();
  const path = "server/src/services/change-consent-gate.ts";
  write(root, path, readFileSync(join(root, path), "utf8").replace("eq(changeConsents.displayedDiff, displayedDiff);", "true;"));
  assert.ok(retainedBoardGateBoundaryViolations(root).some((entry) => entry.includes("displayedDiff")));
});

test("rejects same-run change-consent consumption", () => {
  const root = fixtureRoot();
  const path = "server/src/services/change-consent-gate.ts";
  write(root, path, readFileSync(join(root, path), "utf8").replace("ne(changeConsents.sourceRunId, actorRunId);", "true;"));
  assert.ok(retainedBoardGateBoundaryViolations(root).some((entry) => entry.includes("sourceRunId")));
});

test("rejects an alternate consent writer", () => {
  const root = fixtureRoot();
  write(root, "server/src/services/parallel-consent.ts", "db.update(changeConsents);\n");
  assert.ok(retainedBoardGateBoundaryViolations(root).some((entry) => entry.includes("alternate change-consent writer")));
});

test("rejects an alternate execution-decision writer", () => {
  const root = fixtureRoot();
  write(root, "server/src/services/parallel-policy.ts", "db.insert(issueExecutionDecisions);\n");
  assert.ok(retainedBoardGateBoundaryViolations(root).some((entry) => entry.includes("alternate execution-policy")));
});

test("rejects a replacement generic board-gate table", () => {
  const root = fixtureRoot();
  write(root, "packages/db/schema/board_gates.ts", 'pgTable("board_gates", {});\n');
  assert.ok(retainedBoardGateBoundaryViolations(root).some((entry) => entry.includes("replacement generic")));
});

test("rejects interaction-card coupling", () => {
  const root = fixtureRoot();
  const path = "server/src/services/tool-gateway.ts";
  write(root, path, `${readFileSync(join(root, path), "utf8")}\nissueThreadInteractions;\n`);
  assert.ok(retainedBoardGateBoundaryViolations(root).some((entry) => entry.includes("retired interaction")));
});

test("rejects provider wake coupling", () => {
  const root = fixtureRoot();
  const path = "server/src/services/issue-execution-policy.ts";
  write(root, path, `${readFileSync(join(root, path), "utf8")}\nenqueueWakeup();\n`);
  assert.ok(retainedBoardGateBoundaryViolations(root).some((entry) => entry.includes("wake symbol")));
});

test("rejects a noncanonical run foreign key", () => {
  const root = fixtureRoot();
  const path = "packages/db/schema/change_consents.ts";
  const retiredRunOwner = ["heart", "beatRuns"].join("");
  write(root, path, readFileSync(join(root, path), "utf8").replaceAll("issueExecutionRuns.id", `${retiredRunOwner}.id`));
  assert.ok(retainedBoardGateBoundaryViolations(root).some((entry) => entry.includes("issueExecutionRuns")));
});
