import { and, eq } from "drizzle-orm";
import {
  agents,
  environments,
  invites,
  joinRequests,
  type Db,
} from "@paperclipai/db";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type CompanySkillChannel,
  type EnvironmentDriver,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { assertEnvironmentSelectionForCompany } from "../routes/environment-selection.js";
import { accessService } from "./access.js";
import { createAgentAdapterConfigurationService } from "./agent-adapter-config-revisions.js";
import { deduplicateAgentName } from "./agents.js";
import { logActivity } from "./activity-log.js";
import { resolveHumanInviteRole } from "./company-member-roles.js";
import { environmentService } from "./environments.js";
import {
  agentJoinGrantsFromDefaults,
  humanJoinGrantsFromDefaults,
} from "./invite-grants.js";
import { createRuntimeAgentConfigurationService } from "./runtime-agent-configuration.js";
import type { AuthorizationActor } from "./authorization.js";

type JoinApprovalTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

export interface JoinRequestApprovalInput {
  companyId: string;
  requestId: string;
  actor: {
    actorId: string;
    userId: string;
    authorization: Extract<AuthorizationActor, { type: "board" }>;
  };
  defaultEnvironmentId?: string | null;
  skillChannel?: CompanySkillChannel | null;
}

export interface JoinRequestApprovalDependencies {
  /**
   * Resolves only the current ACPX-admitted transports for an exact adapter.
   * This seam keeps join approval testable without inventing a local catalog.
   */
  resolveAdapterEnvironmentDrivers?: (
    adapterType: string,
  ) => Promise<readonly EnvironmentDriver[]>;
}

async function resolveCurrentAcpxEnvironmentDrivers(
  adapterType: string,
): Promise<readonly EnvironmentDriver[]> {
  const registry = await import("../adapters/registry.js");
  // A join request can outlive the board catalog page. Refresh before the
  // environment is selected so this approval cannot revive a removed ACPX
  // transport from a stale Paperclip snapshot.
  await registry.refreshAcpxAdapters();
  const adapter = registry.findServerAdapter(adapterType);
  if (!adapter) {
    throw unprocessable(
      `Agent runtime "${adapterType}" is not currently available in the local catalog.`,
      {
        code: "agent_join_adapter_unavailable",
        adapterType,
      },
    );
  }
  return adapter.definition.environment.drivers;
}

/**
 * The sole owner of board approval for an invite-backed join request.
 *
 * This deliberately composes the canonical runtime-agent, adapter-revision,
 * operational, membership, and grant owners inside one outer database
 * transaction. A partial agent cannot escape if an initial revision or a
 * downstream membership/grant write fails.
 */
