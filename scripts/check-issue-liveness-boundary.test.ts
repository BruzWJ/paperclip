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
import { issueLivenessBoundaryViolations } from "./check-issue-liveness-boundary.ts";

const roots = new Set<string>();

function write(root: string, path: string, source: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
}

function replace(
  root: string,
  path: string,
  expected: string,
  replacement: string,
): void {
  const absolute = join(root, path);
  const source = readFileSync(absolute, "utf8");
  assert.ok(source.includes(expected), `${path} is missing mutation target ${expected}`);
  writeFileSync(absolute, source.replace(expected, replacement));
}

function replaceAfter(
  root: string,
  path: string,
  owner: string,
  expected: string,
  replacement: string,
): void {
  const absolute = join(root, path);
  const source = readFileSync(absolute, "utf8");
  const ownerIndex = source.indexOf(owner);
  assert.notEqual(ownerIndex, -1, `${path} is missing owner ${owner}`);
  const mutationIndex = source.indexOf(expected, ownerIndex + owner.length);
  assert.notEqual(
    mutationIndex,
    -1,
    `${path} is missing mutation target ${expected} after ${owner}`,
  );
  writeFileSync(
    absolute,
    `${source.slice(0, mutationIndex)}${replacement}${source.slice(
      mutationIndex + expected.length,
    )}`,
  );
}

function append(root: string, path: string, source: string): void {
  const absolute = join(root, path);
  writeFileSync(absolute, `${readFileSync(absolute, "utf8")}${source}`);
}

function assertViolation(root: string, expected: string): void {
  const violations = issueLivenessBoundaryViolations(root);
  assert.ok(
    violations.some((entry) => entry.includes(expected)),
    `expected a violation containing ${expected}; received:\n${violations.join("\n")}`,
  );
}

