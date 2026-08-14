import { and, eq } from "drizzle-orm";
import {
  documentAnnotationComments,
  documentRevisions,
  documents,
  taskDocuments,
  type Db,
} from "@paperclipai/db";
import { isCanonicalUuid, isSystemTaskDocumentKey } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { mapTaskDocumentRow, parseDocumentKey, taskDocumentSelect } from "./document-projections.js";
import { taskReferenceService } from "./task-references.js";

export function createDocumentsContext(db: Db) {
  const taskReferences = taskReferenceService(db);
  return { db, taskReferences };
}

export type DocumentsContext = ReturnType<typeof createDocumentsContext>;

export function buildDocumentsDocumentListFilter(scope: DocumentsContext) {
  const filterSystemDocuments = <T extends { key: string }>(rows: T[], includeSystem: boolean) =>
    includeSystem ? rows : rows.filter((row) => !isSystemTaskDocumentKey(row.key));

  return { filterSystemDocuments };
}

export function createDocumentsMutationMethods(
  scope: DocumentsContext & ReturnType<typeof buildDocumentsDocumentListFilter>,
) {
  const { db, taskReferences } = scope;

  return {
    restoreTaskDocumentRevision: async (input: {
      taskId: string;
      key: string;
      revisionId: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      if (!isCanonicalUuid(input.revisionId)) {
        throw notFound("Document revision not found");
      }
      const key = parseDocumentKey(input.key);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(taskDocumentSelect)
          .from(taskDocuments)
          .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
          .where(and(eq(taskDocuments.taskId, input.taskId), eq(taskDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) throw notFound("Document not found");
        if (existing.lockedAt) {
          throw conflict("Document is locked", {
            key: existing.key,
            documentId: existing.id,
            lockedAt: existing.lockedAt,
          });
        }

        const revision = await tx
          .select({
            id: documentRevisions.id,
            companyId: documentRevisions.companyId,
            documentId: documentRevisions.documentId,
            revisionNumber: documentRevisions.revisionNumber,
            title: documentRevisions.title,
            format: documentRevisions.format,
            body: documentRevisions.body,
          })
          .from(documentRevisions)
          .where(
            and(eq(documentRevisions.id, input.revisionId), eq(documentRevisions.documentId, existing.id)),
          )
          .then((rows) => rows[0] ?? null);

        if (!revision) throw notFound("Document revision not found");
        if (existing.latestRevisionId === revision.id) {
          throw conflict("Selected revision is already the latest revision", {
            currentRevisionId: existing.latestRevisionId,
          });
        }

        const now = new Date();
        const nextRevisionNumber = existing.latestRevisionNumber + 1;
        const [restoredRevision] = await tx
          .insert(documentRevisions)
          .values({
            companyId: existing.companyId,
            documentId: existing.id,
            revisionNumber: nextRevisionNumber,
            title: revision.title ?? null,
            format: revision.format,
            body: revision.body,
            changeSummary: `Restored from revision ${revision.revisionNumber}`,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdAt: now,
          })
          .returning();

        await tx
          .update(documents)
          .set({
            title: revision.title ?? null,
            format: revision.format,
            latestBody: revision.body,
            latestRevisionId: restoredRevision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        await tx
          .update(taskDocuments)
          .set({ updatedAt: now })
          .where(eq(taskDocuments.documentId, existing.id));
        await taskReferences.syncDocument(existing.id, tx);

        return {
          restoredFromRevisionId: revision.id,
          restoredFromRevisionNumber: revision.revisionNumber,
          document: {
            ...existing,
            title: revision.title ?? null,
            format: revision.format,
            body: revision.body,
            latestRevisionId: restoredRevision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            updatedAt: now,
          },
        };
      });
    },

    lockTaskDocument: async (input: {
      taskId: string;
      key: string;
      lockedByAgentId?: string | null;
      lockedByUserId?: string | null;
    }) => {
      const key = parseDocumentKey(input.key);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(taskDocumentSelect)
          .from(taskDocuments)
          .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
          .where(and(eq(taskDocuments.taskId, input.taskId), eq(taskDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) throw notFound("Document not found");
        if (existing.lockedAt) {
          return {
            changed: false as const,
            document: mapTaskDocumentRow(existing, true),
          };
        }

        const now = new Date();
        await tx
          .update(documents)
          .set({
            lockedAt: now,
            lockedByAgentId: input.lockedByAgentId ?? null,
            lockedByUserId: input.lockedByUserId ?? null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        await tx
          .update(taskDocuments)
          .set({ updatedAt: now })
          .where(eq(taskDocuments.documentId, existing.id));

        return {
          changed: true as const,
          document: {
            ...mapTaskDocumentRow(existing, true),
            lockedAt: now,
            lockedByAgentId: input.lockedByAgentId ?? null,
            lockedByUserId: input.lockedByUserId ?? null,
            updatedAt: now,
          },
        };
      });
    },

    unlockTaskDocument: async (taskId: string, rawKey: string) => {
      const key = parseDocumentKey(rawKey);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(taskDocumentSelect)
          .from(taskDocuments)
          .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
          .where(and(eq(taskDocuments.taskId, taskId), eq(taskDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) throw notFound("Document not found");
        if (!existing.lockedAt) {
          return {
            changed: false as const,
            document: mapTaskDocumentRow(existing, true),
          };
        }

        const now = new Date();
        await tx
          .update(documents)
          .set({
            lockedAt: null,
            lockedByAgentId: null,
            lockedByUserId: null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        await tx
          .update(taskDocuments)
          .set({ updatedAt: now })
          .where(eq(taskDocuments.documentId, existing.id));

        return {
          changed: true as const,
          document: {
            ...mapTaskDocumentRow(existing, true),
            lockedAt: null,
            lockedByAgentId: null,
            lockedByUserId: null,
            updatedAt: now,
          },
        };
      });
    },

    deleteTaskDocument: async (taskId: string, rawKey: string) => {
      const key = parseDocumentKey(rawKey);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(taskDocumentSelect)
          .from(taskDocuments)
          .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
          .where(and(eq(taskDocuments.taskId, taskId), eq(taskDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) return null;
        if (existing.lockedAt) {
          throw conflict("Document is locked", {
            key: existing.key,
            documentId: existing.id,
            lockedAt: existing.lockedAt,
          });
        }

        const annotationCommentIds = await tx
          .select({ id: documentAnnotationComments.id })
          .from(documentAnnotationComments)
          .where(eq(documentAnnotationComments.documentId, existing.id));
        for (const annotationComment of annotationCommentIds) {
          await taskReferences.deleteCommentSource(annotationComment.id, tx);
        }
        await taskReferences.deleteDocumentSource(existing.id, tx);
        await tx.delete(taskDocuments).where(eq(taskDocuments.documentId, existing.id));
        await tx.delete(documents).where(eq(documents.id, existing.id));

        return {
          ...existing,
          body: existing.latestBody,
          latestRevisionId: existing.latestRevisionId ?? null,
        };
      });
    },
  };
}
