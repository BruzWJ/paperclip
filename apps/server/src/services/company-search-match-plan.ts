import { sql, type SQL } from "drizzle-orm";
import { type CompanySearchScope } from "@paperclipai/shared";
import * as searchSupport from "./company-search-query-support.js";
import { companySearchBranchFetchLimit } from "./company-search-result-support.js";

export function buildCompanySearchMatchPlan(context: searchSupport.CompanySearchScopeContext) {
  const { companyId, query } = context;
  const normalizedQuery = searchSupport.normalizeQuery(query.q);

  const hasSearchText = normalizedQuery.length > 0;

  const tokens = searchSupport.tokenizeQuery(normalizedQuery);

  const scope = query.scope;

  const sort = query.sort;

  const limit = query.limit;

  const offset = query.offset;

  if (!hasSearchText && !searchSupport.taskOnlyFiltersActive(query)) {
    return {
      emptyResponse: {
        query: query.q,
        normalizedQuery,
        scope,
        sort,
        limit,
        offset,
        results: [],
        countsByType: searchSupport.emptySearchCounts(),
        filterOptionCounts: searchSupport.emptyFilterOptionCounts(),
        zeroResults: null,
        hasMore: false,
      },
    };
  }

  const fetchLimit = companySearchBranchFetchLimit(limit, offset);

  const escapedTokens = tokens.map(searchSupport.escapeLikePattern);

  // LIKE/ILIKE both treat backslash as the default escape character, so the
  // escaped tokens stay literal inside ILIKE ANY(...) patterns too.
  const tokenPatterns = escapedTokens.map((token) => `%${token}%`);

  const tokenPatternArray = searchSupport.sqlTextArray(tokenPatterns);

  const fuzzyTokens = searchSupport.fuzzyEligibleTokens(tokens);

  const fuzzyTokenArray = searchSupport.sqlTextArray(fuzzyTokens);

  const escapedQuery = searchSupport.escapeLikePattern(normalizedQuery);

  const containsPattern = hasSearchText ? `%${escapedQuery}%` : "__paperclip_no_match__";

  const startsWithPattern = hasSearchText ? `${escapedQuery}%` : "__paperclip_no_match__";

  const fuzzyEnabled =
    hasSearchText &&
    normalizedQuery.length >= searchSupport.MIN_FUZZY_QUERY_LENGTH &&
    !/[\\%_]/.test(normalizedQuery);

  const fuzzyTokensEnabled = fuzzyEnabled && fuzzyTokens.length > 0;

  const tokenCount = tokens.length;

  // --- shared match expressions against the `tasks` table -------------
  // Raw-column ILIKE keeps the predicates compatible with the existing
  // pg_trgm GIN indexes (lower(col) LIKE expressions cannot use them).
  const titlePhraseMatch = hasSearchText
    ? sql<boolean>`tasks.title ILIKE ${containsPattern}`
    : searchSupport.noMatchSql();

  const titleStartsWith = hasSearchText
    ? sql<boolean>`tasks.title ILIKE ${startsWithPattern}`
    : searchSupport.noMatchSql();

  const titleExactMatch = hasSearchText
    ? sql<boolean>`lower(tasks.title) = ${normalizedQuery}`
    : searchSupport.noMatchSql();

  const identifierPhraseMatch = hasSearchText
    ? sql<boolean>`coalesce(tasks.identifier, '') ILIKE ${containsPattern}`
    : searchSupport.noMatchSql();

  const identifierStartsWith = hasSearchText
    ? sql<boolean>`coalesce(tasks.identifier, '') ILIKE ${startsWithPattern}`
    : searchSupport.noMatchSql();

  const identifierExactMatch = hasSearchText
    ? sql<boolean>`lower(coalesce(tasks.identifier, '')) = ${normalizedQuery}`
    : searchSupport.noMatchSql();

  const requestPhraseMatch = hasSearchText
    ? sql<boolean>`coalesce(tasks.request, '') ILIKE ${containsPattern}`
    : searchSupport.noMatchSql();

  const titleTokenMatch =
    tokenCount > 0 ? sql<boolean>`tasks.title ILIKE ANY(${tokenPatternArray})` : searchSupport.noMatchSql();

  const identifierTokenMatch =
    tokenCount > 0
      ? sql<boolean>`coalesce(tasks.identifier, '') ILIKE ANY(${tokenPatternArray})`
      : searchSupport.noMatchSql();

  const requestTokenMatch =
    tokenCount > 0
      ? sql<boolean>`coalesce(tasks.request, '') ILIKE ANY(${tokenPatternArray})`
      : searchSupport.noMatchSql();

  // Comment/document matches are computed once per request into tagged
  // CTEs (task_id, ord) where ord 1 is the phrase pattern and ord k+1 is
  // token k. Flags and per-token coverage become cheap hashed IN probes
  // against those sets instead of per-task-row correlated subqueries.
  // Single-pattern queries stay a bare `col ILIKE pattern` so the pg_trgm
  // GIN indexes can bitmap-scan them; multi-pattern queries use one tagged
  // pass over the table (an OR/ANY form would seq-scan anyway).
  const matchPatterns = hasSearchText
    ? [containsPattern, ...tokenPatterns.filter((pattern) => pattern !== containsPattern)]
    : [];

  const matchPatternOrdinal = (pattern: string) => matchPatterns.indexOf(pattern) + 1;

  const matchPatternArray = searchSupport.sqlTextArray(matchPatterns);

  const commentMatchesCte = !hasSearchText
    ? sql`SELECT NULL::uuid AS task_id, 0 AS ord WHERE false`
    : matchPatterns.length === 1
      ? sql`
              SELECT search_comments.task_id, 1 AS ord
              FROM task_comments search_comments
              WHERE search_comments.company_id = ${companyId}
                AND search_comments.body ILIKE ${matchPatterns[0]!}
              GROUP BY 1, 2
            `
      : sql`
              SELECT search_comments.task_id, pat.ord::int AS ord
              FROM task_comments search_comments
              INNER JOIN unnest(${matchPatternArray}) WITH ORDINALITY AS pat(pattern, ord)
                ON search_comments.body ILIKE pat.pattern
              WHERE search_comments.company_id = ${companyId}
              GROUP BY 1, 2
            `;

  // Documents get one UNION ALL arm per pattern (each arm a bare
  // `col ILIKE pattern`) so the planner can pick a pg_trgm bitmap scan per
  // pattern; latest_body is large enough that skipping the seq scan for
  // selective patterns dwarfs the duplicate-recheck cost on common ones.
  const documentMatchesCte = !hasSearchText
    ? sql`SELECT NULL::uuid AS task_id, 0 AS ord WHERE false`
    : sql.join(
        matchPatterns.map(
          (pattern, index) => sql`
              SELECT search_task_documents.task_id, ${index + 1}::int AS ord
              FROM task_documents search_task_documents
              INNER JOIN documents search_documents
                ON search_documents.id = search_task_documents.document_id
                AND search_documents.company_id = search_task_documents.company_id
              WHERE search_task_documents.company_id = ${companyId}
                AND (
                  search_documents.title ILIKE ${pattern}
                  OR search_documents.latest_body ILIKE ${pattern}
                )
              GROUP BY 1, 2
            `,
        ),
        sql` UNION ALL `,
      );

  const commentMatch = hasSearchText
    ? sql<boolean>`tasks.id IN (SELECT comment_matches.task_id FROM comment_matches)`
    : searchSupport.noMatchSql();

  const documentMatch = hasSearchText
    ? sql<boolean>`tasks.id IN (SELECT document_matches.task_id FROM document_matches)`
    : searchSupport.noMatchSql();

  // Each query token (length >= MIN_FUZZY_TOKEN_LENGTH) must have at least
  // one title word within Levenshtein edit distance. This handles typos
  // like "serach" -> "search" (transposition) and "mibile" -> "mobile"
  // (substitution) without the trigram noise that drop-character variants
  // produced (e.g. "serac" matching "service"). Edit budget is gated on
  // the SHORTER of the two strings so 4–5 letter English words don't get
  // swept in by lev=2 collisions.
  const fuzzyMaxEditsExpr = sql.raw(
    `CASE
            WHEN least(length(qt.value), length(title_word.value)) >= ${searchSupport.FUZZY_PAIR_LONG_LENGTH} THEN ${searchSupport.FUZZY_PAIR_LONG_MAX_EDITS}
            WHEN least(length(qt.value), length(title_word.value)) >= ${searchSupport.FUZZY_PAIR_MEDIUM_LENGTH} THEN ${searchSupport.FUZZY_PAIR_MEDIUM_MAX_EDITS}
            ELSE ${searchSupport.FUZZY_PAIR_SHORT_MAX_EDITS}
          END`,
  );

  const fuzzyMinTitleWordLengthExpr = sql.raw(`${searchSupport.MIN_FUZZY_TOKEN_LENGTH}`);

  const fuzzyTokenTitleMatch = fuzzyTokensEnabled
    ? sql<boolean>`
            coalesce((
              SELECT bool_and(
                EXISTS (
                  SELECT 1
                  FROM regexp_split_to_table(lower(tasks.title), '[^a-z0-9]+') AS title_word(value)
                  WHERE length(title_word.value) >= ${fuzzyMinTitleWordLengthExpr}
                    AND levenshtein_less_equal(qt.value, title_word.value, ${fuzzyMaxEditsExpr}) <= ${fuzzyMaxEditsExpr}
                )
              )
              FROM unnest(${fuzzyTokenArray}) AS qt(value)
            ), false)
          `
    : searchSupport.noMatchSql();

  const fuzzyIdentifierMatch = fuzzyEnabled
    ? sql<boolean>`similarity(lower(coalesce(tasks.identifier, '')), ${normalizedQuery}) >= ${searchSupport.FUZZY_IDENTIFIER_SIMILARITY_THRESHOLD}`
    : searchSupport.noMatchSql();

  const taskTextMatch = sql<boolean>`(
          ${titlePhraseMatch}
          OR ${identifierPhraseMatch}
          OR ${requestPhraseMatch}
          OR ${titleTokenMatch}
          OR ${identifierTokenMatch}
          OR ${requestTokenMatch}
        )`;

  const fuzzyMatch = sql<boolean>`(${fuzzyTokenTitleMatch} OR ${fuzzyIdentifierMatch})`;

  const anySearchMatch = sql<boolean>`(${taskTextMatch} OR ${commentMatch} OR ${documentMatch} OR ${fuzzyMatch})`;

  const taskFilters = searchSupport.taskFilterConditions(companyId, query);

  const hasTaskOnlyFilters = searchSupport.taskOnlyFiltersActive(query);

  // Scope conditions over precomputed flag columns (alias-qualified).
  function flagTextMatch(alias: string) {
    return sql<boolean>`(
            ${sql.raw(alias)}.title_phrase OR ${sql.raw(alias)}.ident_phrase OR ${sql.raw(alias)}.request_phrase
            OR ${sql.raw(alias)}.title_token OR ${sql.raw(alias)}.ident_token OR ${sql.raw(alias)}.request_token
          )`;
  }

  function flagFuzzyMatch(alias: string) {
    return sql<boolean>`(${sql.raw(alias)}.fuzzy_title OR ${sql.raw(alias)}.fuzzy_ident)`;
  }

  function flagScopeCondition(alias: string, forScope: CompanySearchScope): SQL<boolean> {
    if (!hasSearchText) {
      return forScope === "comments" || forScope === "documents"
        ? searchSupport.noMatchSql()
        : sql<boolean>`true`;
    }
    if (forScope === "comments") return sql<boolean>`${sql.raw(alias)}.comment_match`;
    if (forScope === "documents") return sql<boolean>`${sql.raw(alias)}.document_match`;
    if (forScope === "tasks") return sql<boolean>`(${flagTextMatch(alias)} OR ${flagFuzzyMatch(alias)})`;
    return sql<boolean>`(${flagTextMatch(alias)} OR ${sql.raw(alias)}.comment_match OR ${sql.raw(alias)}.document_match OR ${flagFuzzyMatch(alias)})`;
  }
  return {
    normalizedQuery,
    hasSearchText,
    tokens,
    scope,
    sort,
    limit,
    offset,
    fetchLimit,
    escapedTokens,
    tokenPatterns,
    tokenPatternArray,
    fuzzyTokens,
    fuzzyTokenArray,
    escapedQuery,
    containsPattern,
    startsWithPattern,
    fuzzyEnabled,
    fuzzyTokensEnabled,
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
    matchPatterns,
    matchPatternOrdinal,
    matchPatternArray,
    commentMatchesCte,
    documentMatchesCte,
    commentMatch,
    documentMatch,
    fuzzyMaxEditsExpr,
    fuzzyMinTitleWordLengthExpr,
    fuzzyTokenTitleMatch,
    fuzzyIdentifierMatch,
    taskTextMatch,
    fuzzyMatch,
    anySearchMatch,
    taskFilters,
    hasTaskOnlyFilters,
    flagTextMatch,
    flagFuzzyMatch,
    flagScopeCondition,
  };
}
export type CompanySearchMatchPlan = ReturnType<typeof buildCompanySearchMatchPlan>;
