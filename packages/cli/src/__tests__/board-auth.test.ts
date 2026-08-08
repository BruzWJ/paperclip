import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStoredBoardCredential,
  loginBoardCli,
  readBoardAuthStore,
  removeStoredBoardCredential,
  setStoredBoardCredential,
} from "../client/board-auth.js";

afterEach(() => vi.restoreAllMocks());

function createTempAuthPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-auth-"));
  return path.join(dir, "auth.json");
}

describe("board auth store", () => {
  it("returns an empty store when the file does not exist", () => {
    const authPath = createTempAuthPath();
    expect(readBoardAuthStore(authPath)).toEqual({
      version: 1,
      credentials: {},
    });
  });

  it("stores and retrieves credentials by normalized api base", () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100/",
      token: "token-123",
      userId: "user-1",
      storePath: authPath,
    });

    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toMatchObject({
      apiBase: "http://localhost:3100",
      token: "token-123",
      userId: "user-1",
    });
  });

  it("removes stored credentials", () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "token-123",
      storePath: authPath,
    });

    expect(removeStoredBoardCredential("http://localhost:3100", authPath)).toBe(true);
    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toBeNull();
  });

  it("starts personal board-key approval as a same-origin JSON request", async () => {
    const authPath = createTempAuthPath();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "challenge-1",
        token: "challenge-secret",
        boardApiToken: "pcp_board_personal",
        approvalPath: "/cli-auth/challenge-1",
        approvalUrl: "http://localhost:3100/cli-auth/challenge-1",
        pollPath: "/cli-auth/challenges/challenge-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        suggestedPollIntervalMs: 500,
      }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "approved" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: "user-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    await loginBoardCli({
      apiBase: "http://localhost:3100",
      requestedAccess: "board",
      storePath: authPath,
      print: false,
      openBrowser: false,
    });

    const challengeRequest = fetchMock.mock.calls[0];
    expect(challengeRequest?.[0]).toBe("http://localhost:3100/api/cli-auth/challenges");
    expect(new Headers(challengeRequest?.[1]?.headers).get("origin"))
      .toBe("http://localhost:3100");
    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toMatchObject({
      token: "pcp_board_personal",
      userId: "user-1",
    });
  });
});
