import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  agentAdapterConfigurationTestInputSchema,
  agentAdapterRevisionConfigurationSchema,
  agentOperationalConfigurationUpdateSchema,
  runtimeAgentCreateConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
  type AgentAdapterConfigRevision,
  type InvokableTaskOwnerCatalogEntry,
} from "@paperclipai/shared";
import { trackAgentCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  accessService,
  approvalService,
  logActivity,
  createRuntimeAgentConfigurationService,
} from "../services/index.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { OrdinaryTaskRuntime } from "../services/ordinary-task-runtime.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { renderOrgChartSvg, renderOrgChartPng, type OrgNode, ORG_CHART_STYLES } from "./org-chart-svg.js";
import { getTelemetryClient } from "../telemetry.js";
import {
  RuntimeAgentConfigurationConflict,
  RuntimeAgentConfigurationDenied,
  RuntimeAgentConfigurationInvalid,
} from "../services/runtime-agent-configuration.js";
import { createAgentAdapterConfigurationService } from "../services/agent-adapter-config-revisions.js";
import { createAgentOperationalConfigurationService } from "../services/agent-operational-configuration.js";
import { assertExactQueryKeys, parseExactOptionalEnum } from "./exact-query.js";
import {
  adoptPluginManagedAgentFromBoard,
  getPluginManagedAgentBinding,
  terminateAgentForHireRejectionInTransaction,
  terminatePluginManagedAgentFromBoard,
} from "../services/plugin-managed-agents.js";
import type { TaskSessionStore } from "../services/task-session/store.js";
import type { TaskExecutionCancellationService } from "../services/task-execution-cancellation.js";
import { resolveInvokableTaskOwnerCatalogFromDb } from "../services/agent-invokability.js";
import {
  createAdapterConfigurationDraftTestService,
} from "../services/adapter-configuration-draft-test.js";

