import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { userProfilesApi } from "./userProfiles";
import { queryKeys } from "../lib/queryKeys";

describe("user profiles API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("addresses a profile by the exact stored user ID", async () => {
    mockApi.get.mockResolvedValue({});

    await userProfilesApi.get(
      "11111111-1111-4111-8111-111111111111",
      "User ID / 42",
    );

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/11111111-1111-4111-8111-111111111111/users/User%20ID%20%2F%2042/profile",
    );
    expect(
      queryKeys.userProfile(
        "11111111-1111-4111-8111-111111111111",
        "User ID / 42",
      ),
    ).toEqual([
      "user-profile",
      "11111111-1111-4111-8111-111111111111",
      "User ID / 42",
    ]);
  });
});