export function createJoinRequestApprovalService(
  db: Db,
  dependencies: JoinRequestApprovalDependencies = {},
) {
  const resolveAdapterEnvironmentDrivers =
    dependencies.resolveAdapterEnvironmentDrivers
    ?? resolveCurrentAcpxEnvironmentDrivers;
  async function approveInTransaction(
    tx: JoinApprovalTransaction,
    input: JoinRequestApprovalInput,
  ) {
    const txDb = tx as unknown as Db;
    const joinRequest = await tx
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.companyId, input.companyId),
          eq(joinRequests.id, input.requestId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!joinRequest) throw notFound("Join request not found");

    if (joinRequest.status === "approved") {
      if (
        joinRequest.requestType === "agent" &&
        input.defaultEnvironmentId !== undefined &&
        input.defaultEnvironmentId !== null &&
        input.defaultEnvironmentId !== joinRequest.approvedEnvironmentId
      ) {
        throw conflict(
          "Join request was already approved with a different execution environment",
        );
      }
      return joinRequest;
    }
    if (joinRequest.status !== "pending_approval") {
      throw conflict("Join request is not pending");
    }
    if (joinRequest.createdAgentId) {
      throw conflict(
        "Pending agent join request already has a created agent and cannot be safely approved",
      );
    }

    const invite = await tx
      .select()
      .from(invites)
      .where(eq(invites.id, joinRequest.inviteId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!invite) throw notFound("Invite not found");
    if (invite.companyId !== input.companyId) {
      throw conflict("Join request invite does not belong to this company");
    }

    const access = accessService(txDb);
    let createdAgentId: string | null = null;
    let approvedEnvironmentId: string | null = null;
    let createdAgentAdapterConfigRevisionId: string | null = null;

    if (joinRequest.requestType === "human") {
      if (!joinRequest.requestingUserId) {
        throw conflict("Join request missing user identity");
      }
      const membershipRole = resolveHumanInviteRole(
        invite.defaultsPayload as Record<string, unknown> | null,
      );
      await access.ensureMembership(
        input.companyId,
        "user",
        joinRequest.requestingUserId,
        membershipRole,
        "active",
      );
      const grants = humanJoinGrantsFromDefaults(
        invite.defaultsPayload as Record<string, unknown> | null,
        membershipRole,
      );
      await access.setPrincipalGrants(
        input.companyId,
        "user",
        joinRequest.requestingUserId,
        grants,
        input.actor.userId,
      );
    } else {
      if (
        typeof joinRequest.adapterType !== "string" ||
        joinRequest.adapterType.trim().length === 0
      ) {
        throw conflict(
          "Agent join request is missing an explicit adapter type",
        );
      }
      if (
        !joinRequest.agentDefaultsPayload ||
        typeof joinRequest.agentDefaultsPayload !== "object" ||
        Array.isArray(joinRequest.agentDefaultsPayload)
      ) {
        throw conflict(
          "Agent join request is missing explicit adapter configuration",
        );
      }
      if (!input.defaultEnvironmentId) {
        throw unprocessable(
          "Agent join approval requires an explicit execution environment",
          { code: "agent_join_environment_required" },
        );
      }
      if (!input.skillChannel) {
        throw unprocessable(
          "Agent join approval requires an explicit company skill channel",
          { code: "agent_join_skill_channel_required" },
        );
      }

      const allowedDrivers = await resolveAdapterEnvironmentDrivers(
        joinRequest.adapterType,
      );
      await assertEnvironmentSelectionForCompany(
        environmentService(txDb),
        input.companyId,
        input.defaultEnvironmentId,
        {
          allowedDrivers: [...allowedDrivers],
        },
      );
      const environment = await tx
        .select()
        .from(environments)
        .where(eq(environments.id, input.defaultEnvironmentId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!environment || environment.status !== "active") {
        throw unprocessable(
          "Agent execution environment must exist and be active",
          { code: "agent_execution_environment_unavailable" },
        );
      }

      const companyAgents = await tx
        .select({
          id: agents.id,
          name: agents.name,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.companyId, input.companyId));
      const agentName = deduplicateAgentName(
        joinRequest.agentName ?? "New Agent",
        companyAgents,
      );

      const runtime = createRuntimeAgentConfigurationService(txDb);
      const runtimeResult = await runtime.createInTransaction({
        transaction: tx,
        companyId: input.companyId,
        actor: {
          kind: "board",
          actorId: input.actor.actorId,
          authorization: input.actor.authorization,
        },
        source: "board",
        idempotencyKey: `join-request:${joinRequest.id}:runtime-agent`,
        configuration: {
          name: agentName,
          title: null,
          reportsTo: null,
          capabilities: joinRequest.capabilities ?? null,
          contextGrants: Object.fromEntries(
            AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false]),
          ),
          actionGrants: Object.fromEntries(
            PAPERCLIP_ACTION_KEYS.map((key) => [key, false]),
          ),
          mentionReachGrants: Object.fromEntries(
            AGENT_MENTION_REACH_GRANT_KEYS.map((key) => [key, false]),
          ),
          companyToolIds: [],
        },
      });
      const adapterConfigurations =
        createAgentAdapterConfigurationService(txDb);
      const adapterResult = await adapterConfigurations.createRevision({
        companyId: input.companyId,
        agentId: runtimeResult.agentId,
        configuration: {
          adapterType: joinRequest.adapterType,
          adapterConfig: joinRequest.agentDefaultsPayload,
          defaultEnvironmentId: input.defaultEnvironmentId,
          runtimeConfig: {},
          companySkillPins: [],
          skillChannel: input.skillChannel,
        },
        actor: {
          type: "user",
          userId: input.actor.actorId,
        },
      });
      await access.ensureMembership(
        input.companyId,
        "agent",
        runtimeResult.agentId,
        "member",
        "active",
      );
      await access.setPrincipalGrants(
        input.companyId,
        "agent",
        runtimeResult.agentId,
        agentJoinGrantsFromDefaults(
          invite.defaultsPayload as Record<string, unknown> | null,
        ),
        input.actor.userId,
      );
      createdAgentId = runtimeResult.agentId;
      approvedEnvironmentId = environment.id;
      createdAgentAdapterConfigRevisionId = adapterResult.revision.id;
    }

    const now = new Date();
    const approved = await tx
      .update(joinRequests)
      .set({
        status: "approved",
        approvedByUserId: input.actor.userId,
        approvedAt: now,
        createdAgentId,
        approvedEnvironmentId,
        createdAgentAdapterConfigRevisionId,
        updatedAt: now,
      })
      .where(
        and(
          eq(joinRequests.id, joinRequest.id),
          eq(joinRequests.companyId, input.companyId),
          eq(joinRequests.status, "pending_approval"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!approved) {
      throw conflict("Join request was resolved concurrently");
    }

    await logActivity(txDb, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actor.userId ?? input.actor.actorId,
      action: "join.approved",
      entityType: "join_request",
      entityId: joinRequest.id,
      details: {
        requestType: joinRequest.requestType,
        createdAgentId,
        approvedEnvironmentId,
        createdAgentAdapterConfigRevisionId,
      },
    });
    return approved;
  }

  return {
    approve(input: JoinRequestApprovalInput) {
      return db.transaction((tx) => approveInTransaction(tx, input));
    },
  };
}

export type JoinRequestApprovalService = ReturnType<
  typeof createJoinRequestApprovalService
>;
