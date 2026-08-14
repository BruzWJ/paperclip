import { taskComments, taskSessionMessages, type Db } from "@paperclipai/db";
import { decodeTaskSessionMessage, encodeTaskSessionMessage } from "@paperclipai/shared/task-session";
import { describe, expect, it } from "vitest";
import {
  TASK_SESSION_DEFAULT_PAGE_SIZE,
  TASK_SESSION_MAX_PAGE_SIZE,
  TaskSessionInvalidCursor,
  createTaskSessionStore,
  isSettledTaskSessionMessage,
  type TaskSessionPageScope,
} from "../services/task-session/store.js";
export type MessageRow = typeof taskSessionMessages.$inferSelect;
export type CommentRow = typeof taskComments.$inferSelect;

export const companyId = "10000000-0000-4000-8000-000000000001";
export const otherCompanyId = "10000000-0000-4000-8000-000000000002";
export const taskId = "20000000-0000-4000-8000-000000000001";
export const otherTaskId = "20000000-0000-4000-8000-000000000002";
export const runId = "30000000-0000-4000-8000-000000000001";
export const otherRunId = "30000000-0000-4000-8000-000000000002";
export const sessionId = "ses_store";
export const otherSessionId = "ses_other";

export function messageRow(seq: number): MessageRow {
  const id = `msg_${seq.toString().padStart(4, "0")}`;
  const timeCreated = new Date(1_700_000_000_000 + seq);
  const message = decodeTaskSessionMessage({
    id,
    type: "user",
    text: `message ${seq}`,
    time: { created: timeCreated.getTime() },
  });
  const encoded = encodeTaskSessionMessage(message) as unknown as Record<string, unknown>;
  const { id: _id, type: _type, ...data } = encoded;
  return {
    id,
    companyId,
    taskId,
    sessionId,
    seq,
    modelStateSeq: seq,
    type: "user",
    data,
    runId,
    ownershipEpoch: 1,
    agentId: null,
    adapterConfigRevisionId: null,
    timeCreated,
    timeUpdated: timeCreated,
  };
}

export function commentRow(seq: number): CommentRow {
  const createdAt = new Date(1_700_000_000_000 + seq);
  return {
    id: `40000000-0000-4000-8000-${seq.toString().padStart(12, "0")}`,
    companyId,
    taskId,
    authorAgentId: null,
    authorUserId: "user-1",
    authorType: "user",
    runId,
    sessionId,
    canonicalSourceKind: "human_comment",
    canonicalSourceId: `source-${seq}`,
    canonicalMessageId: `msg_${seq.toString().padStart(4, "0")}`,
    admittedEventSeq: seq,
    promotedEventSeq: seq,
    projectedEventSeq: seq,
    body: `comment ${seq}`,
    presentation: null,
    metadata: null,
    sourceTrust: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function queuedDb<Row>(pages: readonly (readonly Row[])[]) {
  let pageIndex = 0;
  let selectCount = 0;
  const limits: number[] = [];
  const db = {
    select() {
      selectCount += 1;
      const query = {
        from() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        limit(limit: number) {
          limits.push(limit);
          return Promise.resolve([...(pages[pageIndex++] ?? [])]);
        },
      };
      return query;
    },
  } as unknown as Db;
  return {
    db,
    limits,
    get selectCount() {
      return selectCount;
    },
  };
}

export function scope(patch: Partial<TaskSessionPageScope> = {}): TaskSessionPageScope {
  return {
    companyId,
    taskId,
    sessionId,
    runId,
    direction: "asc",
    projection: "run-trace",
    ...patch,
  };
}

export { taskComments, taskSessionMessages, decodeTaskSessionMessage };
export { encodeTaskSessionMessage, describe, expect, it };
export { TASK_SESSION_DEFAULT_PAGE_SIZE, TASK_SESSION_MAX_PAGE_SIZE };
export { TaskSessionInvalidCursor, createTaskSessionStore };
export { isSettledTaskSessionMessage };
export type { Db, TaskSessionPageScope };
