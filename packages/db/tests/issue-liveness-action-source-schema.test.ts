import {
  ISSUE_BOARD_LIFECYCLE_COMMAND_SUBTYPES,
  ISSUE_CREATOR_WITHDRAWAL_ACTOR_KINDS,
} from "@paperclipai/shared";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  issueBoardReopenCommands,
  issueBoardUserComments,
} from "../schema/issue_board_reopen_commands.js";
import { issueExecutionPromptSegments } from "../schema/issue_execution_runs.js";
import { issueExecutionRefs } from "../schema/issue_execution_runtime.js";
import {
  issueBoardLifecycleCommands,
  issueCreatorWithdrawalCommands,
} from "../schema/issue_lifecycle_commands.js";
import { issues } from "../schema/issues.js";

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

function foreignKeyColumns(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): { local: string[]; foreign: string[] } {
  const key = getTableConfig(table).foreignKeys.find(
    (candidate) => candidate.getName() === name,
  );
  expect(key).toBeDefined();
  const reference = key!.reference();
  return {
    local: reference.columns.map((column) => column.name),
    foreign: reference.foreignColumns.map((column) => column.name),
  };
}

describe("P15-P17 canonical action-source provenance", () => {
  it("captures the immutable parent epoch for every direct child", () => {
    expect(columnNames(issues)).toContain("parent_ownership_epoch");
    const parentShape = checkSql(issues, "issues_parent_epoch_check");
    expect(parentShape).toContain('"parent_id" is null');
    expect(parentShape).toContain('"parent_ownership_epoch" is null');
    expect(parentShape).toContain('"parent_ownership_epoch" > 0');
    expect(foreignKeyColumns(issues, "issues_parent_fk")).toEqual({
      local: ["company_id", "parent_id"],
      foreign: ["company_id", "id"],
    });
    expect(
      getTableConfig(issues).foreignKeys.some((key) =>
        key.reference().columns.some(
          (column) => column.name === "parent_ownership_epoch",
        ),
      ),
    ).toBe(false);
  });

  it("gives every named-board comment one exact issue epoch", () => {
    expect(columnNames(issueBoardUserComments)).toEqual([
      "id",
      "company_id",
      "issue_id",
      "ownership_epoch",
      "actor_user_id",
      "idempotency_key",
      "identity_digest",
      "mention_target_agent_id",
      "comment_id",
      "execution_ref_id",
      "created_at",
    ]);
    expect(columnNames(issueBoardUserComments)).not.toContain(
      "mention_ownership_epoch",
    );
    expect(
      checkSql(issueBoardUserComments, "issue_board_user_comments_epoch_check"),
    ).toContain('"ownership_epoch" > 0');
    expect(
      foreignKeyColumns(
        issueBoardUserComments,
        "issue_board_user_comments_creator_edge_fk",
      ),
    ).toEqual({
      local: ["company_id", "issue_id", "ownership_epoch"],
      foreign: ["company_id", "issue_id", "ownership_epoch"],
    });
    expect(
      foreignKeyColumns(
        issueBoardUserComments,
        "issue_board_user_comments_ref_fk",
      ),
    ).toEqual({
      local: [
        "company_id",
        "issue_id",
        "ownership_epoch",
        "execution_ref_id",
      ],
      foreign: ["company_id", "issue_id", "ownership_epoch", "id"],
    });
  });

  it("records a previous epoch only for exact reassignment refs", () => {
    expect(columnNames(issueExecutionRefs)).toContain(
      "previous_ownership_epoch",
    );
    const shape = checkSql(
      issueExecutionRefs,
      "issue_execution_refs_previous_epoch_check",
    );
    expect(shape).toContain("'issue_reassignment'");
    expect(shape).toContain('"previous_ownership_epoch" > 0');
    expect(shape).toContain(
      '"previous_ownership_epoch" = "issue_execution_refs"."ownership_epoch" - 1',
    );
    expect(shape).toContain('"previous_ownership_epoch" is null');
  });

  it("retains the write-once native-resume acceptance time", () => {
    const resumedAt = getTableConfig(issueExecutionPromptSegments).columns.find(
      (column) => column.name === "resumed_at",
    );
    expect(resumedAt?.notNull).toBe(false);
    expect(resumedAt?.hasDefault).toBe(false);
    const shape = checkSql(
      issueExecutionPromptSegments,
      "issue_execution_prompt_segments_resumed_at_check",
    );
    expect(shape).toContain('"resumed_at" is null');
    expect(shape).toContain('"resumed_at" >');
    expect(shape).toContain("'resumed'");
    expect(shape).toContain('"protocol_settlement_state" is not null');
  });

  it("owns one checked user-or-plugin withdrawal command per outgoing epoch", () => {
    expect(ISSUE_CREATOR_WITHDRAWAL_ACTOR_KINDS).toEqual([
      "user",
      "plugin",
    ]);
    expect(columnNames(issueCreatorWithdrawalCommands)).toEqual([
      "id",
      "company_id",
      "issue_id",
      "outgoing_ownership_epoch",
      "resulting_ownership_epoch",
      "resulting_creator_edge_id",
      "actor_kind",
      "actor_user_id",
      "actor_plugin_installation_id",
      "actor_plugin_key",
      "plugin_withdrawal_operation_id",
      "issue_update_id",
      "accepted_at",
    ]);
    const epoch = checkSql(
      issueCreatorWithdrawalCommands,
      "issue_creator_withdrawal_commands_epoch_check",
    );
    expect(epoch).toContain('"outgoing_ownership_epoch" > 0');
    expect(epoch).toContain('"outgoing_ownership_epoch" + 1');
    const actor = checkSql(
      issueCreatorWithdrawalCommands,
      "issue_creator_withdrawal_commands_actor_check",
    );
    expect(actor).toContain("'user'");
    expect(actor).toContain("'plugin'");
    expect(actor).toContain('"resulting_creator_edge_id" is not null');
    expect(actor).toContain('"resulting_creator_edge_id" is null');
    expect(actor).toContain('"plugin_withdrawal_operation_id" is not null');
    expect(actor).toContain('"issue_update_id" is not null');
    expect(
      getTableConfig(issueCreatorWithdrawalCommands).foreignKeys.map((key) =>
        key.getName()
      ),
    ).toEqual(
      expect.arrayContaining([
        "issue_creator_withdrawal_commands_resulting_edge_fk",
        "issue_creator_withdrawal_commands_outgoing_edge_fk",
        "issue_creator_withdrawal_commands_update_fk",
        "issue_creator_withdrawal_commands_plugin_operation_fk",
      ]),
    );
    expect(
      foreignKeyColumns(
        issueCreatorWithdrawalCommands,
        "issue_creator_withdrawal_commands_resulting_edge_fk",
      ),
    ).toEqual({
      local: [
        "company_id",
        "issue_id",
        "resulting_ownership_epoch",
        "resulting_creator_edge_id",
      ],
      foreign: ["company_id", "issue_id", "ownership_epoch", "id"],
    });
    expect(
      getTableConfig(issueCreatorWithdrawalCommands).uniqueConstraints.map(
        (value) => value.getName(),
      ),
    ).toContain("issue_creator_withdrawal_commands_epoch_uq");
  });

  it("owns only the seven named-board lifecycle mutation subtypes", () => {
    expect(ISSUE_BOARD_LIFECYCLE_COMMAND_SUBTYPES).toEqual([
      "execution_policy_configure",
      "execution_policy_decision",
      "tree_control_pause",
      "tree_control_resume",
      "tree_control_cancel",
      "tree_control_restore",
      "tree_control_release",
    ]);
    expect(columnNames(issueBoardLifecycleCommands)).toEqual([
      "id",
      "company_id",
      "issue_id",
      "ownership_epoch",
      "actor_user_id",
      "subtype",
      "source_command_id",
      "idempotency_key",
      "committed_at",
    ]);
    const subtype = checkSql(
      issueBoardLifecycleCommands,
      "issue_board_lifecycle_commands_subtype_check",
    );
    for (const value of ISSUE_BOARD_LIFECYCLE_COMMAND_SUBTYPES) {
      expect(subtype).toContain(`'${value}'`);
    }
    expect(
      foreignKeyColumns(
        issueBoardLifecycleCommands,
        "issue_board_lifecycle_commands_creator_edge_fk",
      ),
    ).toEqual({
      local: ["company_id", "issue_id", "ownership_epoch"],
      foreign: ["company_id", "issue_id", "ownership_epoch"],
    });
    const config = getTableConfig(issueBoardLifecycleCommands);
    expect(config.uniqueConstraints.map((value) => value.getName())).toEqual(
      expect.arrayContaining([
        "issue_board_lifecycle_commands_source_issue_uq",
        "issue_board_lifecycle_commands_idempotency_issue_uq",
      ]),
    );
    expect(
      config.uniqueConstraints
        .find(
          (value) =>
            value.getName() ===
            "issue_board_lifecycle_commands_source_issue_uq",
        )
        ?.columns.map((column) => column.name),
    ).toEqual(["company_id", "issue_id", "source_command_id"]);
    expect(columnNames(issueBoardLifecycleCommands)).not.toEqual(
      expect.arrayContaining([
        "actor_agent_id",
        "state",
        "status",
        "payload",
        "updated_at",
      ]),
    );
  });

  it("keeps board reopen separately typed from the lifecycle-command ledger", () => {
    const config = getTableConfig(issueBoardReopenCommands);
    expect(config.name).toBe(
      "issue_board_reopen_commands",
    );
    expect(ISSUE_BOARD_LIFECYCLE_COMMAND_SUBTYPES).not.toContain(
      "board_reopen" as never,
    );
    expect(columnNames(issueBoardReopenCommands)).toEqual([
      "id",
      "company_id",
      "issue_id",
      "actor_user_id",
      "reason",
      "idempotency_key",
      "identity_digest",
      "prior_status",
      "prior_disposition",
      "ownership_epoch",
      "branch",
      "preserved_owner_kind",
      "continuity_fence_generation",
      "creator_edge_id",
      "execution_ref_id",
      "system_escalation_identity_id",
      "created_at",
    ]);
    const branch = checkSql(
      issueBoardReopenCommands,
      "issue_board_reopen_commands_branch_check",
    );
    expect(branch).toContain("'agent_execution'");
    expect(branch).toContain("'board_only'");
    expect(branch).toContain('"execution_ref_id" is not null');
    expect(branch).toContain('"execution_ref_id" is null');
    expect(branch).toContain(
      '"system_escalation_identity_id" is not null',
    );
    expect(branch).toContain('"system_escalation_identity_id" is null');
    expect(
      checkSql(
        issueBoardReopenCommands,
        "issue_board_reopen_commands_epoch_check",
      ),
    ).toContain('"continuity_fence_generation" > 0');
    expect(
      foreignKeyColumns(
        issueBoardReopenCommands,
        "issue_board_reopen_commands_system_escalation_fk",
      ),
    ).toEqual({
      local: [
        "company_id",
        "issue_id",
        "system_escalation_identity_id",
      ],
      foreign: ["company_id", "escalation_issue_id", "id"],
    });
  });
});
