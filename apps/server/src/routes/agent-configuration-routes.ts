import {
  agentAdapterRevisionConfigurationSchema,
  agentOperationalConfigurationUpdateSchema,
  runtimeAgentCreateConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
} from "@paperclipai/shared";
import { trackAgentCreated } from "@paperclipai/shared/telemetry";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { getTelemetryClient } from "../telemetry.js";
import type { AgentRouteContext } from "./agent-route-context.js";
import { assertBoard, getAccessibleResource } from "./authz.js";

type AgentConfigurationRoutesContext = Pick<
  AgentRouteContext,
  | "router"
  | "db"
  | "svc"
  | "runtimeAgentConfiguration"
  | "adapterConfigurations"
  | "operationalConfigurations"
  | "rethrowRuntimeAgentConfigurationError"
  | "assertNotPluginManagedTriage"
  | "assertCanCreateAgentsForCompany"
  | "assertCanUpdateAgent"
  | "assertCanReadAgent"
  | "redactAdapterConfigRevision"
>;

export function registerAgentConfigurationRoutes(context: AgentConfigurationRoutesContext): void {
  const {
    router,
    db,
    svc,
    runtimeAgentConfiguration,
    adapterConfigurations,
    operationalConfigurations,
    rethrowRuntimeAgentConfigurationError,
    assertNotPluginManagedTriage,
    assertCanCreateAgentsForCompany,
    assertCanUpdateAgent,
    assertCanReadAgent,
    redactAdapterConfigRevision,
  } = context;

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
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
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
      const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
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
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!existing) return;
    await assertCanReadAgent(req, existing);
    const revisions = await adapterConfigurations.listRevisions({
      companyId: existing.companyId,
      agentId: existing.id,
    });
    res.json(revisions.map(redactAdapterConfigRevision));
  });

  router.get("/agents/:id/adapter-config-revisions/current", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
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
  });

  router.post(
    "/agents/:id/adapter-config-revisions",
    validate(agentAdapterRevisionConfigurationSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
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
          adapterType: result.revision.acpConfiguration.launchProfile.registryName,
          revisionNumber: result.revision.revisionNumber,
          appended: result.appended,
        },
      });

      res.status(result.appended ? 201 : 200).json({
        revision: redactAdapterConfigRevision(result.revision),
        current: {
          agentId: result.current.id,
          currentAdapterConfigRevisionId: result.current.currentAdapterConfigRevisionId,
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
      const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
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
}
