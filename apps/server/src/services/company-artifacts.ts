import { buffer } from "node:stream/consumers";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agents,
  assets,
  companies,
  documents,
  taskAttachments,
  taskDocuments,
  tasks,
  taskWorkProducts,
  projects,
} from "@paperclipai/db";
import {
  attachmentArtifactWorkProductMetadataSchema,
  COMPANY_ARTIFACTS_MAX_LIMIT,
  SYSTEM_TASK_DOCUMENT_KEYS,
  type CompanyArtifact,
  type CompanyArtifactGroup,
  type CompanyArtifactGroupBy,
  type CompanyArtifactMediaKind,
  type CompanyArtifactsQuery,
  type CompanyArtifactsResponse,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import type { StorageService } from "../storage/types.js";
import {
  readTaskExecutionRun,
  resolveTaskExecutionRunIdentityById,
} from "./task-execution-run-service.js";

const TEXT_PREVIEW_BYTES = 4096;
const PREVIEW_TEXT_MAX_LENGTH = 280;
const GROUP_PREVIEW_ARTIFACT_LIMIT = 3;
const GROUPED_ARTIFACT_FETCH_LIMIT = COMPANY_ARTIFACTS_MAX_LIMIT * 10;

type ArtifactCursor = {
  updatedAt: string;
  id: string;
};

type ArtifactGroupBy = Exclude<CompanyArtifactGroupBy, "none">;

type TaskGroupingRow = {
  id: string;
  parentId: string | null;
  taskNumber: number;
  identifier: string;
  title: string | null;
  updatedAt: Date;
};

function encodeCursor(cursor: ArtifactCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): ArtifactCursor | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("Noncanonical cursor");
    const parsed = JSON.parse(decoded.toString("utf8")) as Partial<ArtifactCursor>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      Object.keys(parsed).sort().join(",") !== "id,updatedAt"
    ) {
      throw new Error("Invalid cursor");
    }
    const date = new Date(parsed.updatedAt);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== parsed.updatedAt) {
      throw new Error("Invalid cursor date");
    }
    return { id: parsed.id, updatedAt: parsed.updatedAt };
  } catch {
    throw badRequest("Invalid artifacts cursor");
  }
}

function cursorCondition(updatedAt: SQL<Date>, artifactId: SQL<string>, cursor: ArtifactCursor | null) {
  if (!cursor) return undefined;
  return sql`(${updatedAt} < ${cursor.updatedAt}::timestamptz OR (${updatedAt} = ${cursor.updatedAt}::timestamptz AND ${artifactId} < ${cursor.id}))`;
}

function isAfterCursor(item: { updatedAt: string; id: string }, cursor: ArtifactCursor | null) {
  if (!cursor) return true;
  const dateDiff = Date.parse(item.updatedAt) - Date.parse(cursor.updatedAt);
  return dateDiff < 0 || (dateDiff === 0 && item.id < cursor.id);
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizePreviewText(input: string | null | undefined) {
  if (!input) return null;
  const stripped = input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_\-~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  return stripped.length > PREVIEW_TEXT_MAX_LENGTH
    ? `${stripped.slice(0, PREVIEW_TEXT_MAX_LENGTH - 3).trimEnd()}...`
    : stripped;
}

function classifyMediaKind(contentType: string | null | undefined, fallback: CompanyArtifactMediaKind = "file") {
  const normalized = (contentType ?? "").toLowerCase();
  if (!normalized) return fallback;
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/xml" ||
    normalized.endsWith("+xml") ||
    normalized === "application/markdown"
  ) {
    return "text";
  }
  return "file";
}

