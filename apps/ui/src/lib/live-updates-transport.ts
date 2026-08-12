import type { QueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import {
  LIVE_EVENT_SOCKET_PATH,
  type LiveEventClientToServerEvents,
  type LiveEventServerToClientEvents,
  type LiveEventSocketAuth,
} from "@paperclipai/shared";

type LiveUpdatesSocket = Socket<
  LiveEventServerToClientEvents,
  LiveEventClientToServerEvents
>;

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

export function reconcileActiveCompanyQueries(queryClient: QueryClient) {
  // The app has one selected company, so active domain queries belong to that
  // company. REST remains canonical after every initial/reconnected socket.
  return queryClient.invalidateQueries({
    type: "active",
    refetchType: "active",
  });
}
