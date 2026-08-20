import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { taskCommentProjectionSources } from "../schema/task_comment_projection_sources.js";
import { taskComments } from "../schema/task_comments.js";

const dialect = new PgDialect();

function columns(table: Parameters<typeof getTableConfig>[0]): string[] {
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

describe("canonical task comment projection schema", () => {
  it("owns immutable parent and root tuples plus first-class plugin authors", () => {
    expect(columns(taskComments)).toEqual(
      expect.arrayContaining([
        "author_plugin_installation_id",
        "author_plugin_key",
        "reply_to_comment_id",
        "reply_to_projected_event_seq",
        "thread_root_comment_id",
        "thread_root_projected_event_seq",
      ]),
    );
    expect(columns(taskComments)).not.toContain("deleted_at");
    const config = getTableConfig(taskComments);
    const foreignKeyNames = config.foreignKeys.map((key) => key.getName());
    expect(foreignKeyNames).toEqual(expect.arrayContaining([
      "task_comments_run_scope_fk",
      "task_comments_reply_parent_fk",
      "task_comments_thread_root_fk",
    ]));
    expect(foreignKeyNames).not.toContain(
      "task_comments_author_plugin_installation_fk",
    );
    expect(config.uniqueConstraints.map((value) => value.name)).toContain(
      "task_comments_projected_identity_uq",
    );
    expect(
      checkSql(taskComments, "task_comments_reply_shape_check"),
    ).toContain('"task_comments"."thread_root_projected_event_seq" is not null');
    expect(
      checkSql(taskComments, "task_comments_reply_order_check"),
    ).toContain(
      '"task_comments"."reply_to_projected_event_seq" < "task_comments"."projected_event_seq"',
    );
    const sourceKinds = checkSql(
      taskComments,
      "task_comments_canonical_source_kind_check",
    );
    expect(sourceKinds).toContain("'run_progress'");
    expect(sourceKinds).not.toContain(["normalized", "final"].join("_"));
  });

  it("keeps one run-progress origin with its terminal dependency", () => {
    expect(columns(taskCommentProjectionSources)).toEqual(
      expect.arrayContaining([
        "reply_to_comment_id",
        "reply_to_projected_event_seq",
        "thread_root_comment_id",
        "thread_root_projected_event_seq",
        "terminal_session_message_id",
      ]),
    );
    const config = getTableConfig(taskCommentProjectionSources);
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "task_comment_projection_sources_comment_fk",
        "task_comment_projection_sources_run_fk",
        "task_comment_projection_sources_reply_parent_fk",
        "task_comment_projection_sources_thread_root_fk",
        "task_comment_projection_sources_terminal_message_fk",
      ]),
    );
    const runProgress = config.indexes.find(
      (index) => index.config.name ===
        "task_comment_projection_sources_run_progress_uq",
    );
    expect(runProgress?.config.unique).toBe(true);
    expect(
      dialect.sqlToQuery(runProgress!.config.where!).sql,
    ).toContain("source_kind\" = 'run_progress'");
    expect(
      checkSql(
        taskCommentProjectionSources,
        "task_comment_projection_sources_terminal_dependency_check",
      ),
    ).toContain("= 'run_progress'");
  });
});
