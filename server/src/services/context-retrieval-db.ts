import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  canonicalizeMoneyAmount,
  decodeIssueDisposition,
  decodeSystemCreatorSourceKind,
  parseBudgetCurrency,
  type AgentVisibleIssueStatus,
  type AcpCostUnavailableReason,
} from "@paperclipai/shared";
import {
  decodeIssueSessionMessage,
  encodeIssueSessionMessage,
  type IssueSessionMessage,
} from "@paperclipai/shared/issue-session";
import type {
  CanonicalRunTracePart,
  CanonicalRunTraceTurn,
  CanonicalRunTrace,
  ContextRetrievalCommentProjection,
  ContextRetrievalIssueProjection,
  ContextRetrievalRepository,
  ProviderSafeIssueCreator,
  ProviderSafeIssueOwner,
  RetrievalCursorPosition,
  RetrievalIssueFilters,
} from "./context-retrieval.js";
import {
  resolveIssueExecutionRunIdentityById,
  type IssueExecutionRunService,
} from "./issue-execution-run-service.js";
import {
  redactEventPayload,
  redactSensitiveText,
} from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";

interface IssueProjectionRow {
  id: string;
  identifier: string | null;
  title: string | null;
  request: string | null;
  status: string | null;
  disposition: unknown;
  priority: string;
  parentId: string | null;
  ownerKind: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  creatorKind: string | null;
  creatorAuthorityId: string | null;
  creatorAgentId: string | null;
  creatorAdapterConfigRevisionId: string | null;
  creatorUserId: string | null;
  creatorPluginInstallationId: string | null;
  creatorPluginKey: string | null;
  creatorCallbackKey: string | null;
  creatorCallbackVersion: string | null;
  creatorRoutineId: string | null;
  creatorRoutineDispatchId: string | null;
  creatorSystemSourceKind: string | null;
  creatorSystemSourceId: string | null;
  directChildCount: number | string;
  updatedAt: Date | string;
}

interface CommentProjectionRow {
  id: string;
  issueId: string;
  body: string;
  authorType: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorPluginKey: string | null;
  runId: string | null;
  sequence: number | string;
  createdAt: Date | string;
}

function exactStatus(value: string | null): AgentVisibleIssueStatus {
  if (
    value !== "open" &&
    value !== "blocked" &&
    value !== "done" &&
    value !== "cancelled"
  ) {
    throw new Error("Canonical issue row has no agent-visible lifecycle status");
  }
  return value;
}

function exactPriority(
  value: string,
): ContextRetrievalIssueProjection["priority"] {
  if (
    value !== "critical" &&
    value !== "high" &&
    value !== "medium" &&
    value !== "low"
  ) {
    throw new Error(`Canonical issue row has invalid priority ${value}`);
  }
  return value;
}

function owner(row: IssueProjectionRow): ProviderSafeIssueOwner {
  if (row.ownerKind === "agent" && row.ownerAgentId && !row.ownerUserId) {
    return { kind: "agent", agentId: row.ownerAgentId };
  }
  if (row.ownerKind === "user" && row.ownerUserId && !row.ownerAgentId) {
    return { kind: "user", userId: row.ownerUserId };
  }
  if (row.ownerKind === "board" && !row.ownerAgentId && !row.ownerUserId) {
    return { kind: "board" };
  }
  throw new Error("Canonical issue row has an invalid owner shape");
}

