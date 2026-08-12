import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  ApiError: class ApiError extends Error {},
  api: mockApi,
}));

import { agentsApi } from "./agents";

describe("invokable task-owner catalog API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the company-authorized presentation catalog", async () => {
    mockApi.get.mockResolvedValue([]);

    await agentsApi.listInvokableTaskOwners("company / one");

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company%20%2F%20one/task-owner-catalog",
    );
  });
});
