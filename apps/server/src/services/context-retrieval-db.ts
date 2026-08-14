import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { taskSessionMessages, type Db } from "@paperclipai/db";
import {
  canonicalizeMoneyAmount,
  parseBudgetCurrency,
  type AcpCostUnavailableReason,
} from "@paperclipai/shared";
import type { CanonicalRunTrace, ContextRetrievalRepository } from "./context-retrieval.js";
import {
  resolveTaskExecutionRunIdentityById,
  type TaskExecutionRunService,
} from "./task-execution-run-service.js";
import { decodeStoredTaskSessionMessage } from "./task-session/store.js";
import {
  type CommentProjectionRow,
  executedRows,
  finiteNumber,
  iso,
  mapContextTaskRow,
  TASK_SELECT,
  taskAfterSql,
  taskFilterSql,
  type TaskProjectionRow,
} from "./context-retrieval-db-task-projections.js";
import {
  mapContextCommentAuthor,
  sanitizeCanonicalMessage,
} from "./context-retrieval-db-message-projections.js";

export function createContextRetrievalDbRepository(
  db: Db,
  options: {
    runService: Pick<TaskExecutionRunService, "readJoinedRunDetail">;
  },
): ContextRetrievalRepository {
  return {
    async taskReach({ companyId, activeTaskId, taskId }) {
      const rows = executedRows<{
        sameCompany: boolean;
        active: boolean;
        descendant: boolean;
      }>(
        await db.execute(sql<{
          sameCompany: boolean;
          active: boolean;
          descendant: boolean;
        }>`
          WITH RECURSIVE descendants AS (
            SELECT id
            FROM tasks
            WHERE company_id = ${companyId}
              AND parent_id = ${activeTaskId}
              AND hidden_at IS NULL
            UNION ALL
            SELECT child.id
            FROM tasks child
            JOIN descendants parent ON child.parent_id = parent.id
            WHERE child.company_id = ${companyId}
              AND child.hidden_at IS NULL
          )
          SELECT
            true AS "sameCompany",
            (target.id = ${activeTaskId}) AS "active",
            EXISTS (SELECT 1 FROM descendants WHERE id = target.id) AS "descendant"
          FROM tasks target
          WHERE target.company_id = ${companyId}
            AND target.id = ${taskId}
            AND target.hidden_at IS NULL
          LIMIT 1
        `),
      );
      return rows[0] ?? null;
    },

    async listTopLevelTasks({ companyId, filters, after, limit }) {
      const rows = executedRows<TaskProjectionRow>(
        await db.execute(sql<TaskProjectionRow>`
          SELECT ${TASK_SELECT}
          FROM tasks i
          WHERE i.company_id = ${companyId}
            AND i.parent_id IS NULL
            AND i.hidden_at IS NULL
            AND i.lifecycle_status IS NOT NULL
            ${taskFilterSql(filters)}
            ${taskAfterSql(after)}
          ORDER BY i.updated_at DESC, i.id DESC
          LIMIT ${limit}
        `),
      );
      return rows.map(mapContextTaskRow);
    },

    async listDirectChildren({ companyId, taskId, after, limit }) {
      const rows = executedRows<TaskProjectionRow>(
        await db.execute(sql<TaskProjectionRow>`
          SELECT ${TASK_SELECT}
          FROM tasks i
          WHERE i.company_id = ${companyId}
            AND i.parent_id = ${taskId}
            AND i.hidden_at IS NULL
            AND i.lifecycle_status IS NOT NULL
            ${taskAfterSql(after)}
          ORDER BY i.updated_at DESC, i.id DESC
          LIMIT ${limit}
        `),
      );
      return rows.map(mapContextTaskRow);
    },

    async listTaskComments({ companyId, taskId, after, limit }) {
      const afterSequence = after ? Number(after.sortValue) : null;
      if (after && (!Number.isSafeInteger(afterSequence) || afterSequence! < 0)) {
        throw new Error("Comment keyset cursor sequence is invalid");
      }
      const rows = executedRows<CommentProjectionRow>(
        await db.execute(sql<CommentProjectionRow>`
          SELECT
            c.id,
            c.task_id AS "taskId",
            c.body,
            c.author_type AS "authorType",
            c.author_agent_id AS "authorAgentId",
            c.author_user_id AS "authorUserId",
            c.author_plugin_key AS "authorPluginKey",
            source.run_id AS "runId",
            source.projected_event_seq AS "sequence",
            c.created_at AS "createdAt"
          FROM task_comments c
          JOIN task_comment_projection_sources source
            ON source.comment_id = c.id
           AND source.company_id = c.company_id
           AND source.task_id = c.task_id
          WHERE c.company_id = ${companyId}
            AND c.task_id = ${taskId}
            ${
              after && afterSequence !== null
                ? sql`AND (
                    source.projected_event_seq > ${afterSequence}
                    OR (
                      source.projected_event_seq = ${afterSequence}
                      AND c.id::text > ${after.id}
                    )
                  )`
                : sql``
            }
          ORDER BY source.projected_event_seq ASC, c.id ASC
          LIMIT ${limit}
        `),
      );
      return rows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        body: row.body,
        author: mapContextCommentAuthor(row),
        runId: row.runId,
        sequence: Number(row.sequence),
        createdAt: iso(row.createdAt),
      }));
    },

    async runTask({ companyId, runId }) {
      const identity = await resolveTaskExecutionRunIdentityById(db, runId);
      return identity?.companyId === companyId ? { taskId: identity.taskId } : null;
    },

    async readCanonicalRunTrace({ companyId, runId, after, limit }) {
      const identity = await resolveTaskExecutionRunIdentityById(db, runId);
      if (!identity || identity.companyId !== companyId) return null;
      const afterSeq = after ? Number(after.sortValue) : -1;
      if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) {
        throw new Error("Run trace cursor sequence is invalid");
      }
      const messageLimit = limit ?? 100;
      if (!Number.isSafeInteger(messageLimit) || messageLimit < 1) {
        throw new Error("Run trace page size is invalid");
      }
      const detail = await options.runService.readJoinedRunDetail({
        ...identity,
        limit: Math.max(messageLimit, 100),
      });
      if (!detail) return null;
      const run = detail.run;
      const messages = await db
        .select()
        .from(taskSessionMessages)
        .where(
          and(
            eq(taskSessionMessages.companyId, companyId),
            eq(taskSessionMessages.taskId, run.taskId),
            eq(taskSessionMessages.sessionId, run.sessionId),
            or(
              eq(taskSessionMessages.runId, runId),
              sql`exists (
                select 1
                from task_execution_run_refs member
                join task_execution_refs source_ref
                  on source_ref.company_id = member.company_id
                  and source_ref.task_id = member.task_id
                  and source_ref.session_id = member.session_id
                  and source_ref.id = member.ref_id
                where member.company_id = ${companyId}
                  and member.task_id = ${run.taskId}
                  and member.session_id = ${run.sessionId}
                  and member.run_id = ${runId}
                  and member.prompt_transmission_phase = 'transmitted'
                  and source_ref.source_message_id = ${taskSessionMessages.id}
              )`,
              sql`exists (
                select 1
                from task_execution_prompt_segments segment
                where segment.company_id = ${companyId}
                  and segment.task_id = ${run.taskId}
                  and segment.session_id = ${run.sessionId}
                  and segment.run_id = ${runId}
                  and segment.prompt_transmission_phase = 'transmitted'
                  and segment.source_message_id = ${taskSessionMessages.id}
              )`,
            ),
            after
              ? or(
                  gt(taskSessionMessages.seq, afterSeq),
                  and(eq(taskSessionMessages.seq, afterSeq), gt(taskSessionMessages.id, after.id)),
                )
              : undefined,
          ),
        )
        .orderBy(asc(taskSessionMessages.seq), asc(taskSessionMessages.id))
        .limit(messageLimit);
      const turns = messages.map((row) =>
        sanitizeCanonicalMessage(decodeStoredTaskSessionMessage(row), row.seq),
      );
      const accountingRow = detail.accounting.items.at(-1) ?? null;
      const costRow = accountingRow
        ? (detail.costs.items.find((candidate) => candidate.accountingId === accountingRow.id) ?? null)
        : null;
      const accounting =
        accountingRow && costRow
          ? {
              contextUsedTokens: finiteNumber(accountingRow.contextUsedTokens),
              contextWindowTokens: finiteNumber(accountingRow.contextWindowTokens),
              budgetCurrency: parseBudgetCurrency(costRow.budgetCurrency),
              cost:
                costRow.kind === "known"
                  ? {
                      kind: "known" as const,
                      knownDeltaAmount: canonicalizeMoneyAmount(costRow.knownDeltaAmount ?? "0"),
                    }
                  : {
                      kind: "unavailable" as const,
                      unavailableReason: costRow.unavailableReason as AcpCostUnavailableReason,
                    },
            }
          : null;
      return {
        runId,
        runKind: run.kind,
        taskId: run.taskId,
        status: run.status,
        startedAt: run.startedAt ? iso(run.startedAt) : null,
        finishedAt: run.finishedAt ? iso(run.finishedAt) : null,
        accounting,
        turns,
        outcome:
          run.status === "succeeded"
            ? "succeeded"
            : run.status === "interrupted" ||
                run.status === "failed" ||
                run.status === "cancelled" ||
                run.status === "timed_out"
              ? "failed"
              : null,
        comments: [...detail.outputComments.items],
        nextCursor: null,
      } satisfies CanonicalRunTrace;
    },
  };
}
export * from "./context-retrieval-db-task-projections.js";
export * from "./context-retrieval-db-message-projections.js";
