// @vitest-environment node

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { LIVE_EVENT_SOCKET_PATH } from "@paperclipai/shared";

const { ioMock, socket } = vi.hoisted(() => {
  const socket = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    recovered: false,
  };
  return {
    socket,
    ioMock: vi.fn(() => socket),
  };
});

vi.mock("socket.io-client", () => ({
  io: ioMock,
}));

import {
  createLiveUpdatesSocket,
  createRunStreamSynchronizer,
  synchronizeRunStream,
} from "../lib/live-updates-transport";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

describe("LiveUpdatesProvider Socket.IO transport", () => {
  it("creates one cookie-authenticated websocket-only company connection", () => {
    expect(createLiveUpdatesSocket(COMPANY_ID)).toBe(socket);
    expect(ioMock).toHaveBeenCalledExactlyOnceWith({
      path: LIVE_EVENT_SOCKET_PATH,
      addTrailingSlash: false,
      transports: ["websocket"],
      withCredentials: true,
      auth: { companyId: COMPANY_ID },
      autoConnect: false,
      forceNew: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
    });
  });

  it("catches up loaded transcripts through Socket.IO without REST invalidation", () => {
    const client = new QueryClient();
    client.setQueryData(["runs", "detail", RUN_ID], {
      run: { id: RUN_ID },
      sessionMessages: {
        items: [{ modelStateSeq: 41 }],
        truncated: false,
      },
    });
    const synchronizer = createRunStreamSynchronizer(socket as never, client);
    synchronizer.onSocketConnect();

    expect(socket.emit).toHaveBeenCalledExactlyOnceWith(
      "live:run-stream-sync:v1",
      { runId: RUN_ID, afterSeq: 41, afterId: "" },
      expect.any(Function),
    );
    synchronizer.dispose();
    client.clear();
  });

  it("catches up a detail that hydrates after the socket connects", () => {
    const client = new QueryClient();
    const connectedSocket = {
      connected: true,
      recovered: false,
      emit: vi.fn(),
    };
    const synchronizer = createRunStreamSynchronizer(connectedSocket as never, client);

    client.setQueryData(["runs", "detail", RUN_ID], {
      run: { id: RUN_ID },
      sessionMessages: {
        items: [{ modelStateSeq: 17 }],
        truncated: false,
      },
    });

    expect(connectedSocket.emit).toHaveBeenCalledExactlyOnceWith(
      "live:run-stream-sync:v1",
      { runId: RUN_ID, afterSeq: 17, afterId: "" },
      expect.any(Function),
    );
    synchronizer.dispose();
    client.clear();
  });

  it("Socket-syncs again after a later REST hydration replaces the cache", async () => {
    const client = new QueryClient();
    client.setQueryData(["runs", "detail", RUN_ID], {
      run: { id: RUN_ID },
      sessionMessages: { items: [{ modelStateSeq: 17 }], truncated: false },
    });
    const connectedSocket = { connected: true, recovered: false, emit: vi.fn() };
    const synchronizer = createRunStreamSynchronizer(connectedSocket as never, client);
    synchronizer.onSocketConnect();

    await client.invalidateQueries({
      queryKey: ["runs", "detail", RUN_ID],
      refetchType: "none",
    });
    await client.fetchQuery({
      queryKey: ["runs", "detail", RUN_ID],
      staleTime: 0,
      queryFn: async () => ({
        run: { id: RUN_ID },
        sessionMessages: { items: [{ modelStateSeq: 29 }], truncated: false },
      }),
    });

    expect(connectedSocket.emit).toHaveBeenLastCalledWith(
      "live:run-stream-sync:v1",
      { runId: RUN_ID, afterSeq: 29, afterId: "" },
      expect.any(Function),
    );
    expect(connectedSocket.emit).toHaveBeenCalledTimes(2);
    synchronizer.dispose();
    client.clear();
  });

  it("uses Socket.IO catch-up again after a recovered reconnect", () => {
    const client = new QueryClient();
    client.setQueryData(["runs", "detail", RUN_ID], {
      run: { id: RUN_ID },
      sessionMessages: { items: [{ modelStateSeq: 23 }], truncated: false },
    });
    const recoveredSocket = { connected: true, recovered: true, emit: vi.fn() };
    const synchronizer = createRunStreamSynchronizer(recoveredSocket as never, client);

    synchronizer.onSocketConnect();
    synchronizer.onSocketConnect();

    expect(recoveredSocket.emit).toHaveBeenCalledTimes(2);
    expect(recoveredSocket.emit).toHaveBeenLastCalledWith(
      "live:run-stream-sync:v1",
      { runId: RUN_ID, afterSeq: 23, afterId: "" },
      expect.any(Function),
    );
    synchronizer.dispose();
    client.clear();
  });

  it("continues Socket.IO catch-up with the compound server cursor", () => {
    const client = new QueryClient();
    const pagedSocket = { emit: vi.fn() };
    synchronizeRunStream(pagedSocket as never, client, RUN_ID, 31);

    const acknowledge = pagedSocket.emit.mock.calls[0]?.[2] as ((response: unknown) => void) | undefined;
    acknowledge?.({
      runId: RUN_ID,
      run: null,
      messages: [],
      nextCursor: { afterSeq: 44, afterId: "assistant-050" },
    });

    expect(pagedSocket.emit).toHaveBeenNthCalledWith(
      2,
      "live:run-stream-sync:v1",
      { runId: RUN_ID, afterSeq: 44, afterId: "assistant-050" },
      expect.any(Function),
    );
    client.clear();
  });
});
