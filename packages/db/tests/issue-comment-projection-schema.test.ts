import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { issueCommentProjectionSources } from "../schema/issue_comment_projection_sources.js";
import { issueComments } from "../schema/issue_comments.js";

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

describe("canonical issue comment projection schema", () => {
  it("owns immutable parent and root tuples plus first-class plugin authors", () => {
    expect(columns(issueComments)).toEqual(
      expect.arrayContaining([
        "author_plugin_installation_id",
        "author_plugin_key",
        "reply_to_comment_id",
        "reply_to_projected_event_seq",
        "thread_root_comment_id",
        "thread_root_projected_event_seq",
      ]),
    );
    expect(columns(issueComments)).not.toContain("deleted_at");
    const config = getTableConfig(issueComments);
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "issue_comments_author_plugin_installation_fk",
        "issue_comments_run_scope_fk",
        "issue_comments_reply_parent_fk",
        "issue_comments_thread_root_fk",
      ]),
    );
    expect(config.uniqueConstraints.map((value) => value.name)).toContain(
      "issue_comments_projected_identity_uq",
    );
    expect(
      checkSql(issueComments, "issue_comments_reply_shape_check"),
    ).toContain('"issue_comments"."thread_root_projected_event_seq" is not null');
    expect(
      checkSql(issueComments, "issue_comments_reply_order_check"),
    ).toContain(
      '"issue_comments"."reply_to_projected_event_seq" < "issue_comments"."projected_event_seq"',
    );
    const sourceKinds = checkSql(
      issueComments,
      "issue_comments_canonical_source_kind_check",
    );
    expect(sourceKinds).toContain("'run_progress'");
    expect(sourceKinds).not.toContain(["normalized", "final"].join("_"));
  });

  it("keeps one run-progress origin with terminal and positive steering dependencies", () => {
    expect(columns(issueCommentProjectionSources)).toEqual(
      expect.arrayContaining([
        "reply_to_comment_id",
        "reply_to_projected_event_seq",
        "thread_root_comment_id",
        "thread_root_projected_event_seq",
        "steering_target_run_id",
        "ref_id",
        "ref_ordinal",
        "segment_ordinal",
        "terminal_session_message_id",
      ]),
    );
    const config = getTableConfig(issueCommentProjectionSources);
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "issue_comment_projection_sources_comment_fk",
        "issue_comment_projection_sources_run_fk",
        "issue_comment_projection_sources_reply_parent_fk",
        "issue_comment_projection_sources_thread_root_fk",
        "issue_comment_projection_sources_steering_segment_fk",
        "issue_comment_projection_sources_terminal_message_fk",
      ]),
    );
    const steeringTarget = config.foreignKeys.find(
      (key) =>
        key.getName() ===
        "issue_comment_projection_sources_steering_segment_fk",
    );
    expect(
      steeringTarget?.reference().columns.map((column) => column.name),
    ).toEqual([
      "company_id",
      "issue_id",
      "session_id",
      "steering_target_run_id",
      "ref_ordinal",
      "ref_id",
      "segment_ordinal",
    ]);
    const runProgress = config.indexes.find(
      (index) => index.config.name ===
        "issue_comment_projection_sources_run_progress_uq",
    );
    expect(runProgress?.config.unique).toBe(true);
    expect(
      dialect.sqlToQuery(runProgress!.config.where!).sql,
    ).toContain("source_kind\" = 'run_progress'");
    expect(
      checkSql(
        issueCommentProjectionSources,
        "issue_comment_projection_sources_steering_segment_shape_check",
      ),
    ).toContain(
      '"issue_comment_projection_sources"."steering_target_run_id" is not null',
    );
    expect(
      checkSql(
        issueCommentProjectionSources,
        "issue_comment_projection_sources_steering_segment_shape_check",
      ),
    ).toContain('"issue_comment_projection_sources"."segment_ordinal" > 0');
    expect(
      checkSql(
        issueCommentProjectionSources,
        "issue_comment_projection_sources_terminal_dependency_check",
      ),
    ).toContain("= 'run_progress'");
  });
});