function canonicalLivenessSchema(): string {
  return [
    "export const issueExecutionFinalizationStaleCheckOutbox = pgTable(",
    '  "issue_execution_finalization_stale_check_outbox",',
    "  {",
    '    companyId: uuid("company_id").notNull(),',
    '    issueId: uuid("issue_id").notNull(),',
    '    ownershipEpoch: integer("ownership_epoch").notNull(),',
    '    runId: uuid("run_id").notNull(),',
    '    finalizationId: uuid("finalization_id").primaryKey(),',
    '    createdAt: timestamp("created_at").notNull(),',
    '    processedAt: timestamp("processed_at"),',
    "  },",
    "  (table) => [",
    '    foreignKey({ columns: [table.companyId, table.issueId, table.ownershipEpoch, table.runId], foreignColumns: [issueExecutionRuns.companyId, issueExecutionRuns.issueId, issueExecutionRuns.ownershipEpoch, issueExecutionRuns.id], name: "issue_execution_finalization_stale_check_outbox_run_fk" }),',
    '    foreignKey({ columns: [table.companyId, table.runId, table.finalizationId], foreignColumns: [issueExecutionFinalizations.companyId, issueExecutionFinalizations.runId, issueExecutionFinalizations.id], name: "issue_execution_finalization_stale_check_outbox_finalization_fk" }),',
    "  ],",
    ");",
    "",
    "export const issueLivenessReconciliations = pgTable(",
    '  "issue_liveness_reconciliations",',
    "  {",
    '    id: uuid("id").primaryKey(),',
    '    companyId: uuid("company_id").notNull(),',
    '    issueId: uuid("issue_id").notNull(),',
    '    ownershipEpoch: integer("ownership_epoch").notNull(),',
    '    frontierFinalizationId: uuid("frontier_finalization_id").notNull(),',
    '    creatorEdgeId: uuid("creator_edge_id").notNull(),',
    '    creatorEdgeAdmissionVersion: integer("creator_edge_admission_version").notNull(),',
    '    staleTargetAgentId: uuid("stale_target_agent_id").notNull(),',
    '    sourceRunId: uuid("source_run_id").notNull(),',
    '    sourceMode: text("source_mode").notNull(),',
    '    sourceCommentId: uuid("source_comment_id").notNull(),',
    '    followupSystemReplyCommentId: uuid("followup_system_reply_comment_id"),',
    '    followupRefId: uuid("followup_ref_id"),',
    '    followupRunId: uuid("followup_run_id"),',
    '    followupFinalizationId: uuid("followup_finalization_id"),',
    '    acceptedActionKind: text("accepted_action_kind"),',
    '    acceptedActionSourceId: text("accepted_action_source_id"),',
    '    acceptedActionCommittedAt: timestamp("accepted_action_committed_at"),',
    '    supersededBeforeAttentionAt: timestamp("superseded_before_attention_at"),',
    '    boardAttentionEmittedAt: timestamp("board_attention_emitted_at"),',
    '    boardAttentionReason: text("board_attention_reason"),',
    '    exitActionKind: text("exit_action_kind"),',
    '    exitActionSourceId: text("exit_action_source_id"),',
    '    exitActionCommittedAt: timestamp("exit_action_committed_at"),',
    '    admittedAt: timestamp("admitted_at").notNull(),',
    "  },",
    "  (table) => [",
    '    check("issue_liveness_reconciliations_followup_chain_check", sql`${table.followupRunId}`),',
    '    check("issue_liveness_reconciliations_initial_settlement_check", sql`${table.acceptedActionKind}`),',
    '    check("issue_liveness_reconciliations_accepted_action_kind_check", sql`${table.acceptedActionKind} in (\'authenticated_human_comment\', \'issue_create_child\', \'mention_agent\', \'mention_board\', \'issue_assign\', \'issue_update\', \'creator_withdrawal\', \'board_lifecycle_command\', \'board_reopen\')`),',
    '    check("issue_liveness_reconciliations_exit_action_kind_check", sql`${table.exitActionKind} in (\'authenticated_human_comment\', \'issue_create_child\', \'mention_agent\', \'mention_board\', \'issue_assign\', \'issue_update\', \'creator_withdrawal\', \'board_lifecycle_command\', \'board_reopen\')`),',
    "    foreignKey({",
    "      columns: [table.companyId, table.issueId, table.ownershipEpoch, table.creatorEdgeId, table.creatorEdgeAdmissionVersion],",
    "      foreignColumns: [issueCreatorEdgeReceivability.companyId, issueCreatorEdgeReceivability.issueId, issueCreatorEdgeReceivability.ownershipEpoch, issueCreatorEdgeReceivability.id, issueCreatorEdgeReceivability.admissionVersion],",
    '      name: "issue_liveness_reconciliations_creator_edge_fk",',
    "    }),",
    "    foreignKey({",
    "      columns: [table.companyId, table.issueId, table.ownershipEpoch, table.sourceRunId, table.staleTargetAgentId, table.sourceMode],",
    "      foreignColumns: [issueExecutionRuns.companyId, issueExecutionRuns.issueId, issueExecutionRuns.ownershipEpoch, issueExecutionRuns.id, issueExecutionRuns.targetAgentId, issueExecutionRuns.executionMode],",
    '      name: "issue_liveness_reconciliations_source_run_fk",',
    "    }),",
    "    foreignKey({",
    "      columns: [table.companyId, table.sourceRunId, table.frontierFinalizationId],",
    "      foreignColumns: [issueExecutionFinalizations.companyId, issueExecutionFinalizations.runId, issueExecutionFinalizations.id],",
    '      name: "issue_liveness_reconciliations_frontier_finalization_fk",',
    "    }),",
    "    foreignKey({",
    "      columns: [table.companyId, table.issueId, table.sourceRunId, table.sourceCommentId],",
    "      foreignColumns: [issueComments.companyId, issueComments.issueId, issueComments.runId, issueComments.id],",
    '      name: "issue_liveness_reconciliations_source_comment_fk",',
    "    }),",
    "    foreignKey({",
    "      columns: [table.companyId, table.issueId, table.followupSystemReplyCommentId, table.sourceCommentId],",
    "      foreignColumns: [issueComments.companyId, issueComments.issueId, issueComments.id, issueComments.replyToCommentId],",
    '      name: "issue_liveness_reconciliations_followup_reply_fk",',
    "    }),",
    "    foreignKey({",
    "      columns: [table.companyId, table.issueId, table.ownershipEpoch, table.followupRefId, table.staleTargetAgentId, table.sourceMode],",
    "      foreignColumns: [issueExecutionRefs.companyId, issueExecutionRefs.issueId, issueExecutionRefs.ownershipEpoch, issueExecutionRefs.id, issueExecutionRefs.targetAgentId, issueExecutionRefs.mode],",
    '      name: "issue_liveness_reconciliations_followup_ref_fk",',
    "    }),",
    "    foreignKey({",
    "      columns: [table.companyId, table.issueId, table.ownershipEpoch, table.followupRunId, table.staleTargetAgentId, table.sourceMode],",
    "      foreignColumns: [issueExecutionRuns.companyId, issueExecutionRuns.issueId, issueExecutionRuns.ownershipEpoch, issueExecutionRuns.id, issueExecutionRuns.targetAgentId, issueExecutionRuns.executionMode],",
    '      name: "issue_liveness_reconciliations_followup_run_fk",',
    "    }),",
    "    foreignKey({",
    "      columns: [table.companyId, table.followupRunId, table.followupFinalizationId],",
    "      foreignColumns: [issueExecutionFinalizations.companyId, issueExecutionFinalizations.runId, issueExecutionFinalizations.id],",
    '      name: "issue_liveness_reconciliations_followup_finalization_fk",',
    "    }),",
    '    unique("issue_liveness_reconciliations_frontier_uq").on(table.companyId, table.issueId, table.ownershipEpoch, table.frontierFinalizationId),',
    '    uniqueIndex("issue_liveness_reconciliations_followup_comment_uq").on(table.followupSystemReplyCommentId),',
    '    uniqueIndex("issue_liveness_reconciliations_followup_ref_uq").on(table.followupRefId),',
    '    uniqueIndex("issue_liveness_reconciliations_followup_run_uq").on(table.followupRunId),',
    '    uniqueIndex("issue_liveness_reconciliations_followup_finalization_uq").on(table.followupFinalizationId),',
    "  ],",
    ");",
    "",
  ].join("\n");
}

