import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  TASK_EXECUTION_RUN_STATUSES,
  normalizeTaskIdentifier,
  type TaskExecutionRunEnvelopeRecord,
  type TaskExecutionRunListPageRecord,
  type TaskExecutionRunStatus,
} from "@paperclipai/shared";
import {
  listTaskExecutionRunsForActivity,
  listTaskExecutionRunsForAgent,
  listTaskExecutionRunsForTask,
  resolveTaskExecutionRunIdentityById,
  type TaskExecutionRunEnvelope,
  type TaskExecutionRunListCursor,
  type TaskExecutionRunService,
} from "../services/task-execution-run-service.js";
import {
  accessService,
  taskService,
} from "../services/index.js";
import type {
  AdapterConfigurationPreflightService,
} from "../services/adapter-configuration-preflight.js";
import {
  assertBoard,
  assertCompanyAccess,
  getAccessibleResource,
} from "./authz.js";

const MAX_RUN_DETAIL_LIMIT = 500;
const MAX_RUN_LIST_LIMIT = 200;
const RUN_STATUSES = new Set<string>(TASK_EXECUTION_RUN_STATUSES);

function encodeRunListCursor(cursor: TaskExecutionRunListCursor | null) {
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

function decodeRunListCursor(value: unknown): TaskExecutionRunListCursor | null {
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

function runStatuses(value: unknown): readonly TaskExecutionRunStatus[] | null {
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
  return statuses as TaskExecutionRunStatus[];
}

function serializeRunEnvelope(
  run: TaskExecutionRunEnvelope,
): TaskExecutionRunEnvelopeRecord {
  return {
    id: run.runId,
    companyId: run.companyId,
    taskId: run.taskId,
    sessionId: run.sessionId,
    executionScopeId: run.executionScopeId,
    kind: run.kind,
    status: run.status,
    ownershipEpoch: run.ownershipEpoch,
    targetAgentId: run.targetAgentId,
    adapterConfigRevisionId: run.adapterConfigRevisionId,
    executionMode: run.executionMode,
    taskExecutionAuthorityId: run.taskExecutionAuthorityId,
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
  runService: Pick<TaskExecutionRunService, "readJoinedRunDetail">,
  adapterConfigurationPreflight: AdapterConfigurationPreflightService,
) {
  const router = Router();
  const tasks = taskService(db);
  const access = accessService(db);

  async function resolveTaskByRef(rawId: string) {
    const identifier = normalizeTaskIdentifier(rawId);
    return identifier
      ? tasks.getByIdentifier(identifier)
      : tasks.getById(rawId);
  }

  async function taskReadAllowed(
    req: Parameters<typeof assertCompanyAccess>[0],
    task: {
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
      action: "task:read",
      resource: {
        type: "task",
        companyId: task.companyId,
        taskId: task.id,
        projectId: task.projectId,
        parentTaskId: task.parentId,
        ownerAgentId: task.ownerAgentId,
        ownerUserId: task.ownerUserId,
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
      ? await listTaskExecutionRunsForAgent(db, {
          companyId,
          targetAgentId: agentId,
          cursor,
          limit: runListLimit(req.query.limit),
          statuses: statuses ?? undefined,
        })
      : await listTaskExecutionRunsForActivity(db, {
          companyId,
          cursor,
          limit: runListLimit(req.query.limit),
          statuses: statuses ?? undefined,
        });
    const response: TaskExecutionRunListPageRecord = {
      items: page.items.map(serializeRunEnvelope),
      nextCursor: encodeRunListCursor(page.nextCursor),
    };
    res.json(response);
  });

  router.get("/tasks/:id/runs", async (req, res) => {
    const task = await getAccessibleResource(
      req,
      res,
      resolveTaskByRef(req.params.id as string),
      "Task not found",
    );
    if (!task) return;
    const decision = await taskReadAllowed(req, task);
    if (!decision.allowed) {
      res.status(403).json({
        error: "Task runs are outside this actor's authorization boundary",
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
    const page = await listTaskExecutionRunsForTask(db, {
      companyId: task.companyId,
      taskId: task.id,
      cursor,
      limit: runListLimit(req.query.limit),
      statuses: statuses ?? undefined,
    });
    const response: TaskExecutionRunListPageRecord = {
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
    return getAccessibleResource(
      req,
      res,
      resolveTaskExecutionRunIdentityById(db, runId),
      "Task execution run not found",
    );
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
      res.status(404).json({ error: "Task execution run not found" });
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

  return router;
}
