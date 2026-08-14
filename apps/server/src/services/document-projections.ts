import { documents, taskDocuments } from "@paperclipai/db";
import { taskDocumentKeySchema, validationDetails } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";

export function parseDocumentKey(key: string) {
  const parsed = taskDocumentKeySchema.safeParse(key);
  if (!parsed.success) {
    throw unprocessable("Invalid document key", validationDetails(parsed.error));
  }
  return parsed.data;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505"
  );
}

export function nextAvailableDocumentKey(sourceKey: string, existingKeys: string[]) {
  const usedKeys = new Set(existingKeys);
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const baseMaxLength = 64 - suffix.length;
    const base = sourceKey.slice(0, baseMaxLength).replace(/[-_]+$/g, "") || "document";
    const candidate = `${base}${suffix}`;
    if (!usedKeys.has(candidate) && taskDocumentKeySchema.safeParse(candidate).success) {
      return candidate;
    }
  }
  throw conflict("Unable to choose a new document key for locked document", {
    key: sourceKey,
  });
}

export type TaskDocumentRow = {
  id: string;
  companyId: string;
  taskId: string;
  key: string;
  title: string | null;
  format: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  lockedAt: Date | null;
  lockedByAgentId: string | null;
  lockedByUserId: string | null;
  sourceTrust: typeof documents.$inferSelect.sourceTrust;
  createdAt: Date;
  updatedAt: Date;
};

export function mapTaskDocumentBase(row: TaskDocumentRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    taskId: row.taskId,
    key: row.key,
    title: row.title,
    format: row.format,
    latestRevisionId: row.latestRevisionId ?? null,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    lockedAt: row.lockedAt,
    lockedByAgentId: row.lockedByAgentId,
    lockedByUserId: row.lockedByUserId,
    sourceTrust: row.sourceTrust ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapTaskDocumentRow(
  row: TaskDocumentRow,
  includeBody: true,
): ReturnType<typeof mapTaskDocumentBase> & { body: string };

export function mapTaskDocumentRow(
  row: TaskDocumentRow,
  includeBody: false,
): ReturnType<typeof mapTaskDocumentBase>;

export function mapTaskDocumentRow(row: TaskDocumentRow, includeBody: boolean) {
  const document = mapTaskDocumentBase(row);
  return includeBody ? { ...document, body: row.latestBody } : document;
}

export const taskDocumentSelect = {
  id: documents.id,
  companyId: documents.companyId,
  taskId: taskDocuments.taskId,
  key: taskDocuments.key,
  title: documents.title,
  format: documents.format,
  latestBody: documents.latestBody,
  latestRevisionId: documents.latestRevisionId,
  latestRevisionNumber: documents.latestRevisionNumber,
  createdByAgentId: documents.createdByAgentId,
  createdByUserId: documents.createdByUserId,
  updatedByAgentId: documents.updatedByAgentId,
  updatedByUserId: documents.updatedByUserId,
  lockedAt: documents.lockedAt,
  lockedByAgentId: documents.lockedByAgentId,
  lockedByUserId: documents.lockedByUserId,
  sourceTrust: documents.sourceTrust,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};
