// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { LIVE_EVENT_SOCKET_PATH } from "@paperclipai/shared";

const { ioMock, socket } = vi.hoisted(() => {
  const socket = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
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
  reconcileActiveCompanyQueries,
} from "../lib/live-updates-transport";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

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

  it("reconciles all active REST projections after a connection gap", async () => {
    const invalidateQueries = vi.fn(async () => undefined);
    await reconcileActiveCompanyQueries({ invalidateQueries } as never);
    expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({
      type: "active",
      refetchType: "active",
    });
  });
});
