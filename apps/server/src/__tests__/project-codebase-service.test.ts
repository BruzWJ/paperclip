import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectService } from "../services/projects.js";
import { createMockDb } from "./helpers/mock-db.js";

describe("project codebase service", () => {
  it.each([
    {
      cwd: "/srv/acme/project ",
      repoUrl: "https://github.com/acme/project.git",
    },
    {
      cwd: "/srv/acme/project",
      repoUrl: "https://GitHub.com/acme/project.git",
    },
  ])(
    "rejects invalid explicit values instead of rewriting them",
    async (input) => {
      const projectId = randomUUID();
      const companyId = randomUUID();
      const { db, calls } = createMockDb({
        select: [[{ id: projectId, companyId }]],
      });

      const created = await projectService(db).createWorkspace(
        projectId,
        input,
      );

      expect(created).toBeNull();
      expect(calls.some((call) => call.operation === "insert")).toBe(false);
    },
  );

  it("rejects a noncanonical update without changing the retained workspace", async () => {
    const projectId = randomUUID();
    const companyId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date("2026-08-12T00:00:00.000Z");
    const { db, calls } = createMockDb({
      select: [
        [
          {
            id: workspaceId,
            companyId,
            projectId,
            cwd: "/srv/acme/project",
            repoUrl: "https://github.com/acme/project.git",
            createdAt: now,
            updatedAt: now,
          },
        ],
      ],
    });

    const updated = await projectService(db).updateWorkspace(
      projectId,
      workspaceId,
      { repoUrl: "https://github.com:443/acme/project.git" },
    );

    expect(updated).toBeNull();
    expect(calls.some((call) => call.operation === "update")).toBe(false);
  });
});
