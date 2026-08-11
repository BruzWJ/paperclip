import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock("./client", () => ({
  ApiError: class ApiError extends Error {},
  api: mockApi,
}));

import { agentsApi } from "./agents";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";

describe("agent company skill pins API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the dedicated company-scoped resource", async () => {
    mockApi.get.mockResolvedValue({
      entries: [{ key: "code-review", versionId: VERSION_ID }],
    });

    await agentsApi.companySkillPins("agent-name", "company-1");

    expect(mockApi.get).toHaveBeenCalledWith(
      "/agents/agent-name/company-skill-pins?companyId=company-1",
    );
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it("replaces pins with one PUT and never reconstructs an adapter revision", async () => {
    const entries = [
      { key: "code-review", versionId: VERSION_ID },
    ];
    mockApi.put.mockResolvedValue({ entries });

    await expect(
      agentsApi.replaceCompanySkillPins(
        "agent-name",
        entries,
        "company-1",
      ),
    ).resolves.toEqual({ entries });

    expect(mockApi.put).toHaveBeenCalledWith(
      "/agents/agent-name/company-skill-pins?companyId=company-1",
      { entries },
    );
    expect(mockApi.get).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

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
