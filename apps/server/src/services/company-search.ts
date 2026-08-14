import { type Db, companies } from "@paperclipai/db";
import {
  type CompanySearchQuery,
  type CompanySearchResponse,
  TASK_PRIORITIES,
  type CompanyArtifact,
} from "@paperclipai/shared";
import { companySearchExtractService } from "./company-search-extract.js";
import { buildCompanySearchMatchPlan } from "./company-search-match-plan.js";
import { buildCompanySearchTaskQuery } from "./company-search-task-query.js";
import { buildCompanySearchBranchQuery } from "./company-search-branch-query.js";

import { eq } from "drizzle-orm";
import {
  SearchResultWithSort,
  SimpleSearchRow,
  activeTaskFilters,
  createSnippet,
  emptySearchCounts,
  iso,
  matchTerms,
  priorityRank,
  queryWithoutFilter,
  queryWithoutTaskFilters,
  requireCompany,
  type TaskSearchRow,
  type CompanySearchScopeContext,
} from "./company-search-query-support.js";
import {
  artifactResult,
  compareSearchResults,
  scopeIncludesAgents,
  scopeIncludesArtifacts,
  scopeIncludesProjects,
  scopeIncludesTasks,
  scoreSimpleRow,
  stripInternalSortFields,
  taskResult,
} from "./company-search-result-support.js";

