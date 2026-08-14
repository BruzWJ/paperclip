import {
  type Db,
  type RuntimeAgentConfigurationSnapshot,
  approvals,
  runtimeAgentConfigurationAudits,
} from "@paperclipai/db";
import {
  isCanonicalUuid,
  type RuntimeAgentHireConfigurationInput,
  type RuntimeAgentUpdateConfigurationInput,
} from "@paperclipai/shared";
import {
  promptCapabilityGenerationIdentity,
  type PromptCapabilityBinding,
} from "./prompt-capability-gateway.js";
import {
  type RuntimeAgentConfigurationBoardActor,
  type RuntimeAgentConfigurationControlActor,
  type RuntimeAgentConfigurationControlSource,
  type RuntimeAgentConfigurationResult,
  type RuntimeAgentConfigurationServiceOptions,
  type RuntimeAgentConfigurationTransaction,
  type RuntimeAgentCreateConfiguration,
  type RuntimeAgentUpdateConfiguration,
  RuntimeAgentConfigurationInvalid,
  parseRuntimeAgentCreateConfiguration,
  CONFIGURATION_KEYS,
  InternalActor,
  ParsedCreateConfiguration,
} from "./runtime-agent-configuration-part-1.js";
import {
  assertActorSource,
  assertNonempty,
  loadSnapshot,
  normalizedIdempotencyKey,
  parseRuntimeAgentConfigureConfiguration,
  parseRuntimeAgentHireConfiguration,
  parseRuntimeAgentUpdateConfiguration,
  actorAuditColumns,
  sha256,
  snapshotsChangedKeys,
} from "./runtime-agent-configuration-part-2.js";
import {
  createRuntimeAgentConfigurationServiceContext,
  findIdempotentResult,
  hireApprovalPayload,
  replaceMentionReachGrants,
} from "./runtime-agent-configuration-part-4.js";
import { createRuntimeAgentConfigurationServiceOperationsSection1Resubmit } from "./runtime-agent-configuration-operations-method-1-resubmit.js";
import { createRuntimeAgentConfigurationServiceOperationsSection1Update } from "./runtime-agent-configuration-operations-method-1-update.js";

import { budgetService } from "./budgets.js";
import {
  assertBoardAuthority,
  assertPluginAuthority,
  assertReportsTo,
  assertRunActionAuthority,
  lockCompanyAndAgents,
  replaceActionGrants,
  replaceContextGrants,
} from "./runtime-agent-configuration-part-3.js";

