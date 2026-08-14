import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agents, assets, projects, taskAttachments, taskWorkProducts, tasks } from "@paperclipai/db";
import { attachmentArtifactWorkProductMetadataSchema, type CompanyArtifact } from "@paperclipai/shared";
import { readTaskExecutionRun, resolveTaskExecutionRunIdentityById } from "./task-execution-run-service.js";
import * as artifactProjection from "./company-artifact-projections.js";

export async function loadCompanyFileArtifacts(
  context: artifactProjection.CompanyArtifactSourceContext,
): Promise<CompanyArtifact[]> {
  const { db, storage, companyId, query, cursor, groupBy, taskConditions, sourceFetchLimit, q } = context;
  const artifacts: CompanyArtifact[] = [];
  const workProductAttachmentIds = new Set<string>();
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
    : artifactProjection.cursorCondition(
        sql<Date>`${taskWorkProducts.updatedAt}`,
        workProductArtifactId,
        cursor,
      );

  const workProductKind = artifactProjection.contentTypeKindCondition(workProductContentType, query.kind);

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
      and(eq(taskWorkProducts.taskId, tasks.id), eq(tasks.companyId, taskWorkProducts.companyId)),
    )
    .leftJoin(
      projects,
      and(eq(tasks.projectId, projects.id), eq(projects.companyId, taskWorkProducts.companyId)),
    )
    .where(and(...workProductConditions))
    .orderBy(desc(taskWorkProducts.updatedAt), desc(workProductArtifactId));

  const workProductRows = await workProductRowsQuery.limit(sourceFetchLimit);

  const workProductRunIds = [
    ...new Set(
      workProductRows.map((row) => row.createdByRunId).filter((runId): runId is string => runId !== null),
    ),
  ];

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

  const workProductAgents =
    workProductAgentIds.length === 0
      ? []
      : await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, workProductAgentIds)));

  const workProductAgentById = new Map(workProductAgents.map((agent) => [agent.id, agent]));

  const workProductAttachmentRows = await db
    .select({
      attachmentId: sql<string | null>`${taskWorkProducts.metadata}->>'attachmentId'`,
    })
    .from(taskWorkProducts)
    .innerJoin(
      tasks,
      and(eq(taskWorkProducts.taskId, tasks.id), eq(tasks.companyId, taskWorkProducts.companyId)),
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
      ? (workProductAgentIdByRunId.get(row.createdByRunId) ?? null)
      : null;
    const createdByAgent = createdByAgentId ? (workProductAgentById.get(createdByAgentId) ?? null) : null;
    const metadata = attachmentArtifactWorkProductMetadataSchema.safeParse(row.metadata);
    const attachmentMetadata = metadata.success ? metadata.data : null;
    if (attachmentMetadata) {
      workProductAttachmentIds.add(attachmentMetadata.attachmentId);
    }
    const contentType = attachmentMetadata?.contentType ?? null;
    artifacts.push({
      id: row.artifactId,
      source: "work_product",
      mediaKind: artifactProjection.classifyMediaKind(contentType, attachmentMetadata ? "file" : "empty"),
      title: row.title,
      previewText: artifactProjection.normalizePreviewText(row.summary),
      contentType,
      contentPath: attachmentMetadata?.contentPath ?? null,
      openPath:
        attachmentMetadata?.openPath ??
        (typeof row.metadata?.openPath === "string" ? row.metadata.openPath : null),
      downloadPath: attachmentMetadata?.downloadPath ?? null,
      task: {
        id: row.taskId,
        taskNumber: row.taskNumber,
        identifier: row.taskIdentifier,
        title: row.taskTitle,
      },
      project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
      createdByAgent: createdByAgent ? { id: createdByAgent.id, name: createdByAgent.name } : null,
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
    : artifactProjection.cursorCondition(
        sql<Date>`${taskAttachments.updatedAt}`,
        attachmentArtifactId,
        cursor,
      );

  const attachmentKind = artifactProjection.contentTypeKindCondition(
    sql<string>`${assets.contentType}`,
    query.kind,
  );

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
      and(eq(taskAttachments.assetId, assets.id), eq(assets.companyId, taskAttachments.companyId)),
    )
    .innerJoin(
      tasks,
      and(eq(taskAttachments.taskId, tasks.id), eq(tasks.companyId, taskAttachments.companyId)),
    )
    .leftJoin(projects, and(eq(tasks.projectId, projects.id), eq(projects.companyId, tasks.companyId)))
    .leftJoin(
      attachmentAgent,
      and(eq(assets.createdByAgentId, attachmentAgent.id), eq(attachmentAgent.companyId, assets.companyId)),
    )
    .where(and(...attachmentConditions))
    .orderBy(desc(taskAttachments.updatedAt), desc(attachmentArtifactId));

  const attachmentRows = await attachmentRowsQuery.limit(sourceFetchLimit);

  const attachmentArtifacts = await Promise.all(
    attachmentRows.map(async (row): Promise<CompanyArtifact | null> => {
      if (workProductAttachmentIds.has(row.attachmentId)) return null;
      const mediaKind = artifactProjection.classifyMediaKind(row.contentType);
      const contentPath = artifactProjection.attachmentContentPath(row.attachmentId);
      return {
        id: row.artifactId,
        source: "attachment",
        mediaKind,
        title: row.originalFilename ?? "Attachment",
        previewText:
          mediaKind === "text"
            ? await artifactProjection.readTextAttachmentPreview(storage, {
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
        createdByAgent:
          row.createdByAgentId && row.createdByAgentName
            ? { id: row.createdByAgentId, name: row.createdByAgentName }
            : null,
        updatedAt: row.updatedAt.toISOString(),
        taskFragment: `attachment-${row.attachmentId}`,
      };
    }),
  );

  artifacts.push(...attachmentArtifacts.filter((artifact): artifact is CompanyArtifact => artifact !== null));
  return artifacts;
}
