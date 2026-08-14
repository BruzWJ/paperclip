import * as t from "./company-portability.test-support.js";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "@paperclipai/shared";
const { beforeEach, vi, runtimeAgentConfigurationSvc, fullFalseGrantMap } = t;
const { agentSvc, operationalConfigurationSvc } = t;
const { adapterConfigurationSvc, preflightAdapterConfiguration, secretSvc } = t;
const { taskSvc, ordinaryTaskRuntime, taskSessionProducers, companySvc } = t;
const { projectSvc, routineSvc, assetSvc, accessSvc } = t;

const importedAgents = new Map<string, Record<string, any>>();
export function registerSuiteSetup() {
  beforeEach(() => {
    vi.clearAllMocks();
    importedAgents.clear();
    runtimeAgentConfigurationSvc.get.mockResolvedValue({
      contextGrants: fullFalseGrantMap(AGENT_CONTEXT_GRANT_KEYS),
      actionGrants: fullFalseGrantMap(PAPERCLIP_ACTION_KEYS),
      mentionReachGrants: fullFalseGrantMap(AGENT_MENTION_REACH_GRANT_KEYS),
    });
    runtimeAgentConfigurationSvc.create.mockImplementation(async (input: any) => {
      const created = await agentSvc.create(input.companyId, {
        ...input.configuration,
        status: "idle",
      });
      const agentId =
        created?.id ??
        `agent-${String(input.configuration.name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")}`;
      importedAgents.set(agentId, {
        companyId: input.companyId,
        status: "idle",
        ...input.configuration,
        ...created,
        id: agentId,
      });
      return {
        agentId,
        companyId: input.companyId,
        configuration: input.configuration,
        auditId: `audit-${agentId}`,
        retried: false,
      };
    });
    runtimeAgentConfigurationSvc.update.mockImplementation(async (input: any) => {
      const updated = await agentSvc.update(input.targetAgentId, input.configuration);
      const previous = importedAgents.get(input.targetAgentId) ?? {};
      const row = {
        ...previous,
        companyId: input.companyId,
        status: "idle",
        ...input.configuration,
        ...updated,
        id: input.targetAgentId,
      };
      importedAgents.set(input.targetAgentId, row);
      return {
        agentId: input.targetAgentId,
        companyId: input.companyId,
        configuration: input.configuration,
        auditId: `audit-${input.targetAgentId}`,
        retried: false,
      };
    });
    operationalConfigurationSvc.update.mockImplementation(async (input: any) => {
      const row = {
        ...(importedAgents.get(input.agentId) ?? {}),
        ...input.configuration,
        id: input.agentId,
        companyId: input.companyId,
      };
      importedAgents.set(input.agentId, row);
      return { agent: row };
    });
    adapterConfigurationSvc.createRevision.mockImplementation(async (input: any) => {
      const row = {
        ...(importedAgents.get(input.agentId) ?? {}),
        ...input.configuration,
        id: input.agentId,
        companyId: input.companyId,
      };
      importedAgents.set(input.agentId, row);
      return { agent: row };
    });
    agentSvc.getById.mockImplementation(async (agentId: string) => {
      const imported = importedAgents.get(agentId);
      if (imported) return imported;
      const createCall = runtimeAgentConfigurationSvc.create.mock.calls.at(-1)?.[0];
      if (createCall) {
        return {
          id: agentId,
          companyId: createCall.companyId,
          name: createCall.configuration.name,
          status: "idle",
        };
      }
      const listed = await agentSvc.list();
      return listed.find((agent: { id: string }) => agent.id === agentId) ?? null;
    });
    preflightAdapterConfiguration.mockReset();
    preflightAdapterConfiguration.mockResolvedValue(undefined);
    secretSvc.create.mockResolvedValue({ id: "secret-created" });
    secretSvc.remove.mockResolvedValue(true);
    secretSvc.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
    secretSvc.syncEnvBindingsForTarget.mockResolvedValue([]);
    taskSvc.listComments.mockResolvedValue([]);
    ordinaryTaskRuntime.create.mockResolvedValue({
      task: {
        id: "task-imported",
        title: "Imported task",
      },
      executionRef: {
        id: "ref-imported",
      },
    });
    taskSessionProducers.appendCanonicalControlNotice.mockResolvedValue({
      commentId: "comment-imported",
    });
    taskSessionProducers.appendCanonicalUserComment.mockResolvedValue({
      commentId: "comment-imported",
    });
    companySvc.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      budgetCurrency: "USD",
      budgetMonthlyAmount: "0",
      knownSpendAmount: "0",
      description: null,
      taskPrefix: "PAP",
      brandColor: "#5c5fff",
      logoAssetId: null,
      logoUrl: null,
      requireBoardApprovalForNewAgents: false,
    });
    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
      budgetCurrency: "USD",
      budgetMonthlyAmount: "0",
      knownSpendAmount: "0",
      requireBoardApprovalForNewAgents: false,
    });
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        status: "idle",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        currentAdapterConfigRevisionId: "11111111-1111-4111-8111-111111111111",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: "Review implementation work carefully before reporting completion.",
      },
      {
        id: "agent-2",
        name: "Reviewer",
        status: "idle",
        title: "Review Lead",
        icon: "globe",
        reportsTo: null,
        capabilities: "Owns marketing",
        currentAdapterConfigRevisionId: "11111111-1111-4111-8111-111111111112",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    taskSvc.list.mockResolvedValue([]);
    taskSvc.getById.mockResolvedValue(null);
    taskSvc.getByIdentifier.mockResolvedValue(null);
    routineSvc.list.mockResolvedValue([]);
    routineSvc.getDetail.mockImplementation(async (id: string) => {
      const rows = await routineSvc.list();
      return rows.find((row: { id: string }) => row.id === id) ?? null;
    });
    routineSvc.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "routine-created",
      companyId: "company-1",
      projectId: input.projectId,
      goalId: null,
      parentTaskId: null,
      title: input.title,
      description: input.description ?? null,
      assigneeAgentId: input.assigneeAgentId,
      priority: input.priority ?? "medium",
      status: input.status ?? "active",
      concurrencyPolicy: input.concurrencyPolicy ?? "coalesce_if_active",
      catchUpPolicy: input.catchUpPolicy ?? "skip_missed",
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      lastTriggeredAt: null,
      lastEnqueuedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    routineSvc.createTrigger.mockImplementation(
      async (_routineId: string, input: Record<string, unknown>) => ({
        id: "trigger-created",
        companyId: "company-1",
        routineId: "routine-created",
        kind: input.kind,
        label: input.label ?? null,
        enabled: input.enabled ?? true,
        cronExpression: input.kind === "schedule" ? (input.cronExpression ?? null) : null,
        timezone: input.kind === "schedule" ? (input.timezone ?? null) : null,
        nextRunAt: null,
        lastFiredAt: null,
        publicId: null,
        secretId: null,
        signingMode: input.kind === "webhook" ? (input.signingMode ?? "bearer") : null,
        replayWindowSec: input.kind === "webhook" ? (input.replayWindowSec ?? 300) : null,
        lastRotatedAt: null,
        lastResult: null,
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    assetSvc.getById.mockReset();
    assetSvc.getById.mockResolvedValue(null);
    assetSvc.create.mockReset();
    accessSvc.setPrincipalPermission.mockResolvedValue(undefined);
    assetSvc.create.mockResolvedValue({
      id: "asset-created",
    });
    accessSvc.listActiveUserMemberships.mockResolvedValue([
      {
        id: "membership-1",
        companyId: "company-1",
        principalType: "user",
        principalId: "user-1",
        membershipRole: "owner",
        status: "active",
      },
    ]);
    accessSvc.copyActiveUserMemberships.mockResolvedValue([]);
  });
}

export { importedAgents };
