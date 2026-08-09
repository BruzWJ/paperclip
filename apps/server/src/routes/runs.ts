import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  ISSUE_EXECUTION_RUN_STATUSES,
  issueExecutionWatchdogDecisionInputSchema,
  normalizeIssueIdentifier,
  type IssueExecutionRunEnvelopeRecord,
  type IssueExecutionRunListPageRecord,
  type IssueExecutionRunStatus,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  listIssueExecutionRunsForActivity,
  listIssueExecutionRunsForAgent,
  listIssueExecutionRunsForIssue,
  resolveIssueExecutionRunIdentityById,
  type IssueExecutionRunEnvelope,
  type IssueExecutionRunListCursor,
  type IssueExecutionRunService,
} from "../services/issue-execution-run-service.js";
import {
  accessService,
  issueService,
} from "../services/index.js";
import {
  createIssueExecutionWatchdogDecisionService,
} from "../services/issue-execution-watchdog-decisions.js";
import type {
  AdapterConfigurationPreflightService,
} from "../services/adapter-configuration-preflight.js";
import {
  assertBoard,
  assertCompanyAccess,
  getAccessibleResource,
  hasCompanyAccess,
} from "./authz.js";

const MAX_RUN_DETAIL_LIMIT = 500;
const MAX_RUN_LIST_LIMIT = 200;
const RUN_STATUSES = new Set<string>(ISSUE_EXECUTION_RUN_STATUSES);

function encodeRunListCursor(cursor: IssueExecutionRunListCursor | null) {
  if (!cursor) return null;
  return Buffer.from(
    JSON.stringify({
      version: 1,
      createdAt: cursor.createdAt,
      runId: cursor.runId,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeRunListCursor(value: unknown): IssueExecutionRunListCursor | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 1000) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      Object.keys(parsed).length !== 3 ||
      parsed.version !== 1 ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.runId !== "string" ||
      parsed.runId.length === 0
    ) {
      return null;
    }
    if (!Number.isFinite(new Date(parsed.createdAt).getTime())) return null;
    return { createdAt: parsed.createdAt, runId: parsed.runId };
  } catch {
    return null;
  }
}

function runListLimit(value: unknown): number {
  if (typeof value !== "string" || value.trim().length === 0) return 100;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? Math.min(parsed, MAX_RUN_LIST_LIMIT)
    : 100;
}

function runStatuses(value: unknown): readonly IssueExecutionRunStatus[] | null {
  if (value === undefined) return null;
  const source = Array.isArray(value) ? value : [value];
  const statuses = source.flatMap((entry) =>
    typeof entry === "string" ? entry.split(",") : [],
  );
  if (
    statuses.length === 0 ||
    new Set(statuses).size !== statuses.length ||
    statuses.some((status) => !RUN_STATUSES.has(status))
  ) {
    return null;
  }
  return statuses as IssueExecutionRunStatus[];
}

