import type { Db } from "@paperclipai/db";
import { registerAgentConfigurationRoutes } from "./agent-configuration-routes.js";
import {
  createAgentRouteContext,
  type AgentRouteOptions,
  type AgentRouteContext,
} from "./agent-route-context.js";

import {
  agentAdapterConfigurationTestInputSchema,
  type InvokableTaskOwnerCatalogEntry,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { resolveInvokableTaskOwnerCatalogFromDb } from "../services/agent-invokability.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";
import { assertExactQueryKeys, parseExactOptionalEnum } from "./exact-query.js";
import { ORG_CHART_STYLES, renderOrgChartPng, renderOrgChartSvg, type OrgNode } from "./org-chart-svg.js";

import { notFound } from "../errors.js";
import { logActivity } from "../services/index.js";
import {
  adoptPluginManagedAgentFromBoard,
  terminatePluginManagedAgentFromBoard,
} from "../services/plugin-managed-agents.js";

type AgentLifecycleRoutesContext = Pick<
  AgentRouteContext,
  | "router"
  | "db"
  | "options"
  | "svc"
  | "approvalsSvc"
  | "assertNotPluginManagedTriage"
  | "getAccessibleAgent"
  | "assertCanUpdateAgent"
>;

export function registerAgentLifecycleRoutes(context: AgentLifecycleRoutesContext): void {
  const {
    router,
    db,
    options,
    svc,
    approvalsSvc,
    assertNotPluginManagedTriage,
    getAccessibleAgent,
    assertCanUpdateAgent,
  } = context;

  router.post("/agents/:id/pause", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    if (existing.status === "pending_approval") {
      const managedTermination = await terminatePluginManagedAgentFromBoard(
        db,
        {
          companyId: existing.companyId,
          agentId: existing.id,
          actorUserId: req.actor.userId,
        },
        {
          taskExecutionCancellation: options.taskExecutionCancellation,
          dispatchRef: options.ordinaryTasks.dispatchRef,
        },
      );
      if (!managedTermination) {
        const openApproval = await approvalsSvc.findOpenHireApprovalForAgent(existing.companyId, id);
        if (openApproval) {
          await approvalsSvc.reject(
            openApproval.id,
            req.actor.userId,
            "Hire rejected because the pending agent was paused",
          );
        } else {
          await svc.terminate(id, {
            actor: { kind: "user", userId: req.actor.userId },
            taskExecutionCancellation: options.taskExecutionCancellation,
            dispatchRef: options.ordinaryTasks.dispatchRef,
          });
        }
      }
      const terminated = await svc.getById(id);
      if (!terminated) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await logActivity(db, {
        companyId: terminated.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "agent.pending_hire_rejected",
        entityType: "agent",
        entityId: terminated.id,
        details: { requestedAction: "pause" },
      });
      res.json(terminated);
      return;
    }
    await assertNotPluginManagedTriage(existing);
    const agent = await svc.pause(id, {
      actor: { kind: "user", userId: req.actor.userId },
      taskExecutionCancellation: options.taskExecutionCancellation,
    });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/resume", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    await assertNotPluginManagedTriage(existing);
    const agent = await svc.resume(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/clear-error", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    if (existing.orgChainHealth?.status === "invalid_org_chain") {
      res.status(409).json({
        error:
          existing.orgChainHealth?.repairGuidance ??
          "Repair this agent's reporting chain before clearing its error",
      });
      return;
    }

    const agent = await svc.clearError(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "agent.error_cleared",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/terminate", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }

    // Terminating an agent that is still awaiting approval is the agent-detail
    // equivalent of rejecting the hire. When a linked hire approval is still
    // open, delegate to approvalsSvc.reject(), which both resolves the approval
    // (clearing the inbox "Approve/Reject" card) and terminates the agent.
    // Mirror the approve path's exclusive branch so we never terminate twice:
    // reject() already enters the canonical tombstone transaction.
    let agent: Awaited<ReturnType<typeof svc.terminate>> = null;
    const managedTermination = await terminatePluginManagedAgentFromBoard(
      db,
      {
        companyId: existing.companyId,
        agentId: existing.id,
        actorUserId: req.actor.userId,
      },
      {
        taskExecutionCancellation: options.taskExecutionCancellation,
        dispatchRef: options.ordinaryTasks.dispatchRef,
      },
    );
    if (managedTermination) {
      agent = await svc.getById(id);
    } else {
      const openApproval = await approvalsSvc.findOpenHireApprovalForAgent(existing.companyId, id);
      if (openApproval) {
        await approvalsSvc.reject(openApproval.id, req.actor.userId);
        agent = await svc.getById(id);
      }
    }
    if (!agent) {
      agent = await svc.terminate(id, {
        actor: { kind: "user", userId: req.actor.userId },
        taskExecutionCancellation: options.taskExecutionCancellation,
        dispatchRef: options.ordinaryTasks.dispatchRef,
      });
    }
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.json(agent);
  });

  router.post("/agents/:id/plugin-management/adopt", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) return;
    await assertCanUpdateAgent(req, existing);

    const pluginManagement = await adoptPluginManagedAgentFromBoard(db, {
      companyId: existing.companyId,
      agentId: existing.id,
      actorUserId: req.actor.userId,
    });
    const agent = await svc.getById(existing.id);
    if (!agent) throw notFound("Agent not found after adoption");
    res.json({
      agent: agent,
      pluginManagement,
    });
  });
}