function canonicalRunSchema(): string {
  return [
    "export const issueExecutionRunLivenessFacts = pgTable(",
    '  "issue_execution_run_liveness_facts",',
    "  {",
    '    id: uuid("id").primaryKey(),',
    '    companyId: uuid("company_id").notNull(),',
    '    runId: uuid("run_id").notNull(),',
    '    livenessState: text("liveness_state").notNull(),',
    '    livenessReason: text("liveness_reason").notNull(),',
    '    continuationAttempt: integer("continuation_attempt").notNull(),',
    '    lastUsefulActionAt: timestamp("last_useful_action_at"),',
    '    nextAction: text("next_action"),',
    "  },",
    "  (table) => [",
    '    check("issue_execution_run_liveness_facts_state_check", sql`${table.livenessState} in (\'completed\', \'advanced\', \'plan_only\', \'empty_response\', \'blocked\', \'failed\', \'needs_followup\')`),',
    '    unique("issue_execution_run_liveness_facts_run_uq").on(table.runId),',
    '    unique("issue_execution_run_liveness_facts_run_id_uq").on(table.runId, table.id),',
    "  ],",
    ");",
    "export const issueExecutionFinalizations = pgTable(",
    '  "issue_execution_finalizations",',
    "  {",
    '    runLivenessFactId: uuid("run_liveness_fact_id"),',
    "  },",
    "  (table) => [",
    "    foreignKey({",
    "      columns: [table.runId, table.runLivenessFactId],",
    "      foreignColumns: [issueExecutionRunLivenessFacts.runId, issueExecutionRunLivenessFacts.id],",
    '      name: "issue_execution_finalizations_liveness_fact_fk",',
    "    }),",
    "  ],",
    ");",
    "",
  ].join("\n");
}

