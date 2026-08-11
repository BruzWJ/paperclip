import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiConnectionError, ApiRequestError, PaperclipApiClient } from "../client/http.js";

describe("PaperclipApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("adds the board authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      apiKey: "token-123",
    });

    await client.post("/api/test", { hello: "world" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/api/test");

    const headers = call[1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-123");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("forwards explicit per-request headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      apiKey: "token-123",
    });

    await client.post(
      "/api/test",
      { hello: "world" },
      { headers: { "Idempotency-Key": "agent-create-1" } },
    );

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["Idempotency-Key"]).toBe("agent-create-1");
    expect(headers.authorization).toBe("Bearer token-123");
  });

  it("returns null on ignoreNotFound", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });
    const result = await client.get("/api/missing", { ignoreNotFound: true });
    expect(result).toBeNull();
  });

  it("throws ApiRequestError with details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Request conflict", details: { resourceId: "1" } }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/test", {})).rejects.toMatchObject({
      status: 409,
      message: "Request conflict",
      details: { resourceId: "1" },
    } satisfies Partial<ApiRequestError>);
  });

  it("throws ApiConnectionError with recovery guidance when fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/companies/imports/preview", {})).rejects.toBeInstanceOf(ApiConnectionError);
    await expect(client.post("/api/companies/imports/preview", {})).rejects.toMatchObject({
      url: "http://localhost:3100/api/companies/imports/preview",
      method: "POST",
      causeMessage: "fetch failed",
    } satisfies Partial<ApiConnectionError>);
    await expect(client.post("/api/companies/imports/preview", {})).rejects.toThrow(
      /Could not reach the Paperclip API\./,
    );
    await expect(client.post("/api/companies/imports/preview", {})).rejects.toThrow(
      /curl http:\/\/localhost:3100\/api\/health/,
    );
    await expect(client.post("/api/companies/imports/preview", {})).rejects.toThrow(
      /pnpm dev|pnpm paperclipai run/,
    );
  });

  it("retries once after interactive auth recovery", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Board access required" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const recoverAuth = vi.fn().mockResolvedValue("board-token-123");
    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      recoverAuth,
    });

    const result = await client.post<{ ok: boolean }>("/api/test", { hello: "world" });

    expect(result).toEqual({ ok: true });
    expect(recoverAuth).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(retryHeaders.authorization).toBe("Bearer board-token-123");
  });
});