function serializeRunEnvelope(
  run: IssueExecutionRunEnvelope,
): IssueExecutionRunEnvelopeRecord {
  return {
    id: run.runId,
    companyId: run.companyId,
    issueId: run.issueId,
    sessionId: run.sessionId,
    executionScopeId: run.executionScopeId,
    kind: run.kind,
    status: run.status,
    ownershipEpoch: run.ownershipEpoch,
    targetAgentId: run.targetAgentId,
    adapterConfigRevisionId: run.adapterConfigRevisionId,
    executionMode: run.executionMode,
    issueExecutionAuthorityId: run.issueExecutionAuthorityId,
    consultExecutionId: run.consultExecutionId,
    parentRunId: run.parentRunId,
    retryOfRunId: run.retryOfRunId,
    currentAttemptId: run.currentAttemptId,
    currentLeaseId: run.currentLeaseId,
    cancellationIntentId: run.cancellationIntentId,
    terminalFinalizationId: run.terminalFinalizationId,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    terminalClassification: run.terminalClassification,
    terminalReasonCode: run.terminalReasonCode,
    processExitCode: run.processExitCode,
    processSignal: run.processSignal,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function runDetailLimit(value: unknown): number {
  if (typeof value !== "string" || value.trim().length === 0) return 200;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? Math.min(parsed, MAX_RUN_DETAIL_LIMIT)
    : 200;
}

export function runRoutes(
  db: Db,
  runService: Pick<IssueExecutionRunService, "readJoinedRunDetail">,
  adapterConfigurationPreflight: AdapterConfigurationPreflightService,
) {
  const router = Router();
  const watchdogDecisions = createIssueExecutionWatchdogDecisionService(db);
  const issues = issueService(db);
  const access = accessService(db);

  async function resolveIssueByRef(rawId: string) {
    const identifier = normalizeIssueIdentifier(rawId);
    return identifier
      ? issues.getByIdentifier(identifier)
      : issues.getById(rawId);
  }

  async function issueReadAllowed(
    req: Parameters<typeof assertCompanyAccess>[0],
    issue: {
      id: string;
      companyId: string;
      projectId: string | null;
      parentId: string | null;
      ownerAgentId: string | null;
      ownerUserId: string | null;
    },
  ) {
    return access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        ownerAgentId: issue.ownerAgentId,
        ownerUserId: issue.ownerUserId,
      },
    });
  }

  router.get("/companies/:companyId/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId =
      typeof req.query.agentId === "string" && req.query.agentId.length > 0
        ? req.query.agentId
        : null;
    const cursor = decodeRunListCursor(req.query.cursor);
    if (req.query.cursor !== undefined && !cursor) {
      res.status(400).json({ error: "Invalid run list cursor" });
      return;
    }
    const statuses = runStatuses(req.query.status);
    if (req.query.status !== undefined && !statuses) {
      res.status(400).json({ error: "Invalid run status filter" });
      return;
    }
    const page = agentId
      ? await listIssueExecutionRunsForAgent(db, {
          companyId,
          targetAgentId: agentId,
          cursor,
          limit: runListLimit(req.query.limit),
          statuses: statuses ?? undefined,
        })
      : await listIssueExecutionRunsForActivity(db, {
          companyId,
          cursor,
          limit: runListLimit(req.query.limit),
          statuses: statuses ?? undefined,
        });
    const response: IssueExecutionRunListPageRecord = {
      items: page.items.map(serializeRunEnvelope),
      nextCursor: encodeRunListCursor(page.nextCursor),
    };
    res.json(response);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const issue = await getAccessibleResource(
      req,
      res,
      resolveIssueByRef(req.params.id as string),
      "Issue not found",
    );
    if (!issue) return;
    const decision = await issueReadAllowed(req, issue);
    if (!decision.allowed) {
      res.status(403).json({
        error: "Issue runs are outside this actor's authorization boundary",
      });
      return;
    }
    const cursor = decodeRunListCursor(req.query.cursor);
    if (req.query.cursor !== undefined && !cursor) {
      res.status(400).json({ error: "Invalid run list cursor" });
      return;
    }
    const statuses = runStatuses(req.query.status);
    if (req.query.status !== undefined && !statuses) {
      res.status(400).json({ error: "Invalid run status filter" });
      return;
    }
    const page = await listIssueExecutionRunsForIssue(db, {
      companyId: issue.companyId,
      issueId: issue.id,
      cursor,
      limit: runListLimit(req.query.limit),
      statuses: statuses ?? undefined,
    });
    const response: IssueExecutionRunListPageRecord = {
      items: page.items.map(serializeRunEnvelope),
      nextCursor: encodeRunListCursor(page.nextCursor),
    };
    res.json(response);
  });

  async function accessibleIdentity(
    req: Parameters<typeof assertCompanyAccess>[0],
    res: Parameters<Router["get"]>[1] extends (...args: infer T) => unknown
      ? T[1]
      : never,
    runId: string,
  ) {
    const identity = await resolveIssueExecutionRunIdentityById(db, runId);
    if (!identity || !hasCompanyAccess(req, identity.companyId)) {
      res.status(404).json({ error: "Issue execution run not found" });
      return null;
    }
    assertCompanyAccess(req, identity.companyId);
    return identity;
  }

  router.get("/runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const identity = await accessibleIdentity(req, res, runId);
    if (!identity) return;
    const detail = await runService.readJoinedRunDetail({
      ...identity,
      limit: runDetailLimit(req.query.limit),
      sessionProjection: "audit",
      sessionEventCursor:
        typeof req.query.eventCursor === "string"
          ? req.query.eventCursor
          : null,
      sessionMessageCursor:
        typeof req.query.messageCursor === "string"
          ? req.query.messageCursor
          : null,
    });
    if (!detail) {
      res.status(404).json({ error: "Issue execution run not found" });
      return;
    }
    res.json({
      ...detail,
      run: serializeRunEnvelope(detail.run),
    });
  });

  router.post(
    "/runs/:runId/runtime-readiness",
    async (req, res) => {
      assertBoard(req);
      const runId = req.params.runId as string;
      const identity = await accessibleIdentity(req, res, runId);
      if (!identity) return;
      res.json(
        await adapterConfigurationPreflight.inspect(identity),
      );
    },
  );

  router.post(
    "/runs/:runId/watchdog-decisions",
    validate(issueExecutionWatchdogDecisionInputSchema),
    async (req, res) => {
      assertBoard(req);
      const runId = req.params.runId as string;
      const identity = await accessibleIdentity(req, res, runId);
      if (!identity) return;
      const row = await watchdogDecisions.record({
        runId: identity.runId,
        actor: { kind: "user", userId: req.actor.userId },
        decision: req.body,
      });
      res.status(201).json(row);
    },
  );

  return router;
}
