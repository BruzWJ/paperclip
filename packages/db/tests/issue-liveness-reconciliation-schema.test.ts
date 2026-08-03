import {
  AGENT_LIVENESS_ACTION_KINDS,
  AGENT_LIVENESS_ATTENTION_REASONS,
  ISSUE_EXECUTION_REF_MESSAGE_KINDS,
  ISSUE_EXECUTION_REF_SOURCE_KINDS,
  type AttentionSourceKind,
} from "@paperclipai/shared";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { issueCreatorEdgeReceivability } from "../schema/issue_creator_delivery.js";
import { issueExecutionRefs } from "../schema/issue_execution_runtime.js";
import {
  issueExecutionFinalizationStaleCheckOutbox,
  issueLivenessReconciliations,
} from "../schema/issue_liveness_reconciliations.js";

const dialect = new PgDialect();

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkSql(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): string {
  const constraint = getTableConfig(table).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint).toBeDefined();
  return dialect.sqlToQuery(constraint!.value).sql;
}

describe("P15-P17 issue liveness reconciliation schema", () => {
  it("uses the sole closed shared source, action, attention, and reason catalogs", () => {
    const attentionSource: AttentionSourceKind = "agent_liveness";

    expect(attentionSource).toBe("agent_liveness");
    expect(ISSUE_EXECUTION_REF_SOURCE_KINDS).toContain(
      "agent_liveness_followup",
    );
    expect(ISSUE_EXECUTION_REF_MESSAGE_KINDS).toEqual([
      "user",
      "synthetic",
    ]);
    expect(AGENT_LIVENESS_ACTION_KINDS).toEqual([
      "authenticated_human_comment",
      "issue_create_child",
      "mention_agent",
      "issue_assign",
      "issue_update",
      "creator_withdrawal",
      "board_lifecycle_command",
      "board_reopen",
    ]);
    expect(AGENT_LIVENESS_ATTENTION_REASONS).toEqual([
      "agent_no_action",
      "agent_followup_failed",
      "agent_unavailable",
    ]);
    expect(
      checkSql(issueExecutionRefs, "issue_execution_refs_source_kind_check"),
    ).toContain("'agent_liveness_followup'");
    const messageKindCheck = checkSql(
      issueExecutionRefs,
      "issue_execution_refs_message_kind_check",
    );
    expect(messageKindCheck).toContain("'user'");
    expect(messageKindCheck).toContain("'synthetic'");
    expect(messageKindCheck).not.toContain("'system'");
  });

  it("owns a reference-only finalization outbox with one nullable processing marker", () => {
    const config = getTableConfig(
      issueExecutionFinalizationStaleCheckOutbox,
    );

    expect(config.name).toBe(
      "issue_execution_finalization_stale_check_outbox",
    );
    expect(columnNames(issueExecutionFinalizationStaleCheckOutbox)).toEqual([
      "company_id",
      "issue_id",
      "ownership_epoch",
      "run_id",
      "finalization_id",
      "created_at",
      "processed_at",
    ]);
    expect(columnNames(issueExecutionFinalizationStaleCheckOutbox)).not.toEqual(
      expect.arrayContaining([
        "state",
        "status",
        "outcome",
        "retry_count",
        "deadline_at",
        "payload",
      ]),
    );
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "issue_execution_finalization_stale_check_outbox_run_fk",
        "issue_execution_finalization_stale_check_outbox_finalization_fk",
      ]),
    );
    expect(
      checkSql(
        issueExecutionFinalizationStaleCheckOutbox,
        "issue_execution_finalization_stale_check_outbox_time_check",
      ),
    ).toContain('"processed_at" >=');
  });

  it("binds one exact immutable creator-edge admission and one unique frontier", () => {
    const edgeConfig = getTableConfig(issueCreatorEdgeReceivability);
    const reconciliationConfig = getTableConfig(issueLivenessReconciliations);

    expect(columnNames(issueCreatorEdgeReceivability)).toContain(
      "admission_version",
    );
    expect(
      checkSql(
        issueCreatorEdgeReceivability,
        "issue_creator_edge_receivability_admission_version_check",
      ),
    ).toContain('"admission_version" > 0');
    expect(
      edgeConfig.uniqueConstraints.map((constraint) => constraint.getName()),
    ).toContain(
      "issue_creator_edge_receivability_admission_identity_uq",
    );

    const frontier = reconciliationConfig.uniqueConstraints.find(
      (constraint) =>
        constraint.getName() === "issue_liveness_reconciliations_frontier_uq",
    );
    expect(frontier?.columns.map((column) => column.name)).toEqual([
      "company_id",
      "issue_id",
      "ownership_epoch",
      "frontier_finalization_id",
    ]);
    expect(
      reconciliationConfig.foreignKeys.map((key) => key.getName()),
    ).toEqual(
      expect.arrayContaining([
        "issue_liveness_reconciliations_creator_edge_fk",
        "issue_liveness_reconciliations_source_run_fk",
        "issue_liveness_reconciliations_frontier_finalization_fk",
        "issue_liveness_reconciliations_source_comment_fk",
        "issue_liveness_reconciliations_followup_reply_fk",
        "issue_liveness_reconciliations_followup_ref_fk",
        "issue_liveness_reconciliations_followup_run_fk",
        "issue_liveness_reconciliations_followup_finalization_fk",
      ]),
    );
    const creatorEdgeFk = reconciliationConfig.foreignKeys.find(
      (key) =>
        key.getName() === "issue_liveness_reconciliations_creator_edge_fk",
    );
    expect(
      creatorEdgeFk?.reference().columns.map((column) => column.name),
    ).toEqual([
      "company_id",
      "issue_id",
      "ownership_epoch",
      "creator_edge_id",
      "creator_edge_admission_version",
    ]);
    const sourceRunFk = reconciliationConfig.foreignKeys.find(
      (key) =>
        key.getName() === "issue_liveness_reconciliations_source_run_fk",
    );
    expect(
      sourceRunFk?.reference().columns.map((column) => column.name),
    ).toEqual([
      "company_id",
      "issue_id",
      "ownership_epoch",
      "source_run_id",
      "stale_target_agent_id",
      "source_mode",
    ]);
    const followupRefFk = reconciliationConfig.foreignKeys.find(
      (key) =>
        key.getName() === "issue_liveness_reconciliations_followup_ref_fk",
    );
    expect(
      followupRefFk?.reference().columns.map((column) => column.name),
    ).toEqual([
      "company_id",
      "issue_id",
      "ownership_epoch",
      "followup_ref_id",
      "stale_target_agent_id",
      "source_mode",
    ]);
    const followupReplyFk = reconciliationConfig.foreignKeys.find(
      (key) =>
        key.getName() === "issue_liveness_reconciliations_followup_reply_fk",
    );
    expect(
      followupReplyFk?.reference().columns.map((column) => column.name),
    ).toEqual([
      "company_id",
      "issue_id",
      "followup_system_reply_comment_id",
      "source_comment_id",
    ]);
  });

  it("keeps only closed progressive-chain, settlement, attention, and exit facts", () => {
    const columns = columnNames(issueLivenessReconciliations);

    expect(columns).toEqual(
      expect.arrayContaining([
        "frontier_finalization_id",
        "creator_edge_id",
        "creator_edge_admission_version",
        "stale_target_agent_id",
        "source_run_id",
        "source_mode",
        "source_comment_id",
        "followup_system_reply_comment_id",
        "followup_ref_id",
        "followup_run_id",
        "followup_finalization_id",
        "accepted_action_kind",
        "accepted_action_source_id",
        "accepted_action_committed_at",
        "superseded_before_attention_at",
        "board_attention_emitted_at",
        "board_attention_reason",
        "exit_action_kind",
        "exit_action_source_id",
        "exit_action_committed_at",
      ]),
    );
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "state",
        "status",
        "outcome",
        "prompt",
        "message",
        "response",
        "retry_count",
        "deadline_at",
        "escalation_id",
        "creator_delivery_id",
      ]),
    );

    const chain = checkSql(
      issueLivenessReconciliations,
      "issue_liveness_reconciliations_followup_chain_check",
    );
    expect(chain).toContain('"followup_ref_id" is null');
    expect(chain).toContain('"followup_system_reply_comment_id" is not null');
    expect(chain).toContain('"followup_finalization_id" is null');
    expect(chain).toContain('"followup_run_id" is not null');

    const settlement = checkSql(
      issueLivenessReconciliations,
      "issue_liveness_reconciliations_initial_settlement_check",
    );
    expect(settlement).toContain('"accepted_action_kind" is not null');
    expect(settlement).toContain(
      '"superseded_before_attention_at" is not null',
    );
    expect(settlement).toContain('"board_attention_emitted_at" is not null');

    const acceptedKinds = checkSql(
      issueLivenessReconciliations,
      "issue_liveness_reconciliations_accepted_action_kind_check",
    );
    const exitKinds = checkSql(
      issueLivenessReconciliations,
      "issue_liveness_reconciliations_exit_action_kind_check",
    );
    for (const kind of AGENT_LIVENESS_ACTION_KINDS) {
      expect(acceptedKinds).toContain(`'${kind}'`);
      expect(exitKinds).toContain(`'${kind}'`);
    }
    const accepted = checkSql(
      issueLivenessReconciliations,
      "issue_liveness_reconciliations_accepted_action_tuple_check",
    );
    expect(accepted).toContain('"accepted_action_committed_at" >');
    expect(accepted).toContain('"admitted_at"');
    expect(accepted).not.toContain(
      '"accepted_action_committed_at" >=',
    );
    const attention = checkSql(
      issueLivenessReconciliations,
      "issue_liveness_reconciliations_attention_tuple_check",
    );
    for (const reason of AGENT_LIVENESS_ATTENTION_REASONS) {
      expect(attention).toContain(`'${reason}'`);
    }

    const exit = checkSql(
      issueLivenessReconciliations,
      "issue_liveness_reconciliations_exit_action_tuple_check",
    );
    expect(exit).toContain('"exit_action_committed_at" >');
    expect(exit).toContain('"board_attention_emitted_at"');
  });
});
