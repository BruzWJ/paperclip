import { and, desc, eq, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  agents,
  assets,
  documents,
  projects,
  taskAttachments,
  taskDocuments,
  taskWorkProducts,
  tasks,
} from "@paperclipai/db";
import {
  COMPANY_ARTIFACTS_MAX_LIMIT,
  COMPANY_ARTIFACTS_MAX_QUERY_LENGTH,
  SYSTEM_TASK_DOCUMENT_KEYS,
  type CompanySearchQuery,
} from "@paperclipai/shared";
import { companyArtifactsService } from "./company-artifacts.js";
import { visibleTaskCondition } from "./task-visibility.js";
import {
  taskOnlyFiltersActive,
  taskFilterConditions,
  type CompanySearchScopeContext,
} from "./company-search-query-support.js";
import {
  scopeIncludesAgents,
  scopeIncludesArtifacts,
  scopeIncludesProjects,
  simpleTextCondition,
} from "./company-search-result-support.js";

export function buildCompanySearchBranchQuery(context: CompanySearchScopeContext) {
  const {
    db,
    companyId,
    query,
    normalizedQuery,
    hasSearchText,
    scope,
    limit,
    fetchLimit,
    tokenPatternArray,
    containsPattern,
    taskFilters,
    hasTaskOnlyFilters,
  } = context;
  // --- agents / projects / artifacts ------------------------------------
  const simpleCondition = simpleTextCondition(
    [sql`${agents.name}`, sql`${agents.title}`, sql`${agents.capabilities}`],
    containsPattern,
    tokenPatternArray,
  );

  const projectCondition = simpleTextCondition(
    [sql`${projects.name}`, sql`${projects.description}`],
    containsPattern,
    tokenPatternArray,
  );

  async function fetchAgentRows() {
    if (!hasSearchText || !scopeIncludesAgents(scope) || hasTaskOnlyFilters) return [];
    const rows = await db
      .select({
        id: agents.id,
        title: agents.name,
        description: agents.capabilities,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), simpleCondition))
      .orderBy(desc(agents.updatedAt), desc(agents.id))
      .limit(fetchLimit);
    return rows;
  }

  async function fetchProjectRows() {
    if (!hasSearchText || !scopeIncludesProjects(scope) || hasTaskOnlyFilters) return [];
    const rows = await db
      .select({
        id: projects.id,
        title: projects.name,
        description: projects.description,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt), projectCondition))
      .orderBy(desc(projects.updatedAt), desc(projects.id))
      .limit(fetchLimit);
    return rows;
  }

  async function countArtifacts(filters: CompanySearchQuery = query) {
    if (!hasSearchText) return 0;
    const artifactTaskFilters = taskFilterConditions(companyId, filters);
    const artifactTaskConditions = [
      eq(tasks.companyId, companyId),
      visibleTaskCondition(),
      ...artifactTaskFilters,
    ];
    const documentArtifactConditions = [
      eq(taskDocuments.companyId, companyId),
      eq(documents.companyId, companyId),
      or(isNotNull(documents.createdByAgentId), isNotNull(documents.updatedByAgentId))!,
      notInArray(taskDocuments.key, [...SYSTEM_TASK_DOCUMENT_KEYS]),
      sql<boolean>`(
              coalesce(${documents.title}, '') ILIKE ${containsPattern} ESCAPE '\\'
              OR ${documents.latestBody} ILIKE ${containsPattern} ESCAPE '\\'
              OR coalesce(${tasks.identifier}, '') ILIKE ${containsPattern} ESCAPE '\\'
              OR ${tasks.title} ILIKE ${containsPattern} ESCAPE '\\'
            )`,
      ...artifactTaskConditions,
    ];
    const workProductConditions = [
      eq(taskWorkProducts.companyId, companyId),
      eq(taskWorkProducts.type, "artifact"),
      eq(taskWorkProducts.provider, "paperclip"),
      sql<boolean>`(
              ${taskWorkProducts.title} ILIKE ${containsPattern} ESCAPE '\\'
              OR coalesce(${taskWorkProducts.summary}, '') ILIKE ${containsPattern} ESCAPE '\\'
              OR coalesce(${tasks.identifier}, '') ILIKE ${containsPattern} ESCAPE '\\'
              OR ${tasks.title} ILIKE ${containsPattern} ESCAPE '\\'
            )`,
      ...artifactTaskConditions,
    ];
    const attachmentConditions = [
      eq(taskAttachments.companyId, companyId),
      isNull(taskAttachments.taskCommentId),
      isNotNull(assets.createdByAgentId),
      sql<boolean>`(
              coalesce(${assets.originalFilename}, '') ILIKE ${containsPattern} ESCAPE '\\'
              OR coalesce(${tasks.identifier}, '') ILIKE ${containsPattern} ESCAPE '\\'
              OR ${tasks.title} ILIKE ${containsPattern} ESCAPE '\\'
            )`,
      ...artifactTaskConditions,
    ];
    const [documentRows, workProductRows, attachmentRows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(taskDocuments)
        .innerJoin(
          documents,
          and(eq(taskDocuments.documentId, documents.id), eq(documents.companyId, taskDocuments.companyId)),
        )
        .innerJoin(
          tasks,
          and(eq(taskDocuments.taskId, tasks.id), eq(tasks.companyId, taskDocuments.companyId)),
        )
        .where(and(...documentArtifactConditions)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(taskWorkProducts)
        .innerJoin(
          tasks,
          and(eq(taskWorkProducts.taskId, tasks.id), eq(tasks.companyId, taskWorkProducts.companyId)),
        )
        .where(and(...workProductConditions)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(taskAttachments)
        .innerJoin(
          assets,
          and(eq(taskAttachments.assetId, assets.id), eq(assets.companyId, taskAttachments.companyId)),
        )
        .innerJoin(
          tasks,
          and(eq(taskAttachments.taskId, tasks.id), eq(tasks.companyId, taskAttachments.companyId)),
        )
        .where(and(...attachmentConditions)),
    ]);
    return (
      Number(documentRows[0]?.count ?? 0) +
      Number(workProductRows[0]?.count ?? 0) +
      Number(attachmentRows[0]?.count ?? 0)
    );
  }

  async function countAgents(filters: CompanySearchQuery = query) {
    if (!hasSearchText || taskOnlyFiltersActive(filters)) return 0;
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), simpleCondition));
    return Number(rows[0]?.count ?? 0);
  }

  async function countProjects(filters: CompanySearchQuery = query) {
    if (!hasSearchText || taskOnlyFiltersActive(filters)) return 0;
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt), projectCondition));
    return Number(rows[0]?.count ?? 0);
  }

  async function fetchArtifactRows() {
    if (!hasSearchText || !scopeIncludesArtifacts(scope)) return [];
    const result = await companyArtifactsService(db).list(
      companyId,
      {
        kind: "all",
        groupBy: "none",
        q: normalizedQuery.slice(0, COMPANY_ARTIFACTS_MAX_QUERY_LENGTH),
        limit: Math.min(fetchLimit, COMPANY_ARTIFACTS_MAX_LIMIT),
      },
      { taskConditions: taskFilters },
    );
    return result.artifacts;
  }
  return {
    simpleCondition,
    projectCondition,
    fetchAgentRows,
    fetchProjectRows,
    countArtifacts,
    countAgents,
    countProjects,
    fetchArtifactRows,
  };
}
export type CompanySearchBranchQuery = ReturnType<typeof buildCompanySearchBranchQuery>;
