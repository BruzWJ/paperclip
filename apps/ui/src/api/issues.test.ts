import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { issuesApi } from "./issues";

describe("issuesApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.patch.mockReset();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue({});
    mockApi.patch.mockResolvedValue({});
  });

  it("passes parentId through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { parentId: "issue-parent-1", limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?parentId=issue-parent-1&limit=25",
    );
  });

  it("passes descendantOf through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { descendantOf: "issue-root-1", includeBlockedBy: true, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?descendantOf=issue-root-1&includeBlockedBy=true&limit=25",
    );
  });

  it("passes generic workspaceId filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { workspaceId: "workspace-1", limit: 1000 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?workspaceId=workspace-1&limit=1000",
    );
  });

  it("passes pagination offsets through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { limit: 500, offset: 1500 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?limit=500&offset=1500",
    );
  });

  it("passes issue list sort options through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      limit: 500,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?limit=500&sortField=updated&sortDir=desc",
    );
  });

  it("requests the compact issue list view explicitly", async () => {
    await issuesApi.listCompact("company-1", {
      touchedByUserId: "me",
      includeLiveDescendantSummary: true,
      limit: 100,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?touchedByUserId=me&includeLiveDescendantSummary=true&limit=100&sortField=updated&sortDir=desc&view=compact",
    );
  });

  it("passes plan document filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { hasPlanDocument: false, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?hasPlanDocument=false&limit=25",
    );
  });

  it("passes live descendant summary opt-in through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { includeLiveDescendantSummary: true, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?includeLiveDescendantSummary=true&limit=25",
    );
  });

  it("uses only the canonical board mutation and typed comment endpoints", async () => {
    await issuesApi.updateTitle("issue-1", { title: "New title" });
    await issuesApi.reassign("issue-1", {
      ownerAgentId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "reassign-once",
    });
    await issuesApi.reopen("issue-1", {
      reason: "New evidence changed the outcome.",
      idempotencyKey: "reopen-once",
    });
    await issuesApi.addComment("issue-1", {
      message: "Please review this.",
      idempotencyKey: "comment-once",
      mention: {
        targetAgentId: "11111111-1111-4111-8111-111111111111",
        ownershipEpoch: 4,
      },
    });

    expect(mockApi.patch).toHaveBeenCalledWith(
      "/issues/issue-1",
      { title: "New title" },
    );
    expect(mockApi.post).toHaveBeenNthCalledWith(
      1,
      "/issues/issue-1/reassign",
      {
        ownerAgentId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: "reassign-once",
      },
    );
    expect(mockApi.post).toHaveBeenNthCalledWith(
      2,
      "/issues/issue-1/reopen",
      {
        reason: "New evidence changed the outcome.",
        idempotencyKey: "reopen-once",
      },
    );
    expect(mockApi.post).toHaveBeenNthCalledWith(
      3,
      "/issues/issue-1/comments",
      {
        message: "Please review this.",
        idempotencyKey: "comment-once",
        mention: {
          targetAgentId: "11111111-1111-4111-8111-111111111111",
          ownershipEpoch: 4,
        },
      },
    );
  });

  it("uses dedicated creator, owner, and withdrawal form endpoints", async () => {
    const ownerAgentId =
      "11111111-1111-4111-8111-111111111111";
    await issuesApi.creatorReassign("issue-1", {
      ownerAgentId,
      idempotencyKey: "creator-reassign-once",
    });
    await issuesApi.commitCreatorFormUpdate({
      issueId: "22222222-2222-4222-8222-222222222222",
      message: "Creator follow-up",
    });
    await issuesApi.selfAssignForWithdrawal("issue-1", {
      idempotencyKey: "withdraw-once",
    });
    await issuesApi.commitOwnerFormUpdate({
      issueId: "22222222-2222-4222-8222-222222222222",
      message: "Cancel after withdrawal",
      status: "cancelled",
    });

    expect(mockApi.post).toHaveBeenNthCalledWith(
      1,
      "/issues/issue-1/creator-reassign",
      {
        ownerAgentId,
        idempotencyKey: "creator-reassign-once",
      },
    );
    expect(mockApi.post).toHaveBeenNthCalledWith(
      2,
      "/issue-creator-form-updates",
      {
        issueId: "22222222-2222-4222-8222-222222222222",
        message: "Creator follow-up",
      },
    );
    expect(mockApi.post).toHaveBeenNthCalledWith(
      3,
      "/issues/issue-1/withdrawal-self-assignment",
      { idempotencyKey: "withdraw-once" },
    );
    expect(mockApi.post).toHaveBeenNthCalledWith(
      4,
      "/issue-owner-form-updates",
      {
        issueId: "22222222-2222-4222-8222-222222222222",
        message: "Cancel after withdrawal",
        status: "cancelled",
      },
    );
  });
});