function canonicalLivenessService(): string {
  return [
    "export type IssueLivenessActionReference =",
    "  | `issue_board_user_comment:${string}`",
    "  | `issue_board_mention:${string}`",
    "  | `issue:${string}`",
    "  | `issue_consult_execution:${string}`",
    "  | `issue_execution_prompt_segment:${string}:${string}:${number}`",
    "  | `issue_execution_ref:${string}`",
    "  | `issue_update:${string}`",
    "  | `issue_creator_withdrawal_command:${string}`",
    "  | `issue_board_lifecycle_command:${string}`",
    "  | `issue_board_reopen_command:${string}`;",
    "async function resolveIssueLivenessActionSourceInTransaction() {}",
    "export async function recordIssueLivenessActionInTransaction() {}",
    "function processFinalizationInTransaction(run: any, finalization: any) {",
    "  if (run.terminalFinalizationId !== finalization.id || run.targetAgentId === null) throw new Error();",
    "  if (row.staleTargetAgentId !== run.targetAgentId) throw new Error();",
    "  if (binding.ref.targetAgentId !== run.targetAgentId) throw new Error();",
    "  transaction.insert(issueLivenessReconciliations).values({",
    "    staleTargetAgentId: run.targetAgentId,",
    "    sourceRunId: run.runId,",
    "    sourceCommentId: finalization.progressCommentId,",
    "  });",
    "  transaction.insert(issueConsultExecutions).values({",
    "    targetAgentId: run.targetAgentId,",
    "  });",
    "  admission.admitExecutionSource({",
    "    targetAgentId: run.targetAgentId,",
    '    sourceKind: "agent_liveness_followup",',
    "    replyToCommentId: finalization.progressCommentId,",
    "  });",
    "  transaction.update(issueLivenessReconciliations);",
    "  transaction.update(issueExecutionFinalizationStaleCheckOutbox);",
    "}",
    "async function consumeFinalizationOutbox(input: any) {",
    "  return database.transaction((transaction: any) => processFinalizationInTransaction(transaction, input));",
    "}",
    "",
  ].join("\n");
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-issue-liveness-gate-"));
  roots.add(root);
  write(
    root,
    "packages/shared/src/issue-runtime.ts",
    [
      'export const AGENT_VISIBLE_ISSUE_STATUSES = ["open", "blocked", "done", "cancelled"] as const;',
      'export const AGENT_LIVENESS_ACTION_KINDS = ["authenticated_human_comment", "issue_create_child", "mention_agent", "mention_board", "issue_assign", "issue_update", "creator_withdrawal", "board_lifecycle_command", "board_reopen"] as const;',
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/shared/src/constants.ts",
    [
      'export const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;',
      'export const BLOCKER_ATTENTION_STATES = ["needs_attention"] as const;',
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/issues.ts",
    [
      'check("issues_lifecycle_status_check", sql`${table.lifecycleStatus} in (\'open\', \'blocked\', \'done\', \'cancelled\')`),',
      'check("issues_board_presentation_status_check", sql`${table.boardPresentationStatus} in (\'backlog\', \'todo\', \'in_progress\', \'in_review\', \'blocked\', \'done\', \'cancelled\')`),',
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/issue_creator_edge.ts",
    'check("issue_updates_status_check", sql`${table.status} is null or ${table.status} in (\'open\', \'blocked\', \'done\', \'cancelled\')`),\n',
  );
  write(
    root,
    "packages/shared/src/validators/issue.ts",
    [
      "export const commitIssueOwnerFormSchema = z",
      "  .object({",
      '    status: z.enum(["open", "blocked", "done", "cancelled"]).optional(),',
      "  });",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/company-portability.ts",
    [
      "interface PortableCanonicalIssueCreateInput {",
      "  lifecycleStatus: AgentVisibleIssueStatus;",
      "}",
      "function parse(extension: any) {",
      "  const lifecycleStatus = asString(extension.lifecycleStatus);",
      "  if (!lifecycleStatus || ![\"open\", \"blocked\", \"done\", \"cancelled\"].includes(",
      "    lifecycleStatus,",
      "  )) throw new Error();",
      "  const boardPresentationStatus = asString(",
      "    extension.boardPresentationStatus,",
      "  );",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/runtime-interface-compiler.ts",
    [
      "function issueFilterSchema() {",
      "  return objectSchema({",
      '    status: { type: "string", enum: ["open", "blocked", "done", "cancelled"] },',
      "  });",
      "}",
      "function issueUpdateDescriptor() {",
      "  return [",
      '    { status: { type: "string", enum: ["open", "blocked"] } },',
      '    { status: { type: "string", enum: ["done", "cancelled"] } },',
      "  ];",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/plugins/sdk/src/types.ts",
    [
      "export interface PluginRunIssuesClient {",
      '  status?: "open" | "blocked" | "done" | "cancelled";',
      "}",
      "export interface PluginCreatorCallbackDelivery {",
      '  status: "open" | "blocked" | "done" | "cancelled" | null;',
      "}",
      "export interface PluginIssuesClient {",
      '  status?: "open" | "blocked" | "done" | "cancelled";',
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/plugins/sdk/src/protocol.ts",
    [
      '"issues.list": [',
      "  params: {",
      '    status?: "open" | "blocked" | "done" | "cancelled";',
      "  },",
      "],",
      '"run.issues.listCompanyIssues": [',
      "  params: {",
      '    status?: "open" | "blocked" | "done" | "cancelled";',
      "  },",
      "],",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/plugins/sdk/src/worker-rpc-host.ts",
    [
      "function listCompanyIssues(input: {",
      '  status?: "open" | "blocked" | "done" | "cancelled";',
      "} = {}) {}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/plugins/sdk/src/ui/components.ts",
    [
      "export interface IssuesListFilters {",
      '  status?: "open" | "blocked" | "done" | "cancelled";',
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/ui/src/plugins/bridge-init.ts",
    [
      "type PluginIssuesListFilters = {",
      '  status?: "open" | "blocked" | "done" | "cancelled";',
      "};",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/ui/src/pages/IssueDetail.tsx",
    [
      "const commitHumanOwnerStatus = useMutation({",
      "  mutationFn: async (input: {",
      '    status: "open" | "blocked" | "done" | "cancelled";',
      "  }) => issuesApi.commitOwnerFormUpdate({ status: input.status }),",
      "});",
      "",
    ].join("\n"),
  );
  write(root, "packages/db/schema/issue_liveness_reconciliations.ts", canonicalLivenessSchema());
  write(root, "packages/db/schema/issue_execution_runs.ts", canonicalRunSchema());
  write(root, "apps/server/src/services/issue-liveness-reconciliation.ts", canonicalLivenessService());
  write(
    root,
    "apps/server/src/services/issue-execution-finalization-postgres.ts",
    [
      "function insertProductiveLivenessFact() {",
      "  transaction.insert(issueExecutionRunLivenessFacts).values({",
      "    id,",
      "    companyId: input.companyId,",
      "    runId: input.runId,",
      "    livenessState: classification.livenessState,",
      "    livenessReason: classification.livenessReason,",
      "    continuationAttempt: classification.continuationAttempt,",
      "    lastUsefulActionAt: classification.lastUsefulActionAt,",
      "    nextAction: classification.nextAction,",
      "  });",
      "  const finalization = { runLivenessFactId: livenessId };",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/issue-execution-postgres.ts",
    [
      "const finalizer = createPostgresIssueExecutionFinalizationWriter({",
      "});",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/issue-execution-dispatcher-postgres.ts",
    [
      "async function assertRefDispatchable(issue: any) {",
      '  if (ref.sourceKind === "agent_liveness_followup") throw new Error();',
      '  if (!["open", "blocked"].includes(issue.lifecycleStatus)) throw new Error();',
      "}",
      'const discoverable = ne(issueExecutionRefs.sourceKind, "agent_liveness_followup");',
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/issue-execution-cancellation.ts",
    [
      "",
    ].join("\n"),
  );
  const producers: Record<string, string> = {
    "apps/server/src/services/canonical-issue-aggregate.ts":
      "recordIssueLivenessActionInTransaction(tx, `issue:${persistedIssue.id}`);\n",
    "apps/server/src/services/ordinary-issue-runtime.ts": [
      "recordIssueLivenessActionInTransaction(tx, `issue_execution_ref:${admission.ref.id}`);",
      "recordIssueLivenessActionInTransaction(tx, `issue_board_reopen_command:${command.id}`);",
      "recordIssueLivenessActionInTransaction(tx, `issue_board_user_comment:${command.id}`);",
      "recordIssueLivenessActionInTransaction(tx, `issue_creator_withdrawal_command:${command.id}`);",
      "",
    ].join("\n"),
    "apps/server/src/services/runtime-issue-action-port.ts": [
      "recordIssueLivenessActionInTransaction(tx, `issue_update:${update.id}`);",
      "recordIssueLivenessActionInTransaction(tx, `issue_execution_ref:${admission.ref.id}`);",
      "recordIssueLivenessActionInTransaction(tx, `issue_board_mention:${mention.id}`);",
      "",
    ].join("\n"),
    "apps/server/src/services/issue-board-lifecycle-command.ts":
      "recordIssueLivenessActionInTransaction(tx, `issue_board_lifecycle_command:${row.id}`);\n",
    "apps/server/src/services/issue-execution-prompt-cycle-postgres.ts":
      "recordIssueLivenessActionInTransaction(tx, `issue_execution_prompt_segment:${prompt.identity.runId}:${prompt.identity.refId}:${prompt.identity.segmentOrdinal}`);\n",
  };
  for (const [path, source] of Object.entries(producers)) write(root, path, source);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts the canonical completion-only same-agent liveness boundary", () => {
  assert.deepEqual(issueLivenessBoundaryViolations(fixtureRoot()), []);
});

test("does not confuse seven-value board presentation or blocker needs_attention with lifecycle", () => {
  const root = fixtureRoot();
  assert.equal(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("agent-visible lifecycle"),
    ),
    false,
  );
});

test("rejects a fifth agent-visible lifecycle value", () => {
  const root = fixtureRoot();
  replace(
    root,
    "packages/shared/src/issue-runtime.ts",
    '"done", "cancelled"',
    '"done", "cancelled", "parked"',
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("agent-visible lifecycle"),
    ),
  );
});

for (const [path, owner, expectedViolation] of [
  [
    "packages/db/schema/issues.ts",
    "issues_lifecycle_status_check",
    "lifecycle constraint",
  ],
  [
    "packages/db/schema/issue_creator_edge.ts",
    "issue_updates_status_check",
    "issue_updates_status_check",
  ],
] as const) {
  test(`rejects an arbitrary fifth lifecycle value in ${path}`, () => {
    const root = fixtureRoot();
    replaceAfter(
      root,
      path,
      owner,
      "'cancelled'",
      "'cancelled', 'parked'",
    );
    assertViolation(root, expectedViolation);
  });
}

test("rejects an arbitrary fifth owner-form validator value", () => {
  const root = fixtureRoot();
  replaceAfter(
    root,
    "packages/shared/src/validators/issue.ts",
    "commitIssueOwnerFormSchema",
    '"cancelled"',
    '"cancelled", "parked"',
  );
  assertViolation(root, "commitIssueOwnerFormSchema");
});

test("rejects an arbitrary fifth company-portability parser value", () => {
  const root = fixtureRoot();
  replaceAfter(
    root,
    "apps/server/src/services/company-portability.ts",
    "const lifecycleStatus = asString(extension.lifecycleStatus);",
    '"cancelled"',
    '"cancelled", "parked"',
  );
  assertViolation(root, "manifest parser");
});

test("rejects extending the canonical company-portability input type", () => {
  const root = fixtureRoot();
  replaceAfter(
    root,
    "apps/server/src/services/company-portability.ts",
    "interface PortableCanonicalIssueCreateInput",
    "AgentVisibleIssueStatus;",
    'AgentVisibleIssueStatus | "parked";',
  );
  assertViolation(root, "canonical import input");
});

for (const [owner, expected, replacement, expectedViolation] of [
  [
    "function issueFilterSchema()",
    '"cancelled"]',
    '"cancelled", "parked"]',
    "issueFilterSchema",
  ],
  [
    "function issueUpdateDescriptor(",
    '"blocked"]',
    '"blocked", "parked"]',
    "owner-form runtime schema",
  ],
] as const) {
  test(`rejects an arbitrary fifth runtime-interface value in ${owner}`, () => {
    const root = fixtureRoot();
    replaceAfter(
      root,
      "apps/server/src/services/runtime-interface-compiler.ts",
      owner,
      expected,
      replacement,
    );
    assertViolation(root, expectedViolation);
  });
}

test("rejects an arbitrary third locked dispatchable lifecycle value", () => {
  const root = fixtureRoot();
  replaceAfter(
    root,
    "apps/server/src/services/issue-execution-dispatcher-postgres.ts",
    "async function assertRefDispatchable",
    '"blocked"',
    '"blocked", "parked"',
  );
  assertViolation(root, "locked dispatchability");
});

for (const [path, owner, expectedViolation] of [
  [
    "packages/plugins/sdk/src/types.ts",
    "export interface PluginRunIssuesClient",
    "PluginRunIssuesClient filter",
  ],
  [
    "packages/plugins/sdk/src/types.ts",
    "export interface PluginCreatorCallbackDelivery",
    "PluginCreatorCallbackDelivery status",
  ],
  [
    "packages/plugins/sdk/src/types.ts",
    "export interface PluginIssuesClient",
    "PluginIssuesClient filter",
  ],
  [
    "packages/plugins/sdk/src/protocol.ts",
    '"issues.list": [',
    "issues.list RPC filter",
  ],
  [
    "packages/plugins/sdk/src/protocol.ts",
    '"run.issues.listCompanyIssues": [',
    "run.issues.listCompanyIssues RPC filter",
  ],
  [
    "packages/plugins/sdk/src/worker-rpc-host.ts",
    "listCompanyIssues(input:",
    "worker-host company-issue filter",
  ],
  [
    "packages/plugins/sdk/src/ui/components.ts",
    "export interface IssuesListFilters",
    "plugin UI IssuesListFilters",
  ],
] as const) {
  test(`rejects an arbitrary fifth plugin projection value in ${owner}`, () => {
    const root = fixtureRoot();
    replaceAfter(root, path, owner, '"cancelled"', '"cancelled" | "parked"');
    assertViolation(root, expectedViolation);
  });
}

for (const [path, owner, expectedViolation] of [
  [
    "apps/ui/src/plugins/bridge-init.ts",
    "type PluginIssuesListFilters =",
    "host UI plugin bridge filter",
  ],
  [
    "apps/ui/src/pages/IssueDetail.tsx",
    "const commitHumanOwnerStatus = useMutation(",
    "human owner status mutation",
  ],
] as const) {
  test(`rejects an arbitrary fifth UI projection value in ${path}`, () => {
    const root = fixtureRoot();
    replaceAfter(root, path, owner, '"cancelled"', '"cancelled" | "parked"');
    assertViolation(root, expectedViolation);
  });
}

for (const field of ["state", "outcome", "status"] as const) {
  test(`rejects a liveness reconciliation ${field} enum`, () => {
    const root = fixtureRoot();
    replace(
      root,
      "packages/db/schema/issue_liveness_reconciliations.ts",
      '    admittedAt: timestamp("admitted_at").notNull(),',
      `    ${field}: text("${field}"),\n    admittedAt: timestamp("admitted_at").notNull(),`,
    );
    assert.ok(
      issueLivenessBoundaryViolations(root).some((entry) =>
        entry.includes(`extra ${field}`),
      ),
    );
  });
}

test("rejects a duplicate issue-liveness frontier/outcome table", () => {
  const root = fixtureRoot();
  write(
    root,
    "packages/db/schema/issue_liveness_outcomes.ts",
    'export const duplicate = pgTable("issue_liveness_outcomes", {});\n',
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("duplicate issue-frontier/outcome table"),
    ),
  );
});

test("rejects weakening the exact nine-action predicate", () => {
  const root = fixtureRoot();
  replace(
    root,
    "packages/shared/src/issue-runtime.ts",
    ', "board_lifecycle_command", "board_reopen"',
    ', "board_lifecycle_command"',
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("exactly nine values"),
    ),
  );
});

test("rejects restoring automatic agent-liveness Board Attention", () => {
  const root = fixtureRoot();
  replace(
    root,
    "apps/server/src/services/issue-execution-postgres.ts",
    "const finalizer =",
    "notifyAttention();\nconst finalizer =",
  );
  write(
    root,
    "apps/server/src/services/attention.ts",
    'add({ sourceKind: "agent_liveness" });\n',
  );
  const violations = issueLivenessBoundaryViolations(root);
  assert.ok(violations.some((entry) => entry.includes("must not dispatch")));
  assert.ok(violations.some((entry) => entry.includes("must not project")));
});

test("rejects weakening finalization-frontier uniqueness", () => {
  const root = fixtureRoot();
  replace(
    root,
    "packages/db/schema/issue_liveness_reconciliations.ts",
    "table.frontierFinalizationId),",
    "table.sourceRunId),",
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("frontier uniqueness"),
    ),
  );
});

test("rejects weakening creator-edge admission-version binding", () => {
  const root = fixtureRoot();
  replace(
    root,
    "packages/db/schema/issue_liveness_reconciliations.ts",
    "issueCreatorEdgeReceivability.admissionVersion],",
    "issueCreatorEdgeReceivability.id],",
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("admissionVersion"),
    ),
  );
});

test("rejects removal of the progressively complete follow-up chain check", () => {
  const root = fixtureRoot();
  replace(
    root,
    "packages/db/schema/issue_liveness_reconciliations.ts",
    '"issue_liveness_reconciliations_followup_chain_check"',
    '"removed_followup_chain_check"',
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("followup_chain_check"),
    ),
  );
});

test("rejects a second finalization stale-check outbox writer", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/parallel-finalizer.ts",
    "transaction.insert(issueExecutionFinalizationStaleCheckOutbox).values({});\n",
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("noncanonical insert"),
    ),
  );
});

for (const path of [
  "apps/server/src/services/issue-liveness-timer.ts",
  "apps/server/src/routes/issue-liveness-read.ts",
  "apps/server/src/services/startup-issue-liveness.ts",
] as const) {
  test(`rejects stale-check caller ${path}`, () => {
    const root = fixtureRoot();
    write(root, path, "await liveness.consumeFinalizationOutbox(input);\n");
    assert.ok(
      issueLivenessBoundaryViolations(root).some((entry) =>
        entry.includes("stale-check caller") ||
        entry.includes("alternate direct liveness outbox consumer"),
      ),
    );
  });
}

for (const path of [
  "apps/server/src/services/issue-execution-postgres.ts",
  "apps/server/src/services/unrelated-finalization-caller.ts",
] as const) {
  test(`rejects a per-run stale-check consumer in ${path}`, () => {
    const root = fixtureRoot();
    write(
      root,
      path,
      "await finalizer.consumeFinalizationOutboxForRun(input);\n",
    );
    assertViolation(root, "per-run stale-check consumption");
  });
}

test("rejects an ordinary-comment per-run stale-check caller", () => {
  const root = fixtureRoot();
  append(
    root,
    "apps/server/src/services/ordinary-issue-runtime.ts",
    "await finalizer.consumeFinalizationOutboxForRun(comment);\n",
  );
  assertViolation(root, "per-run stale-check consumption");
});

test("rejects an alternate follow-up recipient", () => {
  const root = fixtureRoot();
  replace(
    root,
    "apps/server/src/services/issue-liveness-reconciliation.ts",
    "    targetAgentId: run.targetAgentId,",
    "    targetAgentId: issue.ownerAgentId,",
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("alternate liveness recipient"),
    ),
  );
});

test("rejects generated mention routing", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/issue-liveness-reconciliation.ts",
    `${canonicalLivenessService()}\nmention_agent({ agentId: run.targetAgentId });\n`,
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("generated mention"),
    ),
  );
});

