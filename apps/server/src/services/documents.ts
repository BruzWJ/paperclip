import {
  type Db,
  documentAnnotationComments,
  documentRevisions,
  documents,
  taskDocuments,
  tasks,
} from "@paperclipai/db";

import {
  buildDocumentsDocumentListFilter,
  createDocumentsContext,
  createDocumentsMutationMethods,
  type DocumentsContext,
} from "./document-mutations.js";

import { and, eq, asc, desc } from "drizzle-orm";
import { isCanonicalUuid } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import {
  mapTaskDocumentRow,
  parseDocumentKey,
  taskDocumentSelect,
  isUniqueViolation,
  nextAvailableDocumentKey,
} from "./document-projections.js";

export function createDocumentsReadMethods(
  scope: DocumentsContext & ReturnType<typeof buildDocumentsDocumentListFilter>,
) {
  const { db, filterSystemDocuments } = scope;

  return {
    getTaskDocumentPayload: async (task: { id: string }, options: { includeSystem?: boolean } = {}) => {
      const [planDocument, documentSummaries] = await Promise.all([
        db
          .select(taskDocumentSelect)
          .from(taskDocuments)
          .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
          .where(and(eq(taskDocuments.taskId, task.id), eq(taskDocuments.key, "plan")))
          .then((rows) => rows[0] ?? null),
        db
          .select(taskDocumentSelect)
          .from(taskDocuments)
          .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
          .where(eq(taskDocuments.taskId, task.id))
          .orderBy(asc(taskDocuments.key), desc(documents.updatedAt)),
      ]);

      return {
        planDocument: planDocument ? mapTaskDocumentRow(planDocument, true) : null,
        documentSummaries: filterSystemDocuments(documentSummaries, options.includeSystem ?? false).map(
          (row) => mapTaskDocumentRow(row, false),
        ),
      };
    },

    listTaskDocuments: async (taskId: string, options: { includeSystem?: boolean } = {}) => {
      const rows = await db
        .select(taskDocumentSelect)
        .from(taskDocuments)
        .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
        .where(eq(taskDocuments.taskId, taskId))
        .orderBy(asc(taskDocuments.key), desc(documents.updatedAt));
      return filterSystemDocuments(rows, options.includeSystem ?? false).map((row) =>
        mapTaskDocumentRow(row, true),
      );
    },

    getTaskDocumentByKey: async (taskId: string, rawKey: string) => {
      const key = parseDocumentKey(rawKey);
      const row = await db
        .select(taskDocumentSelect)
        .from(taskDocuments)
        .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
        .where(and(eq(taskDocuments.taskId, taskId), eq(taskDocuments.key, key)))
        .then((rows) => rows[0] ?? null);
      return row ? mapTaskDocumentRow(row, true) : null;
    },

    listTaskDocumentRevisions: async (taskId: string, rawKey: string) => {
      const key = parseDocumentKey(rawKey);
      return db
        .select({
          id: documentRevisions.id,
          companyId: documentRevisions.companyId,
          documentId: documentRevisions.documentId,
          taskId: taskDocuments.taskId,
          key: taskDocuments.key,
          revisionNumber: documentRevisions.revisionNumber,
          title: documentRevisions.title,
          format: documentRevisions.format,
          body: documentRevisions.body,
          changeSummary: documentRevisions.changeSummary,
          createdByAgentId: documentRevisions.createdByAgentId,
          createdByUserId: documentRevisions.createdByUserId,
          createdAt: documentRevisions.createdAt,
        })
        .from(taskDocuments)
        .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
        .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
        .where(and(eq(taskDocuments.taskId, taskId), eq(taskDocuments.key, key)))
        .orderBy(desc(documentRevisions.revisionNumber));
    },
  };
}

