import type { Db } from "@paperclipai/db";
import { tasks } from "@paperclipai/db";
import {
  COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type CompanySearchFilterOptionCounts,
  type CompanySearchTaskFilterKey,
  type CompanySearchUpdatedWithinOption,
} from "@paperclipai/shared";
import { sql, type SQL } from "drizzle-orm";
import * as searchSupport from "./company-search-query-support.js";
import { sqlUuidArray, type TaskSearchRow } from "./company-search-query-support.js";
import { matchedFacetConditions, scopeIncludesTasks } from "./company-search-result-support.js";
import { visibleTaskCondition } from "./task-visibility.js";

export async function enrichCompanySearchTaskSnippets(
  db: Db,
  companyId: string,
  hasSearchText: boolean,
  containsPattern: string,
  tokenPatternArray: SQL,
  rows: TaskSearchRow[],
): Promise<TaskSearchRow[]> {
  if (!hasSearchText || rows.length === 0) return rows;
  const snippetIds = rows
    .filter((row) => {
      const fields = row.matchedFields ?? [];
      return fields.includes("comment") || fields.includes("document");
    })
    .map((row) => row.id);
  if (snippetIds.length === 0) return rows;

  const snippetRows = (await db.execute(sql`
    SELECT
      target.id AS "taskId",
      best_comment.id AS "commentId",
      best_comment.body AS "commentSnippet",
      best_document.latest_body AS "documentSnippet",
      best_document.title AS "documentTitle",
      best_document.key AS "documentKey"
    FROM unnest(${sqlUuidArray(snippetIds)}) AS target(id)
    LEFT JOIN LATERAL (
      SELECT search_comments.id, search_comments.body
      FROM task_comments search_comments
      WHERE search_comments.company_id = ${companyId}
        AND search_comments.task_id = target.id
        AND (
          search_comments.body ILIKE ${containsPattern}
          OR search_comments.body ILIKE ANY(${tokenPatternArray})
        )
      ORDER BY
        CASE WHEN search_comments.body ILIKE ${containsPattern} THEN 0 ELSE 1 END,
        search_comments.updated_at DESC,
        search_comments.id DESC
      LIMIT 1
    ) best_comment ON true
    LEFT JOIN LATERAL (
      SELECT search_task_documents.key, search_documents.latest_body, search_documents.title
      FROM task_documents search_task_documents
      INNER JOIN documents search_documents
        ON search_documents.id = search_task_documents.document_id
        AND search_documents.company_id = search_task_documents.company_id
      WHERE search_task_documents.company_id = ${companyId}
        AND search_task_documents.task_id = target.id
        AND (
          coalesce(search_documents.title, '') ILIKE ${containsPattern}
          OR search_documents.latest_body ILIKE ${containsPattern}
          OR coalesce(search_documents.title, '') ILIKE ANY(${tokenPatternArray})
          OR search_documents.latest_body ILIKE ANY(${tokenPatternArray})
        )
      ORDER BY
        CASE
          WHEN coalesce(search_documents.title, '') ILIKE ${containsPattern} THEN 0
          WHEN search_documents.latest_body ILIKE ${containsPattern} THEN 1
          ELSE 2
        END,
        search_documents.updated_at DESC,
        search_documents.id DESC
      LIMIT 1
    ) best_document ON true
  `)) as unknown as Array<{
    taskId: string;
    commentId: string | null;
    commentSnippet: string | null;
    documentSnippet: string | null;
    documentTitle: string | null;
    documentKey: string | null;
  }>;
  const byTaskId = new Map(snippetRows.map((row) => [row.taskId, row]));
  return rows.map((row) => {
    const snippet = byTaskId.get(row.id);
    return snippet ? { ...row, ...snippet } : row;
  });
}

