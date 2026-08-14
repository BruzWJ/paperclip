import { sql, type SQL } from "drizzle-orm";
import {
  COMPANY_SEARCH_MAX_LIMIT,
  type CompanyArtifact,
  type CompanySearchArtifactSummary,
  type CompanySearchQuery,
  type CompanySearchResult,
  type CompanySearchScope,
  type CompanySearchSnippet,
  type CompanySearchSort,
  type CompanySearchTaskFilterKey,
  type CompanySearchTaskSummary,
} from "@paperclipai/shared";
import {
  COMPANY_SEARCH_BRANCH_FETCH_LIMIT,
  TaskSearchRow,
  SimpleSearchRow,
  SearchResultWithSort,
  sqlTextArray,
  taskDisplayLabel,
  extractFirstImageUrl,
  createSnippet,
  iso,
  matchTerms,
  updatedWithinStart,
} from "./company-search-query-support.js";

export { COMPANY_SEARCH_BRANCH_FETCH_LIMIT } from "./company-search-query-support.js";

export // Facet conditions expressed against the `m` alias of the aggregate
// matched-tasks CTE (plain columns, no drizzle table references).
function matchedFacetConditions(
  companyId: string,
  query: CompanySearchQuery,
  omit?: CompanySearchTaskFilterKey,
): SQL[] {
  const conditions: SQL[] = [];
  if (omit !== "status" && query.status.length > 0) {
    conditions.push(sql`m.status = ANY(${sqlTextArray(query.status)})`);
  }
  if (omit !== "priority" && query.priority.length > 0) {
    conditions.push(sql`m.priority = ANY(${sqlTextArray(query.priority)})`);
  }
  if (omit !== "ownerAgentId" && query.ownerAgentId !== undefined) {
    conditions.push(sql`m.owner_agent_id = ${query.ownerAgentId}`);
  }
  if (omit !== "ownerUserId" && query.ownerUserId) {
    conditions.push(sql`m.owner_user_id = ${query.ownerUserId}`);
  }
  if (omit !== "projectId" && query.projectId) {
    conditions.push(sql`m.project_id = ${query.projectId}`);
  }
  if (omit !== "labelId" && query.labelId) {
    conditions.push(sql`
      EXISTS (
        SELECT 1
        FROM task_labels facet_filter_labels
        WHERE facet_filter_labels.company_id = ${companyId}
          AND facet_filter_labels.task_id = m.id
          AND facet_filter_labels.label_id = ${query.labelId}
      )
    `);
  }
  if (omit !== "updatedWithin") {
    const updatedWithin = updatedWithinStart(query.updatedWithin);
    // ISO strings: raw sql params bypass drizzle's column-level Date mapping.
    if (updatedWithin) conditions.push(sql`m.updated_at >= ${updatedWithin.toISOString()}::timestamptz`);
  }
  if (omit !== "updatedAfter" && query.updatedAfter) {
    conditions.push(sql`m.updated_at >= ${new Date(query.updatedAfter).toISOString()}::timestamptz`);
  }
  return conditions;
}

export function stripInternalSortFields(result: SearchResultWithSort): CompanySearchResult {
  const { sortCreatedAt: _sortCreatedAt, sortPriorityRank: _sortPriorityRank, ...publicResult } = result;
  return publicResult;
}

export function compareSearchResults(sort: CompanySearchSort) {
  return (left: SearchResultWithSort, right: SearchResultWithSort) => {
    if (sort === "updated") {
      const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      if (updated !== 0) return updated;
      if (right.score !== left.score) return right.score - left.score;
    } else if (sort === "created") {
      const created = (right.sortCreatedAt ?? "").localeCompare(left.sortCreatedAt ?? "");
      if (created !== 0) return created;
      const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      if (updated !== 0) return updated;
    } else if (sort === "priority") {
      const priority = left.sortPriorityRank - right.sortPriorityRank;
      if (priority !== 0) return priority;
      const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      if (updated !== 0) return updated;
      if (right.score !== left.score) return right.score - left.score;
    } else {
      if (right.score !== left.score) return right.score - left.score;
      const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      if (updated !== 0) return updated;
    }
    return right.id.localeCompare(left.id);
  };
}

export function scopeIncludesTasks(scope: CompanySearchScope) {
  return scope === "all" || scope === "tasks" || scope === "comments" || scope === "documents";
}

export function scopeIncludesAgents(scope: CompanySearchScope) {
  return scope === "all" || scope === "agents";
}

export function scopeIncludesArtifacts(scope: CompanySearchScope) {
  return scope === "all" || scope === "artifacts";
}

export function scopeIncludesProjects(scope: CompanySearchScope) {
  return scope === "all" || scope === "projects";
}

