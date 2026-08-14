import { and, asc, eq, max, sql } from "drizzle-orm";
import { type Db, folders, routines } from "@paperclipai/db";
import {
  type CreateFolder,
  type Folder,
  type FolderKind,
  type FolderListResult,
  type MoveFolder,
  type MoveFolderItem,
  type UpdateFolder,
  isCanonicalUuid,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

const MAX_FOLDER_DEPTH = 4;

type FolderRow = typeof folders.$inferSelect;

function isPostgresError(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function normalizeFolderSlug(value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return slug || "folder";
}

function buildFolderViews(rows: FolderRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const views = new Map<string, Folder>();
  const visiting = new Set<string>();

  function resolve(row: FolderRow): Folder {
    const existing = views.get(row.id);
    if (existing) return existing;
    if (visiting.has(row.id)) throw unprocessable("Folder hierarchy contains a cycle");
    visiting.add(row.id);
    const parent = row.parentId ? byId.get(row.parentId) : null;
    if (row.parentId && !parent) throw unprocessable("Folder hierarchy contains an invalid parent");
    const parentView = parent ? resolve(parent) : null;
    const view: Folder = {
      ...row,
      parentId: row.parentId ?? null,
      systemKey: row.systemKey ?? null,
      color: row.color ?? null,
      path: parentView ? `${parentView.path}/${row.slug}` : row.slug,
      depth: (parentView?.depth ?? 0) + 1,
    };
    visiting.delete(row.id);
    views.set(row.id, view);
    return view;
  }

  for (const row of rows) resolve(row);
  return views;
}

export function folderService(db: Db, mutationLockHeld = false) {
  async function withCompanyFolderLock<T>(companyId: string, operation: (lockedDb: Db) => Promise<T>) {
    if (mutationLockHeld) return operation(db);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:folders:${companyId}`}, 0))`,
      );
      return operation(tx as unknown as Db);
    });
  }

  async function getRows(companyId: string, kind: FolderKind) {
    return db
      .select()
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.kind, kind)))
      .orderBy(asc(folders.position), asc(folders.name), asc(folders.id));
  }

  async function getFolderRow(companyId: string, folderId: string) {
    if (!isCanonicalUuid(companyId) || !isCanonicalUuid(folderId)) return null;
    return db
      .select()
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getFolder(companyId: string, folderId: string) {
    const row = await getFolderRow(companyId, folderId);
    if (!row) return null;
    const views = buildFolderViews(await getRows(companyId, row.kind));
    return views.get(row.id) ?? null;
  }

  async function assertNoSlugConflict(
    companyId: string,
    kind: FolderKind,
    parentId: string | null,
    slug: string,
    excludeFolderId?: string,
  ) {
    const existing = await db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.companyId, companyId),
          eq(folders.kind, kind),
          parentId === null ? sql`${folders.parentId} is null` : eq(folders.parentId, parentId),
          eq(folders.slug, slug),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing && existing.id !== excludeFolderId) {
      throw conflict("Folder slug already exists under this parent");
    }
  }

  async function nextPosition(companyId: string, kind: FolderKind, parentId: string | null) {
    const row = await db
      .select({ value: max(folders.position) })
      .from(folders)
      .where(
        and(
          eq(folders.companyId, companyId),
          eq(folders.kind, kind),
          parentId === null ? sql`${folders.parentId} is null` : eq(folders.parentId, parentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Number(row?.value ?? -1) + 1;
  }

  async function routineCounts(companyId: string) {
    return db
      .select({
        folderId: routines.folderId,
        count: sql<number>`count(*)::int`,
      })
      .from(routines)
      .where(eq(routines.companyId, companyId))
      .groupBy(routines.folderId);
  }

  async function list(companyId: string, kind: FolderKind): Promise<FolderListResult> {
    const [folderRows, countRows] = await Promise.all([getRows(companyId, kind), routineCounts(companyId)]);
    const views = buildFolderViews(folderRows);
    const countsByFolderId = new Map<string | null, number>();
    for (const row of countRows) countsByFolderId.set(row.folderId ?? null, Number(row.count ?? 0));
    return {
      kind,
      folders: folderRows.map((row) => ({
        ...views.get(row.id)!,
        itemCount: countsByFolderId.get(row.id) ?? 0,
      })),
      allCount: Array.from(countsByFolderId.values()).reduce((sum, count) => sum + count, 0),
      unfiledCount: countsByFolderId.get(null) ?? 0,
    };
  }

  function assertMutableFolder(folder: Folder) {
    if (folder.systemKey) {
      throw forbidden("System-managed folders cannot be changed");
    }
  }

  async function validateParent(companyId: string, kind: FolderKind, parentId: string | null) {
    if (!parentId) return null;
    const parent = await getFolder(companyId, parentId);
    if (!parent || parent.kind !== kind) throw notFound("Parent folder not found");
    if (parent.systemKey) throw forbidden("System-managed folders are read-only");
    return parent;
  }

  async function create(companyId: string, input: CreateFolder): Promise<Folder> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) =>
        folderService(lockedDb, true).create(companyId, input),
      );
    }
    const parentId = input.parentId ?? null;
    const parent = await validateParent(companyId, input.kind, parentId);
    if ((parent?.depth ?? 0) + 1 > MAX_FOLDER_DEPTH) {
      throw unprocessable(`Folder depth cannot exceed ${MAX_FOLDER_DEPTH}`);
    }
    const name = input.name;
    const slug = input.slug ?? normalizeFolderSlug(name);
    await assertNoSlugConflict(companyId, input.kind, parentId, slug);
    const position = input.position ?? (await nextPosition(companyId, input.kind, parentId));
    let row: FolderRow;
    try {
      row = await db
        .insert(folders)
        .values({
          companyId,
          kind: input.kind,
          parentId,
          name,
          slug,
          color: input.color ?? null,
          position,
        })
        .returning()
        .then((rows) => rows[0]!);
    } catch (error) {
      if (isPostgresError(error, "23505")) throw conflict("Folder slug already exists under this parent");
      throw error;
    }
    return (await getFolder(companyId, row.id))!;
  }

  async function update(companyId: string, folderId: string, patch: UpdateFolder): Promise<Folder | null> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) =>
        folderService(lockedDb, true).update(companyId, folderId, patch),
      );
    }
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    assertMutableFolder(existing);
    const name = patch.name ?? existing.name;
    const slug = patch.slug ?? (patch.name === undefined ? existing.slug : normalizeFolderSlug(name));
    await assertNoSlugConflict(companyId, existing.kind, existing.parentId, slug, existing.id);
    try {
      await db
        .update(folders)
        .set({
          name,
          slug,
          color: patch.color === undefined ? existing.color : patch.color,
          position: patch.position ?? existing.position,
          updatedAt: new Date(),
        })
        .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)));
    } catch (error) {
      if (isPostgresError(error, "23505")) throw conflict("Folder slug already exists under this parent");
      throw error;
    }
    return getFolder(companyId, folderId);
  }

  function descendantIdsFromRows(rows: FolderRow[], folderId: string) {
    if (!rows.some((row) => row.id === folderId)) throw notFound("Folder not found");
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.parentId) continue;
      children.set(row.parentId, [...(children.get(row.parentId) ?? []), row.id]);
    }
    const result = new Set([folderId]);
    const queue = [folderId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const childId of children.get(current) ?? []) {
        if (result.has(childId)) throw unprocessable("Folder hierarchy contains a cycle");
        result.add(childId);
        queue.push(childId);
      }
    }
    return result;
  }

  async function moveFolder(companyId: string, folderId: string, input: MoveFolder): Promise<Folder | null> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) =>
        folderService(lockedDb, true).moveFolder(companyId, folderId, input),
      );
    }
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    assertMutableFolder(existing);
    const parentId = input.parentId === undefined ? existing.parentId : input.parentId;
    if (parentId === existing.id) throw unprocessable("A folder cannot be its own parent");
    const rows = await getRows(companyId, existing.kind);
    const descendants = descendantIdsFromRows(rows, existing.id);
    if (parentId && descendants.has(parentId))
      throw unprocessable("A folder cannot be moved into its own subtree");
    const parent = await validateParent(companyId, existing.kind, parentId);
    const views = buildFolderViews(rows);
    const relativeDepth = Math.max(
      ...Array.from(descendants).map((id) => views.get(id)!.depth - existing.depth + 1),
    );
    if ((parent?.depth ?? 0) + relativeDepth > MAX_FOLDER_DEPTH) {
      throw unprocessable(`Folder depth cannot exceed ${MAX_FOLDER_DEPTH}`);
    }
    await assertNoSlugConflict(companyId, existing.kind, parentId, existing.slug, existing.id);
    try {
      await db
        .update(folders)
        .set({ parentId, position: input.position, updatedAt: new Date() })
        .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)));
    } catch (error) {
      if (isPostgresError(error, "23505")) throw conflict("Folder slug already exists under this parent");
      if (isPostgresError(error, "23503")) throw conflict("Parent folder changed during move");
      throw error;
    }
    return getFolder(companyId, folderId);
  }

  async function deleteFolder(companyId: string, folderId: string): Promise<Folder | null> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) =>
        folderService(lockedDb, true).deleteFolder(companyId, folderId),
      );
    }
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    assertMutableFolder(existing);
    const child = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.parentId, folderId)))
      .then((rows) => rows[0] ?? null);
    if (child) throw conflict("Move or delete nested folders first");
    try {
      await db.delete(folders).where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)));
    } catch (error) {
      if (isPostgresError(error, "23503")) throw conflict("Move or delete nested folders first");
      throw error;
    }
    return existing;
  }

  async function moveItem(companyId: string, input: MoveFolderItem) {
    if (input.folderId) {
      const target = await getFolder(companyId, input.folderId);
      if (!target) throw notFound("Folder not found");
      if (target.kind !== input.kind) throw unprocessable("Folder kind must match item kind");
      if (target.systemKey) throw forbidden("System-managed folders are read-only");
    }
    const row = await db
      .update(routines)
      .set({ folderId: input.folderId ?? null, updatedAt: new Date() })
      .where(and(eq(routines.companyId, companyId), eq(routines.id, input.itemId)))
      .returning({ id: routines.id, folderId: routines.folderId })
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Routine not found");
    return { kind: input.kind, itemId: row.id, folderId: row.folderId ?? null };
  }
  return {
    list,
    create,
    update,
    moveFolder,
    deleteFolder,
    moveItem,
    getFolder,
  };
}
