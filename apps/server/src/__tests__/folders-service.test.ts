import { describe, expect, it } from "vitest";
import { folderSlugSchema } from "@paperclipai/shared";
import { folderService, normalizeFolderSlug } from "../services/folders.js";
import { createMockDb } from "./helpers/mock-db.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const createdAt = new Date("2026-01-01T00:00:00.000Z");

function folderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    companyId,
    kind: "skill" as const,
    parentId: null,
    name: "Engineering",
    slug: "engineering",
    systemKey: null,
    color: null,
    position: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("folder service", () => {
  it("normalizes names and validates canonical folder slugs without persistence", () => {
    expect(normalizeFolderSlug("  Café / Code Review  ")).toBe("cafe-code-review");
    expect(folderSlugSchema.safeParse("../escape").success).toBe(false);
    expect(folderSlugSchema.safeParse("Valid Slug").success).toBe(false);
    expect(folderSlugSchema.safeParse("valid-slug-2").success).toBe(true);
  });

  it("builds nested paths and item counts from fixed query results", async () => {
    const root = folderRow();
    const child = folderRow({
      id: "00000000-0000-4000-8000-000000000011",
      parentId: root.id,
      name: "Code Review",
      slug: "code-review",
      position: 1,
    });
    const harness = createMockDb({
      select: [
        [root, child],
        [
          { folderId: root.id, count: 2 },
          { folderId: child.id, count: 1 },
          { folderId: null, count: 3 },
        ],
      ],
    });

    const result = await folderService(harness.db, true).list(companyId, "skill");

    expect(result).toMatchObject({ kind: "skill", allCount: 6, unfiledCount: 3 });
    expect(result.folders).toEqual([
      expect.objectContaining({ id: root.id, path: "engineering", depth: 1, itemCount: 2 }),
      expect.objectContaining({ id: child.id, path: "engineering/code-review", depth: 2, itemCount: 1 }),
    ]);
    expect(harness.remaining("select")).toBe(0);
  });

  it("creates a first-class folder from deterministic query results", async () => {
    const row = folderRow({ name: "Code Review", slug: "code-review" });
    const harness = createMockDb({
      select: [[], [{ value: -1 }], [row], [row]],
      insert: [[row]],
    });

    const created = await folderService(harness.db, true).create(companyId, {
      kind: "skill",
      name: "  Code Review  ",
    });

    expect(created).toMatchObject({
      id: row.id,
      name: "Code Review",
      slug: "code-review",
      path: "code-review",
      depth: 1,
    });
    expect(harness.calls.some((call) => call.operation === "insert" && call.method === "values")).toBe(true);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it.each(["bundled", "my", "projects"])(
    "rejects the reserved %s root before issuing a query",
    async (slug) => {
      const harness = createMockDb();

      await expect(folderService(harness.db, true).create(companyId, {
        kind: "skill",
        name: slug,
        slug,
      })).rejects.toMatchObject({
        status: 403,
        message: "Reserved skill folders are system-managed",
      });
      expect(harness.calls).toEqual([]);
    },
  );

  it("rejects moving an item into a folder of the wrong kind", async () => {
    const target = folderRow({ kind: "skill" });
    const harness = createMockDb({ select: [[target], [target]] });

    await expect(folderService(harness.db, true).moveItem(companyId, {
      kind: "routine",
      itemId: "00000000-0000-4000-8000-000000000020",
      folderId: target.id,
    })).rejects.toMatchObject({
      status: 422,
      message: "Folder kind must match item kind",
    });
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("protects system-managed folders from updates", async () => {
    const system = folderRow({ systemKey: "bundled:software-development" });
    const harness = createMockDb({ select: [[system], [system]] });

    await expect(folderService(harness.db, true).update(companyId, system.id, {
      name: "Changed",
    })).rejects.toMatchObject({ status: 403, message: "System-managed folders cannot be changed" });
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("rejects deleting a folder while it still has a child", async () => {
    const parent = folderRow({ kind: "routine" });
    const child = folderRow({
      id: "00000000-0000-4000-8000-000000000011",
      kind: "routine",
      parentId: parent.id,
      name: "Child",
      slug: "child",
    });
    const harness = createMockDb({
      select: [[parent], [parent, child], [parent], [parent, child], [{ id: child.id }]],
    });

    await expect(folderService(harness.db, true).deleteFolder(companyId, parent.id)).rejects.toMatchObject({
      status: 409,
      message: "Move or delete nested folders first",
    });
    expect(harness.calls.some((call) => call.operation === "delete")).toBe(false);
  });

  it("rejects moving a folder into its own subtree", async () => {
    const parent = folderRow({ kind: "routine" });
    const child = folderRow({
      id: "00000000-0000-4000-8000-000000000011",
      kind: "routine",
      parentId: parent.id,
      name: "Child",
      slug: "child",
    });
    const harness = createMockDb({
      select: [[parent], [parent, child], [parent], [parent, child], [parent, child]],
    });

    await expect(folderService(harness.db, true).moveFolder(companyId, parent.id, {
      parentId: child.id,
      position: 0,
    })).rejects.toMatchObject({
      status: 422,
      message: "A folder cannot be moved into its own subtree",
    });
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });
});
