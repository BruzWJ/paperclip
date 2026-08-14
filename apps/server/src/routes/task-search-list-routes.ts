import {
  companySearchExtractQuerySchema,
  companySearchQuerySchema,
  validationDetails,
} from "@paperclipai/shared";
import {
  parseStatusFilter,
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_MAX_LIMIT,
  type TaskFilters,
} from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskSearchListRoutesContext = Pick<
  TaskRouteContext,
  | "opts"
  | "router"
  | "svc"
  | "access"
  | "getSearchService"
  | "searchRateLimiter"
  | "parseBooleanQuery"
  | "parseOptionalBooleanQuery"
  | "parseOptionalCanonicalUuidQuery"
  | "parseOptionalExactNonBlankQuery"
  | "filterTasksForActor"
  | "actorCanReadCompanyScope"
  | "companySearchRateLimitActor"
  | "toPublicTask"
  | "toCompactTask"
  | "compactTaskListEtag"
  | "requestMatchesEtag"
  | "TASK_LIST_QUERY_KEYS"
  | "taskListRequestKey"
  | "coordinateTaskListGet"
  | "estimatedJsonBytes"
  | "logTaskListRequest"
>;

export function registerTaskSearchAndListRoutes(context: TaskSearchListRoutesContext): void {
  const {
    opts,
    router,
    svc,
    access,
    getSearchService,
    searchRateLimiter,
    parseBooleanQuery,
    parseOptionalBooleanQuery,
    parseOptionalCanonicalUuidQuery,
    parseOptionalExactNonBlankQuery,
    filterTasksForActor,
    actorCanReadCompanyScope,
    companySearchRateLimitActor,
    toPublicTask,
    toCompactTask,
    compactTaskListEtag,
    requestMatchesEtag,
    TASK_LIST_QUERY_KEYS,
    taskListRequestKey,
    coordinateTaskListGet,
    estimatedJsonBytes,
    logTaskListRequest,
  } = context;

  router.get("/companies/:companyId/search/extract", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const companyScopeDecision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!companyScopeDecision.allowed) {
      res.status(403).json({
        error: "Company search is outside this actor's authorization boundary",
      });
      return;
    }
    const parsedQuery = companySearchExtractQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: validationDetails(parsedQuery.error)[0]?.message ?? "Invalid extract search query",
      });
      return;
    }
    const rateLimit = searchRateLimiter.consume(companySearchRateLimitActor(req, companyId));
    res.setHeader("X-RateLimit-Limit", String(rateLimit.limit));
    res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      res.status(429).json({
        error: "Search rate limit exceeded",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    const result = await getSearchService().extract(companyId, parsedQuery.data);
    res.json(result);
  });

  router.get("/companies/:companyId/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const companyScopeDecision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!companyScopeDecision.allowed) {
      res.status(403).json({
        error: "Company search is outside this actor's authorization boundary",
      });
      return;
    }
    const parsedQuery = companySearchQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: validationDetails(parsedQuery.error)[0]?.message ?? "Invalid search query",
      });
      return;
    }
    const rateLimit = searchRateLimiter.consume(companySearchRateLimitActor(req, companyId));
    res.setHeader("X-RateLimit-Limit", String(rateLimit.limit));
    res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      res.status(429).json({
        error: "Search rate limit exceeded",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    const result = await getSearchService().search(companyId, parsedQuery.data);
    res.json(result);
  });

  router.get("/companies/:companyId/tasks", async (req, res) => {
    const startedAt = Date.now();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const unsupportedQueryKeys = Object.keys(req.query)
      .filter((key) => !TASK_LIST_QUERY_KEYS.has(key))
      .sort();
    if (unsupportedQueryKeys.length > 0) {
      res.status(422).json({
        error: `Unsupported task-list query parameter${unsupportedQueryKeys.length === 1 ? "" : "s"}: ${unsupportedQueryKeys.join(", ")}`,
      });
      return;
    }
    const ownerUserFilterRaw = req.query.ownerUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const ownerUserId = ownerUserFilterRaw;
    const touchedByUserId = touchedByUserFilterRaw;
    const inboxArchivedByUserId = inboxArchivedByUserFilterRaw;
    const unreadForUserId = unreadForUserFilterRaw;
    const rawLimit = req.query.limit;
    const parsedLimit = typeof rawLimit === "string" && /^[1-9]\d*$/.test(rawLimit) ? Number(rawLimit) : null;
    const limit = parsedLimit ?? TASK_LIST_DEFAULT_LIMIT;
    const rawOffset = req.query.offset;
    const parsedOffset =
      typeof rawOffset === "string" && /^(?:0|[1-9]\d*)$/.test(rawOffset) ? Number(rawOffset) : null;
    const attention = req.query.attention as string | undefined;
    const sortField = req.query.sortField as string | undefined;
    const sortDir = req.query.sortDir as string | undefined;
    const view = req.query.view as string | undefined;
    const compactView = view === "compact";
    const hasPlanDocument = parseOptionalBooleanQuery(req.query.hasPlanDocument, "hasPlanDocument");
    const includeLiveDescendantSummary = parseOptionalBooleanQuery(
      req.query.includeLiveDescendantSummary,
      "includeLiveDescendantSummary",
    );
    const ownerAgentId = parseOptionalCanonicalUuidQuery(req.query.ownerAgentId, "ownerAgentId");
    const participantAgentId = parseOptionalCanonicalUuidQuery(
      req.query.participantAgentId,
      "participantAgentId",
    );
    const projectId = parseOptionalCanonicalUuidQuery(req.query.projectId, "projectId");
    const parentId = parseOptionalCanonicalUuidQuery(req.query.parentId, "parentId");
    const descendantOf = parseOptionalCanonicalUuidQuery(req.query.descendantOf, "descendantOf");
    const labelId = parseOptionalCanonicalUuidQuery(req.query.labelId, "labelId");
    const originKind = parseOptionalExactNonBlankQuery(req.query.originKind, "originKind");
    const originId = parseOptionalExactNonBlankQuery(req.query.originId, "originId");

    for (const [field, value] of Object.entries({
      ownerUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
    })) {
      if (
        value !== undefined &&
        (typeof value !== "string" || value.length === 0 || value.trim() !== value)
      ) {
        res.status(422).json({ error: `${field} must be an exact non-blank user ID` });
        return;
      }
    }
    if (attention !== undefined && attention !== "blocked") {
      res.status(400).json({ error: "attention must be 'blocked' when provided" });
      return;
    }
    if (view !== undefined && view !== "compact") {
      res.status(400).json({ error: "view must be 'compact' when provided" });
      return;
    }
    if (
      rawLimit !== undefined &&
      (parsedLimit === null ||
        !Number.isSafeInteger(parsedLimit) ||
        parsedLimit <= 0 ||
        parsedLimit > TASK_LIST_MAX_LIMIT)
    ) {
      res.status(400).json({
        error: `limit must be a positive integer up to ${TASK_LIST_MAX_LIMIT}`,
      });
      return;
    }
    if (
      rawOffset !== undefined &&
      (parsedOffset === null || !Number.isSafeInteger(parsedOffset) || parsedOffset < 0)
    ) {
      res.status(400).json({ error: "offset must be a non-negative integer" });
      return;
    }
    if (sortField !== undefined && sortField !== "updated") {
      res.status(400).json({ error: "sortField must be 'updated' when provided" });
      return;
    }
    if (sortDir !== undefined && sortDir !== "asc" && sortDir !== "desc") {
      res.status(400).json({ error: "sortDir must be 'asc' or 'desc' when provided" });
      return;
    }
    const offset = parsedOffset ?? 0;

    const listFilters: TaskFilters = {
      attention: attention === "blocked" ? "blocked" : undefined,
      status: parseStatusFilter(req.query.status),
      ownerAgentId,
      participantAgentId,
      ownerUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId,
      parentId,
      descendantOf,
      labelId,
      originKind,
      originId,
      excludeRoutineExecutions: parseBooleanQuery(
        req.query.excludeRoutineExecutions,
        "excludeRoutineExecutions",
      ),
      includeBlockedBy: parseBooleanQuery(req.query.includeBlockedBy, "includeBlockedBy"),
      includeBlockedInboxAttention: parseBooleanQuery(
        req.query.includeBlockedInboxAttention,
        "includeBlockedInboxAttention",
      ),
      includeLiveDescendantSummary: includeLiveDescendantSummary === true,
      hasPlanDocument,
      q: parseOptionalExactNonBlankQuery(req.query.q, "q"),
      limit,
      offset,
      sortField: sortField === "updated" ? "updated" : undefined,
      sortDir: sortDir === "asc" || sortDir === "desc" ? sortDir : undefined,
    };
    const requestKey = taskListRequestKey({
      req,
      companyId,
      normalizedQuery: {
        ...listFilters,
        view: compactView ? "compact" : undefined,
      },
    });
    const coordinated = await coordinateTaskListGet({
      req,
      companyId,
      requestKey,
      allowTtlCache: compactView,
      diagnostics: opts.taskListDiagnostics,
      compute: async () => {
        const rawResult = await svc.list(companyId, listFilters);
        const result = (await actorCanReadCompanyScope(req, companyId))
          ? rawResult
          : await filterTasksForActor(req, rawResult);
        if (compactView) {
          const compactResult = result.map((task) => toCompactTask(task));
          return {
            kind: "compact",
            body: compactResult,
            etag: compactTaskListEtag(compactResult),
            cacheControl: "private, must-revalidate",
          };
        }
        return {
          kind: "full",
          body: result.map((task) => toPublicTask(task)),
        };
      },
    });

    res.setHeader("X-Paperclip-Request-Cache", coordinated.cacheStatus);
    if (!coordinated.response) {
      const body = {
        error: "Too many concurrent task-list requests for this actor/client",
        retryAfterSeconds: coordinated.retryAfterSeconds ?? 1,
      };
      res.setHeader("Retry-After", String(body.retryAfterSeconds));
      logTaskListRequest({
        req,
        res,
        companyId,
        requestKey,
        startedAt,
        cacheStatus: "retry",
        bodyBytes: estimatedJsonBytes(body),
        etagOutcome: "none",
        identicalInFlightCount: coordinated.identicalInFlightCount,
      });
      res.status(429).json(body);
      return;
    }

    if (coordinated.response.kind === "compact") {
      res.setHeader("Cache-Control", coordinated.response.cacheControl);
      res.setHeader("ETag", coordinated.response.etag);
      const etagMatched = requestMatchesEtag(req.header("if-none-match"), coordinated.response.etag);
      logTaskListRequest({
        req,
        res,
        companyId,
        requestKey,
        startedAt,
        cacheStatus: coordinated.cacheStatus,
        bodyBytes: etagMatched ? 0 : estimatedJsonBytes(coordinated.response.body),
        etagOutcome: etagMatched ? "not_modified" : "fresh",
        identicalInFlightCount: coordinated.identicalInFlightCount,
      });
      if (etagMatched) {
        res.status(304).end();
        return;
      }
      res.json(coordinated.response.body);
      return;
    }

    logTaskListRequest({
      req,
      res,
      companyId,
      requestKey,
      startedAt,
      cacheStatus: coordinated.cacheStatus,
      bodyBytes: estimatedJsonBytes(coordinated.response.body),
      etagOutcome: "none",
      identicalInFlightCount: coordinated.identicalInFlightCount,
    });
    res.json(coordinated.response.body);
  });
}
