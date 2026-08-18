import type { QueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import {
  LIVE_EVENT_SOCKET_PATH,
  LIVE_RUN_STREAM_SYNC_EVENT,
  type LiveEventClientToServerEvents,
  type LiveEventServerToClientEvents,
  type LiveEventSocketAuth,
} from "@paperclipai/shared";
import {
  applyRunStateEventToCache,
  applyRunStreamSnapshotsToCache,
  runStreamCursor,
} from "./run-stream-cache";
import type { TaskExecutionRunJoinedDetail } from "../api/runs";

type LiveUpdatesSocket = Socket<LiveEventServerToClientEvents, LiveEventClientToServerEvents>;

export function createLiveUpdatesSocket(companyId: string): LiveUpdatesSocket {
  const auth = { companyId } satisfies LiveEventSocketAuth;
  const socket: LiveUpdatesSocket = io({
    path: LIVE_EVENT_SOCKET_PATH,
    addTrailingSlash: false,
    transports: ["websocket"],
    withCredentials: true,
    auth,
    autoConnect: false,
    forceNew: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
  });
  return socket;
}

export function synchronizeRunStream(
  socket: LiveUpdatesSocket,
  queryClient: QueryClient,
  runId: string,
  afterSeq: number,
  afterId = "",
): void {
  socket.emit(LIVE_RUN_STREAM_SYNC_EVENT, { runId, afterSeq, afterId }, (response) => {
    if (response.runId !== runId) return;
    if (response.run) {
      applyRunStateEventToCache(queryClient, { run: response.run });
    }
    applyRunStreamSnapshotsToCache(queryClient, runId, response.messages);
    const next = response.nextCursor;
    if (
      next !== null &&
      (next.afterSeq > afterSeq || (next.afterSeq === afterSeq && next.afterId > afterId))
    ) {
      synchronizeRunStream(
        socket,
        queryClient,
        runId,
        next.afterSeq,
        next.afterId,
      );
    }
  });
}

function runDetailIdFromQueryKey(queryKey: readonly unknown[]): string | null {
  return queryKey.length === 3 &&
    queryKey[0] === "runs" &&
    queryKey[1] === "detail" &&
    typeof queryKey[2] === "string"
    ? queryKey[2]
    : null;
}

/**
 * Closes the initial-REST hydration race without adding a REST refresh path.
 * A detail that appears after the socket connected immediately catches up from
 * its durable cursor over Socket.IO. Every reconnect performs the same
 * idempotent Socket.IO catch-up, including when packet recovery succeeded, so
 * a sync acknowledgement lost during disconnection cannot leave a gap.
 */
export function createRunStreamSynchronizer(socket: LiveUpdatesSocket, queryClient: QueryClient) {
  const synchronizedRunIds = new Set<string>();

  const synchronizeHydratedDetail = (detail: TaskExecutionRunJoinedDetail, force = false) => {
    if (!force && synchronizedRunIds.has(detail.run.id)) return;
    synchronizedRunIds.add(detail.run.id);
    synchronizeRunStream(socket, queryClient, detail.run.id, runStreamCursor(detail));
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    const runId = runDetailIdFromQueryKey(event.query.queryKey);
    if (!runId) return;
    if (event.type === "removed") {
      synchronizedRunIds.delete(runId);
      return;
    }
    const hydratedFromQuery =
      event.type === "updated" &&
      event.action.type === "success" &&
      event.action.manual !== true;
    if (!socket.connected || (synchronizedRunIds.has(runId) && !hydratedFromQuery)) return;
    const detail = event.query.state.data as TaskExecutionRunJoinedDetail | undefined;
    if (!detail || detail.run.id !== runId) return;
    synchronizeHydratedDetail(detail, hydratedFromQuery);
  });

  return {
    onSocketConnect() {
      for (const [, detail] of queryClient.getQueriesData<TaskExecutionRunJoinedDetail>({
        queryKey: ["runs", "detail"],
      })) {
        if (!detail) continue;
        synchronizedRunIds.add(detail.run.id);
        synchronizeRunStream(socket, queryClient, detail.run.id, runStreamCursor(detail));
      }
    },
    dispose: unsubscribe,
  };
}