export function createRuntimeAgentConfigurationServiceOperationsSection1Create(
  context: ReturnType<typeof createRuntimeAgentConfigurationServiceContext>,
) {
  const { db, options, clock, idFactory } = context;
  async function createInTransactionInternal(
    tx: RuntimeAgentConfigurationTransaction,
    input: {
      companyId: string;
      actor: InternalActor;
      source: "board" | "onboarding" | "agent_hire" | "plugin_control";
      configuration: ParsedCreateConfiguration;
      idempotencyKey: string | null;
    },
  ): Promise<RuntimeAgentConfigurationResult> {
    const requestDigest = sha256({
      operation: "create",
      companyId: input.companyId,
      source: input.source,
      actor: actorAuditColumns(input.actor),
      configuration: input.configuration,
    });
    const now = clock();
    const locked = await lockCompanyAndAgents(tx, input.companyId);
    let responsibleUserId: string | null = null;
    if (input.actor.kind === "agent") {
      responsibleUserId = (
        await assertRunActionAuthority(tx, input.actor, "agent_hire", now, locked.company, locked.agents)
      ).responsibleUserId;
    }
    if (input.actor.kind === "board") {
      await assertBoardAuthority(tx, input.actor, input.companyId, "create", null);
    } else if (input.actor.kind === "plugin") {
      await assertPluginAuthority(tx, input.actor, "create", null, CONFIGURATION_KEYS, options);
    } else if (responsibleUserId) {
      // The run-bound hire action itself is the creation authority. The
      // responsible-user intersection is applied to protected configure
      // operations, not used to invent a second agents:create requirement.
    }
    const retry = await findIdempotentResult(tx, input.companyId, input.idempotencyKey, requestDigest);
    if (retry) return retry;
    const agentId = idFactory();
    if (!isCanonicalUuid(agentId)) {
      throw new RuntimeAgentConfigurationInvalid("idFactory must produce UUIDs");
    }
    const reportsTo = input.actor.kind === "agent" ? input.actor.actorId : input.configuration.reportsTo;
    assertReportsTo(agentId, reportsTo, locked.agents);
    const requiresApproval = input.actor.kind !== "board" && locked.company.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    await budgetService(tx as unknown as Db).createAgentInTransaction(
      {
        id: agentId,
        companyId: input.companyId,
        name: input.configuration.name,
        title: input.configuration.title,
        capabilities: input.configuration.capabilities,
        reportsTo,
        status,
        createdAt: now,
        updatedAt: now,
      },
      actorAuditColumns(input.actor).actorUserId,
    );
    await replaceContextGrants(
      tx,
      input.companyId,
      agentId,
      input.configuration.contextGrants,
      input.actor,
      now,
    );
    await replaceActionGrants(
      tx,
      input.companyId,
      agentId,
      input.configuration.actionGrants,
      input.actor,
      now,
    );
    await replaceMentionReachGrants(
      tx,
      input.companyId,
      agentId,
      input.configuration.mentionReachGrants,
      input.actor,
      now,
    );
    const after = await loadSnapshot(tx, input.companyId, agentId);
    const auditId = idFactory();
    const actorColumns = actorAuditColumns(input.actor);
    await tx.insert(runtimeAgentConfigurationAudits).values({
      id: auditId,
      companyId: input.companyId,
      agentId,
      operation: "create",
      source: input.source,
      ...actorColumns,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      changedKeys: snapshotsChangedKeys(null, after),
      beforeSnapshot: null,
      afterSnapshot: after,
      createdAt: now,
    });
    let approvalId: string | null = null;
    if (requiresApproval) {
      approvalId = idFactory();
      if (!isCanonicalUuid(approvalId)) {
        throw new RuntimeAgentConfigurationInvalid("idFactory must produce UUIDs");
      }
      const actor = input.actor as Exclude<InternalActor, RuntimeAgentConfigurationBoardActor>;
      await tx.insert(approvals).values({
        id: approvalId,
        companyId: input.companyId,
        type: "hire_agent",
        requestedByAgentId: actor.kind === "agent" ? actor.actorId : null,
        requestedByUserId: null,
        status: "pending",
        payload: hireApprovalPayload(actor, agentId, auditId, requestDigest),
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      agentId,
      companyId: input.companyId,
      configuration: after,
      auditId,
      approvalId,
      retried: false,
    };
  }

  async function createInternal(input: {
    companyId: string;
    actor: InternalActor;
    source: "board" | "onboarding" | "agent_hire" | "plugin_control";
    configuration: ParsedCreateConfiguration;
    idempotencyKey: string | null;
  }): Promise<RuntimeAgentConfigurationResult> {
    return db.transaction((tx) => createInTransactionInternal(tx, input));
  }
  return { createInTransactionInternal, createInternal };
}

export function createRuntimeAgentConfigurationServiceOperations(
  context: ReturnType<typeof createRuntimeAgentConfigurationServiceContext>,
) {
  return {
    ...createRuntimeAgentConfigurationServiceOperationsSection1Create(context),
    ...createRuntimeAgentConfigurationServiceOperationsSection1Update(context),
    ...createRuntimeAgentConfigurationServiceOperationsSection1Resubmit(context),
  };
}

export type RuntimeAgentConfigurationServiceOperations = ReturnType<
  typeof createRuntimeAgentConfigurationServiceOperations
>;

/** Composes the public runtime-agent configuration API over atomic operations. */
export function createRuntimeAgentConfigurationService(
  db: Db,
  options: RuntimeAgentConfigurationServiceOptions = {},
) {
  const context = createRuntimeAgentConfigurationServiceContext(db, options);
  const { createInTransactionInternal, createInternal, updateInternal, resubmitHireApprovalInternal } =
    createRuntimeAgentConfigurationServiceOperations(context);
  return {
    async get(input: {
      companyId: string;
      targetAgentId: string;
    }): Promise<RuntimeAgentConfigurationSnapshot> {
      if (!isCanonicalUuid(input.targetAgentId)) {
        throw new RuntimeAgentConfigurationInvalid("targetAgentId must be a UUID");
      }
      return db.transaction((transaction) => loadSnapshot(transaction, input.companyId, input.targetAgentId));
    },

    async create(input: {
      companyId: string;
      actor: RuntimeAgentConfigurationControlActor;
      source: RuntimeAgentConfigurationControlSource;
      configuration: RuntimeAgentCreateConfiguration | unknown;
      idempotencyKey?: string | null;
    }): Promise<RuntimeAgentConfigurationResult> {
      assertActorSource(input.actor, input.source);
      return createInternal({
        companyId: input.companyId,
        actor: input.actor,
        source: input.source,
        configuration: parseRuntimeAgentCreateConfiguration(input.configuration),
        idempotencyKey: normalizedIdempotencyKey(input.idempotencyKey),
      });
    },

    async createInTransaction(input: {
      transaction: RuntimeAgentConfigurationTransaction;
      companyId: string;
      actor: RuntimeAgentConfigurationControlActor;
      source: RuntimeAgentConfigurationControlSource;
      configuration: RuntimeAgentCreateConfiguration | unknown;
      idempotencyKey?: string | null;
    }): Promise<RuntimeAgentConfigurationResult> {
      assertActorSource(input.actor, input.source);
      return createInTransactionInternal(input.transaction, {
        companyId: input.companyId,
        actor: input.actor,
        source: input.source,
        configuration: parseRuntimeAgentCreateConfiguration(input.configuration),
        idempotencyKey: normalizedIdempotencyKey(input.idempotencyKey),
      });
    },

    async update(input: {
      companyId: string;
      targetAgentId: string;
      actor: RuntimeAgentConfigurationControlActor;
      source: RuntimeAgentConfigurationControlSource;
      configuration: RuntimeAgentUpdateConfiguration | unknown;
      idempotencyKey?: string | null;
    }): Promise<RuntimeAgentConfigurationResult> {
      assertActorSource(input.actor, input.source);
      return updateInternal({
        companyId: input.companyId,
        targetAgentId: input.targetAgentId,
        actor: input.actor,
        source: input.source,
        configuration: parseRuntimeAgentUpdateConfiguration(input.configuration),
        idempotencyKey: normalizedIdempotencyKey(input.idempotencyKey),
      });
    },

    async hireFromRun(input: {
      capability: PromptCapabilityBinding;
      invocationId: string;
      configuration: RuntimeAgentHireConfigurationInput;
    }): Promise<RuntimeAgentConfigurationResult> {
      const invocationId = assertNonempty(input.invocationId, "invocationId");
      const parsed = parseRuntimeAgentHireConfiguration(input.configuration);
      return createInternal({
        companyId: input.capability.companyId,
        actor: {
          kind: "agent",
          actorId: input.capability.targetAgentId,
          capability: input.capability,
          invocationId,
        },
        source: "agent_hire",
        configuration: {
          ...parsed,
          reportsTo: input.capability.targetAgentId,
        },
        idempotencyKey: `agent_hire:${promptCapabilityGenerationIdentity(input.capability)}:${invocationId}`,
      });
    },

    async configureFromRun(input: {
      capability: PromptCapabilityBinding;
      invocationId: string;
      targetAgentId: string;
      configuration: RuntimeAgentUpdateConfigurationInput;
    }): Promise<RuntimeAgentConfigurationResult> {
      const invocationId = assertNonempty(input.invocationId, "invocationId");
      return updateInternal({
        companyId: input.capability.companyId,
        targetAgentId: input.targetAgentId,
        actor: {
          kind: "agent",
          actorId: input.capability.targetAgentId,
          capability: input.capability,
          invocationId,
        },
        source: "agent_configure",
        configuration: parseRuntimeAgentConfigureConfiguration(input.configuration),
        idempotencyKey: `agent_configure:${promptCapabilityGenerationIdentity(input.capability)}:${invocationId}`,
      });
    },

    async resubmitHireApproval(input: {
      approvalId: string;
      actor: RuntimeAgentConfigurationBoardActor;
      expectedAgentId: string;
      expectedAuditId: string;
      expectedRequestDigest: string;
      configuration: RuntimeAgentCreateConfiguration | unknown;
    }): Promise<RuntimeAgentConfigurationResult> {
      assertActorSource(input.actor, "board");
      return resubmitHireApprovalInternal({
        ...input,
        configuration: parseRuntimeAgentCreateConfiguration(input.configuration),
      });
    },
  };
}

export type RuntimeAgentConfigurationService = ReturnType<typeof createRuntimeAgentConfigurationService>;
export * from "./runtime-agent-configuration-part-1.js";
export * from "./runtime-agent-configuration-part-2.js";
export * from "./runtime-agent-configuration-part-3.js";
export * from "./runtime-agent-configuration-part-4.js";
