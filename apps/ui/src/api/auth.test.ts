import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, authApi } from "./auth";

const sessionPayload = {
  session: {
    id: "session-1",
    userId: "user-1",
  },
  user: {
    id: "user-1",
    email: "operator@example.com",
    name: "Operator",
    image: null,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("authApi Better Auth contracts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the direct Better Auth session response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionPayload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.getSession()).resolves.toEqual(sessionPayload);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/get-session", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  });

  it("rejects a compatibility-wrapped session response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: sessionPayload })),
    );

    await expect(authApi.getSession()).rejects.toMatchObject({
      code: "INVALID_AUTH_SESSION",
      status: 502,
    } satisfies Partial<AuthApiError>);
  });

  it("updates the Better Auth user and reloads the canonical session", async () => {
    const updatedSession = {
      ...sessionPayload,
      user: {
        ...sessionPayload.user,
        name: "Updated Operator",
        image: "https://example.com/avatar.png",
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: true }))
      .mockResolvedValueOnce(jsonResponse(updatedSession));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      authApi.updateProfile({
        name: "Updated Operator",
        image: "https://example.com/avatar.png",
      }),
    ).resolves.toEqual(updatedSession.user);
    expect(fetchMock.mock.calls).toEqual([
      [
        "/api/auth/update-user",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Updated Operator",
            image: "https://example.com/avatar.png",
          }),
        },
      ],
      [
        "/api/auth/get-session",
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        },
      ],
    ]);
  });
});
