import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { artifactsApi, type CompanyArtifact } from "./artifacts";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const STACK_TASK_ID = "55555555-5555-4555-8555-555555555555";

function sampleArtifact(overrides: Partial<CompanyArtifact> = {}): CompanyArtifact {
  return {
    id: "wp-1",
    source: "work_product",
    mediaKind: "video",
    title: "Primary cut",
    previewText: null,
    contentType: "video/mp4",
    contentPath: "/files/wp-1.mp4",
    openPath: "/files/wp-1.mp4",
    downloadPath: "/files/wp-1.mp4?download=1",
    task: { id: TASK_ID, taskNumber: 10205, identifier: "PAP-10205", title: "Demo reel" },
    project: { id: PROJECT_ID, name: "Paperclip App" },
    createdByAgent: { id: AGENT_ID, name: "ClaudeCoder" },
    updatedAt: "2026-06-01T00:00:00.000Z",
    taskFragment: "work-product-wp-1",
    ...overrides,
  };
}

describe("artifactsApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue({ artifacts: [], nextCursor: null });
  });

  it("calls the company-scoped artifacts endpoint with no params", async () => {
    await artifactsApi.list(COMPANY_ID);
    expect(mockApi.get).toHaveBeenCalledWith(`/companies/${COMPANY_ID}/artifacts`);
  });

  it("omits the kind param when filtering by all", async () => {
    await artifactsApi.list(COMPANY_ID, { kind: "all" });
    expect(mockApi.get).toHaveBeenCalledWith(`/companies/${COMPANY_ID}/artifacts`);
  });

  it("serializes kind, project, search, and pagination params", async () => {
    await artifactsApi.list(COMPANY_ID, {
      kind: "video",
      projectId: PROJECT_ID,
      q: "demo reel",
      limit: 24,
      cursor: "abc",
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      `/companies/${COMPANY_ID}/artifacts?kind=video&projectId=${PROJECT_ID}&q=demo+reel&limit=24&cursor=abc`,
    );
  });

  it("omits groupBy when grouping is none", async () => {
    await artifactsApi.list(COMPANY_ID, { groupBy: "none" });
    expect(mockApi.get).toHaveBeenCalledWith(`/companies/${COMPANY_ID}/artifacts`);
  });

  it("serializes groupBy and the selected stack task", async () => {
    await artifactsApi.list(COMPANY_ID, {
      groupBy: "parent_task",
      groupTaskId: STACK_TASK_ID,
      kind: "image",
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      `/companies/${COMPANY_ID}/artifacts?kind=image&groupBy=parent_task&groupTaskId=${STACK_TASK_ID}`,
    );
  });

  it("preserves groups and selectedGroup from the envelope", async () => {
    const artifact = sampleArtifact();
    const group = {
      id: `task:${TASK_ID}`,
      groupBy: "task" as const,
      task: artifact.task,
      title: "Demo reel",
      count: 3,
      mediaKinds: ["video" as const],
      previewArtifacts: [artifact],
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    mockApi.get.mockResolvedValue({ artifacts: [], groups: [group], nextCursor: "next" });
    const result = await artifactsApi.list(COMPANY_ID, { groupBy: "task" });
    expect(result.groups).toEqual([group]);
    expect(result.nextCursor).toBe("next");
  });

  it("returns the envelope shape from the backend", async () => {
    const artifact = sampleArtifact();
    mockApi.get.mockResolvedValue({ artifacts: [artifact], nextCursor: "next" });
    const result = await artifactsApi.list(COMPANY_ID);
    expect(result).toEqual({ artifacts: [artifact], nextCursor: "next" });
  });
});
