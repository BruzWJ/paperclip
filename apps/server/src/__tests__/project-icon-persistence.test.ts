import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projects as projectsTable } from "@paperclipai/db";
import { projectService } from "../services/projects.js";
import { createMockDb } from "./helpers/mock-db.js";

type ProjectRow = typeof projectsTable.$inferSelect;

function projectRow(input: {
  companyId: string;
  name: string;
  icon?: string | null;
  color?: string | null;
}): ProjectRow {
  const now = new Date("2026-07-01T12:00:00.000Z");
  return {
    id: randomUUID(),
    companyId: input.companyId,
    name: input.name,
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: input.color ?? null,
    icon: input.icon ?? null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function projectPersistenceHarness(row: ProjectRow) {
  return createMockDb({
    // create: shortname check, goals, workspaces, managed-project binding.
    // getById: project, goals, workspaces, managed-project binding.
    select: [[], [], [], [], [row], [], [], []],
    insert: [[row]],
  });
}

describe("project icon persistence", () => {
  it.each([
    {
      title: "persists and round-trips a project icon on create",
      name: "Rocket",
      createInput: { icon: "rocket" },
      expected: { icon: "rocket", color: null },
    },
    {
      title: "defaults icon to null when none is provided",
      name: "Plain",
      createInput: {},
      expected: { icon: null, color: null },
    },
    {
      title: "defaults color to null when none is provided (no auto-assign)",
      name: "Gray",
      createInput: {},
      expected: { icon: null, color: null },
    },
    {
      title: "still persists an explicit color when one is supplied",
      name: "Blue",
      createInput: { color: "#3b82f6" },
      expected: { icon: null, color: "#3b82f6" },
    },
  ])("$title", async ({ name, createInput, expected }) => {
    const companyId = randomUUID();
    const row = projectRow({ companyId, name, ...createInput });
    const { db, calls, remaining } = projectPersistenceHarness(row);
    const projects = projectService(db);

    const created = await projects.create(companyId, { name, ...createInput });
    const fetched = await projects.getById(created.id);

    expect(created).toMatchObject(expected);
    expect(fetched).toMatchObject({ id: row.id, ...expected });

    const valuesCall = calls.find(
      (call) => call.operation === "insert" && call.method === "values",
    );
    expect(valuesCall?.args[0]).toMatchObject({
      companyId,
      name,
      ...createInput,
    });
    expect(remaining("select")).toBe(0);
    expect(remaining("insert")).toBe(0);
  });
});
