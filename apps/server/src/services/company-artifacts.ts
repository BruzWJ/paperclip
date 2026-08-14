import { eq, isNull, type SQL, and, desc, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { type Db, companies, tasks, agents, documents, taskDocuments, projects } from "@paperclipai/db";
import {
  COMPANY_ARTIFACTS_MAX_LIMIT,
  type CompanyArtifact,
  type CompanyArtifactsQuery,
  type CompanyArtifactsResponse,
  SYSTEM_TASK_DOCUMENT_KEYS,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import type { StorageService } from "../storage/types.js";
import {
  buildArtifactGroups,
  decodeCursor,
  emptyGroup,
  encodeCursor,
  escapeLikePattern,
  GROUPED_ARTIFACT_FETCH_LIMIT,
  loadTaskGroupingRows,
  pageByCursor,
  resolveGroupTaskId,
  sortArtifacts,
  cursorCondition,
  normalizePreviewText,
  type CompanyArtifactSourceContext,
} from "./company-artifact-projections.js";
import { loadCompanyFileArtifacts } from "./company-artifact-file-sources.js";
import { alias } from "drizzle-orm/pg-core";

export async function loadCompanyDocumentArtifacts(
  context: CompanyArtifactSourceContext,
): Promise<CompanyArtifact[]> {
  const { db, storage, companyId, query, cursor, groupBy, taskConditions, sourceFetchLimit, q } = context;
  const artifacts: CompanyArtifact[] = [];

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

  const documentCursor = groupBy
    ? undefined
    : cursorCondition(sql<Date>`${documents.updatedAt}`, documentArtifactId, cursor);

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
      and(eq(taskDocuments.documentId, documents.id), eq(documents.companyId, taskDocuments.companyId)),
    )
    .innerJoin(tasks, and(eq(taskDocuments.taskId, tasks.id), eq(tasks.companyId, taskDocuments.companyId)))
    .leftJoin(projects, and(eq(tasks.projectId, projects.id), eq(projects.companyId, tasks.companyId)))
    .leftJoin(
      createdAgent,
      and(eq(documents.createdByAgentId, createdAgent.id), eq(createdAgent.companyId, documents.companyId)),
    )
    .leftJoin(
      updatedAgent,
      and(eq(documents.updatedByAgentId, updatedAgent.id), eq(updatedAgent.companyId, documents.companyId)),
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
      createdByAgent:
        row.createdByAgentId && row.createdByAgentName
          ? { id: row.createdByAgentId, name: row.createdByAgentName }
          : null,
      updatedAt: row.updatedAt.toISOString(),
      taskFragment: `document-${row.key}`,
    });
  }
  return artifacts;
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
      const q = query.q ? "%" + escapeLikePattern(query.q) + "%" : null;
      const taskConditions: SQL[] = [isNull(tasks.hiddenAt), ...(options.taskConditions ?? [])];
      const context = {
        db,
        storage,
        companyId,
        query,
        cursor,
        groupBy,
        taskConditions,
        sourceFetchLimit,
        q,
      };
      const artifacts: CompanyArtifact[] = [];
      if (query.kind === "all" || query.kind === "document")
        artifacts.push(...(await loadCompanyDocumentArtifacts(context)));
      if (query.kind !== "document") artifacts.push(...(await loadCompanyFileArtifacts(context)));
      const sorted = sortArtifacts(artifacts);

      if (!groupBy) {
        const page = sorted.slice(0, query.limit);
        const nextCursor =
          sorted.length > query.limit
            ? encodeCursor({
                id: page[page.length - 1]?.id ?? "",
                updatedAt: page[page.length - 1]?.updatedAt ?? new Date(0).toISOString(),
              })
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
        const selectedGroup =
          groups.find((group) => group.task.id === selectedGroupTaskId) ??
          emptyGroup({
            groupBy,
            task: taskRows.get(selectedGroupTaskId) ?? selectedTask,
          });
        const selectedArtifacts = sorted.filter(
          (artifact) => resolveGroupTaskId(groupBy, artifact.task.id, taskRows) === selectedGroupTaskId,
        );
        const { page, nextCursor } = pageByCursor(selectedArtifacts, query.limit, cursor);
        return { artifacts: page, selectedGroup, nextCursor };
      }

      const { page, nextCursor } = pageByCursor(groups, query.limit, cursor);

      return { artifacts: [], groups: page, nextCursor };
    },
  };
}
export * from "./company-artifact-projections.js";
