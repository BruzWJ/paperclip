import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("./client", () => ({ api: mockApi }));

import { companiesApi } from "./companies";

describe("company session compaction API", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.patch.mockReset();
  });

  it("reads and patches the board-only company settings resource", async () => {
    await companiesApi.getSessionCompactionSettings("company-1");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/session-compaction-settings",
    );

    const settings = {
      auto: false,
      prune: true,
      reserved: 12_000,
      tail_turns: 3,
      preserve_recent_tokens: 6_000,
      modelRef: "anthropic/opus",
    };
    await companiesApi.updateSessionCompactionSettings(
      "company-1",
      settings,
    );
    expect(mockApi.patch).toHaveBeenCalledWith(
      "/companies/company-1/session-compaction-settings",
      settings,
    );
  });
});
