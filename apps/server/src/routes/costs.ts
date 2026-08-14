import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createFinanceEventSchema,
  resolveBudgetIncidentSchema,
  updateCompanyBudgetSchema,
  upsertBudgetPolicySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  budgetService,
  costService,
  financeService,
  taskService,
  accessService,
  logActivity,
  createAgentOperationalConfigurationService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";
import { badRequest } from "../errors.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { TaskExecutionCancellationService } from "../services/task-execution-cancellation.js";
import {
  assertExactQueryKeys,
  parseExactBooleanQuery,
  parseExactPositiveIntegerQuery,
} from "./exact-query.js";

export function parseCostDateRange(query: Record<string, unknown>) {
  const fromRaw = query.from;
  const toRaw = query.to;
  const parseDate = (value: unknown, field: "from" | "to") => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
      throw badRequest(`invalid '${field}' date`);
    }
    const parsed = new Date(value);
    if (isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
      throw badRequest(`invalid '${field}' date`);
    }
    return parsed;
  };
  const from = parseDate(fromRaw, "from");
  const to = parseDate(toRaw, "to");
  return from || to ? { from, to } : undefined;
}

export function parseCostLimit(query: Record<string, unknown>) {
  return parseExactPositiveIntegerQuery(query.limit, "limit", {
    defaultValue: 100,
    max: 500,
  });
}

export function costRoutes(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    taskExecutionCancellation: Pick<TaskExecutionCancellationService, "suspendBudgetScopeWork">;
  },
) {
  const router = Router({ caseSensitive: true, strict: true });
  const budgetHooks = {
    suspendWorkForScope: options.taskExecutionCancellation.suspendBudgetScopeWork,
  };
  const costs = costService(db);
  const finance = financeService(db);
  const budgets = budgetService(db, budgetHooks);
  const agentOperationalConfigurations = createAgentOperationalConfigurationService(db, budgetHooks);
  const tasks = taskService(db);
  const access = accessService(db);

  async function assertCompanyCostReadAllowed(
    req: Parameters<typeof assertCompanyAccess>[0],
    res: any,
    companyId: string,
  ) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Costs are outside this actor's authorization boundary" });
    return false;
  }

  async function assertTaskCostReadAllowed(
    req: Parameters<typeof assertCompanyAccess>[0],
    res: any,
    task: {
      id: string;
      companyId: string;
      projectId: string | null;
      parentId: string | null;
      ownerAgentId: string | null;
      ownerUserId: string | null;
      boardPresentationStatus: string;
    },
  ) {
    const decision = await access.decide({
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
    if (decision.allowed) return true;
    res.status(403).json({
      error: "Task costs are outside this actor's authorization boundary",
    });
    return false;
  }

  router.post(
    "/companies/:companyId/finance-events",
    validate(createFinanceEventSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);

      const event = await finance.createEvent(companyId, {
        ...req.body,
        occurredAt: new Date(req.body.occurredAt),
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "finance_event.reported",
        entityType: "finance_event",
        entityId: event.id,
        details: {
          amount: event.amount,
          currency: event.currency,
          biller: event.biller,
          eventKind: event.eventKind,
          direction: event.direction,
        },
      });

      res.status(201).json(event);
    },
  );

  router.get("/companies/:companyId/costs/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    assertExactQueryKeys(req.query, ["from", "to"]);
    const range = parseCostDateRange(req.query);
    const summary = await costs.summary(companyId, range);
    res.json(summary);
  });

  router.get("/tasks/:id/cost-summary", async (req, res) => {
    const taskId = req.params.id as string;
    const task = await getAccessibleResource(req, res, tasks.getById(taskId), "Task not found");
    if (!task) return;
    if (!(await assertTaskCostReadAllowed(req, res, task))) return;
    assertExactQueryKeys(req.query, ["excludeRoot"]);
    const excludeRoot = parseExactBooleanQuery(req.query.excludeRoot, "excludeRoot");
    const summary = await costs.taskTreeSummary(task.companyId, task.id, {
      excludeRoot,
    });
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    assertExactQueryKeys(req.query, ["from", "to"]);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byAgent(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/cost-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    assertExactQueryKeys(req.query, ["from", "to", "limit"]);
    const range = parseCostDateRange(req.query);
    const limit = parseCostLimit(req.query);
    res.json(await costs.listEvents(companyId, range, limit));
  });

  router.get("/companies/:companyId/costs/finance-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    assertExactQueryKeys(req.query, ["from", "to"]);
    const range = parseCostDateRange(req.query);
    const summary = await finance.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/finance-by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    assertExactQueryKeys(req.query, ["from", "to"]);
    const range = parseCostDateRange(req.query);
    const rows = await finance.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-by-kind", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    assertExactQueryKeys(req.query, ["from", "to"]);
    const range = parseCostDateRange(req.query);
    const rows = await finance.byKind(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    assertExactQueryKeys(req.query, ["from", "to", "limit"]);
    const range = parseCostDateRange(req.query);
    const limit = parseCostLimit(req.query);
    const rows = await finance.list(companyId, range, limit);
    res.json(rows);
  });

  router.get("/companies/:companyId/budgets/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const overview = await budgets.overview(companyId);
    res.json(overview);
  });

  router.post(
    "/companies/:companyId/budgets/policies",
    validate(upsertBudgetPolicySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.body.scopeType === "agent") {
        res.status(422).json({
          error: "Agent budgets must be updated through the agent operational-configuration endpoint",
          code: "agent_budget_requires_operational_configuration",
          agentId: req.body.scopeId,
        });
        return;
      }
      const summary = await budgets.upsertPolicy(companyId, req.body, req.actor.userId);
      res.json(summary);
    },
  );

  router.post(
    "/companies/:companyId/budget-incidents/:incidentId/resolve",
    validate(resolveBudgetIncidentSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const incidentId = req.params.incidentId as string;
      assertCompanyAccess(req, companyId);
      const scope = await budgets.getIncidentScope(companyId, incidentId);
      const incident =
        scope.scopeType === "agent"
          ? await agentOperationalConfigurations.resolveBudgetIncident({
              companyId,
              incidentId,
              resolution: req.body,
              actorUserId: req.actor.userId,
            })
          : await budgets.resolveIncident(companyId, incidentId, req.body, req.actor.userId);
      res.json(incident);
    },
  );

  router.get("/companies/:companyId/costs/by-project", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    assertExactQueryKeys(req.query, ["from", "to"]);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byProject(companyId, range);
    res.json(rows);
  });

  router.patch("/companies/:companyId/budgets", validate(updateCompanyBudgetSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await budgets.setCompanyMonthlyLimit(
      companyId,
      req.body.budgetMonthlyAmount,
      req.actor.userId,
    );
    res.json(summary);
  });

  return router;
}