function contentTypeKindCondition(contentTypeExpression: SQL<string>, kind: CompanyArtifactsQuery["kind"]) {
  if (!kind || kind === "all") return undefined;
  if (kind === "image") return sql`${contentTypeExpression} ILIKE 'image/%'`;
  if (kind === "video") return sql`${contentTypeExpression} ILIKE 'video/%'`;
  if (kind === "text") {
    return sql`(${contentTypeExpression} ILIKE 'text/%' OR ${contentTypeExpression} IN ('application/json', 'application/xml', 'application/markdown') OR ${contentTypeExpression} ILIKE '%+json' OR ${contentTypeExpression} ILIKE '%+xml')`;
  }
  if (kind === "file") {
    return sql`NOT (${contentTypeExpression} ILIKE 'image/%' OR ${contentTypeExpression} ILIKE 'video/%' OR ${contentTypeExpression} ILIKE 'text/%' OR ${contentTypeExpression} IN ('application/json', 'application/xml', 'application/markdown') OR ${contentTypeExpression} ILIKE '%+json' OR ${contentTypeExpression} ILIKE '%+xml')`;
  }
  return undefined;
}

function attachmentContentPath(attachmentId: string) {
  return `/api/attachments/${attachmentId}/content`;
}

async function readTextAttachmentPreview(
  storage: StorageService | undefined,
  input: { companyId: string; objectKey: string; byteSize: number },
) {
  if (!storage || input.byteSize <= 0) return null;
  try {
    const object = await storage.getObject(input.companyId, input.objectKey, {
      range: { start: 0, end: Math.min(input.byteSize, TEXT_PREVIEW_BYTES) - 1 },
    });
    const body = await buffer(object.stream);
    return normalizePreviewText(body.toString("utf8"));
  } catch {
    return null;
  }
}

function sortArtifacts(artifacts: CompanyArtifact[]) {
  return artifacts.sort((a, b) => {
    const dateDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (dateDiff !== 0) return dateDiff;
    return b.id.localeCompare(a.id);
  });
}

function pageByCursor<T extends { id: string; updatedAt: string }>(
  items: T[],
  limit: number,
  cursor: ArtifactCursor | null,
) {
  const filtered = items.filter((item) => isAfterCursor(item, cursor));
  const page = filtered.slice(0, limit);
  const nextCursor = filtered.length > limit
    ? encodeCursor({ id: page[page.length - 1]?.id ?? "", updatedAt: page[page.length - 1]?.updatedAt ?? new Date(0).toISOString() })
    : null;
  return { page, nextCursor };
}

async function loadTaskGroupingRows(db: Db, companyId: string, seedTaskIds: Iterable<string>) {
  const rowsById = new Map<string, TaskGroupingRow>();
  let pending = [...new Set(seedTaskIds)];

  while (pending.length > 0) {
    const rows = await db
      .select({
        id: tasks.id,
        parentId: tasks.parentId,
        taskNumber: tasks.taskNumber,
        identifier: tasks.identifier,
        title: tasks.title,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, pending)));

    const nextPending = new Set<string>();
    for (const row of rows) {
      rowsById.set(row.id, row);
      if (row.parentId && !rowsById.has(row.parentId)) {
        nextPending.add(row.parentId);
      }
    }
    pending = [...nextPending];
  }

  return rowsById;
}

function getTaskSummary(task: TaskGroupingRow) {
  return {
    id: task.id,
    taskNumber: task.taskNumber,
    identifier: task.identifier,
    title: task.title,
  };
}