function creator(row: IssueProjectionRow): ProviderSafeIssueCreator {
  switch (row.creatorKind) {
    case "agent-execution":
      if (
        row.creatorAuthorityId &&
        row.creatorAgentId &&
        row.creatorAdapterConfigRevisionId
      ) {
        return {
          kind: "agent-execution",
          agentId: row.creatorAgentId,
        };
      }
      break;
    case "user/board":
      return { kind: "user/board", userId: row.creatorUserId };
    case "plugin":
      if (
        row.creatorPluginInstallationId &&
        row.creatorPluginKey &&
        row.creatorCallbackKey &&
        row.creatorCallbackVersion
      ) {
        return {
          kind: "plugin",
          pluginKey: row.creatorPluginKey,
        };
      }
      break;
    case "routine":
      if (row.creatorRoutineId && row.creatorRoutineDispatchId) {
        return {
          kind: "routine",
          routineId: row.creatorRoutineId,
        };
      }
      break;
    case "system":
      if (row.creatorSystemSourceKind && row.creatorSystemSourceId) {
        return {
          kind: "system",
          sourceKind: decodeSystemCreatorSourceKind(
            row.creatorSystemSourceKind,
          ),
        };
      }
      break;
  }
  throw new Error("Canonical issue row has an invalid creator shape");
}

function iso(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Canonical projection timestamp is invalid");
  }
  return date.toISOString();
}

function finiteNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function executedRows<Row>(result: unknown): Row[] {
  return Array.from(result as Iterable<Row>);
}

export function mapContextIssueRow(
  row: IssueProjectionRow,
): ContextRetrievalIssueProjection {
  if (!row.request) {
    throw new Error("Canonical issue row has no immutable request");
  }
  const status = exactStatus(row.status);
  const disposition =
    row.disposition === null
      ? null
      : decodeIssueDisposition(row.disposition);
  if (
    ((status === "open" || status === "blocked") &&
      disposition !== null) ||
    ((status === "done" || status === "cancelled") &&
      disposition === null)
  ) {
    throw new Error(
      "Canonical issue row has an invalid lifecycle/disposition shape",
    );
  }
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    request: row.request,
    status,
    disposition,
    priority: exactPriority(row.priority),
    creator: creator(row),
    owner: owner(row),
    parentId: row.parentId,
    directChildCount: Number(row.directChildCount),
    updatedAt: iso(row.updatedAt),
  };
}

function afterDate(after: RetrievalCursorPosition | null): Date | null {
  if (!after) return null;
  const value = new Date(after.sortValue);
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Issue keyset cursor timestamp is invalid");
  }
  return value;
}

const ISSUE_SELECT = sql.raw(`
  i.id,
  i.identifier,
  i.title,
  i.request,
  i.lifecycle_status AS "status",
  i.disposition,
  i.priority,
  i.parent_id AS "parentId",
  i.owner_kind AS "ownerKind",
  i.owner_agent_id AS "ownerAgentId",
  i.owner_user_id AS "ownerUserId",
  i.creator_kind AS "creatorKind",
  i.creator_authority_id AS "creatorAuthorityId",
  (
    SELECT authority.agent_id
    FROM issue_execution_authorities authority
    WHERE authority.company_id = i.company_id
      AND authority.id = i.creator_authority_id
    LIMIT 1
  ) AS "creatorAgentId",
  i.creator_adapter_config_revision_id AS "creatorAdapterConfigRevisionId",
  i.creator_user_id AS "creatorUserId",
  i.creator_plugin_installation_id AS "creatorPluginInstallationId",
  i.creator_plugin_key AS "creatorPluginKey",
  i.creator_callback_key AS "creatorCallbackKey",
  i.creator_callback_version AS "creatorCallbackVersion",
  i.creator_routine_id AS "creatorRoutineId",
  i.creator_routine_dispatch_id AS "creatorRoutineDispatchId",
  i.creator_system_source_kind AS "creatorSystemSourceKind",
  i.creator_system_source_id AS "creatorSystemSourceId",
  (
    SELECT count(*)
    FROM issues child
    WHERE child.company_id = i.company_id
      AND child.parent_id = i.id
      AND child.hidden_at IS NULL
  ) AS "directChildCount",
  i.updated_at AS "updatedAt"
`);

function issueFilterSql(filters: RetrievalIssueFilters) {
  return sql`
    ${filters.status ? sql`AND i.lifecycle_status = ${filters.status}` : sql``}
    ${filters.priority ? sql`AND i.priority = ${filters.priority}` : sql``}
  `;
}

