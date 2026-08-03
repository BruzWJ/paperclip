import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postgres: vi.fn(() => ({ kind: "mock-postgres-client" })),
  drizzle: vi.fn((_client: unknown, _options: { schema: unknown }) => ({
    kind: "mock-drizzle-client",
  })),
}));

vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzle }));

import { createDb } from "../index.js";

describe("database client boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("constructs Drizzle from the mocked PostgreSQL client", () => {
    const result = createDb("postgres://fixture.invalid/paperclip");

    expect(mocks.postgres).toHaveBeenCalledOnce();
    expect(mocks.postgres).toHaveBeenCalledWith(
      "postgres://fixture.invalid/paperclip",
    );
    expect(mocks.drizzle).toHaveBeenCalledOnce();
    expect(mocks.drizzle.mock.calls[0]?.[0]).toEqual({
      kind: "mock-postgres-client",
    });
    expect(mocks.drizzle.mock.calls[0]?.[1]).toMatchObject({
      schema: expect.any(Object),
    });
    expect(result).toEqual({ kind: "mock-drizzle-client" });
  });
});
