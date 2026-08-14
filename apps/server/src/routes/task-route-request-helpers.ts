import {
  type Db,
  documents,
  taskComments,
  taskDocuments,
  tasks as taskRows,
  taskWorkProducts,
} from "@paperclipai/db";
import {
  isCanonicalUuid,
  taskDocumentKeySchema,
  validationDetails,
  type SourceTrustMetadata,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { type Request, type Response } from "express";
import { unprocessable } from "../errors.js";
import { LOW_TRUST_TASK_ANCESTRY_MAX_DEPTH } from "../services/trust-preset-resolver.js";
import { assertBoard } from "./authz.js";

type TaskRequestHelperDependencies = { db: Db };

export function createTaskRequestHelpers(context: TaskRequestHelperDependencies) {
  const { db } = context;

  async function lookupLowTrustSourceArtifact(input: {
    taskId: string;
    artifactKind: "comment" | "document" | "work_product" | "task";
    artifactId: string;
  }): Promise<SourceTrustMetadata | null> {
    if (input.artifactKind === "task") {
      const row = await db
        .select({
          id: taskRows.id,
          companyId: taskRows.companyId,
          parentId: taskRows.parentId,
          sourceTrust: taskRows.sourceTrust,
        })
        .from(taskRows)
        .where(eq(taskRows.id, input.artifactId))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const sourceTask = await db
        .select({ companyId: taskRows.companyId })
        .from(taskRows)
        .where(eq(taskRows.id, input.taskId))
        .then((rows) => rows[0] ?? null);
      if (!sourceTask || row.companyId !== sourceTask.companyId) return null;
      if (row.id !== input.taskId) {
        let cursor = row.parentId;
        let isDescendant = false;
        for (let depth = 0; cursor && depth < LOW_TRUST_TASK_ANCESTRY_MAX_DEPTH; depth += 1) {
          if (cursor === input.taskId) {
            isDescendant = true;
            break;
          }
          const parent = await db
            .select({
              id: taskRows.id,
              companyId: taskRows.companyId,
              parentId: taskRows.parentId,
            })
            .from(taskRows)
            .where(eq(taskRows.id, cursor))
            .then((rows) => rows[0] ?? null);
          if (!parent || parent.companyId !== row.companyId) return null;
          cursor = parent.parentId;
        }
        if (!isDescendant) return null;
      }
      return row?.sourceTrust ?? null;
    }

    if (input.artifactKind === "comment") {
      const row = await db
        .select({ sourceTrust: taskComments.sourceTrust })
        .from(taskComments)
        .where(and(eq(taskComments.id, input.artifactId), eq(taskComments.taskId, input.taskId)))
        .then((rows) => rows[0] ?? null);
      return row?.sourceTrust ?? null;
    }

    if (input.artifactKind === "document") {
      const row = await db
        .select({ sourceTrust: documents.sourceTrust })
        .from(taskDocuments)
        .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
        .where(and(eq(documents.id, input.artifactId), eq(taskDocuments.taskId, input.taskId)))
        .then((rows) => rows[0] ?? null);
      return row?.sourceTrust ?? null;
    }

    const row = await db
      .select({ sourceTrust: taskWorkProducts.sourceTrust })
      .from(taskWorkProducts)
      .where(and(eq(taskWorkProducts.id, input.artifactId), eq(taskWorkProducts.taskId, input.taskId)))
      .then((rows) => rows[0] ?? null);
    return row?.sourceTrust ?? null;
  }

  function withContentPath<T extends { id: string }>(attachment: T) {
    const contentPath = `/api/attachments/${attachment.id}/content`;
    return {
      ...attachment,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
    };
  }

  type ParsedAttachmentRange =
    { kind: "none" } | { kind: "invalid" } | { kind: "range"; start: number; end: number };

  function parseAttachmentRangeHeader(raw: string | undefined, contentLength: number): ParsedAttachmentRange {
    if (!raw) return { kind: "none" };
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return { kind: "invalid" };

    const prefix = "bytes=";
    if (!raw.startsWith(prefix)) return { kind: "invalid" };
    const spec = raw.slice(prefix.length);
    if (!spec || spec.includes(",")) return { kind: "invalid" };

    const [startRaw, endRaw] = spec.split("-", 2);
    if (endRaw === undefined) return { kind: "invalid" };

    if (startRaw === "") {
      if (!/^[1-9]\d*$/.test(endRaw)) return { kind: "invalid" };
      const suffixLength = Number(endRaw);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
      const start = Math.max(contentLength - suffixLength, 0);
      return { kind: "range", start, end: contentLength - 1 };
    }

    if (!/^(?:0|[1-9]\d*)$/.test(startRaw)) return { kind: "invalid" };
    const start = Number(startRaw);
    if (!Number.isSafeInteger(start) || start < 0 || start >= contentLength) return { kind: "invalid" };
    if (endRaw !== "" && !/^(?:0|[1-9]\d*)$/.test(endRaw)) {
      return { kind: "invalid" };
    }
    const end = endRaw === "" ? contentLength - 1 : Number(endRaw);
    if (!Number.isSafeInteger(end) || end < start) return { kind: "invalid" };
    return { kind: "range", start, end: Math.min(end, contentLength - 1) };
  }

  function parseBooleanQuery(value: unknown, field: string) {
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    throw unprocessable(`${field} must be true or false`);
  }

  function parseOptionalBooleanQuery(value: unknown, field: string) {
    if (value === undefined) return undefined;
    return parseBooleanQuery(value, field);
  }

  function parseOptionalCanonicalUuidQuery(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !isCanonicalUuid(value)) {
      throw unprocessable(`${field} must be an exact canonical UUID`);
    }
    return value;
  }

  function parseOptionalExactNonBlankQuery(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
      throw unprocessable(`${field} must be an exact non-blank value`);
    }
    return value;
  }

  function parseAttachmentDownloadQuery(value: unknown) {
    if (value === undefined) return false;
    if (value === "1") return true;
    throw unprocessable("download must be 1 when provided");
  }

  function shouldIncludeDocumentAnnotations(req: Request) {
    return parseBooleanQuery(req.query.includeAnnotations, "includeAnnotations");
  }

  function shouldIncludeDocumentAnnotationComments(req: Request) {
    return parseBooleanQuery(req.query.includeAnnotationComments, "includeAnnotationComments");
  }

  function parseTaskDocumentKeyParam(req: Request, res: Response): string | null {
    const parsed = taskDocumentKeySchema.safeParse(req.params.key);
    if (parsed.success) return parsed.data;
    res.status(400).json({
      error: "Invalid document key",
      details: validationDetails(parsed.error),
    });
    return null;
  }

  function parseDocumentAnnotationStatus(value: unknown): "open" | "resolved" | "all" {
    if (value === undefined || value === "open") return "open";
    if (value === "resolved" || value === "all") return value;
    throw unprocessable("status must be open, resolved, or all");
  }

  function annotationActorInput(req: Request) {
    assertBoard(req);
    return {
      userId: req.actor.userId,
      annotationActor: {
        actorType: "user" as const,
        actorId: req.actor.userId,
        userId: req.actor.userId,
      },
    };
  }
  return {
    lookupLowTrustSourceArtifact,
    withContentPath,
    parseAttachmentRangeHeader,
    parseBooleanQuery,
    parseOptionalBooleanQuery,
    parseOptionalCanonicalUuidQuery,
    parseOptionalExactNonBlankQuery,
    parseAttachmentDownloadQuery,
    shouldIncludeDocumentAnnotations,
    shouldIncludeDocumentAnnotationComments,
    parseTaskDocumentKeyParam,
    parseDocumentAnnotationStatus,
    annotationActorInput,
  };
}

export type TaskRouteRequestContext<
  TBase extends TaskRequestHelperDependencies = TaskRequestHelperDependencies,
> = TBase & ReturnType<typeof createTaskRequestHelpers>;
