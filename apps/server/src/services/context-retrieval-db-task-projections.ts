import { sql } from "drizzle-orm";
import {
  decodeTaskDisposition,
  decodeSystemCreatorSourceKind,
  type AgentVisibleTaskStatus,
} from "@paperclipai/shared";
import type {
  ContextRetrievalTaskProjection,
  ProviderSafeTaskCreator,
  ProviderSafeTaskOwner,
  RetrievalCursorPosition,
  RetrievalTaskFilters,
} from "./context-retrieval.js";

export interface TaskProjectionRow {
  id: string;
  identifier: string;
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

export interface CommentProjectionRow {
  id: string;
  taskId: string;
  body: string;
  authorType: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorPluginKey: string | null;
  runId: string | null;
  sequence: number | string;
  createdAt: Date | string;
}

export function exactStatus(value: string | null): AgentVisibleTaskStatus {
  if (value !== "open" && value !== "blocked" && value !== "done" && value !== "cancelled") {
    throw new Error("Canonical task row has no agent-visible lifecycle status");
  }
  return value;
}

export function exactPriority(value: string): ContextRetrievalTaskProjection["priority"] {
  if (value !== "critical" && value !== "high" && value !== "medium" && value !== "low") {
    throw new Error(`Canonical task row has invalid priority ${value}`);
  }
  return value;
}

export function owner(row: TaskProjectionRow): ProviderSafeTaskOwner {
  if (row.ownerKind === "agent" && row.ownerAgentId && !row.ownerUserId) {
    return { kind: "agent", agentId: row.ownerAgentId };
  }
  if (row.ownerKind === "user" && row.ownerUserId && !row.ownerAgentId) {
    return { kind: "user", userId: row.ownerUserId };
  }
  if (row.ownerKind === "board" && !row.ownerAgentId && !row.ownerUserId) {
    return { kind: "board" };
  }
  throw new Error("Canonical task row has an invalid owner shape");
}

export function creator(row: TaskProjectionRow): ProviderSafeTaskCreator {
  switch (row.creatorKind) {
    case "agent-execution":
      if (row.creatorAuthorityId && row.creatorAgentId && row.creatorAdapterConfigRevisionId) {
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
          sourceKind: decodeSystemCreatorSourceKind(row.creatorSystemSourceKind),
        };
      }
      break;
  }
  throw new Error("Canonical task row has an invalid creator shape");
}

export function iso(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Canonical projection timestamp is invalid");
  }
  return date.toISOString();
}

export function finiteNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function executedRows<Row>(result: unknown): Row[] {
  return Array.from(result as Iterable<Row>);
}

export function mapContextTaskRow(row: TaskProjectionRow): ContextRetrievalTaskProjection {
  if (!row.request) {
    throw new Error("Canonical task row has no immutable request");
  }
  const status = exactStatus(row.status);
  const disposition = row.disposition === null ? null : decodeTaskDisposition(row.disposition);
  if (
    ((status === "open" || status === "blocked") && disposition !== null) ||
    ((status === "done" || status === "cancelled") && disposition === null)
  ) {
    throw new Error("Canonical task row has an invalid lifecycle/disposition shape");
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

export function afterDate(after: RetrievalCursorPosition | null): Date | null {
  if (!after) return null;
  const value = new Date(after.sortValue);
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Task keyset cursor timestamp is invalid");
  }
  return value;
}

export const TASK_SELECT = sql.raw(`
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
    FROM task_execution_authorities authority
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
    FROM tasks child
    WHERE child.company_id = i.company_id
      AND child.parent_id = i.id
      AND child.hidden_at IS NULL
  ) AS "directChildCount",
  i.updated_at AS "updatedAt"
`);

export function taskFilterSql(filters: RetrievalTaskFilters) {
  return sql`
    ${filters.status ? sql`AND i.lifecycle_status = ${filters.status}` : sql``}
    ${filters.priority ? sql`AND i.priority = ${filters.priority}` : sql``}
  `;
}

export function taskAfterSql(after: RetrievalCursorPosition | null) {
  const timestamp = afterDate(after);
  return timestamp && after
    ? sql`AND (i.updated_at < ${timestamp} OR (i.updated_at = ${timestamp} AND i.id::text < ${after.id}))`
    : sql``;
}
