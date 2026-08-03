import { randomUUID } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test as base,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";

type JsonRecord = Record<string, any>;
type MockResult = { status?: number; body?: unknown; headers?: Record<string, string> };

const now = () => new Date().toISOString();
const id = () => randomUUID();
const paperclipLiveEventsWebSocketPattern =
  /^wss?:\/\/[^/]+\/api\/companies\/[^/?#]+\/events\/ws(?:\?[^#]*)?$/;

const defaultExperimental = {
  enableEnvironments: false,
  enableIsolatedWorkspaces: false,
  enableStreamlinedLeftNavigation: true,
  enableApps: false,
  enablePipelines: false,
  enableCases: false,
  enableConferenceRoomChat: false,
  enableIssueWatchdogs: false,
  enableExperimentalFileViewer: false,
  enableCloudSync: false,
  enableExternalObjects: false,
  enableSmokeLab: false,
  enableSummaries: false,
  enableDecisions: false,
  enableGoalsSidebarLink: false,
  enableServerInfoDebugView: false,
  autoRestartDevServerWhenIdle: false,
  enableWorkspaceBranchReconcileForward: true,
  enableWorkspaceDirtyQuarantineRepair: true,
  enableWorktreeRunExecution: false,
  worktreeRunExecutionActivatedAt: null,
  worktreeRunExecutionActivationInstanceId: null,
};

class MockApiResponse {
  constructor(
    private readonly requestUrl: string,
    private readonly statusCode: number,
    private readonly payload: unknown,
    private readonly responseHeaders: Record<string, string> = {},
  ) {}

  ok() { return this.statusCode >= 200 && this.statusCode < 300; }
  status() { return this.statusCode; }
  statusText() { return this.ok() ? "OK" : "Mock request failed"; }
  url() { return this.requestUrl; }
  headers() { return { "content-type": "application/json", ...this.responseHeaders }; }
  headersArray() {
    return Object.entries(this.headers()).map(([name, value]) => ({ name, value }));
  }
  async body() { return Buffer.from(await this.text()); }
  async text() {
    return typeof this.payload === "string"
      ? this.payload
      : JSON.stringify(this.payload ?? null);
  }
  async json() { return this.payload; }
  async dispose() {}
}

export class MockPaperclipApi {
  companies: JsonRecord[] = [];
  agents: JsonRecord[] = [];
  goals: JsonRecord[] = [];
  issues: JsonRecord[] = [];
  runs: JsonRecord[] = [];
  projects: JsonRecord[] = [];
  environments: JsonRecord[] = [];
  applications: JsonRecord[] = [];
  connections: JsonRecord[] = [];
  catalog: JsonRecord[] = [];
  pipelines: JsonRecord[] = [];
  stages: JsonRecord[] = [];
  transitions: JsonRecord[] = [];
  cases: JsonRecord[] = [];
  caseEvents: JsonRecord[] = [];
  smokeRuns: JsonRecord[] = [];
  smokeSteps: JsonRecord[] = [];
  policies: JsonRecord[] = [];
  profiles: JsonRecord[] = [];
  gateways: JsonRecord[] = [];
  gatewayTokens: JsonRecord[] = [];
  actionRequests: JsonRecord[] = [];
  auditEvents: JsonRecord[] = [];
  members: JsonRecord[] = [];
  invites: JsonRecord[] = [];
  settings = { ...defaultExperimental };
  private companyOrdinal = 0;

  private company(idValue: string) {
    return this.companies.find((row) => row.id === idValue);
  }

  private application(idValue: string) {
    return this.applications.find((row) => row.id === idValue);
  }

  private connection(idValue: string) {
    return this.connections.find((row) => row.id === idValue);
  }

  private pipeline(idValue: string) {
    return this.pipelines.find((row) => row.id === idValue);
  }

  private stage(idValue: string) {
    return this.stages.find((row) => row.id === idValue);
  }

  private caseRecord(idValue: string) {
    return this.cases.find((row) => row.id === idValue);
  }

  private pipelineDetail(pipeline: JsonRecord) {
    const stages = this.stages
      .filter((row) => row.pipelineId === pipeline.id)
      .sort((left, right) => left.position - right.position);
    const cases = this.cases.filter((row) => row.pipelineId === pipeline.id);
    return {
      ...pipeline,
      stages,
      transitions: this.transitions.filter((row) => row.pipelineId === pipeline.id),
      stageCount: stages.length,
      openCaseCount: cases.filter((row) => !row.terminalKind).length,
      attentionCount: cases.filter((row) => row.pendingSuggestion || this.stage(row.stageId)?.kind === "review").length,
      inMotionCount: cases.filter((row) => !row.terminalKind).length,
      descendantActiveWorkCount: 0,
      lastActivityAt: cases.at(-1)?.updatedAt ?? pipeline.updatedAt,
      documentKeys: [],
    };
  }

  private isTerminalCase(caseValue: JsonRecord) {
    const kind = this.stage(caseValue.stageId)?.kind;
    return kind === "done" || kind === "cancelled" || Boolean(caseValue.terminalKind);
  }

  private caseRow(caseValue: JsonRecord) {
    const stage = this.stage(caseValue.stageId)!;
    const parent = caseValue.parentCaseId ? this.caseRecord(caseValue.parentCaseId) : undefined;
    const parentPipeline = parent ? this.pipeline(parent.pipelineId) : undefined;
    return {
      case: {
        ...caseValue,
        childCount: this.cases.filter((row) => row.parentCaseId === caseValue.id).length,
        terminalChildCount: this.cases.filter(
          (row) => row.parentCaseId === caseValue.id && this.isTerminalCase(row),
        ).length,
      },
      stage,
      parentCase: parent && parentPipeline
        ? {
            case: parent,
            pipeline: { id: parentPipeline.id, key: parentPipeline.key, name: parentPipeline.name },
          }
        : null,
      activeWork: null,
      descendantActiveWorkCount: 0,
    };
  }

  private caseDetail(caseValue: JsonRecord) {
    const row = this.caseRow(caseValue);
    const pipeline = this.pipeline(caseValue.pipelineId)!;
    const children = this.cases.filter((candidate) => candidate.parentCaseId === caseValue.id);
    const blockers = (caseValue.blockedByCaseIds ?? []).map((blockedByCaseId: string) => ({
      id: id(),
      companyId: caseValue.companyId,
      caseId: caseValue.id,
      blockedByCaseId,
      createdAt: caseValue.createdAt,
      updatedAt: caseValue.updatedAt,
    }));
    const blocks = this.cases
      .filter((candidate) => (candidate.blockedByCaseIds ?? []).includes(caseValue.id))
      .map((candidate) => ({
        id: id(),
        companyId: caseValue.companyId,
        caseId: candidate.id,
        blockedByCaseId: caseValue.id,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      }));
    return {
      ...row,
      pipeline: this.pipelineDetail(pipeline),
      allowedNextStages: this.stages.filter((candidate) => candidate.pipelineId === pipeline.id),
      links: [],
      blockers,
      blocks,
      childrenSummary: {
        childCount: children.length,
        terminalChildCount: children.filter((child) => this.isTerminalCase(child)).length,
        loadedChildren: children.length,
        descendantActiveWorkCount: 0,
      },
      pendingSuggestion: caseValue.pendingSuggestion ?? null,
      liveness: null,
      builtFromAutomation: null,
    };
  }

  private addCaseEvent(caseValue: JsonRecord, type: string, payload: JsonRecord = {}) {
    const event = {
      id: id(),
      companyId: caseValue.companyId,
      caseId: caseValue.id,
      type,
      actorType: "user",
      actorUserId: "user-test",
      actorAgentId: null,
      runId: null,
      fromStageId: payload.fromStageId ?? null,
      toStageId: payload.toStageId ?? null,
      payload,
      createdAt: now(),
      updatedAt: now(),
    };
    this.caseEvents.push(event);
    return event;
  }

  private createCase(pipeline: JsonRecord, input: JsonRecord) {
    if (input.requestKey) {
      const existing = this.cases.find(
        (candidate) => candidate.pipelineId === pipeline.id
          && candidate.parentCaseId === (input.parentCaseId ?? null)
          && candidate.requestKey === input.requestKey,
      );
      if (existing) return { case: this.caseRow(existing).case, created: false };
    }
    const pipelineStages = this.stages
      .filter((row) => row.pipelineId === pipeline.id)
      .sort((left, right) => left.position - right.position);
    const stage = pipelineStages.find((row) => row.key === input.stageKey) ?? pipelineStages[0];
    if (!stage) throw new Error(`Pipeline ${pipeline.id} has no stages`);
    const parent = input.parentCaseId ? this.caseRecord(input.parentCaseId) : undefined;
    const caseValue = {
      id: id(),
      companyId: pipeline.companyId,
      pipelineId: pipeline.id,
      stageId: stage.id,
      caseKey: input.caseKey ?? `${pipeline.key}-${this.cases.filter((row) => row.pipelineId === pipeline.id).length + 1}`,
      title: input.title ?? "Untitled item",
      summary: input.summary ?? null,
      fields: input.fields ?? {},
      workspaceRef: null,
      parentCaseId: input.parentCaseId ?? null,
      parentCaseVersion: parent?.version ?? null,
      requestKey: input.requestKey ?? null,
      blockedByCaseIds: input.blockedByCaseIds ?? [],
      unresolvedDrift: false,
      reviewedVersion: null,
      pendingSuggestion: null,
      terminalKind: stage.kind === "done" || stage.kind === "cancelled" ? stage.kind : null,
      terminalAt: stage.kind === "done" || stage.kind === "cancelled" ? now() : null,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
    };
    this.cases.push(caseValue);
    this.addCaseEvent(caseValue, "created", { toStageId: stage.id });
    return { case: this.caseRow(caseValue).case, created: true };
  }

  private async refreshCatalog(connection: JsonRecord) {
    const target = connection.config?.url ?? connection.transportConfig?.url;
    if (!target) return [];
    try {
      const response = await fetch(String(target), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "paperclip-e2e", method: "tools/list", params: {} }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as JsonRecord;
      const tools = Array.isArray(payload?.result?.tools) ? payload.result.tools : [];
      this.catalog = this.catalog.filter((entry) => entry.connectionId !== connection.id);
      for (const tool of tools) {
        const write = /(?:^|:|_)(?:create|update|delete|write|send|post|put|patch)(?:_|$)/i.test(tool.name ?? "");
        this.catalog.push({
          id: id(),
          companyId: connection.companyId,
          applicationId: connection.applicationId,
          connectionId: connection.id,
          entryKind: "tool",
          name: tool.name,
          toolName: tool.name,
          title: tool.title ?? tool.name,
          description: tool.description ?? null,
          inputSchema: tool.inputSchema ?? {},
          outputSchema: null,
          annotations: null,
          riskLevel: write ? "medium" : "low",
          isReadOnly: !write,
          isWrite: write,
          isDestructive: /delete|remove/i.test(tool.name ?? ""),
          status: "active",
          addedAt: now(),
          version: null,
          schemaHash: null,
          firstSeenAt: now(),
          lastSeenAt: now(),
          reviewedAt: null,
          reviewedByAgentId: null,
          reviewedByUserId: null,
          createdAt: now(),
          updatedAt: now(),
        });
      }
      connection.healthStatus = "ok";
      connection.healthMessage = null;
      connection.lastError = null;
      connection.healthCheckedAt = now();
      return this.catalog.filter((entry) => entry.connectionId === connection.id);
    } catch (error) {
      connection.healthStatus = "error";
      connection.healthMessage = error instanceof Error ? error.message : String(error);
      connection.lastError = connection.healthMessage;
      connection.healthCheckedAt = now();
      throw error;
    }
  }

  async dispatch(method: string, rawUrl: string, data?: unknown): Promise<MockResult> {
    const url = new URL(rawUrl, "http://paperclip.test");
    const path = url.pathname.replace(/^\/api/, "");
    const body = (data && typeof data === "object" ? data : {}) as JsonRecord;

    if (path === "/health") {
      return { body: { status: "ok", version: "test", deploymentExposure: "private", authReady: true, bootstrapStatus: "ready", features: { companyDeletionEnabled: true } } };
    }
    if (path === "/auth/get-session") {
      return { body: { session: { id: "session-test", userId: "user-test", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, user: { id: "user-test", name: "Test Operator", email: "operator@paperclip.test", image: null } } };
    }
    if (path.startsWith("/auth/")) {
      return { body: { user: { id: "user-test", name: body.name ?? "Test Operator", email: body.email ?? "operator@paperclip.test", image: null }, session: { id: "session-test" } } };
    }
    if (path === "/bootstrap/claim") return { body: { claimed: true, userId: "user-test" } };
    if (path === "/cli-auth/me") {
      return { body: { user: { id: "user-test", name: "Test Operator", email: "operator@paperclip.test", image: null }, userId: "user-test", isInstanceAdmin: true, companyIds: this.companies.map((row) => row.id), memberships: this.companies.map((row) => ({ companyId: row.id, membershipRole: "owner", status: "active" })), source: "better-auth", keyId: null } };
    }

    if (path === "/instance/settings/experimental") {
      if (method === "PATCH") Object.assign(this.settings, body);
      return { body: this.settings };
    }
    if (path === "/instance/settings/general") {
      return { body: { censorUsernameInLogs: false, keyboardShortcuts: true, feedbackDataSharingPreference: "ask", backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 }, ...body } };
    }
    if (path === "/instance/settings") {
      return { body: { id: "00000000-0000-4000-8000-000000000001", defaultEnvironmentId: null, general: { censorUsernameInLogs: false, keyboardShortcuts: true, feedbackDataSharingPreference: "ask", backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } }, experimental: this.settings, createdAt: now(), updatedAt: now() } };
    }

    if (path === "/companies/stats") {
      return { body: Object.fromEntries(this.companies.map((company) => [company.id, { agentCount: this.agents.filter((row) => row.companyId === company.id).length, issueCount: this.issues.filter((row) => row.companyId === company.id).length }])) };
    }
    if (path === "/companies" && method === "GET") return { body: this.companies };
    if (path === "/companies" && method === "POST") {
      this.companyOrdinal += 1;
      const companyId = id();
      const prefix = `E${String(this.companyOrdinal).padStart(2, "0")}`;
      const company = { id: companyId, name: body.name ?? `Company ${this.companyOrdinal}`, description: body.description ?? null, status: "active", issuePrefix: prefix, prefix, urlKey: prefix, budgetCurrency: "USD", budgetMonthlyAmount: "0", attachmentMaxBytes: 10_000_000, requireBoardApprovalForNewAgents: false, feedbackDataSharingEnabled: false, brandColor: null, logoAssetId: null, createdAt: now(), updatedAt: now() };
      this.companies.push(company);
      this.goals.push({ id: id(), companyId, level: "company", title: body.name ?? company.name, description: null, status: "active", createdAt: now(), updatedAt: now() });
      this.environments.push({ id: id(), companyId, name: "Local", description: null, driver: "local", status: "active", config: {}, metadata: null, createdAt: now(), updatedAt: now() });
      this.members.push({ id: id(), companyId, principalType: "user", principalId: "user-test", status: "active", membershipRole: "owner", createdAt: now(), updatedAt: now(), user: { id: "user-test", email: "operator@paperclip.test", name: "Test Operator", image: null }, grants: [], removal: { canArchive: false, reason: null } });
      return { status: 201, body: company };
    }
    const companyMatch = path.match(/^\/companies\/([^/]+)$/);
    if (companyMatch) {
      const company = this.company(companyMatch[1]!);
      if (!company) return { status: 404, body: { error: "Company not found" } };
      if (method === "DELETE") {
        this.companies = this.companies.filter((row) => row.id !== company.id);
        return { body: { ok: true } };
      }
      if (method === "PATCH") Object.assign(company, body, { updatedAt: now() });
      return { body: company };
    }

    const scoped = path.match(/^\/companies\/([^/]+)\/(.+)$/);
    if (scoped) {
      const companyId = scoped[1]!;
      const resource = scoped[2]!;
      if (resource === "goals") {
        if (method === "GET") return { body: this.goals.filter((row) => row.companyId === companyId) };
        const goal = { id: id(), companyId, level: body.level ?? "company", status: body.status ?? "active", ...body, createdAt: now(), updatedAt: now() };
        this.goals.push(goal);
        return { status: 201, body: goal };
      }
      if (resource === "environments") {
        if (method === "GET") return { body: this.environments.filter((row) => row.companyId === companyId) };
        const environment = { id: id(), companyId, status: "active", config: {}, metadata: null, ...body, createdAt: now(), updatedAt: now() };
        this.environments.push(environment);
        return { status: 201, body: environment };
      }
      if (resource === "agents" || resource === "runtime-agents") {
        if (method === "GET") return { body: this.agents.filter((row) => row.companyId === companyId) };
        const input = body.agent ?? body;
        const configuration = body.configuration ?? body.runtimeConfiguration ?? body;
        const agent = { id: id(), companyId, name: input.name ?? body.name ?? "Agent", title: input.title ?? body.title ?? null, icon: null, status: "idle", reportsTo: input.reportsTo ?? body.reportsTo ?? null, capabilities: input.capabilities ?? body.capabilities ?? null, adapterType: configuration.adapterType ?? body.adapterType ?? "codex", adapterConfig: configuration.adapterConfig ?? body.adapterConfig ?? { model: configuration.model ?? body.model ?? "gpt-5.6" }, currentAdapterConfigRevisionId: id(), runtimeConfig: configuration.runtimeConfig ?? {}, defaultEnvironmentId: configuration.defaultEnvironmentId ?? body.defaultEnvironmentId ?? this.environments.find((row) => row.companyId === companyId)?.id ?? null, permissions: {}, createdAt: now(), updatedAt: now() };
        this.agents.push(agent);
        if (resource === "runtime-agents") return { status: 201, body: { agent, configuration: { agentId: agent.id, adapterType: agent.adapterType, adapterConfig: agent.adapterConfig, defaultEnvironmentId: agent.defaultEnvironmentId }, auditId: id(), retried: false } };
        return { status: 201, body: agent };
      }
      if (resource === "issues") {
        if (method === "GET") return { body: this.issues.filter((row) => row.companyId === companyId) };
        const issue = { id: id(), companyId, identifier: `${this.company(companyId)?.issuePrefix ?? "ISS"}-${this.issues.length + 1}`, title: body.title ?? null, request: body.request ?? body.description ?? "", lifecycleStatus: body.lifecycleStatus ?? "open", boardPresentationStatus: body.boardPresentationStatus ?? "todo", ownerAgentId: body.ownerAgentId ?? body.assigneeAgentId ?? body.agentId ?? null, ownerUserId: body.ownerUserId ?? null, projectId: body.projectId ?? null, createdAt: now(), updatedAt: now() };
        this.issues.push(issue);
        if (issue.ownerAgentId) this.runs.push({ id: id(), companyId, issueId: issue.id, agentId: issue.ownerAgentId, targetAgentId: issue.ownerAgentId, status: "running", createdAt: now(), updatedAt: now() });
        return { status: 201, body: issue };
      }
      if (resource.startsWith("runs")) {
        const agentId = url.searchParams.get("agentId");
        return { body: { items: this.runs.filter((row) => row.companyId === companyId && (!agentId || row.agentId === agentId || row.targetAgentId === agentId)), nextCursor: null } };
      }
      if (resource === "projects") return { body: this.projects.filter((row) => row.companyId === companyId) };
      if (resource === "members") {
        return { body: { members: this.members.filter((row) => row.companyId === companyId), access: { currentUserRole: "owner", canManageMembers: true, canInviteUsers: true, canApproveJoinRequests: true } } };
      }
      const memberMatch = resource.match(/^members\/([^/]+)$/);
      if (memberMatch) {
        const member = this.members.find((row) => row.companyId === companyId && row.id === memberMatch[1]);
        if (!member) return { status: 404, body: { error: "Member not found" } };
        if (method === "PATCH") Object.assign(member, body, { updatedAt: now() });
        return { body: member };
      }
      if (resource === "invites") {
        if (method === "GET") return { body: { invites: this.invites.filter((row) => row.companyId === companyId), nextOffset: null } };
        const token = `pcp_mock_${id().replaceAll("-", "")}`;
        const invite = { id: id(), token, companyId, companyName: this.company(companyId)?.name ?? null, inviteType: "company_join", allowedJoinTypes: body.allowedJoinTypes ?? "human", humanRole: body.humanRole ?? "operator", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), source: "board", inviteUrl: `http://127.0.0.1/invite/${token}`, onboardingTextUrl: `http://127.0.0.1/invite/${token}`, state: "active", createdAt: now(), updatedAt: now() };
        this.invites.push(invite); return { status: 201, body: invite };
      }
      if (resource === "user-directory") return { body: { users: [{ principalId: "user-test", status: "active", user: { id: "user-test", email: "operator@paperclip.test", name: "Test Operator", image: null } }] } };
      if (resource === "issue-owner-catalog") return { body: this.agents.filter((row) => row.companyId === companyId).map((row) => ({ id: row.id, name: row.name, kind: "agent", capabilities: row.capabilities })) };
      if (resource === "org") return { body: [] };
      if (resource === "labels" || resource === "routines" || resource === "approvals") return { body: [] };

      if (resource === "pipelines") {
        if (method === "GET") {
          return {
            body: this.pipelines
              .filter((row) => row.companyId === companyId && !row.archivedAt)
              .map((row) => this.pipelineDetail(row)),
          };
        }
        const pipeline = {
          id: id(),
          companyId,
          key: body.key ?? `pipeline-${this.pipelines.length + 1}`,
          name: body.name ?? "Pipeline",
          description: body.description ?? null,
          projectId: body.projectId ?? null,
          enforceTransitions: body.enforceTransitions ?? false,
          archivedAt: null,
          connections: null,
          createdAt: now(),
          updatedAt: now(),
        };
        this.pipelines.push(pipeline);
        const inputs = Array.isArray(body.stages) && body.stages.length > 0
          ? body.stages
          : [
              { key: "intake", name: "Intake", kind: "open", position: 0, config: { variables: [] } },
              { key: "done", name: "Done", kind: "done", position: 100, config: { variables: [] } },
            ];
        for (const input of inputs) {
          this.stages.push({
            id: id(),
            pipelineId: pipeline.id,
            key: input.key,
            name: input.name,
            kind: input.kind,
            position: input.position,
            config: input.config ?? {},
            createdAt: now(),
            updatedAt: now(),
          });
        }
        return { status: 201, body: this.pipelineDetail(pipeline) };
      }
      if (resource === "review-cases") {
        const pipelineId = url.searchParams.get("pipelineId");
        const parentCaseId = url.searchParams.get("parentCaseId");
        const rows = this.cases.filter((caseValue) => {
          const pipeline = this.pipeline(caseValue.pipelineId);
          const stage = this.stage(caseValue.stageId);
          return pipeline?.companyId === companyId
            && stage?.kind === "review"
            && (!pipelineId || pipeline.id === pipelineId)
            && (!parentCaseId || caseValue.parentCaseId === parentCaseId);
        }).map((caseValue) => {
          const pipeline = this.pipeline(caseValue.pipelineId)!;
          const stage = this.stage(caseValue.stageId)!;
          return {
            case: this.caseRow(caseValue).case,
            pipeline: { id: pipeline.id, key: pipeline.key, name: pipeline.name },
            stage,
            parentCase: caseValue.parentCaseId ? this.caseRecord(caseValue.parentCaseId) ?? null : null,
            pendingSuggestion: caseValue.pendingSuggestion ?? null,
            reviewConfig: stage.config ?? {},
          };
        });
        return { body: rows };
      }
      if (resource === "pipelines-attention") {
        const reviews = this.cases.filter((caseValue) => {
          const pipeline = this.pipeline(caseValue.pipelineId);
          return pipeline?.companyId === companyId && this.stage(caseValue.stageId)?.kind === "review";
        }).map((caseValue) => {
          const pipeline = this.pipeline(caseValue.pipelineId)!;
          const stage = this.stage(caseValue.stageId)!;
          return {
            case: {
              ...this.caseRow(caseValue).case,
              pipeline: { id: pipeline.id, key: pipeline.key, name: pipeline.name },
              stage,
            },
            review: {
              expectedVersion: caseValue.version,
              approveToStageKey: stage.config?.approveToStageKey ?? null,
              rejectToStageKey: stage.config?.rejectToStageKey ?? null,
              requestChangesToStageKey: stage.config?.requestChangesToStageKey ?? null,
              requireRejectReason: Boolean(stage.config?.requireRejectReason),
              requireRequestChangesReason: Boolean(stage.config?.requireRequestChangesReason),
              reviewerKind: stage.config?.reviewerKind ?? "human",
            },
          };
        });
        const suggestions = this.cases.filter((row) => row.pendingSuggestion).map((caseValue) => {
          const pipeline = this.pipeline(caseValue.pipelineId)!;
          const stage = this.stage(caseValue.stageId)!;
          const target = this.stages.find((candidate) => candidate.pipelineId === pipeline.id && candidate.key === caseValue.pendingSuggestion.toStageKey);
          return {
            case: { ...this.caseRow(caseValue).case, pipeline: { id: pipeline.id, key: pipeline.key, name: pipeline.name }, stage },
            suggestion: {
              ...caseValue.pendingSuggestion,
              fromStageKey: stage.key,
              fromStageName: stage.name,
              toStageName: target?.name ?? null,
              suggestedBy: null,
            },
          };
        });
        const headsUp: JsonRecord[] = [];
        return { body: { suggestions, reviews, headsUp, counts: { suggestions: suggestions.length, reviews: reviews.length, headsUp: 0 } } };
      }
      if (resource === "case-events") {
        const items = this.caseEvents
          .filter((event) => this.caseRecord(event.caseId)?.companyId === companyId)
          .map((event) => {
            const caseValue = this.caseRecord(event.caseId)!;
            const pipeline = this.pipeline(caseValue.pipelineId)!;
            return {
              ...event,
              case: { id: caseValue.id, caseKey: caseValue.caseKey, title: caseValue.title, terminalKind: caseValue.terminalKind },
              pipeline: { id: pipeline.id, key: pipeline.key, name: pipeline.name },
              fromStage: event.fromStageId ? this.stage(event.fromStageId) ?? null : null,
              toStage: event.toStageId ? this.stage(event.toStageId) ?? null : null,
              actorAgent: null,
            };
          });
        return { body: { items, pagination: { limit: Number(url.searchParams.get("limit") ?? 100), offset: 0, nextOffset: null, hasMore: false } } };
      }

      if (resource === "tools/applications") {
        if (method === "GET") return { body: { applications: this.applications.filter((row) => row.companyId === companyId && row.status !== "archived") } };
        const application = { id: id(), companyId, name: body.name ?? "Application", description: body.description ?? null, type: body.type ?? "mcp_http", status: body.status ?? "active", pluginId: body.pluginId ?? null, ownerAgentId: null, ownerUserId: "user-test", metadata: body.metadata ?? null, archivedAt: null, createdAt: now(), updatedAt: now() };
        this.applications.push(application);
        return { status: 201, body: application };
      }
      if (resource === "tools/connections") {
        if (method === "GET") return { body: { connections: this.connections.filter((row) => row.companyId === companyId && row.status !== "archived") } };
        let application = body.applicationId ? this.application(body.applicationId) : undefined;
        if (!application) {
          application = { id: id(), companyId, name: body.applicationName ?? body.name ?? "Application", description: null, type: "mcp_http", status: "active", pluginId: null, ownerAgentId: null, ownerUserId: "user-test", metadata: null, archivedAt: null, createdAt: now(), updatedAt: now() };
          this.applications.push(application);
        }
        const connection = { id: id(), companyId, applicationId: application.id, name: body.name ?? application.name, uid: `mock:${id()}`, connectionKind: "mcp", ownership: "customer", transport: body.transport ?? "mcp_remote", authKind: "none", status: body.status ?? "active", transportConfig: body.transportConfig ?? body.config ?? {}, config: body.config ?? body.transportConfig ?? {}, credentialSecretRefs: [], credentialRefs: [], healthStatus: "ok", healthMessage: null, healthCheckedAt: now(), lastError: null, enabled: body.enabled ?? true, createdByAgentId: null, createdByUserId: "user-test", createdAt: now(), updatedAt: now(), installs: [], grants: [] };
        this.connections.push(connection);
        return { status: 201, body: connection };
      }
      if (resource === "tools/apps/connect") {
        const application = { id: id(), companyId, name: body.name ?? "Connected app", description: null, type: "mcp_http", status: "active", pluginId: null, ownerAgentId: null, ownerUserId: "user-test", metadata: null, archivedAt: null, createdAt: now(), updatedAt: now() };
        const connection = { id: id(), companyId, applicationId: application.id, name: application.name, uid: `mock:${id()}`, connectionKind: "mcp", ownership: "customer", transport: "mcp_remote", authKind: body.credentialValues ? "api_key" : "none", status: "draft", transportConfig: { url: body.link }, config: { url: body.link }, credentialSecretRefs: [], healthStatus: "ok", healthMessage: null, healthCheckedAt: now(), lastError: null, enabled: true, createdByAgentId: null, createdByUserId: "user-test", createdAt: now(), updatedAt: now(), installs: [], grants: [] };
        this.applications.push(application);
        this.connections.push(connection);
        const entries = await this.refreshCatalog(connection).catch(() => []);
        return { status: 201, body: { connectionId: connection.id, application, actions: { readOnly: entries.filter((entry) => entry.isReadOnly).map((entry) => ({ catalogEntryId: entry.id, name: entry.title, toolName: entry.toolName })), write: entries.filter((entry) => entry.isWrite).map((entry) => ({ catalogEntryId: entry.id, name: entry.title, toolName: entry.toolName })) } } };
      }
      const finishMatch = resource.match(/^tools\/apps\/([^/]+)\/finish$/);
      if (finishMatch) {
        const connection = this.connection(finishMatch[1]!);
        if (!connection) return { status: 404, body: { error: "Connection not found" } };
        connection.status = "active";
        return { body: { connection, application: this.application(connection.applicationId), installed: true } };
      }
      if (resource === "tools/apps/attention") return { body: { connections: this.connections.filter((row) => row.companyId === companyId && row.healthStatus !== "ok"), count: this.connections.filter((row) => row.companyId === companyId && row.healthStatus !== "ok").length } };
      if (resource === "tools/gallery") return { body: { apps: [] } };
      if (resource === "tools/profiles") {
        if (method === "GET") return { body: { profiles: this.profiles.filter((row) => row.companyId === companyId) } };
        const profile = { id: id(), companyId, entries: [], bindings: [], ...body, createdAt: now(), updatedAt: now() };
        this.profiles.push(profile); return { status: 201, body: profile };
      }
      if (resource === "tools/policies") {
        if (method === "GET") return { body: { policies: this.policies.filter((row) => row.companyId === companyId) } };
        const policy = { id: id(), companyId, status: "active", ...body, createdAt: now(), updatedAt: now() };
        this.policies.push(policy); return { status: 201, body: policy };
      }
      if (resource === "tools/gateways") {
        if (method === "GET") return { body: { gateways: this.gateways.filter((row) => row.companyId === companyId) } };
        const gateway = { id: id(), companyId, status: "active", tokens: [], ...body, createdAt: now(), updatedAt: now() };
        this.gateways.push(gateway); return { status: 201, body: gateway };
      }
      const approveActionMatch = resource.match(/^tools\/action-requests\/([^/]+)\/approve$/);
      if (approveActionMatch) {
        const actionRequest = this.actionRequests.find((row) => row.id === approveActionMatch[1]);
        if (!actionRequest) return { status: 404, body: { error: "Action request not found" } };
        actionRequest.status = "approved";
        actionRequest.phase = "done";
        actionRequest.updatedAt = now();
        return { body: actionRequest };
      }
      if (resource === "tools/runtime-slots") return { body: { runtimeSlots: [] } };
      if (resource === "tools/runtime-health") return { body: { status: "healthy", slots: [] } };
      if (resource === "smoke-lab/runs") {
        if (method === "GET") return { body: this.smokeRuns.filter((row) => row.companyId === companyId) };
        const run = { id: id(), companyId, status: "running", ...body, createdAt: now(), updatedAt: now() };
        this.smokeRuns.push(run); return { status: 201, body: { run } };
      }
      const smokeRunMatch = resource.match(/^smoke-lab\/runs\/([^/]+)(?:\/(steps))?$/);
      if (smokeRunMatch) {
        const run = this.smokeRuns.find((row) => row.id === smokeRunMatch[1] && row.companyId === companyId);
        if (!run) return { status: 404, body: { error: "Smoke run not found" } };
        if (smokeRunMatch[2] === "steps" && method === "POST") {
          const step = { id: id(), companyId, runId: run.id, ...body, createdAt: now(), updatedAt: now() };
          this.smokeSteps.push(step);
          return { status: 201, body: { step, summary: { recorded: this.smokeSteps.filter((row) => row.runId === run.id).length } } };
        }
        if (method === "PATCH") Object.assign(run, body, { updatedAt: now() });
        return { body: { run, steps: this.smokeSteps.filter((row) => row.runId === run.id) } };
      }
      if (resource === "smoke-lab/services/start") {
        return { body: { started: true, services: [{ id: "oauth", status: "running" }, { id: "mcp-http", status: "running" }] } };
      }
      if (resource === "smoke-lab/services" && method === "GET") {
        return { body: { services: [{ id: "oauth", status: "running" }, { id: "mcp-http", status: "running" }] } };
      }
      if (resource === "smoke-lab/install-fixtures") {
        let connections = this.connections.filter((row) => row.companyId === companyId && row.smokeFixture);
        if (connections.length === 0) {
          for (const fixture of [
            { name: "Smoke Lab HTTP MCP fixture", transport: "mcp_remote", tools: ["todo.list", "todo.add", "email.send", "fixture.schemaFlip"] },
            { name: "Smoke Lab stdio MCP fixture", transport: "local_stdio", tools: ["time.now", "slow.ping", "crash.now", "malicious.metadata"] },
          ]) {
            const application = { id: id(), companyId, name: fixture.name, description: "Deterministic browser fixture", type: fixture.transport === "mcp_remote" ? "mcp_http" : "mcp_stdio", status: "active", ownerUserId: "user-test", createdAt: now(), updatedAt: now() };
            const connection = { id: id(), companyId, applicationId: application.id, name: fixture.name, uid: `smoke:${id()}`, connectionKind: "mcp", ownership: "customer", transport: fixture.transport, authKind: "none", status: "active", transportConfig: {}, config: {}, credentialSecretRefs: [], credentialRefs: [], healthStatus: "ok", healthMessage: null, healthCheckedAt: now(), lastError: null, enabled: true, smokeFixture: true, createdByUserId: "user-test", createdAt: now(), updatedAt: now(), installs: [], grants: [] };
            this.applications.push(application);
            this.connections.push(connection);
            fixture.tools.forEach((toolName, index) => {
              this.catalog.push({
                id: id(),
                companyId,
                applicationId: application.id,
                connectionId: connection.id,
                entryKind: "tool",
                name: toolName,
                toolName,
                title: toolName,
                description: "Deterministic Smoke Lab action",
                inputSchema: {},
                riskLevel: index === 0 ? "low" : "medium",
                isReadOnly: index === 0,
                isWrite: index !== 0,
                isDestructive: index === 2,
                status: "active",
                createdAt: now(),
                updatedAt: now(),
              });
            });
          }
          connections = this.connections.filter((row) => row.companyId === companyId && row.smokeFixture);
        }
        return { body: { connections, catalog: this.catalog.filter((entry) => connections.some((connection) => connection.id === entry.connectionId)) } };
      }
    }

    const pipelineMatch = path.match(/^\/pipelines\/([^/]+)(?:\/(.*))?$/);
    if (pipelineMatch) {
      const pipeline = this.pipeline(pipelineMatch[1]!);
      if (!pipeline) return { status: 404, body: { code: "not_found", error: "Pipeline not found" } };
      const action = pipelineMatch[2];
      if (!action) {
        if (method === "PATCH") {
          Object.assign(pipeline, body, {
            archivedAt: body.archived === true ? now() : body.archived === false ? null : pipeline.archivedAt,
            updatedAt: now(),
          });
        }
        return { body: this.pipelineDetail(pipeline) };
      }
      if (action === "health") {
        return { body: { healthy: true, status: "healthy", warnings: [], errors: [], pipelineId: pipeline.id } };
      }
      if (action === "intake-form") {
        const stage = this.stages
          .filter((candidate) => candidate.pipelineId === pipeline.id)
          .sort((left, right) => left.position - right.position)[0];
        const variables = Array.isArray(stage?.config?.variables) ? stage.config.variables : [];
        return {
          body: {
            pipelineId: pipeline.id,
            stageId: stage?.id ?? null,
            stageName: stage?.name ?? null,
            fields: variables.map((variable: JsonRecord) => ({
              key: variable.key ?? variable.name,
              label: variable.label ?? variable.key ?? variable.name,
              type: variable.type ?? "text",
              options: variable.options ?? [],
              required: variable.required ?? false,
            })),
          },
        };
      }
      if (action === "stages" && method === "POST") {
        const stage = {
          id: id(),
          pipelineId: pipeline.id,
          key: body.key,
          name: body.name,
          kind: body.kind,
          position: body.position,
          config: body.config ?? {},
          createdAt: now(),
          updatedAt: now(),
        };
        this.stages.push(stage);
        pipeline.updatedAt = now();
        return { status: 201, body: stage };
      }
      const stageMatch = action.match(/^stages\/([^/]+)(?:\/(.*))?$/);
      if (stageMatch) {
        const stage = this.stage(stageMatch[1]!);
        if (!stage || stage.pipelineId !== pipeline.id) return { status: 404, body: { code: "not_found", error: "Stage not found" } };
        if (method === "DELETE") {
          this.stages = this.stages.filter((candidate) => candidate.id !== stage.id);
          return { body: { deleted: true } };
        }
        if (method === "PATCH") {
          if (stageMatch[2] === "automation-env") stage.automationEnv = body.env ?? null;
          else Object.assign(stage, body);
          stage.updatedAt = now();
        }
        return { body: stage };
      }
      if (action === "transitions" && method === "PUT") {
        this.transitions = this.transitions.filter((candidate) => candidate.pipelineId !== pipeline.id);
        for (const edge of body.transitions ?? []) {
          const from = this.stages.find((candidate) => candidate.pipelineId === pipeline.id && candidate.key === edge.fromStageKey);
          const to = this.stages.find((candidate) => candidate.pipelineId === pipeline.id && candidate.key === edge.toStageKey);
          if (from && to) this.transitions.push({ id: id(), pipelineId: pipeline.id, fromStageId: from.id, toStageId: to.id, label: edge.label ?? null });
        }
        if (typeof body.enforceTransitions === "boolean") pipeline.enforceTransitions = body.enforceTransitions;
        pipeline.updatedAt = now();
        return { body: { transitions: this.transitions.filter((candidate) => candidate.pipelineId === pipeline.id) } };
      }
      if (action === "cases") {
        if (method === "GET") {
          const parentCaseId = url.searchParams.get("parentCaseId");
          const terminal = url.searchParams.get("terminal");
          return {
            body: this.cases.filter((caseValue) => {
              if (caseValue.pipelineId !== pipeline.id) return false;
              if (parentCaseId && caseValue.parentCaseId !== parentCaseId) return false;
              if (terminal === "true" && !this.isTerminalCase(caseValue)) return false;
              if (terminal === "false" && this.isTerminalCase(caseValue)) return false;
              return true;
            }).map((caseValue) => this.caseRow(caseValue)),
          };
        }
        return { status: 201, body: this.createCase(pipeline, body) };
      }
      if (action === "cases/batch" && method === "POST") {
        return {
          status: 201,
          body: (body.items ?? []).map((input: JsonRecord) => ({ ok: true, ...this.createCase(pipeline, input) })),
        };
      }
      const pipelineDocumentMatch = action.match(/^documents\/([^/]+)(?:\/revisions(?:\/([^/]+)\/restore)?)?$/);
      if (pipelineDocumentMatch) {
        const key = decodeURIComponent(pipelineDocumentMatch[1]!);
        if (action.endsWith("/revisions")) return { body: [] };
        const document = { id: `${pipeline.id}:${key}`, title: body.title ?? key, latestBody: body.body ?? "", format: "markdown" };
        const revision = { id: id(), pipelineId: pipeline.id, key, revisionNumber: 1, title: document.title, format: "markdown", body: body.body ?? "", changeSummary: null, createdAt: now() };
        if (method === "GET") return { body: { link: { key, documentId: document.id }, document, revision } };
        return { body: { document, revision } };
      }
    }

    const caseMatch = path.match(/^\/cases\/([^/]+)(?:\/(.*))?$/);
    if (caseMatch) {
      const caseValue = this.caseRecord(caseMatch[1]!);
      if (!caseValue) return { status: 404, body: { code: "not_found", error: "Item not found" } };
      const action = caseMatch[2];
      const pipeline = this.pipeline(caseValue.pipelineId)!;
      const currentStage = () => this.stage(caseValue.stageId)!;
      const versionConflict = () => typeof body.expectedVersion === "number" && body.expectedVersion !== caseValue.version;
      if (!action) {
        if (method === "PATCH") {
          if (versionConflict()) return { status: 409, body: { code: "version_conflict", error: "Item changed since it was loaded" } };
          const fieldsChanged = body.fields !== undefined && JSON.stringify(body.fields) !== JSON.stringify(caseValue.fields);
          if (body.title !== undefined) caseValue.title = body.title;
          if (body.summary !== undefined) caseValue.summary = body.summary;
          if (body.fields !== undefined) caseValue.fields = body.fields;
          if (body.parentCaseId !== undefined) caseValue.parentCaseId = body.parentCaseId;
          caseValue.version += 1;
          caseValue.updatedAt = now();
          this.addCaseEvent(caseValue, "updated", { fieldsChanged });
          if (fieldsChanged) {
            for (const dependent of this.cases.filter((candidate) => (candidate.blockedByCaseIds ?? []).includes(caseValue.id))) {
              dependent.unresolvedDrift = true;
              this.addCaseEvent(dependent, "upstream_drift", {
                upstreamCaseId: caseValue.id,
                upstreamTitle: caseValue.title,
                version: caseValue.version,
              });
            }
          }
          return { body: this.caseRow(caseValue).case };
        }
        return { body: this.caseDetail(caseValue) };
      }
      if (action === "events") {
        const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";
        const items = this.caseEvents.filter((event) => event.caseId === caseValue.id);
        if (order === "desc") items.reverse();
        return { body: { items, pagination: { limit: Number(url.searchParams.get("limit") ?? 100), offset: 0, nextOffset: null, hasMore: false, order } } };
      }
      if (action === "children") {
        return { body: this.cases.filter((candidate) => candidate.parentCaseId === caseValue.id).map((candidate) => this.caseRow(candidate)) };
      }
      if (action === "children/tree") {
        const row = this.caseRow(caseValue);
        return { body: { case: { ...row.case, pipeline: { id: pipeline.id, key: pipeline.key, name: pipeline.name }, stage: row.stage }, childGroups: [], totalNodes: 1, truncated: false } };
      }
      if (action === "issue-links") return { body: [] };
      if (action === "outputs") return { body: { items: [], outputs: [] } };
      if (action === "suggest-transition" && method === "POST") {
        caseValue.pendingSuggestion = { id: id(), toStageKey: body.toStageKey, rationale: body.rationale, confidence: body.confidence ?? null, createdAt: now() };
        this.addCaseEvent(caseValue, "transition_suggested", { toStageKey: body.toStageKey, rationale: body.rationale });
        return { status: 201, body: { case: this.caseRow(caseValue).case, suggestion: caseValue.pendingSuggestion } };
      }
      if (action === "resolve-suggestion" && method === "POST") {
        const suggestion = caseValue.pendingSuggestion;
        if (!suggestion) return { status: 404, body: { code: "not_found", error: "Suggestion not found" } };
        if (body.resolution === "accept") {
          const target = this.stages.find((candidate) => candidate.pipelineId === pipeline.id && candidate.key === suggestion.toStageKey);
          if (target) {
            const fromStageId = caseValue.stageId;
            caseValue.stageId = target.id;
            caseValue.version += 1;
            caseValue.updatedAt = now();
            this.addCaseEvent(caseValue, "transition_suggestion_accepted", { fromStageId, toStageId: target.id, reason: body.reason ?? suggestion.rationale });
          }
        } else {
          this.addCaseEvent(caseValue, "transition_suggestion_dismissed", { reason: body.reason ?? null });
        }
        caseValue.pendingSuggestion = null;
        return { body: { case: this.caseRow(caseValue).case, resolved: true } };
      }
      if (action === "acknowledge-drift" && method === "POST") {
        if (versionConflict()) return { status: 409, body: { code: "version_conflict", error: "Item changed since it was loaded" } };
        caseValue.unresolvedDrift = false;
        caseValue.updatedAt = now();
        const event = this.addCaseEvent(caseValue, "drift_acknowledged");
        return { body: { case: this.caseRow(caseValue).case, event, acknowledged: true } };
      }
      if (action === "review" && method === "POST") {
        if (versionConflict()) return { status: 409, body: { code: "version_conflict", error: "Item changed since it was loaded" } };
        const stage = currentStage();
        const targetKey = body.decision === "approve"
          ? stage.config?.approveToStageKey
          : body.decision === "reject"
            ? stage.config?.rejectToStageKey
            : stage.config?.requestChangesToStageKey;
        const target = this.stages.find((candidate) => candidate.pipelineId === pipeline.id && candidate.key === targetKey);
        const fromStageId = caseValue.stageId;
        if (target) caseValue.stageId = target.id;
        caseValue.version += 1;
        caseValue.updatedAt = now();
        if (body.decision === "approve") caseValue.reviewedVersion = caseValue.version;
        const event = this.addCaseEvent(caseValue, "review_decided", { decision: body.decision, reason: body.reason ?? null, fromStageId, toStageId: target?.id ?? null });
        return { body: { case: this.caseRow(caseValue).case, event } };
      }
      if (action === "transition" && method === "POST") {
        if (versionConflict()) return { status: 409, body: { code: "version_conflict", error: "Item changed since it was loaded" } };
        const target = this.stages.find((candidate) => candidate.pipelineId === pipeline.id && (candidate.key === body.toStageKey || candidate.id === body.toStageKey));
        if (!target) return { status: 422, body: { code: "invalid_stage", error: "Target stage does not exist" } };
        const unresolvedBlockers = (caseValue.blockedByCaseIds ?? [])
          .map((blockedById: string) => this.caseRecord(blockedById))
          .filter((candidate: JsonRecord | undefined): candidate is JsonRecord => Boolean(candidate && !this.isTerminalCase(candidate)));
        if (unresolvedBlockers.length > 0) {
          return { status: 409, body: { code: "blocked", error: `Blocked by ${unresolvedBlockers.map((candidate) => candidate.title).join(", ")}` } };
        }
        if (caseValue.unresolvedDrift) {
          return { status: 409, body: { code: "unresolved_drift", error: "Upstream changes were not acknowledged" } };
        }
        const terminalTarget = target.kind === "done" || target.kind === "cancelled";
        const children = this.cases.filter((candidate) => candidate.parentCaseId === caseValue.id);
        const nonterminalChildren = children.filter((candidate) => !this.isTerminalCase(candidate));
        if (terminalTarget && currentStage().config?.requireChildrenTerminal && nonterminalChildren.length > 0) {
          return { status: 409, body: { code: "children_not_terminal", error: `Children must finish first: ${nonterminalChildren.map((candidate) => candidate.title).join(", ")}` } };
        }
        if (terminalTarget && caseValue.reviewedVersion != null && caseValue.reviewedVersion !== caseValue.version) {
          return { status: 409, body: { code: "review_outdated", error: "Item changed since review approval" } };
        }
        const edgeAllowed = this.transitions.some((edge) => edge.pipelineId === pipeline.id && edge.fromStageId === caseValue.stageId && edge.toStageId === target.id);
        if (pipeline.enforceTransitions && !edgeAllowed && !body.force) {
          return { status: 409, body: { code: "transition_not_allowed", error: "This move skips the normal flow" } };
        }
        const fromStageId = caseValue.stageId;
        caseValue.stageId = target.id;
        caseValue.version += 1;
        caseValue.updatedAt = now();
        caseValue.terminalKind = terminalTarget ? target.kind : null;
        caseValue.terminalAt = terminalTarget ? now() : null;
        const event = this.addCaseEvent(caseValue, body.force ? "transition_forced" : "transitioned", { fromStageId, toStageId: target.id, reason: body.reason ?? null });
        return { body: { case: this.caseRow(caseValue).case, event } };
      }
      const caseDocumentMatch = action.match(/^documents\/([^/]+)(?:\/revisions(?:\/([^/]+)\/restore)?)?$/);
      if (caseDocumentMatch) {
        const key = decodeURIComponent(caseDocumentMatch[1]!);
        if (action.endsWith("/revisions")) return { body: [] };
        const document = { id: `${caseValue.id}:${key}`, title: body.title ?? key, latestBody: body.body ?? "", format: body.format ?? "markdown" };
        const revision = { id: id(), caseId: caseValue.id, key, revisionNumber: 1, title: document.title, format: document.format, body: body.body ?? "", changeSummary: body.changeSummary ?? null, createdAt: now() };
        if (method === "GET") return { body: { link: { key, documentId: document.id }, document, revision } };
        return { body: { document, revision } };
      }
    }

    const issueMatch = path.match(/^\/issues\/([^/]+)$/);
    if (issueMatch) {
      const issue = this.issues.find((row) => row.id === issueMatch[1]);
      if (!issue) return { status: 404, body: { error: "Issue not found" } };
      if (method === "PATCH") Object.assign(issue, body, { updatedAt: now() });
      return { body: issue };
    }

    const inviteMatch = path.match(/^\/invites\/([^/]+)(?:\/accept)?$/);
    if (inviteMatch) {
      const invite = this.invites.find((row) => row.token === inviteMatch[1] || row.id === inviteMatch[1]);
      if (!invite) return { status: 404, body: { error: "Invite not found" } };
      if (method === "GET") return { body: invite };
      invite.state = "accepted";
      const member = { id: id(), companyId: invite.companyId, principalType: "user", principalId: body.userId ?? id(), status: "active", membershipRole: invite.humanRole ?? "operator", createdAt: now(), updatedAt: now(), user: { id: body.userId ?? id(), email: body.email ?? "invitee@paperclip.test", name: body.name ?? "Invited User", image: null }, grants: [], removal: { canArchive: true, reason: null } };
      this.members.push(member);
      return { body: { ...member, requestType: "human", status: "approved" } };
    }

    const applicationMatch = path.match(/^\/tool-applications\/([^/]+)$/);
    if (applicationMatch) {
      const application = this.application(applicationMatch[1]!);
      if (!application) return { status: 404, body: { error: "Application not found" } };
      if (method === "DELETE") application.status = "archived";
      if (method === "PATCH") Object.assign(application, body, { updatedAt: now() });
      return { body: application };
    }

    if (path === "/tool-gateway/audit" && method === "GET") {
      const companyId = url.searchParams.get("companyId");
      const connectionId = url.searchParams.get("app");
      const agentId = url.searchParams.get("agent");
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const events = this.auditEvents.filter((event) =>
        (!companyId || event.companyId === companyId)
        && (!connectionId || event.connectionId === connectionId)
        && (!agentId || event.agentId === agentId)
        && (!search || String(event.toolName ?? event.message ?? "").toLowerCase().includes(search)),
      );
      return { body: { events, nextCursor: null } };
    }
    const gatewayTokenCreateMatch = path.match(/^\/tool-gateway\/gateways\/([^/]+)\/tokens$/);
    if (gatewayTokenCreateMatch && method === "POST") {
      const gateway = this.gateways.find((row) => row.id === gatewayTokenCreateMatch[1]);
      if (!gateway) return { status: 404, body: { error: "Gateway not found" } };
      const token = { id: id(), gatewayId: gateway.id, companyId: body.companyId ?? gateway.companyId, token: `pcp_gateway_${id().replaceAll("-", "")}`, status: "active", ...body, createdAt: now(), updatedAt: now() };
      this.gatewayTokens.push(token);
      return { status: 201, body: token };
    }
    const gatewayMcpMatch = path.match(/^\/tool-gateway\/gateways\/([^/]+)\/mcp$/);
    if (gatewayMcpMatch && method === "POST") {
      const bearer = typeof body.authorization === "string" ? body.authorization : null;
      const supplied = url.searchParams.get("token") ?? bearer;
      const tokenValue = supplied?.replace(/^Bearer\s+/i, "");
      // APIRequestContext headers are not passed as body, so the deterministic
      // fixture accepts the only active token for this gateway.
      const active = this.gatewayTokens.find((row) => row.gatewayId === gatewayMcpMatch[1] && row.status === "active" && (!tokenValue || row.token === tokenValue));
      if (!active) return { status: 401, body: { error: "Token revoked" } };
      return { body: { jsonrpc: "2.0", id: body.id ?? 1, result: { tools: this.catalog.map((entry) => ({ name: entry.toolName, description: entry.description, inputSchema: entry.inputSchema })) } } };
    }
    const gatewayTokenRevokeMatch = path.match(/^\/tool-gateway\/gateway-tokens\/([^/]+)\/revoke$/);
    if (gatewayTokenRevokeMatch && method === "POST") {
      const token = this.gatewayTokens.find((row) => row.id === gatewayTokenRevokeMatch[1]);
      if (!token) return { status: 404, body: { error: "Gateway token not found" } };
      token.status = "revoked";
      token.updatedAt = now();
      return { body: token };
    }

    const connectionMatch = path.match(/^\/tool-connections\/([^/]+)(?:\/(.*))?$/);
    if (connectionMatch) {
      const connection = this.connection(connectionMatch[1]!);
      if (!connection) return { status: 404, body: { error: "Connection not found" } };
      const action = connectionMatch[2];
      if (!action && method === "DELETE") { connection.status = "archived"; return { body: connection }; }
      if (!action && method === "PATCH") {
        Object.assign(connection, body, { config: body.config ? { ...connection.config, ...body.config } : connection.config, transportConfig: body.transportConfig ? { ...connection.transportConfig, ...body.transportConfig } : connection.transportConfig, updatedAt: now() });
      }
      if (action === "catalog") return { body: { catalog: this.catalog.filter((row) => row.connectionId === connection.id) } };
      if (action === "catalog/refresh") {
        const hasRemoteTarget = Boolean(connection.config?.url ?? connection.transportConfig?.url);
        const entries = hasRemoteTarget
          ? await this.refreshCatalog(connection).catch(() => [])
          : this.catalog.filter((row) => row.connectionId === connection.id);
        const quarantinedCount = connection.config?.quarantineNewEntries ? 1 : 0;
        return { body: { connectionId: connection.id, catalog: entries, added: entries.length, updated: 0, removed: 0, quarantinedCount } };
      }
      if (action === "health-check") {
        try { await this.refreshCatalog(connection); return { body: { connection, ok: true, healthStatus: "ok" } }; }
        catch { return { status: 502, body: { error: "Connection health check failed", connection } }; }
      }
      if (action === "reconnect") {
        try { await this.refreshCatalog(connection); connection.status = "active"; return { body: { connection, ok: true, healthStatus: "ok" } }; }
        catch { return { status: 502, body: { error: "Reconnect failed", connection } }; }
      }
      if (action === "activity") return { body: { events: this.auditEvents.filter((row) => row.connectionId === connection.id), nextCursor: null } };
      if (action === "test-agents") return { body: { agents: this.agents.filter((row) => row.companyId === connection.companyId) } };
      if (action === "test-calls" && method === "POST") {
        const toolName = body.toolName;
        const matching = this.policies.filter((policy) =>
          policy.companyId === connection.companyId
          && policy.status !== "archived"
          && policy.selectors?.connectionId === connection.id
          && (policy.selectors?.toolNames ?? []).includes(toolName),
        );
        const blocked = matching.find((policy) => policy.policyType === "block");
        const approval = matching.find((policy) => policy.policyType === "require_approval");
        const invocationId = id();
        let result: JsonRecord;
        if (blocked) {
          result = { decision: "off", invocationId, error: { reasonCode: "policy_blocked", message: "Action is blocked by test policy" } };
        } else if (approval) {
          const actionRequest = { id: id(), companyId: connection.companyId, connectionId: connection.id, agentId: body.agentId, toolName, phase: "waiting_for_approval", status: "pending", createdAt: now(), updatedAt: now() };
          this.actionRequests.push(actionRequest);
          result = { decision: "ask_first", invocationId, actionRequestId: actionRequest.id };
        } else {
          result = { decision: "allowed", invocationId };
        }
        this.auditEvents.push({ id: id(), companyId: connection.companyId, connectionId: connection.id, agentId: body.agentId, toolName, decision: result.decision, message: `${toolName}: ${result.decision}`, createdAt: now() });
        return { status: 201, body: result };
      }
      const testCallMatch = action?.match(/^test-calls\/([^/]+)$/);
      if (testCallMatch && method === "GET") {
        const actionRequest = this.actionRequests.find((row) => row.id === testCallMatch[1]);
        if (!actionRequest) return { status: 404, body: { error: "Test call not found" } };
        return { body: { phase: actionRequest.phase, actionRequestId: actionRequest.id } };
      }
      return { body: connection };
    }

    if (path === "/sidebar-preferences/me" || path.endsWith("/sidebar-preferences/me")) return { body: { order: [], companyIds: [] } };
    if (path.includes("/inbox-dismissals")) return { body: [] };
    if (path.includes("/events/ws")) return { status: 426, body: { error: "WebSocket unavailable in UI fixture" } };

    if (method === "GET") {
      if (/\/(?:comments|attachments|approvals|documents|work-products|projects|routines|labels|agents|issues|goals|events)$/.test(path)) return { body: [] };
      if (/\/(?:count|counts)$/.test(path)) return { body: { count: 0 } };
      return { body: [] };
    }
    return { body: { id: id(), ...body, createdAt: now(), updatedAt: now() } };
  }

  response(method: string, url: string, options: JsonRecord = {}) {
    return this.dispatch(method, url, options.data).then(({ status = 200, body, headers }) =>
      new MockApiResponse(url, status, body, headers) as unknown as APIResponse,
    );
  }

  requestContext(): APIRequestContext {
    const call = (method: string) => (url: string, options?: JsonRecord) =>
      this.response(method, url, options);
    return {
      get: call("GET"),
      post: call("POST"),
      put: call("PUT"),
      patch: call("PATCH"),
      delete: call("DELETE"),
      head: call("HEAD"),
      fetch: (url: string, options: JsonRecord = {}) => this.response(options.method ?? "GET", url, options),
      dispose: async () => {},
      storageState: async () => ({ cookies: [], origins: [] }),
    } as unknown as APIRequestContext;
  }
}

const mockApi = new MockPaperclipApi();

export const request = {
  ...playwrightRequest,
  newContext: async () => mockApi.requestContext(),
};

export const test = base.extend({
  request: async ({}, use) => {
    await use(mockApi.requestContext());
  },
  page: async ({ page }, use) => {
    await page.routeWebSocket(paperclipLiveEventsWebSocketPattern, (socket) => {
      // Omitting connectToServer() makes this a fully mocked, always-open
      // transport. LiveUpdatesProvider stays connected without any chance of
      // reaching a Paperclip server or entering a reconnect loop.
      socket.onMessage(() => undefined);
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      let data: unknown;
      try { data = request.postDataJSON(); } catch { data = request.postData() ?? undefined; }
      const result = await mockApi.dispatch(request.method(), request.url(), data);
      await route.fulfill({
        status: result.status ?? 200,
        headers: { "content-type": "application/json", ...result.headers },
        body: typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? null),
      });
    });
    await use(page);
  },
});

export { expect };
export type {
  APIRequestContext,
  APIResponse,
  Browser,
  Locator,
  Page,
} from "@playwright/test";