export async function buildCompanySearchResponse(
  context: CompanySearchScopeContext,
): Promise<CompanySearchResponse> {
  const {
    db,
    companyId,
    query,
    normalizedQuery,
    tokens,
    scope,
    sort,
    limit,
    offset,
    fetchTaskSearchData,
    fetchAgentRows,
    fetchProjectRows,
    countArtifacts,
    countAgents,
    countProjects,
    fetchArtifactRows,
  } = context;
  const [
    company,
    taskSearchData,
    artifactRows,
    agentRows,
    projectRows,
    artifactCount,
    agentCount,
    projectCount,
  ] = await Promise.all([
    db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null),
    fetchTaskSearchData(),
    fetchArtifactRows(),
    fetchAgentRows(),
    fetchProjectRows(),
    scopeIncludesArtifacts(scope) ? countArtifacts(query) : Promise.resolve(0),
    scopeIncludesAgents(scope) ? countAgents(query) : Promise.resolve(0),
    scopeIncludesProjects(scope) ? countProjects(query) : Promise.resolve(0),
  ]);

  requireCompany(company);

  const { rows: taskRows, aggregates } = taskSearchData;

  const countsByType = emptySearchCounts();

  countsByType.task = aggregates.typeCounts.task;

  countsByType.comment = aggregates.typeCounts.comment;

  countsByType.document = aggregates.typeCounts.document;

  countsByType.artifact = artifactCount;

  countsByType.agent = agentCount;

  countsByType.project = projectCount;

  const currentTotalCount =
    (scopeIncludesTasks(scope) ? aggregates.totals.current : 0) + artifactCount + agentCount + projectCount;

  const results: SearchResultWithSort[] = [
    ...taskRows.flatMap((row: TaskSearchRow) => {
      const result = taskResult(row, normalizedQuery, tokens);
      if (!result) return [];
      return [
        {
          ...result,
          sortCreatedAt: iso(row.createdAt),
          sortPriorityRank: priorityRank(row.priority),
        },
      ];
    }),
    ...artifactRows.flatMap((artifact: CompanyArtifact) => {
      const result = artifactResult(artifact, normalizedQuery, tokens);
      return result
        ? [
            {
              ...result,
              sortCreatedAt: artifact.updatedAt,
              sortPriorityRank: TASK_PRIORITIES.length,
            },
          ]
        : [];
    }),
    ...(agentRows as SimpleSearchRow[]).flatMap((row) => {
      const terms = matchTerms(normalizedQuery, tokens);
      const snippet = createSnippet("capabilities", "Agent", row.description ?? row.title, terms);
      return [
        {
          id: row.id,
          type: "agent" as const,
          score: scoreSimpleRow(row, normalizedQuery, tokens),
          title: row.title,
          routeTarget: { kind: "agent" as const, id: row.id },
          matchedFields: ["agent"],
          sourceLabel: snippet?.label ?? null,
          snippet: snippet?.text ?? null,
          snippets: snippet ? [snippet] : [],
          updatedAt: iso(row.updatedAt),
          previewImageUrl: null,
          sortCreatedAt: iso(row.createdAt),
          sortPriorityRank: TASK_PRIORITIES.length,
        },
      ];
    }),
    ...(projectRows as SimpleSearchRow[]).flatMap((row) => {
      const terms = matchTerms(normalizedQuery, tokens);
      const snippet = createSnippet("description", "Project", row.description ?? row.title, terms);
      return [
        {
          id: row.id,
          type: "project" as const,
          score: scoreSimpleRow(row, normalizedQuery, tokens),
          title: row.title,
          routeTarget: { kind: "project" as const, id: row.id },
          matchedFields: ["project"],
          sourceLabel: snippet?.label ?? null,
          snippet: snippet?.text ?? null,
          snippets: snippet ? [snippet] : [],
          updatedAt: iso(row.updatedAt),
          previewImageUrl: null,
          sortCreatedAt: iso(row.createdAt),
          sortPriorityRank: TASK_PRIORITIES.length,
        },
      ];
    }),
  ].sort(compareSearchResults(sort));

  async function countTotalNonTask(filters: CompanySearchQuery) {
    const [artifactTotal, agentTotal, projectTotal] = await Promise.all([
      scopeIncludesArtifacts(scope) ? countArtifacts(filters) : Promise.resolve(0),
      scopeIncludesAgents(scope) ? countAgents(filters) : Promise.resolve(0),
      scopeIncludesProjects(scope) ? countProjects(filters) : Promise.resolve(0),
    ]);
    return artifactTotal + agentTotal + projectTotal;
  }

  const filtersActive = activeTaskFilters(query);

  const zeroResults =
    currentTotalCount === 0 && filtersActive.length > 0
      ? {
          unfilteredTotal:
            (scopeIncludesTasks(scope) ? aggregates.totals.unfiltered : 0) +
            (await countTotalNonTask(queryWithoutTaskFilters(query))),
          loosenSuggestions: (
            await Promise.all(
              filtersActive.map(async (filter) => {
                const resultCount =
                  (scopeIncludesTasks(scope) ? (aggregates.totals.omit[filter.key] ?? 0) : 0) +
                  (await countTotalNonTask(queryWithoutFilter(query, filter.key)));
                return {
                  filter: filter.key,
                  values: filter.values,
                  resultCount,
                  additionalCount: Math.max(0, resultCount - currentTotalCount),
                };
              }),
            )
          ).sort((left, right) => right.additionalCount - left.additionalCount),
        }
      : null;

  const paged = results.slice(offset, offset + limit).map(stripInternalSortFields);

  return {
    query: query.q,
    normalizedQuery,
    scope,
    sort,
    limit,
    offset,
    results: paged,
    countsByType,
    filterOptionCounts: aggregates.filterOptionCounts,
    zeroResults,
    hasMore: results.length > offset + limit,
  };
}

export {
  COMPANY_SEARCH_BRANCH_FETCH_LIMIT,
  companySearchBranchFetchLimit,
} from "./company-search-result-support.js";

export function companySearchService(db: Db) {
  const extractService = companySearchExtractService(db);
  async function search(companyId: string, query: CompanySearchQuery): Promise<CompanySearchResponse> {
    const base = { db, companyId, query };
    const plan = buildCompanySearchMatchPlan(base);
    if (plan.emptyResponse) return plan.emptyResponse;
    const taskQuery = buildCompanySearchTaskQuery({ ...base, ...plan });
    const branchQuery = buildCompanySearchBranchQuery({
      ...base,
      ...plan,
      ...taskQuery,
    });
    return buildCompanySearchResponse({
      ...base,
      ...plan,
      ...taskQuery,
      ...branchQuery,
    });
  }
  return { extract: extractService.extract, search };
}
