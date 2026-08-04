import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTokenCommands } from "../commands/client/token.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerTokenCommands(program);
  return program;
}

describe("token commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    delete process.env.PAPERCLIP_BOARD_API_URL;
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a board token with a ttl-derived expiration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T00:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "board-key-1",
        name: "external-admin",
        token: "pcp_board_plaintext",
        createdAt: "2026-05-23T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: "2026-06-06T00:00:00.000Z",
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "board", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--name", "external-admin",
      "--ttl-days", "14",
      "--json",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3100/api/board-api-keys");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: "external-admin",
      requestedCompanyId: COMPANY_ID,
      expiresAt: "2026-06-06T00:00:00.000Z",
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      key: {
        id: "board-key-1",
        name: "external-admin",
        token: "pcp_board_plaintext",
        expiresAt: "2026-06-06T00:00:00.000Z",
      },
    });
  });

  it("creates a non-expiring board token when requested", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "board-key-1",
        name: "external-admin",
        token: "pcp_board_plaintext",
        createdAt: "2026-05-23T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "board", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--name", "external-admin",
      "--never-expires",
      "--json",
    ], { from: "user" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: "external-admin",
      requestedCompanyId: COMPANY_ID,
      expiresAt: null,
    });
  });

  it("lists and revokes board tokens", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: "board-key-1",
        name: "external-admin",
        createdAt: "2026-05-23T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, keyId: "board-key-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "token", "board", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });

    await createProgram().parseAsync([
      "token", "board", "revoke", "board-key-1",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--json",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3100/api/board-api-keys");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3100/api/board-api-keys/board-key-1");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });
});