test("rejects a system-escalation link on the liveness frontier", () => {
  const root = fixtureRoot();
  replace(
    root,
    "packages/db/schema/issue_liveness_reconciliations.ts",
    '    admittedAt: timestamp("admitted_at").notNull(),',
    '    systemEscalationIdentityId: uuid("system_escalation_identity_id"),\n    admittedAt: timestamp("admitted_at").notNull(),',
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("systemEscalationIdentityId"),
    ),
  );
});

test("rejects a system-escalation reader coupled to the liveness frontier", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/system-escalation.ts",
    [
      "const rows = await database",
      "  .select()",
      "  .from(issueLivenessReconciliations);",
      "ensureSystemEscalation(rows);",
      "",
    ].join("\n"),
  );
  assertViolation(root, "direct access to the issue-liveness reconciliation frontier");
});

for (const [field, column] of [
  ["dismissedAt", "dismissed_at"],
  ["snoozedUntil", "snoozed_until"],
  ["retryState", "retry_state"],
] as const) {
  test(`rejects reconciliation-owned ${field}`, () => {
    const root = fixtureRoot();
    replace(
      root,
      "packages/db/schema/issue_liveness_reconciliations.ts",
      '    admittedAt: timestamp("admitted_at").notNull(),',
      `    ${field}: timestamp("${column}"),\n    admittedAt: timestamp("admitted_at").notNull(),`,
    );
    assert.ok(
      issueLivenessBoundaryViolations(root).some((entry) =>
        entry.includes(field),
      ),
    );
  });
}