function issueAfterSql(after: RetrievalCursorPosition | null) {
  const timestamp = afterDate(after);
  return timestamp && after
    ? sql`AND (i.updated_at < ${timestamp} OR (i.updated_at = ${timestamp} AND i.id::text < ${after.id}))`
    : sql``;
}

export function mapContextCommentAuthor(
  row: CommentProjectionRow,
): ContextRetrievalCommentProjection["author"] {
  if (
    row.authorType === "agent" &&
    typeof row.authorAgentId === "string" &&
    row.authorAgentId.length > 0 &&
    row.authorUserId === null &&
    row.authorPluginKey === null
  ) {
    return { kind: "agent", agentId: row.authorAgentId };
  }
  if (
    row.authorType === "user" &&
    row.authorAgentId === null &&
    typeof row.authorUserId === "string" &&
    row.authorUserId.length > 0 &&
    row.authorPluginKey === null
  ) {
    return { kind: "user", userId: row.authorUserId };
  }
  if (
    row.authorType === "plugin" &&
    row.authorAgentId === null &&
    row.authorUserId === null &&
    typeof row.authorPluginKey === "string" &&
    row.authorPluginKey.length > 0
  ) {
    return { kind: "plugin", pluginKey: row.authorPluginKey };
  }
  if (
    row.authorType === "system" &&
    row.authorAgentId === null &&
    row.authorUserId === null &&
    row.authorPluginKey === null
  ) {
    return { kind: "system" };
  }
  throw new Error("Canonical issue comment row has an invalid author shape");
}

function sanitizedValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactCurrentUserValue(redactSensitiveText(value));
  }
  if (Array.isArray(value)) {
    return value.map(sanitizedValue);
  }
  if (value && typeof value === "object") {
    return redactCurrentUserValue(
      redactEventPayload(value as Record<string, unknown>),
    );
  }
  return value;
}

function wireRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function wireString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function safeModel(
  value: unknown,
): CanonicalRunTraceTurn["model"] {
  const model = wireRecord(value);
  const id = wireString(model.id);
  const providerId = wireString(model.providerID);
  if (!id || !providerId) return null;
  return {
    id,
    providerId,
    ...(wireString(model.variant)
      ? { variant: wireString(model.variant) }
      : {}),
  };
}

function assistantParts(value: unknown): CanonicalRunTracePart[] {
  if (!Array.isArray(value)) return [];
  const result: CanonicalRunTracePart[] = [];
  for (const rawPart of value) {
    const part = wireRecord(rawPart);
    const kind = wireString(part.type);
    const id = wireString(part.id);
    if (!id) continue;
    if ((kind === "text" || kind === "reasoning") && wireString(part.text) !== null) {
      result.push({
        kind,
        id,
        text: redactSensitiveText(String(part.text)),
      });
      continue;
    }
    if (kind !== "tool") continue;
    const state = wireRecord(part.state);
    const status = wireString(state.status);
    const callId = id;
    const name = wireString(part.name);
    if (
      !name ||
      (status !== "pending" &&
        status !== "running" &&
        status !== "completed" &&
        status !== "error")
    ) {
      continue;
    }
    const output =
      status === "pending"
        ? undefined
        : sanitizedValue(
            Object.fromEntries(
              ["structured", "content", "result"]
                .filter((key) => state[key] !== undefined)
                .map((key) => [key, state[key]]),
            ),
          );
    const error = wireRecord(state.error);
    result.push({
      kind: "tool",
      id,
      callId,
      name,
      state: status,
      input: sanitizedValue(state.input),
      ...(output !== undefined ? { output } : {}),
      ...(wireString(error.type) ? { errorKind: wireString(error.type) } : {}),
    });
  }
  return result;
}

/**
 * Builds the descriptor-safe run turn from a schema-validated V2 message.
 * Provider metadata, attachments/snapshots, token/cost usage, and message
 * metadata are intentionally absent from this allowlist.
 */