export function agentRoutes(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    taskSessionStore?: TaskSessionStore;
    ordinaryTasks: OrdinaryTaskRuntime;
    taskExecutionCancellation: Pick<
      TaskExecutionCancellationService,
      | "requestAgentCancellationsInTransaction"
      | "reconcileRequestedCancellations"
      | "requestAgentSuspensionsInTransaction"
    >;
  },
) {
  const router = Router({ caseSensitive: true, strict: true });
  const svc = agentService(db);
  const access = accessService(db);
  const approvalsSvc = approvalService(db, {
    taskExecutionCancellation: options.taskExecutionCancellation,
    terminateHireRejectionAgentInTransaction:
      terminateAgentForHireRejectionInTransaction,
    dispatchRef: options.ordinaryTasks.dispatchRef,
  });
  const runtimeAgentConfiguration =
    createRuntimeAgentConfigurationService(db);
  const adapterConfigurations =
    createAgentAdapterConfigurationService(db);
  const operationalConfigurations =
    createAgentOperationalConfigurationService(db);
  const adapterConfigurationDraftTest =
    createAdapterConfigurationDraftTestService();

  function rethrowRuntimeAgentConfigurationError(error: unknown): never {
    if (error instanceof RuntimeAgentConfigurationInvalid) {
      throw unprocessable(error.message, { code: error.code });
    }
    if (error instanceof RuntimeAgentConfigurationDenied) {
      throw forbidden(error.message, {
        code: error.code,
        reason: error.reason,
      });
    }
    if (error instanceof RuntimeAgentConfigurationConflict) {
      throw conflict(error.message, { code: error.code });
    }
    throw error;
  }

  async function decideAgentRead(req: Request, agent: { id: string; companyId: string }) {
    return access.decide({
      actor: req.actor,
      action: "agent:read",
      resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
    });
  }

  async function assertAgentReadAllowed(req: Request, res: Response, agent: { id: string; companyId: string }) {
    const decision = await decideAgentRead(req, agent);
    if (decision.allowed) return true;
    res.status(403).json({ error: "Agent is outside this actor's authorization boundary" });
    return false;
  }

  async function filterAgentsForActor<T extends Record<string, unknown>>(
    req: Request,
    rows: T[],
  ) {
    const decisions = await Promise.all(rows.map((agent) => {
      const id = typeof agent.id === "string" ? agent.id : null;
      const companyId = typeof agent.companyId === "string" ? agent.companyId : null;
      if (!id || !companyId) return Promise.resolve({ allowed: false });
      return decideAgentRead(req, { id, companyId });
    }));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  async function buildAgentAccessState(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    const membership = await access.getMembership(agent.companyId, "agent", agent.id);
    const grants = membership
      ? await access.listPrincipalGrants(agent.companyId, "agent", agent.id)
      : [];
    return { membership, grants };
  }

  async function buildAgentDetail(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    options?: { restricted?: boolean },
  ) {
    const [chainOfCommand, accessState, pluginManagement] = await Promise.all([
      svc.getChainOfCommand(agent.id),
      buildAgentAccessState(agent),
      options?.restricted
        ? Promise.resolve(null)
        : getPluginManagedAgentBinding(db, {
            companyId: agent.companyId,
            agentId: agent.id,
          }),
    ]);

    return {
      ...agent,
      chainOfCommand,
      access: accessState,
      pluginManagement,
    };
  }

  async function assertNotPluginManagedTriage(agent: {
    id: string;
    companyId: string;
  }) {
    const binding = await getPluginManagedAgentBinding(db, {
      companyId: agent.companyId,
      agentId: agent.id,
    });
    if (binding?.lifecycleState === "triage_paused") {
      throw conflict(
        "Adopt or terminate this plugin-managed agent before changing it",
        {
          code: "plugin_managed_agent_requires_triage_resolution",
          pluginId: binding.pluginId,
          resourceKey: binding.resourceKey,
        },
      );
    }
  }

  async function assertCanCreateAgentsForCompany(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
    return null;
  }

  async function assertBoardCanManageAgentsForCompany(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function assertCanReadConfigurations(req: Request, companyId: string) {
    // Reading agent configurations and config revisions is a
    // read-only operation available to any board (human) member of the
    // company. Responses go through `redactAgentConfiguration` so secrets
    // are never exposed. Mutations still gate on agents:create or
    // agents:configure via the mutating route helpers.
    //
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    return null;
  }

  async function getAccessibleAgent(req: Request, res: Response, id: string) {
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return null;
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    return agent;
  }

  async function assertCanUpdateAgent(req: Request, targetAgent: { id: string; companyId: string }) {
    assertBoard(req);
    assertCompanyAccess(req, targetAgent.companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId: targetAgent.companyId, agentId: targetAgent.id },
      scope: { targetAgentId: targetAgent.id },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function assertCanReadAgent(req: Request, targetAgent: { id: string; companyId: string }) {
    assertBoard(req);
    assertCompanyAccess(req, targetAgent.companyId);
    await assertCanReadConfigurations(req, targetAgent.companyId);
  }

  function redactAdapterConfigRevision(
    revision: Awaited<
      ReturnType<typeof adapterConfigurations.createRevision>
    >["revision"],
  ): AgentAdapterConfigRevision {
    return {
      id: revision.id,
      companyId: revision.companyId,
      agentId: revision.agentId,
      revisionNumber: revision.revisionNumber,
      acpConfiguration: revision.acpConfiguration,
      digest: revision.digest,
      parentRevisionId: revision.parentRevisionId,
      createdByAgentId: revision.createdByAgentId,
      createdByUserId: revision.createdByUserId,
      createdAt: revision.createdAt,
    };
  }

  function toLeanOrgNode(node: Record<string, unknown>): Record<string, unknown> {
    const reports = Array.isArray(node.reports)
      ? (node.reports as Array<Record<string, unknown>>).map((report) => toLeanOrgNode(report))
      : [];
    return {
      id: String(node.id),
      name: String(node.name),
      subtitle: typeof node.title === "string" ? node.title : "",
      status: String(node.status),
      reports,
    };
  }

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
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
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
    res.json(await buildAgentDetail(agent, {
      restricted: req.actor.type !== "board",
    }));
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    const id = req.params.id as string;
    const agent = await getAccessibleResource(
      req,
      res,
      svc.getById(id),
      "Agent not found",
    );
    if (!agent) return;
    if (!(await assertAgentReadAllowed(req, res, agent))) return;
    res.json(await svc.getRuntimeState(agent.id));
  });

  router.post(
    "/companies/:companyId/runtime-agents",
    validate(runtimeAgentCreateConfigurationSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCanCreateAgentsForCompany(req, companyId);

      try {
        const result = await runtimeAgentConfiguration.create({
          companyId,
          actor: {
            kind: "board",
            actorId: req.actor.userId,
            authorization: req.actor,
          },
          source: "board",
          configuration: req.body,
          idempotencyKey: req.header("Idempotency-Key") ?? null,
        });
        const agent = await svc.getById(result.agentId);
        if (!agent) {
          throw notFound("Agent not found after runtime-agent creation");
        }

        if (!result.retried) {
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: req.actor.userId,
            action: "agent.created",
            entityType: "agent",
            entityId: agent.id,
            details: {
              name: agent.name,
              runtimeConfigurationAuditId: result.auditId,
            },
          });
          const telemetryClient = getTelemetryClient();
          if (telemetryClient) {
            trackAgentCreated(telemetryClient, { agentId: agent.id });
          }
        }

        res.status(result.retried ? 200 : 201).json({
          agent: agent,
          configuration: result.configuration,
          auditId: result.auditId,
          retried: result.retried,
        });
      } catch (error) {
        rethrowRuntimeAgentConfigurationError(error);
      }
    },
  );

  router.get("/agents/:id/runtime-configuration", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getById(id),
      "Agent not found",
    );
    if (!existing) return;
    await assertCanReadAgent(req, existing);
    try {
      res.json(
        await runtimeAgentConfiguration.get({
          companyId: existing.companyId,
          targetAgentId: existing.id,
        }),
      );
    } catch (error) {
      rethrowRuntimeAgentConfigurationError(error);
    }
  });

  router.patch(
    "/agents/:id/runtime-configuration",
    validate(runtimeAgentUpdateConfigurationSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Agent not found",
      );
      if (!existing) return;
      await assertCanUpdateAgent(req, existing);
      await assertNotPluginManagedTriage(existing);
      try {
        const result = await runtimeAgentConfiguration.update({
          companyId: existing.companyId,
          targetAgentId: existing.id,
          actor: {
            kind: "board",
            actorId: req.actor.userId,
            authorization: req.actor,
          },
          source: "board",
          configuration: req.body,
          idempotencyKey: req.header("Idempotency-Key") ?? null,
        });
        res.json(result.configuration);
      } catch (error) {
        rethrowRuntimeAgentConfigurationError(error);
      }
    },
  );

  router.get("/agents/:id/adapter-config-revisions", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getById(id),
      "Agent not found",
    );
    if (!existing) return;
    await assertCanReadAgent(req, existing);
    const revisions = await adapterConfigurations.listRevisions({
      companyId: existing.companyId,
      agentId: existing.id,
    });
    res.json(revisions.map(redactAdapterConfigRevision));
  });

  router.get(
    "/agents/:id/adapter-config-revisions/current",
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Agent not found",
      );
      if (!existing) return;
      await assertCanReadAgent(req, existing);
      const revision = await adapterConfigurations.getCurrentRevision({
        companyId: existing.companyId,
        agentId: existing.id,
      });
      if (!revision) {
        res.status(404).json({
          error: "Agent has no current adapter configuration revision",
        });
        return;
      }
      res.json(redactAdapterConfigRevision(revision));
    },
  );

  router.post(
    "/agents/:id/adapter-config-revisions",
    validate(agentAdapterRevisionConfigurationSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Agent not found",
      );
      if (!existing) return;
      await assertCanUpdateAgent(req, existing);
      await assertNotPluginManagedTriage(existing);

      const result = await adapterConfigurations.createRevision({
        companyId: existing.companyId,
        agentId: existing.id,
        configuration: req.body,
        actor: {
          type: "user",
          userId: req.actor.userId,
        },
      });

      await logActivity(db, {
        companyId: existing.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "agent.adapter_config_revision_created",
        entityType: "agent_adapter_config_revision",
        entityId: result.revision.id,
        details: {
          targetAgentId: existing.id,
          adapterType:
            result.revision.acpConfiguration.launchProfile.registryName,
          revisionNumber: result.revision.revisionNumber,
          appended: result.appended,
        },
      });

      res.status(result.appended ? 201 : 200).json({
        revision: redactAdapterConfigRevision(result.revision),
        current: {
          agentId: result.current.id,
          currentAdapterConfigRevisionId:
            result.current.currentAdapterConfigRevisionId,
          updatedAt: result.current.updatedAt,
        },
        appended: result.appended,
      });
    },
  );

  router.patch(
    "/agents/:id/operational-configuration",
    validate(agentOperationalConfigurationUpdateSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Agent not found",
      );
      if (!existing) return;
      await assertCanUpdateAgent(req, existing);
      await assertNotPluginManagedTriage(existing);

      const result = await operationalConfigurations.update({
        companyId: existing.companyId,
        agentId: existing.id,
        configuration: req.body,
        actorUserId: req.actor.userId,
      });

      await logActivity(db, {
        companyId: result.agent.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "agent.operational_configuration_updated",
        entityType: "agent",
        entityId: result.agent.id,
        details: {
          changedKeys: Object.keys(req.body as Record<string, unknown>).sort(),
        },
      });

      res.json(result.agent);
    },
  );

  router.post("/agents/:id/pause", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    if (existing.status === "pending_approval") {
      const managedTermination =
        await terminatePluginManagedAgentFromBoard(db, {
          companyId: existing.companyId,
          agentId: existing.id,
          actorUserId: req.actor.userId,
        }, {
          taskExecutionCancellation: options.taskExecutionCancellation,
          dispatchRef: options.ordinaryTasks.dispatchRef,
        });
      if (!managedTermination) {
        const openApproval =
          await approvalsSvc.findOpenHireApprovalForAgent(
            existing.companyId,
            id,
          );
        if (openApproval) {
          await approvalsSvc.reject(
            openApproval.id,
            req.actor.userId,
            "Hire rejected because the pending agent was paused",
          );
        } else {
          await svc.terminate(
            id,
            {
              actor: { kind: "user", userId: req.actor.userId },
              taskExecutionCancellation: options.taskExecutionCancellation,
              dispatchRef: options.ordinaryTasks.dispatchRef,
            },
          );
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
        error: existing.orgChainHealth?.repairGuidance ?? "Repair this agent's reporting chain before clearing its error",
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
    const managedTermination = await terminatePluginManagedAgentFromBoard(db, {
      companyId: existing.companyId,
      agentId: existing.id,
      actorUserId: req.actor.userId,
    }, {
      taskExecutionCancellation: options.taskExecutionCancellation,
      dispatchRef: options.ordinaryTasks.dispatchRef,
    });
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
      agent = await svc.terminate(
        id,
        {
          actor: { kind: "user", userId: req.actor.userId },
          taskExecutionCancellation: options.taskExecutionCancellation,
          dispatchRef: options.ordinaryTasks.dispatchRef,
        },
      );
    }
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.json(agent);
  });

  router.post(
    "/agents/:id/plugin-management/adopt",
    async (req, res) => {
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
    },
  );

  return router;
}