export function buildCompanySearchTaskQuery(context: searchSupport.CompanySearchScopeContext) {
  const {
    db,
    companyId,
    query,
    hasSearchText,
    tokens,
    scope,
    sort,
    fetchLimit,
    tokenPatterns,
    tokenPatternArray,
    containsPattern,
    tokenCount,
    titlePhraseMatch,
    titleStartsWith,
    titleExactMatch,
    identifierPhraseMatch,
    identifierStartsWith,
    identifierExactMatch,
    requestPhraseMatch,
    titleTokenMatch,
    identifierTokenMatch,
    requestTokenMatch,
    matchPatternOrdinal,
    commentMatchesCte,
    documentMatchesCte,
    commentMatch,
    documentMatch,
    fuzzyTokenTitleMatch,
    fuzzyIdentifierMatch,
    anySearchMatch,
    flagTextMatch,
    flagFuzzyMatch,
    flagScopeCondition,
  } = context;
  // --- combined task results + aggregates statement ---------------------
  // One statement computes everything task-side: the comment/document
  // match sets and the matched-tasks CTE (flags + per-token coverage) are
  // materialized once, then a UNION ALL fans out into the ranked result
  // page and every count (type counts, facet option counts, updated-within
  // buckets, and totals for zero-result recovery) as cheap aggregations.
  type TaskAggregates = {
    typeCounts: { task: number; comment: number; document: number };
    filterOptionCounts: CompanySearchFilterOptionCounts;
    totals: {
      current: number;
      unfiltered: number;
      omit: Partial<Record<CompanySearchTaskFilterKey, number>>;
    };
  };

  type TaskSearchData = {
    rows: searchSupport.TaskSearchRow[];
    aggregates: TaskAggregates;
  };

  async function fetchTaskSearchData(): Promise<TaskSearchData> {
    const filtersActive = searchSupport.activeTaskFilters(query);
    const scopeCond = flagScopeCondition("m", scope);
    const optionCond = scopeIncludesTasks(scope) ? scopeCond : flagScopeCondition("m", "all");
    const titleCond: SQL<boolean> = hasSearchText
      ? sql<boolean>`(${flagTextMatch("m")} OR ${flagFuzzyMatch("m")})`
      : sql<boolean>`true`;
    const facetsAll = matchedFacetConditions(companyId, query);
    const branchWhere = (conditions: SQL[]) =>
      conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
    // Count branches must match the result branch's column list; the
    // trailing NULLs pad the task data columns.
    const countTail = sql`, NULL::uuid, NULL::integer, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::double precision, NULL::text[]`;
    const branches: SQL[] = [];

    const wantResultRows =
      scopeIncludesTasks(scope) && !(!hasSearchText && (scope === "comments" || scope === "documents"));
    if (wantResultRows) {
      const allTokensBonus =
        tokenCount > 0 ? sql`CASE WHEN m.token_coverage = ${tokenCount} THEN 260 ELSE 0 END` : sql`0`;
      const scoreSql = sql`(
              CASE WHEN m.ident_exact THEN 1200 ELSE 0 END
              + CASE WHEN m.ident_starts THEN 700 ELSE 0 END
              + CASE WHEN m.title_exact THEN 900 ELSE 0 END
              + CASE WHEN m.title_starts THEN 550 ELSE 0 END
              + CASE WHEN m.title_phrase THEN 350 ELSE 0 END
              + CASE WHEN m.ident_phrase THEN 320 ELSE 0 END
              + CASE WHEN m.comment_match THEN 180 ELSE 0 END
              + CASE WHEN m.document_match THEN 170 ELSE 0 END
              + CASE WHEN m.request_phrase THEN 120 ELSE 0 END
              + ${allTokensBonus}
              + (m.token_coverage * 70)
              + CASE WHEN (m.fuzzy_title OR m.fuzzy_ident) THEN 110 ELSE 0 END
              + CASE m.status WHEN 'done' THEN 0 WHEN 'cancelled' THEN -30 ELSE 20 END
            )::double precision`;
      const priorityOrderSql = sql`CASE m.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const orderBySql =
        sort === "updated"
          ? sql`m.updated_at DESC, score DESC, m.id DESC`
          : sort === "created"
            ? sql`m.created_at DESC, m.updated_at DESC, m.id DESC`
            : sort === "priority"
              ? sql`${priorityOrderSql} ASC, m.updated_at DESC, score DESC, m.id DESC`
              : sql`score DESC, m.updated_at DESC, m.id DESC`;
      branches.push(sql`(
              SELECT
                'result'::text AS kind,
                NULL::text AS value,
                0 AS count,
                m.id,
                m.task_number AS "taskNumber",
                m.identifier,
                m.title,
                m.request,
                m.status,
                m.priority,
                m.owner_agent_id AS "ownerAgentId",
                m.owner_user_id AS "ownerUserId",
                m.project_id AS "projectId",
                m.created_at AS "createdAt",
                m.updated_at AS "updatedAt",
                ${scoreSql} AS score,
                array_remove(ARRAY[
                  CASE WHEN m.ident_phrase OR m.ident_token OR m.fuzzy_ident THEN 'identifier' END,
                  CASE WHEN m.title_phrase OR m.title_token OR m.fuzzy_title THEN 'title' END,
                  CASE WHEN m.request_phrase OR m.request_token THEN 'request' END,
                  CASE WHEN m.comment_match THEN 'comment' END,
                  CASE WHEN m.document_match THEN 'document' END
                ], NULL)::text[] AS "matchedFields"
              FROM matched m
              ${branchWhere([...facetsAll, scopeCond])}
              ORDER BY ${orderBySql}
              LIMIT ${fetchLimit}
            )`);
    }

    if (scope === "all" || scope === "tasks") {
      branches.push(
        sql`SELECT 'type:task' AS kind, NULL::text AS value, count(*)::int AS count ${countTail} FROM matched m ${branchWhere([...facetsAll, titleCond])}`,
      );
    }
    if (hasSearchText && (scope === "all" || scope === "comments")) {
      branches.push(
        sql`SELECT 'type:comment' AS kind, NULL::text AS value, count(*)::int AS count ${countTail} FROM matched m ${branchWhere([...facetsAll, sql`m.comment_match`])}`,
      );
    }
    if (hasSearchText && (scope === "all" || scope === "documents")) {
      branches.push(
        sql`SELECT 'type:document' AS kind, NULL::text AS value, count(*)::int AS count ${countTail} FROM matched m ${branchWhere([...facetsAll, sql`m.document_match`])}`,
      );
    }

    const facetBranch = (
      kind: string,
      valueSql: SQL,
      omit: CompanySearchTaskFilterKey,
      extra: SQL[] = [],
    ) => sql`
            SELECT ${kind}::text AS kind, ${valueSql}::text AS value, count(*)::int AS count ${countTail}
            FROM matched m
            ${branchWhere([optionCond, ...matchedFacetConditions(companyId, query, omit), ...extra])}
            GROUP BY 2
          `;
    branches.push(facetBranch("facet:status", sql`m.status`, "status"));
    branches.push(facetBranch("facet:priority", sql`m.priority`, "priority"));
    branches.push(
      facetBranch("facet:ownerAgentId", sql`m.owner_agent_id`, "ownerAgentId", [
        sql`m.owner_agent_id IS NOT NULL`,
      ]),
    );
    branches.push(
      facetBranch("facet:ownerUserId", sql`m.owner_user_id`, "ownerUserId", [
        sql`m.owner_user_id IS NOT NULL`,
      ]),
    );
    branches.push(
      facetBranch("facet:projectId", sql`m.project_id`, "projectId", [sql`m.project_id IS NOT NULL`]),
    );
    branches.push(sql`
            SELECT 'facet:labelId' AS kind, matched_labels.label_id::text AS value, count(DISTINCT m.id)::int AS count ${countTail}
            FROM matched m
            INNER JOIN task_labels matched_labels
              ON matched_labels.task_id = m.id
              AND matched_labels.company_id = ${companyId}
            ${branchWhere([optionCond, ...matchedFacetConditions(companyId, query, "labelId")])}
            GROUP BY 2
          `);

    const updatedBaseQuery = {
      ...query,
      updatedWithin: undefined,
      updatedAfter: undefined,
    };
    const updatedBaseFacets = matchedFacetConditions(companyId, updatedBaseQuery);
    for (const option of COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS) {
      const start = searchSupport.updatedWithinStart(option);
      if (!start) continue;
      branches.push(sql`
              SELECT 'facet:updatedWithin'::text AS kind, ${option}::text AS value, count(*)::int AS count ${countTail}
              FROM matched m
              ${branchWhere([optionCond, ...updatedBaseFacets, sql`m.updated_at >= ${start.toISOString()}::timestamptz`])}
            `);
    }

    if (scopeIncludesTasks(scope)) {
      branches.push(
        sql`SELECT 'total:current' AS kind, NULL::text AS value, count(*)::int AS count ${countTail} FROM matched m ${branchWhere([scopeCond, ...facetsAll])}`,
      );
      if (filtersActive.length > 0) {
        branches.push(
          sql`SELECT 'total:unfiltered' AS kind, NULL::text AS value, count(*)::int AS count ${countTail} FROM matched m ${branchWhere([scopeCond])}`,
        );
        for (const filter of filtersActive) {
          branches.push(sql`
                  SELECT ${`total:omit:${filter.key}`}::text AS kind, NULL::text AS value, count(*)::int AS count ${countTail}
                  FROM matched m
                  ${branchWhere([scopeCond, ...matchedFacetConditions(companyId, query, filter.key)])}
                `);
        }
      }
    }

    // Per-token coverage counts matches across task text and the tagged
    // comment/document match sets (hashed IN probes, one set per token).
    const coverageSql =
      tokenCount > 0
        ? sql`(${sql.join(
            tokens.map((_: string, index: number) => {
              const pattern = tokenPatterns[index]!;
              const ord = matchPatternOrdinal(pattern);
              return sql`(CASE WHEN
                tasks.title ILIKE ${pattern}
                OR coalesce(tasks.identifier, '') ILIKE ${pattern}
                OR coalesce(tasks.request, '') ILIKE ${pattern}
                OR tasks.id IN (SELECT comment_matches.task_id FROM comment_matches WHERE comment_matches.ord = ${ord})
                OR tasks.id IN (SELECT document_matches.task_id FROM document_matches WHERE document_matches.ord = ${ord})
              THEN 1 ELSE 0 END)`;
            }),
            sql` + `,
          )})`
        : sql`0`;

    const matchedWhere = hasSearchText ? sql` AND ${anySearchMatch}` : sql``;
    const resultRows = (await db.execute(sql`
            WITH comment_matches AS MATERIALIZED (${commentMatchesCte}),
            document_matches AS MATERIALIZED (${documentMatchesCte}),
            matched AS MATERIALIZED (
              SELECT
                tasks.id,
                tasks.task_number,
                tasks.identifier,
                tasks.title,
                tasks.request,
                ${tasks.boardPresentationStatus} AS status,
                tasks.priority,
                tasks.owner_agent_id,
                tasks.owner_user_id,
                tasks.project_id,
                tasks.created_at,
                tasks.updated_at,
                ${titlePhraseMatch} AS title_phrase,
                ${titleStartsWith} AS title_starts,
                ${titleExactMatch} AS title_exact,
                ${identifierPhraseMatch} AS ident_phrase,
                ${identifierStartsWith} AS ident_starts,
                ${identifierExactMatch} AS ident_exact,
                ${requestPhraseMatch} AS request_phrase,
                ${titleTokenMatch} AS title_token,
                ${identifierTokenMatch} AS ident_token,
                ${requestTokenMatch} AS request_token,
                ${commentMatch} AS comment_match,
                ${documentMatch} AS document_match,
                ${fuzzyTokenTitleMatch} AS fuzzy_title,
                ${fuzzyIdentifierMatch} AS fuzzy_ident,
                ${coverageSql} AS token_coverage
              FROM tasks
              WHERE tasks.company_id = ${companyId}
                AND ${visibleTaskCondition()}
                ${matchedWhere}
            )
            ${sql.join(branches, sql` UNION ALL `)}
          `)) as unknown as Array<
      searchSupport.SearchAggregateRow &
        Omit<
          searchSupport.TaskSearchRow,
          "commentSnippet" | "commentId" | "documentSnippet" | "documentTitle" | "documentKey"
        >
    >;

    const aggregates: TaskAggregates = {
      typeCounts: { task: 0, comment: 0, document: 0 },
      filterOptionCounts: searchSupport.emptyFilterOptionCounts(),
      totals: { current: 0, unfiltered: 0, omit: {} },
    };
    const taskRowsRaw: searchSupport.TaskSearchRow[] = [];
    for (const row of resultRows) {
      if (row.kind === "result") {
        taskRowsRaw.push({
          id: row.id,
          taskNumber: row.taskNumber,
          identifier: row.identifier,
          title: row.title,
          request: row.request,
          status: row.status,
          priority: row.priority,
          ownerAgentId: row.ownerAgentId,
          ownerUserId: row.ownerUserId,
          projectId: row.projectId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          score: row.score,
          matchedFields: row.matchedFields,
          commentSnippet: null,
          commentId: null,
          documentSnippet: null,
          documentTitle: null,
          documentKey: null,
        });
        continue;
      }
      const count = Number(row.count ?? 0);
      if (row.kind === "type:task") aggregates.typeCounts.task = count;
      else if (row.kind === "type:comment") aggregates.typeCounts.comment = count;
      else if (row.kind === "type:document") aggregates.typeCounts.document = count;
      else if (
        row.kind === "facet:status" &&
        row.value &&
        (TASK_STATUSES as readonly string[]).includes(row.value)
      ) {
        aggregates.filterOptionCounts.status[row.value as keyof CompanySearchFilterOptionCounts["status"]] =
          count;
      } else if (
        row.kind === "facet:priority" &&
        row.value &&
        (TASK_PRIORITIES as readonly string[]).includes(row.value)
      ) {
        aggregates.filterOptionCounts.priority[
          row.value as keyof CompanySearchFilterOptionCounts["priority"]
        ] = count;
      } else if (row.kind === "facet:ownerAgentId" && row.value)
        aggregates.filterOptionCounts.ownerAgentId[row.value] = count;
      else if (row.kind === "facet:ownerUserId" && row.value)
        aggregates.filterOptionCounts.ownerUserId[row.value] = count;
      else if (row.kind === "facet:projectId" && row.value)
        aggregates.filterOptionCounts.projectId[row.value] = count;
      else if (row.kind === "facet:labelId" && row.value)
        aggregates.filterOptionCounts.labelId[row.value] = count;
      else if (row.kind === "facet:updatedWithin" && row.value) {
        aggregates.filterOptionCounts.updatedWithin[row.value as CompanySearchUpdatedWithinOption] = count;
      } else if (row.kind === "total:current") aggregates.totals.current = count;
      else if (row.kind === "total:unfiltered") aggregates.totals.unfiltered = count;
      else if (row.kind.startsWith("total:omit:")) {
        aggregates.totals.omit[row.kind.slice("total:omit:".length) as CompanySearchTaskFilterKey] = count;
      }
    }
    return {
      rows: await enrichCompanySearchTaskSnippets(
        db,
        companyId,
        hasSearchText,
        containsPattern,
        tokenPatternArray,
        taskRowsRaw,
      ),
      aggregates,
    };
  }
  return { fetchTaskSearchData };
}

export type CompanySearchTaskQuery = ReturnType<typeof buildCompanySearchTaskQuery>;