function resolveRootTaskId(taskId: string, taskRows: Map<string, TaskGroupingRow>) {
  let current = taskRows.get(taskId);
  if (!current) return taskId;
  const seen = new Set<string>();
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = taskRows.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function resolveGroupTaskId(groupBy: ArtifactGroupBy, taskId: string, taskRows: Map<string, TaskGroupingRow>) {
  return groupBy === "task" ? taskId : resolveRootTaskId(taskId, taskRows);
}

function emptyGroup(input: {
  groupBy: ArtifactGroupBy;
  task: TaskGroupingRow;
}): CompanyArtifactGroup {
  const summary = getTaskSummary(input.task);
  return {
    id: `${input.groupBy}:${input.task.id}`,
    groupBy: input.groupBy,
    task: summary,
    title: summary.title ?? summary.identifier,
    count: 0,
    mediaKinds: [],
    previewArtifacts: [],
    updatedAt: input.task.updatedAt.toISOString(),
  };
}

function buildArtifactGroups(input: {
  artifacts: CompanyArtifact[];
  groupBy: ArtifactGroupBy;
  taskRows: Map<string, TaskGroupingRow>;
}) {
  const groups = new Map<string, CompanyArtifactGroup>();

  for (const artifact of input.artifacts) {
    const groupTaskId = resolveGroupTaskId(input.groupBy, artifact.task.id, input.taskRows);
    const groupTask = input.taskRows.get(groupTaskId) ?? {
      id: artifact.task.id,
      parentId: null,
      taskNumber: artifact.task.taskNumber,
      identifier: artifact.task.identifier,
      title: artifact.task.title,
      updatedAt: new Date(artifact.updatedAt),
    };
    const groupId = `${input.groupBy}:${groupTaskId}`;
    const existing = groups.get(groupId);
    const group = existing ?? emptyGroup({
      groupBy: input.groupBy,
      task: groupTask,
    });
    if (!existing) groups.set(groupId, group);

    group.count += 1;
    if (!group.mediaKinds.includes(artifact.mediaKind)) {
      group.mediaKinds.push(artifact.mediaKind);
    }
    if (group.previewArtifacts.length < GROUP_PREVIEW_ARTIFACT_LIMIT) {
      group.previewArtifacts.push(artifact);
    }
    if (Date.parse(artifact.updatedAt) > Date.parse(group.updatedAt)) {
      group.updatedAt = artifact.updatedAt;
    }
  }

  return [...groups.values()].sort((a, b) => {
    const dateDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (dateDiff !== 0) return dateDiff;
    return b.id.localeCompare(a.id);
  });
}

export function companyArtifactsService(db: Db, storage?: StorageService) {
  return {
    list: async (
      companyId: string,
      query: CompanyArtifactsQuery,
      options: { taskConditions?: SQL[] } = {},
    ): Promise<CompanyArtifactsResponse> => {
      const cursor = decodeCursor(query.cursor);
      const groupBy = query.groupBy === "none" ? null : query.groupBy;
      const company = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const fetchLimit = Math.min(query.limit + 1, COMPANY_ARTIFACTS_MAX_LIMIT + 1);
      const sourceFetchLimit = groupBy ? GROUPED_ARTIFACT_FETCH_LIMIT : fetchLimit;
      const q = query.q ? `%${escapeLikePattern(query.q)}%` : null;
      const taskConditions: SQL[] = [
        isNull(tasks.hiddenAt),
        ...(options.taskConditions ?? []),
      ];
      const artifacts: CompanyArtifact[] = [];
      const workProductAttachmentIds = new Set<string>();

      if (query.kind === "all" || query.kind === "document") {
        const createdAgent = alias(agents, "document_created_agent");
        const updatedAgent = alias(agents, "document_updated_agent");
        const documentArtifactId = sql<string>`concat('document:', ${documents.id})`;
        const documentConditions: SQL[] = [
          eq(taskDocuments.companyId, companyId),
          eq(documents.companyId, companyId),
          or(isNotNull(documents.createdByAgentId), isNotNull(documents.updatedByAgentId))!,
          notInArray(taskDocuments.key, [...SYSTEM_TASK_DOCUMENT_KEYS]),
          ...taskConditions,
        ];
        const documentCursor = groupBy ? undefined : cursorCondition(sql<Date>`${documents.updatedAt}`, documentArtifactId, cursor);
        if (documentCursor) documentConditions.push(documentCursor);
        if (groupBy === "task" && query.groupTaskId) documentConditions.push(eq(tasks.id, query.groupTaskId));
        if (query.projectId) documentConditions.push(eq(tasks.projectId, query.projectId));
        if (q) {
          documentConditions.push(sql`(
            coalesce(${documents.title}, '') ILIKE ${q} ESCAPE '\\'
            OR ${documents.latestBody} ILIKE ${q} ESCAPE '\\'
            OR coalesce(${tasks.identifier}, '') ILIKE ${q} ESCAPE '\\'
            OR ${tasks.title} ILIKE ${q} ESCAPE '\\'
          )`);
        }

        const documentRowsQuery = db
          .select({
            artifactId: documentArtifactId,
            documentId: documents.id,
            taskId: tasks.id,
            taskNumber: tasks.taskNumber,
            taskIdentifier: tasks.identifier,
            taskTitle: tasks.title,
            projectId: projects.id,
            projectName: projects.name,
            key: taskDocuments.key,
            title: documents.title,
            latestBody: documents.latestBody,
            createdByAgentId: sql<string | null>`coalesce(${createdAgent.id}, ${updatedAgent.id})`,
            createdByAgentName: sql<string | null>`coalesce(${createdAgent.name}, ${updatedAgent.name})`,
            updatedAt: documents.updatedAt,
          })
          .from(taskDocuments)
          .innerJoin(
            documents,
            and(
              eq(taskDocuments.documentId, documents.id),
              eq(documents.companyId, taskDocuments.companyId),
            ),
          )
          .innerJoin(
            tasks,
            and(
              eq(taskDocuments.taskId, tasks.id),
              eq(tasks.companyId, taskDocuments.companyId),
            ),
          )
          .leftJoin(
            projects,
            and(
              eq(tasks.projectId, projects.id),
              eq(projects.companyId, tasks.companyId),
            ),
          )
          .leftJoin(
            createdAgent,
            and(
              eq(documents.createdByAgentId, createdAgent.id),
              eq(createdAgent.companyId, documents.companyId),
            ),
          )
          .leftJoin(
            updatedAgent,
            and(
              eq(documents.updatedByAgentId, updatedAgent.id),
              eq(updatedAgent.companyId, documents.companyId),
            ),
          )
          .where(and(...documentConditions))
          .orderBy(desc(documents.updatedAt), desc(documentArtifactId));
        const documentRows = await documentRowsQuery.limit(sourceFetchLimit);

        for (const row of documentRows) {
          artifacts.push({
            id: row.artifactId,
            source: "document",
            mediaKind: "document",
            title: row.title ?? row.key,
            previewText: normalizePreviewText(row.latestBody),
            contentType: "text/markdown",
            contentPath: null,
            openPath: null,
            downloadPath: null,
            task: {
              id: row.taskId,
              taskNumber: row.taskNumber,
              identifier: row.taskIdentifier,
              title: row.taskTitle,
            },
            project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
            createdByAgent: row.createdByAgentId && row.createdByAgentName
              ? { id: row.createdByAgentId, name: row.createdByAgentName }
              : null,
            updatedAt: row.updatedAt.toISOString(),
            taskFragment: `document-${row.key}`,
          });
        }
      }

      if (query.kind !== "document") {
        const workProductArtifactId = sql<string>`concat('work_product:', ${taskWorkProducts.id})`;
        const workProductContentType = sql<string>`coalesce(${taskWorkProducts.metadata}->>'contentType', '')`;
        const workProductBaseConditions: SQL[] = [
          eq(taskWorkProducts.companyId, companyId),
          eq(taskWorkProducts.type, "artifact"),
          eq(taskWorkProducts.provider, "paperclip"),
          ...taskConditions,
        ];
        const workProductConditions: SQL[] = [...workProductBaseConditions];
        const workProductCursor = groupBy
          ? undefined
          : cursorCondition(sql<Date>`${taskWorkProducts.updatedAt}`, workProductArtifactId, cursor);
        const workProductKind = contentTypeKindCondition(workProductContentType, query.kind);
        if (workProductCursor) workProductConditions.push(workProductCursor);
        if (groupBy === "task" && query.groupTaskId) {
          const selectedTaskCondition = eq(tasks.id, query.groupTaskId);
          workProductBaseConditions.push(selectedTaskCondition);
          workProductConditions.push(selectedTaskCondition);
        }
        if (workProductKind) {
          workProductBaseConditions.push(workProductKind);
          workProductConditions.push(workProductKind);
        }
        if (query.projectId) {
          const projectCondition = eq(tasks.projectId, query.projectId);
          workProductBaseConditions.push(projectCondition);
          workProductConditions.push(projectCondition);
        }
        if (q) {
          const searchCondition = sql`(
            ${taskWorkProducts.title} ILIKE ${q} ESCAPE '\\'
            OR coalesce(${taskWorkProducts.summary}, '') ILIKE ${q} ESCAPE '\\'
            OR coalesce(${tasks.identifier}, '') ILIKE ${q} ESCAPE '\\'
            OR ${tasks.title} ILIKE ${q} ESCAPE '\\'
          )`;
          workProductBaseConditions.push(searchCondition);
          workProductConditions.push(searchCondition);
        }

        const workProductRowsQuery = db
          .select({
            artifactId: workProductArtifactId,
            workProductId: taskWorkProducts.id,
            taskId: tasks.id,
            taskNumber: tasks.taskNumber,
            taskIdentifier: tasks.identifier,
            taskTitle: tasks.title,
            projectId: projects.id,
            projectName: projects.name,
            title: taskWorkProducts.title,
            summary: taskWorkProducts.summary,
            metadata: taskWorkProducts.metadata,
            createdByRunId: taskWorkProducts.createdByRunId,
            updatedAt: taskWorkProducts.updatedAt,
          })
          .from(taskWorkProducts)
          .innerJoin(
            tasks,
            and(
              eq(taskWorkProducts.taskId, tasks.id),
              eq(tasks.companyId, taskWorkProducts.companyId),
            ),
          )
          .leftJoin(
            projects,
            and(
              eq(tasks.projectId, projects.id),
              eq(projects.companyId, taskWorkProducts.companyId),
            ),
          )
          .where(and(...workProductConditions))
          .orderBy(desc(taskWorkProducts.updatedAt), desc(workProductArtifactId));
        const workProductRows = await workProductRowsQuery.limit(sourceFetchLimit);
        const workProductRunIds = [...new Set(
          workProductRows
            .map((row) => row.createdByRunId)
            .filter((runId): runId is string => runId !== null),
        )];
        const workProductRuns = await Promise.all(
          workProductRunIds.map(async (runId) => {
            const identity = await resolveTaskExecutionRunIdentityById(db, runId);
            if (!identity || identity.companyId !== companyId) return null;
            return readTaskExecutionRun(db, identity);
          }),
        );
        const workProductAgentIdByRunId = new Map<string, string>();
        for (const run of workProductRuns) {
          if (run) {
            workProductAgentIdByRunId.set(run.runId, run.targetAgentId);
          }
        }
        const workProductAgentIds = [...new Set(workProductAgentIdByRunId.values())];
        const workProductAgents = workProductAgentIds.length === 0
          ? []
          : await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(and(
              eq(agents.companyId, companyId),
              inArray(agents.id, workProductAgentIds),
            ));
        const workProductAgentById = new Map(
          workProductAgents.map((agent) => [agent.id, agent]),
        );

        const workProductAttachmentRows = await db
          .select({
            attachmentId: sql<string | null>`${taskWorkProducts.metadata}->>'attachmentId'`,
          })
          .from(taskWorkProducts)
          .innerJoin(
            tasks,
            and(
              eq(taskWorkProducts.taskId, tasks.id),
              eq(tasks.companyId, taskWorkProducts.companyId),
            ),
          )
          .where(and(...workProductBaseConditions, sql`${taskWorkProducts.metadata}->>'attachmentId' IS NOT NULL`))
          .limit(sourceFetchLimit);

        for (const row of workProductAttachmentRows) {
          if (row.attachmentId) {
            workProductAttachmentIds.add(row.attachmentId);
          }
        }

        for (const row of workProductRows) {
          const createdByAgentId = row.createdByRunId
            ? workProductAgentIdByRunId.get(row.createdByRunId) ?? null
            : null;
          const createdByAgent = createdByAgentId
            ? workProductAgentById.get(createdByAgentId) ?? null
            : null;
          const metadata = attachmentArtifactWorkProductMetadataSchema.safeParse(row.metadata);
          const attachmentMetadata = metadata.success ? metadata.data : null;
          if (attachmentMetadata) {
            workProductAttachmentIds.add(attachmentMetadata.attachmentId);
          }
          const contentType = attachmentMetadata?.contentType ?? null;
          artifacts.push({
            id: row.artifactId,
            source: "work_product",
            mediaKind: classifyMediaKind(contentType, attachmentMetadata ? "file" : "empty"),
            title: row.title,
            previewText: normalizePreviewText(row.summary),
            contentType,
            contentPath: attachmentMetadata?.contentPath ?? null,
            openPath: attachmentMetadata?.openPath ?? (typeof row.metadata?.openPath === "string" ? row.metadata.openPath : null),
            downloadPath: attachmentMetadata?.downloadPath ?? null,
            task: {
              id: row.taskId,
              taskNumber: row.taskNumber,
              identifier: row.taskIdentifier,
              title: row.taskTitle,
            },
            project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
            createdByAgent: createdByAgent
              ? { id: createdByAgent.id, name: createdByAgent.name }
              : null,
            updatedAt: row.updatedAt.toISOString(),
            taskFragment: `work-product-${row.workProductId}`,
          });
        }

        const attachmentAgent = alias(agents, "attachment_agent");
        const attachmentArtifactId = sql<string>`concat('attachment:', ${taskAttachments.id})`;
        const attachmentConditions: SQL[] = [
          eq(taskAttachments.companyId, companyId),
          isNull(taskAttachments.taskCommentId),
          isNotNull(assets.createdByAgentId),
          ...taskConditions,
        ];
        const attachmentCursor = groupBy
          ? undefined
          : cursorCondition(sql<Date>`${taskAttachments.updatedAt}`, attachmentArtifactId, cursor);
        const attachmentKind = contentTypeKindCondition(sql<string>`${assets.contentType}`, query.kind);
        if (attachmentCursor) attachmentConditions.push(attachmentCursor);
        if (groupBy === "task" && query.groupTaskId) attachmentConditions.push(eq(tasks.id, query.groupTaskId));
        if (attachmentKind) attachmentConditions.push(attachmentKind);
        if (query.projectId) attachmentConditions.push(eq(tasks.projectId, query.projectId));
        if (q) {
          attachmentConditions.push(sql`(
            coalesce(${assets.originalFilename}, '') ILIKE ${q} ESCAPE '\\'
            OR coalesce(${tasks.identifier}, '') ILIKE ${q} ESCAPE '\\'
            OR ${tasks.title} ILIKE ${q} ESCAPE '\\'
          )`);
        }

        const attachmentRowsQuery = db
          .select({
            artifactId: attachmentArtifactId,
            attachmentId: taskAttachments.id,
            companyId: taskAttachments.companyId,
            taskId: tasks.id,
            taskNumber: tasks.taskNumber,
            taskIdentifier: tasks.identifier,
            taskTitle: tasks.title,
            projectId: projects.id,
            projectName: projects.name,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            originalFilename: assets.originalFilename,
            createdByAgentId: attachmentAgent.id,
            createdByAgentName: attachmentAgent.name,
            updatedAt: taskAttachments.updatedAt,
          })
          .from(taskAttachments)
          .innerJoin(
            assets,
            and(
              eq(taskAttachments.assetId, assets.id),
              eq(assets.companyId, taskAttachments.companyId),
            ),
          )
          .innerJoin(
            tasks,
            and(
              eq(taskAttachments.taskId, tasks.id),
              eq(tasks.companyId, taskAttachments.companyId),
            ),
          )
          .leftJoin(
            projects,
            and(
              eq(tasks.projectId, projects.id),
              eq(projects.companyId, tasks.companyId),
            ),
          )
          .leftJoin(
            attachmentAgent,
            and(
              eq(assets.createdByAgentId, attachmentAgent.id),
              eq(attachmentAgent.companyId, assets.companyId),
            ),
          )
          .where(and(...attachmentConditions))
          .orderBy(desc(taskAttachments.updatedAt), desc(attachmentArtifactId));
        const attachmentRows = await attachmentRowsQuery.limit(sourceFetchLimit);

        const attachmentArtifacts = await Promise.all(attachmentRows.map(async (row): Promise<CompanyArtifact | null> => {
          if (workProductAttachmentIds.has(row.attachmentId)) return null;
          const mediaKind = classifyMediaKind(row.contentType);
          const contentPath = attachmentContentPath(row.attachmentId);
          return {
            id: row.artifactId,
            source: "attachment",
            mediaKind,
            title: row.originalFilename ?? "Attachment",
            previewText: mediaKind === "text"
              ? await readTextAttachmentPreview(storage, {
                companyId: row.companyId,
                objectKey: row.objectKey,
                byteSize: row.byteSize,
              })
              : null,
            contentType: row.contentType,
            contentPath,
            openPath: contentPath,
            downloadPath: `${contentPath}?download=1`,
            task: {
              id: row.taskId,
              taskNumber: row.taskNumber,
              identifier: row.taskIdentifier,
              title: row.taskTitle,
            },
            project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
            createdByAgent: row.createdByAgentId && row.createdByAgentName
              ? { id: row.createdByAgentId, name: row.createdByAgentName }
              : null,
            updatedAt: row.updatedAt.toISOString(),
            taskFragment: `attachment-${row.attachmentId}`,
          };
        }));

        artifacts.push(...attachmentArtifacts.filter((artifact): artifact is CompanyArtifact => artifact !== null));
      }

      const sorted = sortArtifacts(artifacts);
      if (!groupBy) {
        const page = sorted.slice(0, query.limit);
        const nextCursor = sorted.length > query.limit
          ? encodeCursor({ id: page[page.length - 1]?.id ?? "", updatedAt: page[page.length - 1]?.updatedAt ?? new Date(0).toISOString() })
          : null;

        return { artifacts: page, nextCursor };
      }

      const taskSeedIds = new Set(artifacts.map((artifact) => artifact.task.id));
      if (query.groupTaskId) taskSeedIds.add(query.groupTaskId);
      const taskRows = await loadTaskGroupingRows(db, companyId, taskSeedIds);
      const groups = buildArtifactGroups({
        artifacts: sorted,
        groupBy,
        taskRows,
      });

      if (query.groupTaskId) {
        const selectedTask = taskRows.get(query.groupTaskId);
        if (!selectedTask) {
          return { artifacts: [], selectedGroup: null, nextCursor: null };
        }

        const selectedGroupTaskId = resolveGroupTaskId(groupBy, selectedTask.id, taskRows);
        const selectedGroup = groups.find((group) => group.task.id === selectedGroupTaskId)
          ?? emptyGroup({
            groupBy,
            task: taskRows.get(selectedGroupTaskId) ?? selectedTask,
          });
        const selectedArtifacts = sorted.filter((artifact) =>
          resolveGroupTaskId(groupBy, artifact.task.id, taskRows) === selectedGroupTaskId
        );
        const { page, nextCursor } = pageByCursor(selectedArtifacts, query.limit, cursor);
        return { artifacts: page, selectedGroup, nextCursor };
      }

      const { page, nextCursor } = pageByCursor(groups, query.limit, cursor);
      return { artifacts: [], groups: page, nextCursor };
    },
  };
}
