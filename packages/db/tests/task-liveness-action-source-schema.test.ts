import { TASK_BOARD_LIFECYCLE_COMMAND_SUBTYPES } from "@paperclipai/shared";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { taskBoardUserComments } from "../schema/task_board_user_comments.js";
import { taskExecutionRefs } from "../schema/task_execution_runtime.js";
import {
  taskBoardLifecycleCommands,
} from "../schema/task_lifecycle_commands.js";
import { tasks } from "../schema/tasks.js";

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
    expect(columnNames(tasks)).toContain("parent_ownership_epoch");
    const parentShape = checkSql(tasks, "tasks_parent_epoch_check");
    expect(parentShape).toContain('"parent_id" is null');
    expect(parentShape).toContain('"parent_ownership_epoch" is null');
    expect(parentShape).toContain('"parent_ownership_epoch" > 0');
    expect(foreignKeyColumns(tasks, "tasks_parent_fk")).toEqual({
      local: ["company_id", "parent_id"],
      foreign: ["company_id", "id"],
    });
    expect(
      getTableConfig(tasks).foreignKeys.some((key) =>
        key.reference().columns.some(
          (column) => column.name === "parent_ownership_epoch",
        ),
      ),
    ).toBe(false);
  });

  it("gives every named-board comment one exact task epoch", () => {
    expect(columnNames(taskBoardUserComments)).toEqual([
      "id",
      "company_id",
      "task_id",
      "ownership_epoch",
      "actor_user_id",
      "idempotency_key",
      "identity_digest",
      "mention_target_agent_id",
      "comment_id",
      "execution_ref_id",
      "created_at",
    ]);
    expect(columnNames(taskBoardUserComments)).not.toContain(
      "mention_ownership_epoch",
    );
    expect(
      checkSql(taskBoardUserComments, "task_board_user_comments_epoch_check"),
    ).toContain('"ownership_epoch" > 0');
    expect(
      foreignKeyColumns(
        taskBoardUserComments,
        "task_board_user_comments_creator_edge_fk",
      ),
    ).toEqual({
      local: ["company_id", "task_id", "ownership_epoch"],
      foreign: ["company_id", "task_id", "ownership_epoch"],
    });
    expect(
      foreignKeyColumns(
        taskBoardUserComments,
        "task_board_user_comments_ref_fk",
      ),
    ).toEqual({
      local: [
        "company_id",
        "task_id",
        "ownership_epoch",
        "execution_ref_id",
      ],
      foreign: ["company_id", "task_id", "ownership_epoch", "id"],
    });
  });

  it("records a previous epoch only for exact reassignment refs", () => {
    expect(columnNames(taskExecutionRefs)).toContain(
      "previous_ownership_epoch",
    );
    const shape = checkSql(
      taskExecutionRefs,
      "task_execution_refs_previous_epoch_check",
    );
    expect(shape).toContain("'task_reassignment'");
    expect(shape).toContain('"previous_ownership_epoch" > 0');
    expect(shape).toContain(
      '"previous_ownership_epoch" = "task_execution_refs"."ownership_epoch" - 1',
    );
    expect(shape).toContain('"previous_ownership_epoch" is null');
  });

  it("owns only the seven named-board lifecycle mutation subtypes", () => {
    expect(TASK_BOARD_LIFECYCLE_COMMAND_SUBTYPES).toEqual([
      "execution_policy_configure",
      "execution_policy_decision",
      "tree_control_pause",
      "tree_control_resume",
      "tree_control_cancel",
      "tree_control_restore",
      "tree_control_release",
    ]);
    expect(columnNames(taskBoardLifecycleCommands)).toEqual([
      "id",
      "company_id",
      "task_id",
      "ownership_epoch",
      "actor_user_id",
      "subtype",
      "source_command_id",
      "idempotency_key",
      "committed_at",
    ]);
    const subtype = checkSql(
      taskBoardLifecycleCommands,
      "task_board_lifecycle_commands_subtype_check",
    );
    for (const value of TASK_BOARD_LIFECYCLE_COMMAND_SUBTYPES) {
      expect(subtype).toContain(`'${value}'`);
    }
    expect(
      foreignKeyColumns(
        taskBoardLifecycleCommands,
        "task_board_lifecycle_commands_creator_edge_fk",
      ),
    ).toEqual({
      local: ["company_id", "task_id", "ownership_epoch"],
      foreign: ["company_id", "task_id", "ownership_epoch"],
    });
    const config = getTableConfig(taskBoardLifecycleCommands);
    expect(config.uniqueConstraints.map((value) => value.getName())).toEqual(
      expect.arrayContaining([
        "task_board_lifecycle_commands_source_task_uq",
        "task_board_lifecycle_commands_idempotency_task_uq",
      ]),
    );
    expect(
      config.uniqueConstraints
        .find(
          (value) =>
            value.getName() ===
            "task_board_lifecycle_commands_source_task_uq",
        )
        ?.columns.map((column) => column.name),
    ).toEqual(["company_id", "task_id", "source_command_id"]);
    expect(columnNames(taskBoardLifecycleCommands)).not.toEqual(
      expect.arrayContaining([
        "actor_agent_id",
        "state",
        "status",
        "payload",
        "updated_at",
      ]),
    );
  });

});