export function sanitizeCanonicalMessage(
  message: IssueSessionMessage,
  seq: number,
): CanonicalRunTraceTurn {
  const wire = encodeIssueSessionMessage(message) as unknown as Record<
    string,
    unknown
  >;
  const time = wireRecord(wire.time);
  const base = {
    seq,
    id: String(wire.id),
    kind: message.type,
    timestamp: iso(Number(time.created)),
  } satisfies Pick<
    CanonicalRunTraceTurn,
    "seq" | "id" | "kind" | "timestamp"
  >;
  const completedAt =
    typeof time.completed === "number" ? iso(time.completed) : null;

  switch (message.type) {
    case "agent-switched":
      return {
        ...base,
        agentId: wireString(wire.agent),
      };
    case "model-switched":
      return {
        ...base,
        model: safeModel(wire.model),
      };
    case "user":
    case "synthetic":
    case "system":
      return {
        ...base,
        text: redactSensitiveText(String(wire.text ?? "")),
      };
    case "shell":
      return {
        ...base,
        ...(completedAt ? { completedAt } : {}),
        callId: wireString(wire.callID),
        command: redactSensitiveText(String(wire.command ?? "")),
        output: redactSensitiveText(String(wire.output ?? "")),
      };
    case "assistant": {
      const error = wireRecord(wire.error);
      return {
        ...base,
        ...(completedAt ? { completedAt } : {}),
        agentId: wireString(wire.agent),
        model: safeModel(wire.model),
        content: assistantParts(wire.content),
        finish: wireString(wire.finish),
        errorKind: wireString(error.type),
      };
    }
    case "compaction":
      return {
        ...base,
        text: redactSensitiveText(String(wire.summary ?? "")),
        recent: redactSensitiveText(String(wire.recent ?? "")),
        compactionReason:
          wire.reason === "auto" || wire.reason === "manual"
            ? wire.reason
            : null,
      };
  }
}

