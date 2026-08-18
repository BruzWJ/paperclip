import type {
  RunStateLiveEventPayload,
  RunStreamAssistantMessage,
  RunStreamLiveEventPayload,
} from "@paperclipai/shared";
import type { QueryClient } from "@tanstack/react-query";
import type { TaskExecutionRunJoinedDetail, TaskExecutionSessionMessageRecord } from "../api/runs";
import { queryKeys } from "./queryKeys";

function contentOf(data: Record<string, unknown>): unknown[] {
  return Array.isArray(data.content) ? data.content : [];
}

function partId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function asSessionMessage(
  message: RunStreamAssistantMessage,
  data: Record<string, unknown>,
): TaskExecutionSessionMessageRecord {
  return { ...message, data };
}

function replaceMessage(
  detail: TaskExecutionRunJoinedDetail,
  message: TaskExecutionSessionMessageRecord,
): TaskExecutionRunJoinedDetail {
  const items = detail.sessionMessages.items.filter((candidate) => candidate.id !== message.id);
  items.push(message);
  items.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  return {
    ...detail,
    sessionMessages: {
      ...detail.sessionMessages,
      items,
    },
  };
}

export function applyRunStreamProjection(
  detail: TaskExecutionRunJoinedDetail,
  payload: RunStreamLiveEventPayload,
): TaskExecutionRunJoinedDetail {
  if (detail.run.id !== payload.runId) return detail;
  if (payload.kind === "message.snapshot") {
    return applyRunStreamSnapshot(detail, payload.runId, payload.message);
  }
  const incoming = payload.message;
  const current = detail.sessionMessages.items.find((message) => message.id === incoming.id);
  if (current && current.modelStateSeq >= incoming.modelStateSeq) return detail;

  const content = current ? [...contentOf(current.data)] : [];
  const updatedPartId = payload.part.id;
  const existingPartIndex = content.findIndex((part) => partId(part) === updatedPartId);
  if (existingPartIndex === -1) content.push(payload.part);
  else content[existingPartIndex] = payload.part;

  const next = asSessionMessage(incoming, {
    ...(current?.data ?? {}),
    ...incoming.data,
    content,
  });
  return replaceMessage(detail, next);
}

export function applyRunStreamSnapshot(
  detail: TaskExecutionRunJoinedDetail,
  runId: string,
  message: RunStreamAssistantMessage,
): TaskExecutionRunJoinedDetail {
  if (detail.run.id !== runId) return detail;
  const current = detail.sessionMessages.items.find((candidate) => candidate.id === message.id);
  if (current && current.modelStateSeq >= message.modelStateSeq) return detail;
  return replaceMessage(detail, asSessionMessage(message, message.data));
}

export function applyRunStreamEventToCache(
  queryClient: Pick<QueryClient, "setQueryData">,
  payload: RunStreamLiveEventPayload,
): void {
  queryClient.setQueryData<TaskExecutionRunJoinedDetail>(queryKeys.runDetail(payload.runId), (current) =>
    current ? applyRunStreamProjection(current, payload) : current,
  );
}

export function applyRunStateEventToCache(
  queryClient: Pick<QueryClient, "setQueryData">,
  payload: RunStateLiveEventPayload,
): void {
  queryClient.setQueryData<TaskExecutionRunJoinedDetail>(queryKeys.runDetail(payload.run.id), (current) =>
    current ? { ...current, run: payload.run } : current,
  );
}

export function applyRunStreamSnapshotsToCache(
  queryClient: Pick<QueryClient, "setQueryData">,
  runId: string,
  messages: readonly RunStreamAssistantMessage[],
): void {
  queryClient.setQueryData<TaskExecutionRunJoinedDetail>(queryKeys.runDetail(runId), (current) => {
    if (!current) return current;
    return messages.reduce((detail, message) => applyRunStreamSnapshot(detail, runId, message), current);
  });
}

export function runStreamCursor(detail: TaskExecutionRunJoinedDetail): number {
  return detail.sessionMessages.items.reduce(
    (highest, message) => Math.max(highest, message.modelStateSeq),
    0,
  );
}