type AgentReadRoutesContext = Pick<
  AgentRouteContext,
  | "router"
  | "db"
  | "svc"
  | "adapterConfigurationDraftTest"
  | "assertAgentReadAllowed"
  | "filterAgentsForActor"
  | "buildAgentDetail"
  | "assertCanCreateAgentsForCompany"
  | "toLeanOrgNode"
>;

export function registerAgentReadRoutes(context: AgentReadRoutesContext): void {
  const {
    router,
    db,
    svc,
    adapterConfigurationDraftTest,
    assertAgentReadAllowed,
    filterAgentsForActor,
    buildAgentDetail,
    assertCanCreateAgentsForCompany,
    toLeanOrgNode,
  } = context;

  router.post(
    "/companies/:companyId/adapters/:type/test-configuration",
    validate(agentAdapterConfigurationTestInputSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanCreateAgentsForCompany(req, companyId);
      res.json(
        await adapterConfigurationDraftTest.test({
          adapterType: req.params.type as string,
          adapterConfig: req.body.adapterConfig,
        }),
      );
    },
  );

  router.get("/companies/:companyId/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const unsupportedQueryParams = Object.keys(req.query).sort();
    if (unsupportedQueryParams.length > 0) {
      res.status(400).json({
        error: `Unsupported query parameter${unsupportedQueryParams.length === 1 ? "" : "s"}: ${unsupportedQueryParams.join(", ")}`,
      });
      return;
    }
    const result = await filterAgentsForActor(req, await svc.list(companyId));
    res.json(result);
  });

  router.get("/companies/:companyId/task-owner-catalog", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const catalog = await resolveInvokableTaskOwnerCatalogFromDb(db, {
      companyId,
    });
    const entries: InvokableTaskOwnerCatalogEntry[] = [...catalog.values()]
      .map(({ owner }) => ({
        id: owner.id,
        name: owner.name,
        title: owner.title ?? null,
        icon: owner.icon ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    res.json(entries);
  });

  router.get("/companies/:companyId/org", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tree = await filterAgentsForActor(req, await svc.orgForCompany(companyId));
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    res.json(leanTree);
  });

  router.get("/companies/:companyId/org.svg", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertExactQueryKeys(req.query, ["style"]);
    const style = parseExactOptionalEnum(req.query.style, "style", ORG_CHART_STYLES) ?? "warmth";
    const tree = await filterAgentsForActor(req, await svc.orgForCompany(companyId));
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const svg = renderOrgChartSvg(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache");
    res.send(svg);
  });

  router.get("/companies/:companyId/org.png", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertExactQueryKeys(req.query, ["style"]);
    const style = parseExactOptionalEnum(req.query.style, "style", ORG_CHART_STYLES) ?? "warmth";
    const tree = await filterAgentsForActor(req, await svc.orgForCompany(companyId));
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const png = await renderOrgChartPng(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(png);
  });

  router.get("/agents/:id", async (req, res) => {
    const id = req.params.id as string;
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return;
    if (!(await assertAgentReadAllowed(req, res, agent))) return;
    res.json(
      await buildAgentDetail(agent, {
        restricted: req.actor.type !== "board",
      }),
    );
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    const id = req.params.id as string;
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return;
    if (!(await assertAgentReadAllowed(req, res, agent))) return;
    res.json(await svc.getRuntimeState(agent.id));
  });
}

export function agentRoutes(db: Db, options: AgentRouteOptions) {
  const context = createAgentRouteContext(db, options);
  registerAgentReadRoutes(context);
  registerAgentConfigurationRoutes(context);
  registerAgentLifecycleRoutes(context);
  return context.router;
}