export function createContextRetrievalDbRepository(
  db: Db,
  options: {
    runService: Pick<IssueExecutionRunService, "readJoinedRunDetail">;
  },
): ContextRetrievalRepository {
  return {
    async issueReach({ companyId, activeIssueId, issueId }) {
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
            FROM issues
            WHERE company_id = ${companyId}
              AND parent_id = ${activeIssueId}
              AND hidden_at IS NULL
            UNION ALL
            SELECT child.id
            FROM issues child
            JOIN descendants parent ON child.parent_id = parent.id
            WHERE child.company_id = ${companyId}
              AND child.hidden_at IS NULL
          )
          SELECT
            true AS "sameCompany",
            (target.id = ${activeIssueId}) AS "active",
            EXISTS (SELECT 1 FROM descendants WHERE id = target.id) AS "descendant"
          FROM issues target
          WHERE target.company_id = ${companyId}
            AND target.id = ${issueId}
            AND target.hidden_at IS NULL
          LIMIT 1
        `),
      );
      return rows[0] ?? null;
    },

    async listTopLevelIssues({ companyId, filters, after, limit }) {
      const rows = executedRows<IssueProjectionRow>(
        await db.execute(sql<IssueProjectionRow>`
          SELECT ${ISSUE_SELECT}
          FROM issues i
          WHERE i.company_id = ${companyId}
            AND i.parent_id IS NULL
            AND i.hidden_at IS NULL
            AND i.lifecycle_status IS NOT NULL
            ${issueFilterSql(filters)}
            ${issueAfterSql(after)}
          ORDER BY i.updated_at DESC, i.id DESC
          LIMIT ${limit}
        `),
      );
      return rows.map(mapContextIssueRow);
    },

    async listDirectChildren({ companyId, issueId, after, limit }) {
      const rows = executedRows<IssueProjectionRow>(
        await db.execute(sql<IssueProjectionRow>`
          SELECT ${ISSUE_SELECT}
          FROM issues i
          WHERE i.company_id = ${companyId}
            AND i.parent_id = ${issueId}
            AND i.hidden_at IS NULL
            AND i.lifecycle_status IS NOT NULL
            ${issueAfterSql(after)}
          ORDER BY i.updated_at DESC, i.id DESC
          LIMIT ${limit}
        `),
      );
      return rows.map(mapContextIssueRow);
    },

    async listIssueComments({ companyId, issueId, after, limit }) {
      const afterSequence = after ? Number(after.sortValue) : null;
      if (
        after &&
        (!Number.isSafeInteger(afterSequence) || afterSequence! < 0)
      ) {
        throw new Error("Comment keyset cursor sequence is invalid");
      }
      const rows = executedRows<CommentProjectionRow>(
        await db.execute(sql<CommentProjectionRow>`
          SELECT
            c.id,
            c.issue_id AS "issueId",
            c.body,
            c.author_type AS "authorType",
            c.author_agent_id AS "authorAgentId",
            c.author_user_id AS "authorUserId",
            c.author_plugin_key AS "authorPluginKey",
            source.run_id AS "runId",
            source.projected_event_seq AS "sequence",
            c.created_at AS "createdAt"
          FROM issue_comments c
          JOIN issue_comment_projection_sources source
            ON source.comment_id = c.id
           AND source.company_id = c.company_id
           AND source.issue_id = c.issue_id
          WHERE c.company_id = ${companyId}
            AND c.issue_id = ${issueId}
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
        issueId: row.issueId,
        body: row.body,
        author: mapContextCommentAuthor(row),
        runId: row.runId,
        sequence: Number(row.sequence),
        createdAt: iso(row.createdAt),
      }));
    },

    async runIssue({ companyId, runId }) {
      const identity = await resolveIssueExecutionRunIdentityById(db, runId);
      return identity?.companyId === companyId
        ? { issueId: identity.issueId }
        : null;
    },

    async readCanonicalRunTrace({
      companyId,
      runId,
      projection,
      cursor,
      limit,
    }) {
      const identity = await resolveIssueExecutionRunIdentityById(db, runId);
      if (!identity || identity.companyId !== companyId) return null;
      const detail = await options.runService.readJoinedRunDetail({
        ...identity,
        limit: limit ?? 100,
        sessionProjection: projection,
        sessionMessageCursor: cursor,
      });
      if (!detail) return null;
      const run = detail.run;
      const turns = detail.sessionMessages.items.map((row) =>
        sanitizeCanonicalMessage(
          decodeIssueSessionMessage({
            ...row.data,
            id: row.id,
            type: row.type,
          }),
          Number(row.seq),
        ),
      );
      const accountingRow = detail.accounting.items.at(-1) ?? null;
      const costRow = accountingRow
        ? detail.costs.items.find(
            (candidate) => candidate.accountingId === accountingRow.id,
          ) ?? null
        : null;
      const accounting = accountingRow && costRow
        ? {
            contextUsedTokens: finiteNumber(accountingRow.contextUsedTokens),
            contextWindowTokens: finiteNumber(accountingRow.contextWindowTokens),
            budgetCurrency: parseBudgetCurrency(costRow.budgetCurrency),
            cost: costRow.kind === "known"
              ? {
                  kind: "known" as const,
                  knownDeltaAmount: canonicalizeMoneyAmount(
                    costRow.knownDeltaAmount ?? "0",
                  ),
                }
              : {
                  kind: "unavailable" as const,
                  unavailableReason:
                    costRow.unavailableReason as AcpCostUnavailableReason,
                },
          }
        : null;
      const checkpoint = detail.compactionCheckpoint;
      return {
        runId,
        runKind: run.kind,
        triggeredByRunId: run.triggeredByRunId,
        issueId: run.issueId,
        status: run.status,
        startedAt: run.startedAt ? iso(run.startedAt) : null,
        finishedAt: run.finishedAt ? iso(run.finishedAt) : null,
        accounting,
        checkpoint,
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
        nextCursor: detail.sessionMessages.nextCursor ?? null,
      } satisfies CanonicalRunTrace;
    },
  };
}