export function selectPrimarySnippets(row: TaskSearchRow, normalizedQuery: string, tokens: string[]) {
  const terms = matchTerms(normalizedQuery, tokens);
  const matchedFields = new Set(row.matchedFields ?? []);
  const candidates: Array<CompanySearchSnippet | null> = [];
  if (matchedFields.has("identifier")) {
    candidates.push(createSnippet("identifier", "Identifier", row.identifier, terms));
  }
  if (matchedFields.has("title")) {
    candidates.push(createSnippet("title", "Title", row.title, terms));
  }
  if (matchedFields.has("comment")) {
    candidates.push(createSnippet("comment", "Comment", row.commentSnippet, terms));
  }
  if (matchedFields.has("document")) {
    candidates.push(createSnippet("document", row.documentTitle || "Document", row.documentSnippet, terms));
  }
  if (matchedFields.has("request")) {
    candidates.push(createSnippet("request", "Request", row.request, terms));
  }
  return candidates.filter((snippet): snippet is CompanySearchSnippet => Boolean(snippet)).slice(0, 2);
}

export function taskResult(
  row: TaskSearchRow,
  normalizedQuery: string,
  tokens: string[],
): CompanySearchResult | null {
  const snippets = selectPrimarySnippets(row, normalizedQuery, tokens);
  const sourceLabel = snippets[0]?.label ?? null;
  const fragment = row.commentId
    ? `comment-${row.commentId}`
    : row.documentKey
      ? `document-${row.documentKey}`
      : null;
  const task: CompanySearchTaskSummary = {
    id: row.id,
    taskNumber: row.taskNumber,
    identifier: row.identifier,
    title: row.title,
    boardPresentationStatus: row.status as CompanySearchTaskSummary["boardPresentationStatus"],
    priority: row.priority as CompanySearchTaskSummary["priority"],
    request: row.request ?? "",
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    updatedAt: iso(row.updatedAt)!,
  };
  const previewImageUrl =
    extractFirstImageUrl(row.request) ??
    extractFirstImageUrl(row.commentSnippet) ??
    extractFirstImageUrl(row.documentSnippet);
  return {
    id: row.id,
    type: "task",
    score: Number(row.score),
    title: taskDisplayLabel(row),
    routeTarget: { kind: "task", taskNumber: row.taskNumber, hash: fragment },
    matchedFields: row.matchedFields ?? [],
    sourceLabel,
    snippet: snippets[0]?.text ?? null,
    snippets,
    task,
    updatedAt: task.updatedAt,
    previewImageUrl,
  };
}

export function scoreSimpleRow(
  row: Pick<SimpleSearchRow, "id" | "title" | "description" | "createdAt" | "updatedAt">,
  normalizedQuery: string,
  tokens: string[],
) {
  const haystack = [row.title, row.description].filter(Boolean).join(" ").toLowerCase();
  let score = haystack.includes(normalizedQuery) ? 90 : 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 20;
  }
  if (row.title.toLowerCase().startsWith(normalizedQuery)) score += 80;
  return score;
}

export function artifactResult(
  artifact: CompanyArtifact,
  normalizedQuery: string,
  tokens: string[],
): CompanySearchResult | null {
  const terms = matchTerms(normalizedQuery, tokens);
  const snippet = createSnippet("artifact", "Artifact", artifact.previewText ?? artifact.title, terms);
  const summary: CompanySearchArtifactSummary = {
    id: artifact.id,
    source: artifact.source,
    mediaKind: artifact.mediaKind,
    taskId: artifact.task.id,
    taskNumber: artifact.task.taskNumber,
    taskIdentifier: artifact.task.identifier,
    taskTitle: artifact.task.title,
    taskFragment: artifact.taskFragment,
    projectId: artifact.project?.id ?? null,
    projectName: artifact.project?.name ?? null,
    updatedAt: artifact.updatedAt,
  };
  const score = scoreSimpleRow(
    {
      id: artifact.id,
      title: artifact.title,
      description: [
        artifact.previewText,
        artifact.task.identifier,
        artifact.task.title,
        artifact.project?.name,
      ]
        .filter(Boolean)
        .join(" "),
      createdAt: new Date(artifact.updatedAt),
      updatedAt: new Date(artifact.updatedAt),
    },
    normalizedQuery,
    tokens,
  );
  return {
    id: artifact.id,
    type: "artifact",
    score,
    title: artifact.title,
    routeTarget: {
      kind: "task",
      taskNumber: artifact.task.taskNumber,
      hash: artifact.taskFragment,
    },
    matchedFields: ["artifact"],
    sourceLabel: snippet?.label ?? "Artifact",
    snippet: snippet?.text ?? artifact.previewText,
    snippets: snippet ? [snippet] : [],
    artifact: summary,
    updatedAt: artifact.updatedAt,
    previewImageUrl: artifact.mediaKind === "image" ? artifact.contentPath : null,
  };
}

export function simpleTextCondition(fields: SQL[], containsPattern: string, tokenPatternArray: SQL) {
  const phraseConditions = fields.map(
    (field) => sql<boolean>`coalesce(${field}, '') ILIKE ${containsPattern}`,
  );
  const tokenConditions = fields.map(
    (field) => sql<boolean>`coalesce(${field}, '') ILIKE ANY(${tokenPatternArray})`,
  );
  return sql<boolean>`(${sql.join([...phraseConditions, ...tokenConditions], sql` OR `)})`;
}

export function companySearchBranchFetchLimit(limit: number, offset = 0) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : COMPANY_SEARCH_MAX_LIMIT;
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return Math.min(COMPANY_SEARCH_BRANCH_FETCH_LIMIT, normalizedOffset + normalizedLimit + 1);
}
