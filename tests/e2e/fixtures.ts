import { randomUUID } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test as base,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { LIVE_EVENT_SOCKET_PATH } from "../../packages/shared/src/constants.js";

type JsonRecord = Record<string, any>;
type MockResult = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

const now = () => new Date().toISOString();
const id = () => randomUUID();
const paperclipLiveEventsSocketPattern = new RegExp(
  `^wss?:\\/\\/[^/]+${LIVE_EVENT_SOCKET_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\?[^#]*)?$`,
);
const paperclipLiveEventsApiFixturePath = LIVE_EVENT_SOCKET_PATH.replace(
  /^\/api/,
  "",
);

class MockApiResponse {
  constructor(
    private readonly requestUrl: string,
    private readonly statusCode: number,
    private readonly payload: unknown,
    private readonly responseHeaders: Record<string, string> = {},
  ) {}

  ok() {
    return this.statusCode >= 200 && this.statusCode < 300;
  }
  status() {
    return this.statusCode;
  }
  statusText() {
    return this.ok() ? "OK" : "Mock request failed";
  }
  url() {
    return this.requestUrl;
  }
  headers() {
    return { "content-type": "application/json", ...this.responseHeaders };
  }
  headersArray() {
    return Object.entries(this.headers()).map(([name, value]) => ({
      name,
      value,
    }));
  }
  async body() {
    return Buffer.from(await this.text());
  }
  async text() {
    return typeof this.payload === "string"
      ? this.payload
      : JSON.stringify(this.payload ?? null);
  }
  async json() {
    return this.payload;
  }
  async dispose() {}
}

export class MockPaperclipApi {
  companies: JsonRecord[] = [];
  agents: JsonRecord[] = [];
  goals: JsonRecord[] = [];
  tasks: JsonRecord[] = [];
  runs: JsonRecord[] = [];
  projects: JsonRecord[] = [];
  members: JsonRecord[] = [];
  invites: JsonRecord[] = [];
  private companyOrdinal = 0;
  private authenticatedUser = {
    id: "user-test",
    name: "Test Operator",
    email: "operator@paperclip.test",
    image: null,
  };

  private company(idValue: string) {
    return this.companies.find((row) => row.id === idValue);
  }