function createDocumentsUpsertMethod(
  scope: DocumentsContext & ReturnType<typeof buildDocumentsDocumentListFilter>,
) {
  const { db, taskReferences } = scope;

  return {
    upsertTaskDocument: async (input: {
      taskId: string;
      key: string;
      title?: string | null;
      format: string;
      body: string;
      changeSummary?: string | null;
      baseRevisionId?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      createdByRunId?: string | null;
      sourceTrust?: typeof documents.$inferInsert.sourceTrust;
      lockedDocumentStrategy?: "conflict" | "create_new_document";
    }) => {
      const key = parseDocumentKey(input.key);
      const task = await db
        .select({ id: tasks.id, companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");

      const maxAttempts = input.lockedDocumentStrategy === "create_new_document" ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          return await db.transaction(async (tx) => {
            const now = new Date();
            const createTaskDocumentAtKey = async (documentKey: string) => {
              const [document] = await tx
                .insert(documents)
                .values({
                  companyId: task.companyId,
                  title: input.title ?? null,
                  format: input.format,
                  latestBody: input.body,
                  latestRevisionId: null,
                  latestRevisionNumber: 1,
                  createdByAgentId: input.createdByAgentId ?? null,
                  createdByUserId: input.createdByUserId ?? null,
                  updatedByAgentId: input.createdByAgentId ?? null,
                  updatedByUserId: input.createdByUserId ?? null,
                  lockedAt: null,
                  lockedByAgentId: null,
                  lockedByUserId: null,
                  sourceTrust: input.sourceTrust ?? null,
                  createdAt: now,
                  updatedAt: now,
                })
                .returning();

              const [revision] = await tx
                .insert(documentRevisions)
                .values({
                  companyId: task.companyId,
                  documentId: document.id,
                  revisionNumber: 1,
                  title: input.title ?? null,
                  format: input.format,
                  body: input.body,
                  changeSummary: input.changeSummary ?? null,
                  createdByAgentId: input.createdByAgentId ?? null,
                  createdByUserId: input.createdByUserId ?? null,
                  createdByRunId: input.createdByRunId ?? null,
                  createdAt: now,
                })
                .returning();

              await tx
                .update(documents)
                .set({ latestRevisionId: revision.id })
                .where(eq(documents.id, document.id));

              await tx.insert(taskDocuments).values({
                companyId: task.companyId,
                taskId: task.id,
                documentId: document.id,
                key: documentKey,
                createdAt: now,
                updatedAt: now,
              });
              await taskReferences.syncDocument(document.id, tx);

              return mapTaskDocumentRow(
                {
                  ...document,
                  taskId: task.id,
                  key: documentKey,
                  latestRevisionId: revision.id,
                },
                true,
              );
            };

            const existing = await tx
              .select(taskDocumentSelect)
              .from(taskDocuments)
              .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
              .where(and(eq(taskDocuments.taskId, task.id), eq(taskDocuments.key, key)))
              .then((rows) => rows[0] ?? null);

            if (existing) {
              if (existing.lockedAt) {
                if (input.lockedDocumentStrategy === "create_new_document") {
                  const taskDocumentKeys = await tx
                    .select({ key: taskDocuments.key })
                    .from(taskDocuments)
                    .where(eq(taskDocuments.taskId, task.id));
                  const fallbackKey = nextAvailableDocumentKey(
                    key,
                    taskDocumentKeys.map((row) => row.key),
                  );

                  return {
                    created: true as const,
                    redirectedFromLockedDocument: {
                      id: existing.id,
                      key: existing.key,
                    },
                    document: await createTaskDocumentAtKey(fallbackKey),
                  };
                }

                throw conflict("Document is locked", {
                  key: existing.key,
                  documentId: existing.id,
                  lockedAt: existing.lockedAt,
                });
              }

              if (!input.baseRevisionId) {
                throw conflict("Document update requires baseRevisionId", {
                  currentRevisionId: existing.latestRevisionId,
                });
              }
              if (input.baseRevisionId !== existing.latestRevisionId) {
                throw conflict("Document was updated by someone else", {
                  currentRevisionId: existing.latestRevisionId,
                });
              }

              const nextRevisionNumber = existing.latestRevisionNumber + 1;
              const [revision] = await tx
                .insert(documentRevisions)
                .values({
                  companyId: task.companyId,
                  documentId: existing.id,
                  revisionNumber: nextRevisionNumber,
                  title: input.title ?? null,
                  format: input.format,
                  body: input.body,
                  changeSummary: input.changeSummary ?? null,
                  createdByAgentId: input.createdByAgentId ?? null,
                  createdByUserId: input.createdByUserId ?? null,
                  createdByRunId: input.createdByRunId ?? null,
                  createdAt: now,
                })
                .returning();

              await tx
                .update(documents)
                .set({
                  title: input.title ?? null,
                  format: input.format,
                  latestBody: input.body,
                  latestRevisionId: revision.id,
                  latestRevisionNumber: nextRevisionNumber,
                  updatedByAgentId: input.createdByAgentId ?? null,
                  updatedByUserId: input.createdByUserId ?? null,
                  sourceTrust: input.sourceTrust ?? null,
                  updatedAt: now,
                })
                .where(eq(documents.id, existing.id));

              await tx
                .update(taskDocuments)
                .set({ updatedAt: now })
                .where(eq(taskDocuments.documentId, existing.id));
              await taskReferences.syncDocument(existing.id, tx);

              return {
                created: false as const,
                document: {
                  ...existing,
                  title: input.title ?? null,
                  format: input.format,
                  body: input.body,
                  latestRevisionId: revision.id,
                  latestRevisionNumber: nextRevisionNumber,
                  updatedByAgentId: input.createdByAgentId ?? null,
                  updatedByUserId: input.createdByUserId ?? null,
                  lockedAt: existing.lockedAt,
                  lockedByAgentId: existing.lockedByAgentId,
                  lockedByUserId: existing.lockedByUserId,
                  sourceTrust: input.sourceTrust ?? null,
                  updatedAt: now,
                },
              };
            }

            if (input.baseRevisionId) {
              throw conflict("Document does not exist yet", { key });
            }

            return {
              created: true as const,
              document: await createTaskDocumentAtKey(key),
            };
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            if (input.lockedDocumentStrategy === "create_new_document" && attempt < maxAttempts - 1) {
              continue;
            }
            throw conflict("Document key already exists on this task", { key });
          }
          throw error;
        }
      }

      throw conflict("Unable to choose a new document key for locked document", { key });
    },
  };
}

export { mapTaskDocumentRow, taskDocumentSelect } from "./document-projections.js";

export function documentService(db: Db) {
  const context = createDocumentsContext(db);
  const helpers1 = buildDocumentsDocumentListFilter(context);
  const scope1 = { ...context, ...helpers1 };
  const scope = scope1;
  const methods1 = createDocumentsReadMethods(scope);
  const methods2 = createDocumentsUpsertMethod(scope);
  const methods3 = createDocumentsMutationMethods(scope);
  return { ...methods1, ...methods2, ...methods3 };
}
