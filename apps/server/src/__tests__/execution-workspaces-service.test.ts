import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reserveIssueExecutionWorkspaceBinding,
  IssueExecutionWorkspaceReservationRejected,
} from "../services/execution-workspaces.js";
import { createMockDb } from "./helpers/mock-db.js";

const mkdirMock = vi.hoisted(() => vi.fn());
const createIssueSessionRootMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { mkdir: mkdirMock },
}));

vi.mock("../services/issue-session-root-postgres.js", () => ({
  createIssueSessionRootInTx: createIssueSessionRootMock,
}));

const now = new Date("2026-08-09T00:00:00.000Z");

function reservationIssue(projectWorkspaceId: string | null) {
  return {
    id: "issue-1",
    companyId: "company-1",
    parentId: null,
    projectId: "project-1",
    projectWorkspaceId,
    title: "Run in the project codebase",
    identifier: "PAP-1",
    ownershipEpoch: 1,
    ownerAgentId: "agent-1",
  };
}

function projectCodebase(id: string, cwd: string) {
  return {
    id,
    companyId: "company-1",
    projectId: "project-1",
    cwd,
    repoUrl: `https://github.com/acme/${id}.git`,
  };
}

function executionWorkspaceRow(projectWorkspaceId: string, cwd: string) {
  return {
    id: `execution-${projectWorkspaceId}`,
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId,
    cwd,
    repoUrl: `https://github.com/acme/${projectWorkspaceId}.git`,
    branchName: null,
    lastUsedAt: now,
    createdAt: now,
  };
}

function bindingRow(projectWorkspaceId: string, cwd: string) {
  return {
    id: `binding-${projectWorkspaceId}`,
    companyId: "company-1",
    issueId: "issue-1",
    sessionId: "session-1",
    ownershipEpoch: 1,
    executionWorkspaceId: `execution-${projectWorkspaceId}`,
    absoluteCwd: cwd,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mkdirMock.mockResolvedValue(undefined);
  createIssueSessionRootMock.mockImplementation(async (_tx, input) => ({
    session: {
      id: input.id,
      companyId: input.companyId,
      issueId: input.issueId,
      parentSessionId: input.parentSessionId,
      directory: input.directory,
    },
    contextEpoch: { generation: 1 },
  }));
});

describe("shared local execution workspace reservation", () => {
  it("binds the project codebase as the agent's exact cwd", async () => {
    const selected = projectCodebase("codebase-1", "/repo/project");
    const workspace = executionWorkspaceRow(selected.id, selected.cwd);
    const binding = bindingRow(selected.id, selected.cwd);
    const harness = createMockDb({
      execute: [[], []],
      select: [[], [{ id: "project-1" }], [selected], [], []],
      insert: [[workspace], [binding]],
    });

    const result = await reserveIssueExecutionWorkspaceBinding(harness.db, {
      issue: reservationIssue(selected.id),
      session: { id: "session-1", now },
      provenance: { userId: "board-user" },
    });

    expect(result).toMatchObject({
      projectWorkspaceId: selected.id,
      contextEpochGeneration: 1,
      moved: false,
      binding: { absoluteCwd: "/repo/project" },
    });
    expect(mkdirMock).toHaveBeenCalledWith("/repo/project", {
      recursive: true,
    });
    expect(createIssueSessionRootMock).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({ directory: "/repo/project" }),
    );

    const insertedValues = harness.calls
      .filter((call) => call.operation === "insert" && call.method === "values")
      .map((call) => call.args[0]);
    expect(insertedValues[0]).toMatchObject({
      projectWorkspaceId: selected.id,
      cwd: "/repo/project",
      branchName: null,
    });
    expect(insertedValues[0]).not.toHaveProperty("mode");
    expect(insertedValues[0]).not.toHaveProperty("providerRef");
    expect(insertedValues[1]).toMatchObject({
      absoluteCwd: "/repo/project",
    });
  });

  it("uses the project's only codebase when the issue selector is omitted", async () => {
    const selected = projectCodebase("codebase-1", "/repo/project");
    const workspace = executionWorkspaceRow(selected.id, selected.cwd);
    const binding = bindingRow(selected.id, selected.cwd);
    const harness = createMockDb({
      execute: [[], []],
      select: [[], [{ id: "project-1" }], [selected], [], []],
      insert: [[workspace], [binding]],
    });

    const result = await reserveIssueExecutionWorkspaceBinding(harness.db, {
      issue: reservationIssue(null),
      session: { id: "session-1", now },
    });

    expect(result.projectWorkspaceId).toBe(selected.id);
    expect(result.binding.absoluteCwd).toBe("/repo/project");
  });

  it("rejects a codebase outside the issue project", async () => {
    const harness = createMockDb({
      execute: [[]],
      select: [[], [{ id: "project-1" }], []],
    });

    await expect(
      reserveIssueExecutionWorkspaceBinding(harness.db, {
        issue: reservationIssue("codebase-from-another-project"),
        session: { id: "session-1", now },
      }),
    ).rejects.toMatchObject<
      Partial<IssueExecutionWorkspaceReservationRejected>
    >({ reason: "project_workspace_invalid" });
  });
});