test("rejects removal of a canonical reference-only settlement producer", () => {
  const root = fixtureRoot();
  replace(
    root,
    "apps/server/src/services/canonical-issue-aggregate.ts",
    "recordIssueLivenessActionInTransaction",
    "removedIssueLivenessSettlement",
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("canonical-issue-aggregate.ts"),
    ),
  );
});

test("retains rather than rejects the canonical five-field run-liveness fact", () => {
  const root = fixtureRoot();
  const violations = issueLivenessBoundaryViolations(root);
  assert.equal(
    violations.some((entry) => entry.includes("run-liveness fact")),
    false,
  );
});

test("rejects Attention/frontier ownership on the run-liveness fact", () => {
  const root = fixtureRoot();
  replace(
    root,
    "packages/db/schema/issue_execution_runs.ts",
    '    nextAction: text("next_action"),',
    '    nextAction: text("next_action"),\n    frontierFinalizationId: uuid("frontier_finalization_id"),',
  );
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("frontierFinalizationId"),
    ),
  );
});

test("rejects removal of the canonical run-liveness fact owner", () => {
  const root = fixtureRoot();
  write(root, "packages/db/schema/issue_execution_runs.ts", "");
  assert.ok(
    issueLivenessBoundaryViolations(root).some((entry) =>
      entry.includes("run-liveness fact"),
    ),
  );
});
