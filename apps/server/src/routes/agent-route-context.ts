import type { Db } from "@paperclipai/db";
import { type AgentAdapterConfigRevision } from "@paperclipai/shared";
import { Router, type Request, type Response } from "express";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { createAdapterConfigurationDraftTestService } from "../services/adapter-configuration-draft-test.js";
import { createAgentAdapterConfigurationService } from "../services/agent-adapter-config-revisions.js";
import { createAgentOperationalConfigurationService } from "../services/agent-operational-configuration.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import {
  accessService,
  agentService,
  approvalService,
  createRuntimeAgentConfigurationService,
} from "../services/index.js";
import type { OrdinaryTaskRuntime } from "../services/ordinary-task-runtime.js";
import {
  getPluginManagedAgentBinding,
  terminateAgentForHireRejectionInTransaction,
} from "../services/plugin-managed-agents.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  RuntimeAgentConfigurationConflict,
  RuntimeAgentConfigurationDenied,
  RuntimeAgentConfigurationInvalid,
} from "../services/runtime-agent-configuration.js";
import type { TaskExecutionCancellationService } from "../services/task-execution-cancellation.js";
import type { TaskSessionStore } from "../services/task-session/store.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";

export function createAgentRouteContext(
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
    terminateHireRejectionAgentInTransaction: terminateAgentForHireRejectionInTransaction,
    dispatchRef: options.ordinaryTasks.dispatchRef,
  });
  const runtimeAgentConfiguration = createRuntimeAgentConfigurationService(db);
  const adapterConfigurations = createAgentAdapterConfigurationService(db);
  const operationalConfigurations = createAgentOperationalConfigurationService(db);
  const adapterConfigurationDraftTest = createAdapterConfigurationDraftTestService();

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
      resource: {
        type: "agent",
        companyId: agent.companyId,
        agentId: agent.id,
      },
    });
  }

  async function assertAgentReadAllowed(
    req: Request,
    res: Response,
    agent: { id: string; companyId: string },
  ) {
    const decision = await decideAgentRead(req, agent);
    if (decision.allowed) return true;
    res.status(403).json({ error: "Agent is outside this actor's authorization boundary" });
    return false;
  }

  async function filterAgentsForActor<T extends Record<string, unknown>>(req: Request, rows: T[]) {
    const decisions = await Promise.all(
      rows.map((agent) => {
        const id = typeof agent.id === "string" ? agent.id : null;
        const companyId = typeof agent.companyId === "string" ? agent.companyId : null;
        if (!id || !companyId) return Promise.resolve({ allowed: false });
        return decideAgentRead(req, { id, companyId });
      }),
    );
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  async function buildAgentAccessState(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    const membership = await access.getMembership(agent.companyId, "agent", agent.id);
    const grants = membership ? await access.listPrincipalGrants(agent.companyId, "agent", agent.id) : [];
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

  async function assertNotPluginManagedTriage(agent: { id: string; companyId: string }) {
    const binding = await getPluginManagedAgentBinding(db, {
      companyId: agent.companyId,
      agentId: agent.id,
    });
    if (binding?.lifecycleState === "triage_paused") {
      throw conflict("Adopt or terminate this plugin-managed agent before changing it", {
        code: "plugin_managed_agent_requires_triage_resolution",
        pluginId: binding.pluginId,
        resourceKey: binding.resourceKey,
      });
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
      resource: {
        type: "agent",
        companyId: targetAgent.companyId,
        agentId: targetAgent.id,
      },
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
    revision: Awaited<ReturnType<typeof adapterConfigurations.createRevision>>["revision"],
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
  return {
    router,
    db,
    options,
    svc,
    access,
    approvalsSvc,
    runtimeAgentConfiguration,
    adapterConfigurations,
    operationalConfigurations,
    adapterConfigurationDraftTest,
    rethrowRuntimeAgentConfigurationError,
    decideAgentRead,
    assertAgentReadAllowed,
    filterAgentsForActor,
    buildAgentAccessState,
    buildAgentDetail,
    assertNotPluginManagedTriage,
    assertCanCreateAgentsForCompany,
    assertBoardCanManageAgentsForCompany,
    assertCanReadConfigurations,
    getAccessibleAgent,
    assertCanUpdateAgent,
    assertCanReadAgent,
    redactAdapterConfigRevision,
    toLeanOrgNode,
  };
}

export type AgentRouteContext = ReturnType<typeof createAgentRouteContext>;
export type AgentRouteOptions = Parameters<typeof createAgentRouteContext>[1];