  async dispatch(
    method: string,
    rawUrl: string,
    data?: unknown,
  ): Promise<MockResult> {
    const url = new URL(rawUrl, "http://paperclip.test");
    const path = url.pathname.replace(/^\/api/, "");
    const body = (data && typeof data === "object" ? data : {}) as JsonRecord;

    if (path === "/health") {
      return {
        body: {
          status: "ok",
          version: "test",
          deploymentExposure: "private",
          authReady: true,
          bootstrapStatus: "ready",
          features: { companyDeletionEnabled: true },
        },
      };
    }
    if (path === "/auth/get-session") {
      return {
        body: {
          session: {
            id: "session-test",
            userId: this.authenticatedUser.id,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
          user: this.authenticatedUser,
        },
      };
    }
    if (path.startsWith("/auth/")) {
      if (typeof body.email === "string") {
        this.authenticatedUser = {
          id: `user-${body.email}`,
          name: body.name ?? "Test Operator",
          email: body.email,
          image: null,
        };
      }
      return {
        body: {
          user: this.authenticatedUser,
          session: { id: "session-test" },
        },
      };
    }
    if (path === "/bootstrap/claim")
      return { body: { claimed: true, userId: "user-test" } };
    const cliAuthUserMatch = path.match(/^\/cli-auth\/users\/([^/]+)$/);
    if (cliAuthUserMatch) {
      const userId = decodeURIComponent(cliAuthUserMatch[1]!);
      const memberships = this.members.filter(
        (member) =>
          member.principalType === "user" &&
          member.principalId === userId &&
          member.status === "active",
      );
      const user =
        memberships.find((member) => member.user)?.user ??
        (userId === this.authenticatedUser.id ? this.authenticatedUser : null);
      return {
        body: {
          user,
          userId,
          isInstanceAdmin: true,
          companyIds: memberships.map((membership) => membership.companyId),
          memberships: memberships.map((membership) => ({
            companyId: membership.companyId,
            membershipRole: membership.membershipRole,
            status: membership.status,
          })),
          source: "better-auth",
          keyId: null,
        },
      };
    }

    if (path === "/instance/settings/general") {
      return {
        body: {
          censorUsernameInLogs: false,
          keyboardShortcuts: true,
          enableWorkspaceBranchReconcileForward: true,
          enableWorkspaceDirtyQuarantineRepair: true,
          ...body,
        },
      };
    }
    if (path === "/instance/settings") {
      return {
        body: {
          id: "00000000-0000-4000-8000-000000000001",
          general: {
            censorUsernameInLogs: false,
            keyboardShortcuts: true,
            enableWorkspaceBranchReconcileForward: true,
            enableWorkspaceDirtyQuarantineRepair: true,
          },
          createdAt: now(),
          updatedAt: now(),
        },
      };
    }

    if (path === "/companies/stats") {
      return {
        body: Object.fromEntries(
          this.companies.map((company) => [
            company.id,
            {
              agentCount: this.agents.filter(
                (row) => row.companyId === company.id,
              ).length,
              taskCount: this.tasks.filter(
                (row) => row.companyId === company.id,
              ).length,
            },
          ]),
        ),
      };
    }
    if (path === "/companies" && method === "GET")
      return { body: this.companies };
    if (path === "/companies" && method === "POST") {
      this.companyOrdinal += 1;
      const companyId = id();
      const prefix = `E${String(this.companyOrdinal).padStart(2, "0")}`;
      const company = {
        id: companyId,
        name: body.name ?? `Company ${this.companyOrdinal}`,
        description: body.description ?? null,
        status: "active",
        taskPrefix: prefix,
        budgetCurrency: "USD",
        budgetMonthlyAmount: "0",
        attachmentMaxBytes: 10_000_000,
        requireBoardApprovalForNewAgents: false,
        brandColor: null,
        logoAssetId: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.companies.push(company);
      this.goals.push({
        id: id(),
        companyId,
        level: "company",
        title: body.name ?? company.name,
        description: null,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      });
      this.members.push({
        id: id(),
        companyId,
        principalType: "user",
        principalId: this.authenticatedUser.id,
        status: "active",
        membershipRole: "owner",
        createdAt: now(),
        updatedAt: now(),
        user: this.authenticatedUser,
        grants: [],
        removal: { canArchive: false, reason: null },
      });
      return { status: 201, body: company };
    }

    const companyMatch = path.match(/^\/companies\/([^/]+)$/);
    if (companyMatch) {
      const company = this.company(companyMatch[1]!);
      if (!company)
        return { status: 404, body: { error: "Company not found" } };
      if (method === "DELETE") {
        this.companies = this.companies.filter((row) => row.id !== company.id);
        this.goals = this.goals.filter((row) => row.companyId !== company.id);
        return { body: { ok: true } };
      }
      if (method === "PATCH")
        Object.assign(company, body, { updatedAt: now() });
      return { body: company };
    }

    const scoped = path.match(/^\/companies\/([^/]+)\/(.+)$/);
    if (scoped) {
      const companyId = scoped[1]!;
      const resource = scoped[2]!;
      if (resource === "goals") {
        if (method === "GET")
          return {
            body: this.goals.filter((row) => row.companyId === companyId),
          };
        const goal = {
          id: id(),
          companyId,
          level: body.level ?? "company",
          status: body.status ?? "active",
          ...body,
          createdAt: now(),
          updatedAt: now(),
        };
        this.goals.push(goal);
        return { status: 201, body: goal };
      }
      if (resource === "agents" || resource === "runtime-agents") {
        if (method === "GET")
          return {
            body: this.agents.filter((row) => row.companyId === companyId),
          };
        const input = body.agent ?? body;
        const configuration =
          body.configuration ?? body.runtimeConfiguration ?? body;
        const agent = {
          id: id(),
          companyId,
          name: input.name ?? body.name ?? "Agent",
          title: input.title ?? body.title ?? null,
          icon: null,
          status: "idle",
          reportsTo: input.reportsTo ?? body.reportsTo ?? null,
          capabilities: input.capabilities ?? body.capabilities ?? null,
          adapterType: configuration.adapterType ?? body.adapterType ?? "codex",
          adapterConfig: configuration.adapterConfig ??
            body.adapterConfig ?? {
              model: configuration.model ?? body.model ?? "gpt-5.6",
            },
          currentAdapterConfigRevisionId: id(),
          runtimeConfig: configuration.runtimeConfig ?? {},
          permissions: {},
          createdAt: now(),
          updatedAt: now(),
        };
        this.agents.push(agent);
        if (resource === "runtime-agents") {
          return {
            status: 201,
            body: {
              agent,
              configuration: {
                agentId: agent.id,
                adapterType: agent.adapterType,
                adapterConfig: agent.adapterConfig,
              },
              auditId: id(),
              retried: false,
            },
          };
        }
        return { status: 201, body: agent };
      }
      const taskNumberMatch = /^tasks\/([1-9]\d*)$/.exec(resource);
      if (method === "GET" && taskNumberMatch) {
        const taskNumber = Number(taskNumberMatch[1]);
        const task = this.tasks.find(
          (row) => row.companyId === companyId && row.taskNumber === taskNumber,
        );
        return task
          ? { body: task }
          : { status: 404, body: { error: "Task not found" } };
      }
      if (resource === "tasks") {
        if (method === "GET")
          return {
            body: this.tasks.filter((row) => row.companyId === companyId),
          };
        const taskNumber =
          this.tasks.filter((row) => row.companyId === companyId).length + 1;
        const task = {
          id: id(),
          companyId,
          taskNumber,
          identifier: `${this.company(companyId)?.taskPrefix ?? "TSK"}-${taskNumber}`,
          title: body.title ?? null,
          request: body.request ?? body.description ?? "",
          lifecycleStatus: body.lifecycleStatus ?? "open",
          boardPresentationStatus: body.boardPresentationStatus ?? "todo",
          ownerAgentId:
            body.ownerAgentId ?? body.assigneeAgentId ?? body.agentId ?? null,
          ownerUserId: body.ownerUserId ?? null,
          projectId: body.projectId ?? null,
          goalId: body.goalId ?? null,
          createdAt: now(),
          updatedAt: now(),
        };
        this.tasks.push(task);
        if (task.ownerAgentId) {
          this.runs.push({
            id: id(),
            companyId,
            taskId: task.id,
            agentId: task.ownerAgentId,
            targetAgentId: task.ownerAgentId,
            status: "running",
            createdAt: now(),
            updatedAt: now(),
          });
        }
        return { status: 201, body: task };
      }
      if (resource.startsWith("runs")) {
        const agentId = url.searchParams.get("agentId");
        return {
          body: {
            items: this.runs.filter(
              (row) =>
                row.companyId === companyId &&
                (!agentId ||
                  row.agentId === agentId ||
                  row.targetAgentId === agentId),
            ),
            nextCursor: null,
          },
        };
      }
      if (resource === "projects")
        return {
          body: this.projects.filter((row) => row.companyId === companyId),
        };
      if (resource === "members") {
        return {
          body: {
            members: this.members.filter((row) => row.companyId === companyId),
            access: {
              currentUserRole: "owner",
              canManageMembers: true,
              canInviteUsers: true,
              canApproveJoinRequests: true,
            },
          },
        };
      }
      const memberMatch = resource.match(/^members\/([^/]+)$/);
      if (memberMatch) {
        const member = this.members.find(
          (row) => row.companyId === companyId && row.id === memberMatch[1],
        );
        if (!member)
          return { status: 404, body: { error: "Member not found" } };
        if (method === "PATCH")
          Object.assign(member, body, { updatedAt: now() });
        return { body: member };
      }
      if (resource === "invites") {
        if (method === "GET") {
          return {
            body: {
              invites: this.invites.filter(
                (row) => row.companyId === companyId,
              ),
              nextOffset: null,
            },
          };
        }
        const token = `pcp_mock_${id().replaceAll("-", "")}`;
        const invite = {
          id: id(),
          token,
          companyId,
          companyName: this.company(companyId)?.name ?? null,
          inviteType: "company_join",
          userRole: body.userRole ?? "operator",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          source: "board",
          inviteUrl: `http://127.0.0.1/invite/${token}`,
          state: "active",
          createdAt: now(),
          updatedAt: now(),
        };
        this.invites.push(invite);
        return { status: 201, body: invite };
      }
      if (resource === "user-directory") {
        return {
          body: {
            users: [
              {
                principalId: "user-test",
                status: "active",
                user: {
                  id: "user-test",
                  email: "operator@paperclip.test",
                  name: "Test Operator",
                  image: null,
                },
              },
            ],
          },
        };
      }
      if (resource === "task-owner-catalog") {
        return {
          body: this.agents
            .filter((row) => row.companyId === companyId)
            .map((row) => ({
              id: row.id,
              name: row.name,
              kind: "agent",
              capabilities: row.capabilities,
            })),
        };
      }
      if (resource === "org") return { body: [] };
      if (
        resource === "labels" ||
        resource === "routines" ||
        resource === "approvals"
      )
        return { body: [] };
    }

    const goalMatch = path.match(/^\/goals\/([^/]+)$/);
    if (goalMatch) {
      const goal = this.goals.find((row) => row.id === goalMatch[1]);
      if (!goal) return { status: 404, body: { error: "Goal not found" } };
      if (method === "PATCH") Object.assign(goal, body, { updatedAt: now() });
      if (method === "DELETE")
        this.goals = this.goals.filter((row) => row.id !== goal.id);
      return { body: goal };
    }

    const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const task = this.tasks.find((row) => row.id === taskMatch[1]);
      if (!task) return { status: 404, body: { error: "Task not found" } };
      if (method === "PATCH") Object.assign(task, body, { updatedAt: now() });
      return { body: task };
    }

    const inviteMatch = path.match(/^\/invites\/([^/]+)(?:\/accept)?$/);
    if (inviteMatch) {
      const invite = this.invites.find(
        (row) => row.token === inviteMatch[1] || row.id === inviteMatch[1],
      );
      if (!invite) return { status: 404, body: { error: "Invite not found" } };
      if (method === "GET") return { body: invite };
      if (Object.keys(body).length > 0) {
        return {
          status: 400,
          body: { error: "Invalid invite acceptance body" },
        };
      }
      invite.state = "accepted";
      const joinRequestId = id();
      const member = {
        id: id(),
        companyId: invite.companyId,
        principalType: "user",
        principalId: this.authenticatedUser.id,
        status: "active",
        membershipRole: invite.userRole ?? "operator",
        createdAt: now(),
        updatedAt: now(),
        user: this.authenticatedUser,
        grants: [],
        removal: { canArchive: true, reason: null },
      };
      this.members.push(member);
      return {
        status: 202,
        body: {
          id: joinRequestId,
          inviteId: invite.id,
          companyId: invite.companyId,
          status: "approved",
          requestIp: "127.0.0.1",
          requestingUserId: this.authenticatedUser.id,
          requestEmailSnapshot: this.authenticatedUser.email,
          approvedByUserId: null,
          approvedAt: now(),
          rejectedByUserId: null,
          rejectedAt: null,
          createdAt: now(),
          updatedAt: now(),
        },
      };
    }

    if (
      path === "/users/user-test/sidebar-preferences" ||
      path.endsWith("/users/user-test/sidebar-preferences")
    ) {
      return { body: { orderedIds: [], updatedAt: null } };
    }
    if (path.includes("/inbox-dismissals")) return { body: [] };
    if (path === paperclipLiveEventsApiFixturePath) {
      return {
        status: 426,
        body: { error: "Socket.IO unavailable in API fixture" },
      };
    }

    if (method === "GET") {
      if (
        /\/(?:comments|attachments|approvals|documents|work-products|projects|routines|labels|agents|tasks|events)$/.test(
          path,
        )
      )
        return { body: [] };
      if (/\/(?:count|counts)$/.test(path)) return { body: { count: 0 } };
      return { body: [] };
    }
    return { body: { id: id(), ...body, createdAt: now(), updatedAt: now() } };
  }

  response(method: string, url: string, options: JsonRecord = {}) {
    return this.dispatch(method, url, options.data).then(
      ({ status = 200, body, headers }) =>
        new MockApiResponse(
          url,
          status,
          body,
          headers,
        ) as unknown as APIResponse,
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
      fetch: (url: string, options: JsonRecord = {}) =>
        this.response(options.method ?? "GET", url, options),
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
    await page.routeWebSocket(paperclipLiveEventsSocketPattern, (socket) => {
      const sid = "paperclip-e2e-live-events";
      socket.send(
        `0${JSON.stringify({
          sid,
          upgrades: [],
          pingInterval: 60_000,
          pingTimeout: 20_000,
          maxPayload: 1_000_000,
        })}`,
      );
      socket.onMessage((message) => {
        const packet =
          typeof message === "string" ? message : message.toString();
        if (packet.startsWith("40")) {
          socket.send(`40${JSON.stringify({ sid })}`);
        }
      });
    });
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async (route) => {
      const request = route.request();
      let data: unknown;
      try {
        data = request.postDataJSON();
      } catch {
        data = request.postData() ?? undefined;
      }
      const result = await mockApi.dispatch(
        request.method(),
        request.url(),
        data,
      );
      await route.fulfill({
        status: result.status ?? 200,
        headers: { "content-type": "application/json", ...result.headers },
        body:
          typeof result.body === "string"
            ? result.body
            : JSON.stringify(result.body ?? null),
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
