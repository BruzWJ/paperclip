import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runsApi } from "./runs";
import { tasksApi } from "./tasks";

const fetchMock = vi.fn();
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse([]));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("list filter wire format", () => {
  it("serializes task statuses as repeated query keys", async () => {
    await tasksApi.list(COMPANY_ID, { status: ["todo", "in_progress"] });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/companies/${COMPANY_ID}/tasks?status=todo&status=in_progress`,
    );
  });

  it("serializes run statuses as repeated query keys", async () => {
    await runsApi.listForCompany(COMPANY_ID, { status: ["queued", "running"] });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/companies/${COMPANY_ID}/runs?status=queued&status=running`,
    );
  });
});
