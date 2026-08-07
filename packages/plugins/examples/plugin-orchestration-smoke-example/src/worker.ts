import { randomUUID } from "node:crypto";
import { definePlugin, runWorker, type PluginApiRequestInput } from "@paperclipai/plugin-sdk";

type SmokeInput = {
  companyId: string;
  issueId: string;
  ownerAgentId?: string | null;
};

type SmokeSummary = {
  rootIssueId: string;
  childIssueId: string | null;
  ownerAgentId: string;
  request: string;
  childStatus: string | null;
  joinedRows: unknown[];
};

let readSmokeSummary: ((companyId: string, issueId: string) => Promise<SmokeSummary | null>) | null = null;
let initializeSmoke: ((input: SmokeInput) => Promise<SmokeSummary>) | null = null;

function tableName(namespace: string) {
  return `${namespace}.smoke_runs`;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const CREATOR_CALLBACK_KEY = "issue-runtime-smoke";
const CREATOR_CALLBACK_VERSION = "1";

const plugin = definePlugin({
  async setup(ctx) {
    await ctx.issues.registerCreatorCallback(
      {
        key: CREATOR_CALLBACK_KEY,
        version: CREATOR_CALLBACK_VERSION,
      },
      async (delivery) => ({
        deliveryId: delivery.deliveryId,
        accepted: true,
      }),
    );

    readSmokeSummary = async function readSummary(companyId: string, issueId: string): Promise<SmokeSummary | null> {
      const rows = await ctx.db.query<{
        root_issue_id: string;
        child_issue_id: string | null;
        owner_agent_id: string;
        request: string;
        issue_title: string;
      }>(
        `SELECT s.root_issue_id, s.child_issue_id, s.owner_agent_id, s.request, i.title AS issue_title
         FROM ${tableName(ctx.db.namespace)} s
         JOIN public.issues i ON i.id = s.root_issue_id
         WHERE s.root_issue_id = $1`,
        [issueId],
      );
      const row = rows[0];
      if (!row) return null;
      const child = row.child_issue_id
        ? await ctx.issues.get(row.child_issue_id, companyId)
        : null;
      return {
        rootIssueId: row.root_issue_id,
        childIssueId: row.child_issue_id,
        ownerAgentId: row.owner_agent_id,
        request: row.request,
        childStatus: child?.lifecycleStatus ?? null,
        joinedRows: rows,
      };
    };

    initializeSmoke = async function runSmoke(input: SmokeInput): Promise<SmokeSummary> {
      const root = await ctx.issues.get(input.issueId, input.companyId);
      if (!root) throw new Error(`Issue not found: ${input.issueId}`);

      const ownerAgentId = input.ownerAgentId ?? root.ownerAgentId;
      if (!ownerAgentId) {
        throw new Error("ownerAgentId is required when the root issue has no assigned agent");
      }
      const request = "Verify canonical plugin issue creation and issue updates.";
      const child = await ctx.issues.create({
        companyId: input.companyId,
        parentId: input.issueId,
        projectId: root.projectId ?? undefined,
        title: "Plugin issue runtime smoke child",
        request,
        ownerAgentId,
        callbackKey: CREATOR_CALLBACK_KEY,
        callbackVersion: CREATOR_CALLBACK_VERSION,
        priority: "medium",
      });

      await ctx.db.execute(
        `INSERT INTO ${tableName(ctx.db.namespace)} (id, root_issue_id, child_issue_id, owner_agent_id, request)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           child_issue_id = EXCLUDED.child_issue_id,
           owner_agent_id = EXCLUDED.owner_agent_id,
           request = EXCLUDED.request,
           updated_at = now()`,
        [
          randomUUID(),
          input.issueId,
          child.id,
          ownerAgentId,
          request,
        ],
      );

      return {
        rootIssueId: input.issueId,
        childIssueId: child.id,
        ownerAgentId,
        request,
        childStatus: child.lifecycleStatus,
        joinedRows: await ctx.db.query(
          `SELECT s.id, s.owner_agent_id, i.title AS root_title
           FROM ${tableName(ctx.db.namespace)} s
           JOIN public.issues i ON i.id = s.root_issue_id
           WHERE s.root_issue_id = $1`,
          [input.issueId],
        ),
      };
    };

    ctx.data.register("surface-status", async (params) => {
      const companyId = stringField(params.companyId);
      const issueId = stringField(params.issueId);
      return {
        status: "ok",
        checkedAt: new Date().toISOString(),
        databaseNamespace: ctx.db.namespace,
        routeKeys: (ctx.manifest.apiRoutes ?? []).map((route) => route.routeKey),
        capabilities: ctx.manifest.capabilities,
        summary: companyId && issueId ? await readSmokeSummary?.(companyId, issueId) ?? null : null,
      };
    });

    ctx.actions.register("initialize-smoke", async (params, context) => {
      const companyId = context.actor.companyId;
      const issueId = stringField(params.issueId);
      if (!companyId || !issueId) throw new Error("companyId and issueId are required");
      if (!initializeSmoke) throw new Error("Smoke initializer is not ready");
      return initializeSmoke({
        companyId,
        issueId,
        ownerAgentId: stringField(params.ownerAgentId),
      });
    });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    if (input.routeKey === "summary") {
      const issueId = input.params.issueId;
      return {
        body: await readSmokeSummary?.(input.companyId, issueId) ?? null,
      };
    }

    if (input.routeKey === "initialize") {
      if (!initializeSmoke) throw new Error("Smoke initializer is not ready");
      const body = input.body as Record<string, unknown> | null;
      return {
        status: 201,
        body: await initializeSmoke({
          companyId: input.companyId,
          issueId: input.params.issueId,
          ownerAgentId: stringField(body?.ownerAgentId),
        }),
      };
    }

    return {
      status: 404,
      body: { error: `Unknown orchestration smoke route: ${input.routeKey}` },
    };
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Orchestration smoke plugin worker is running",
      details: {
        surfaces: ["database", "scoped-api-route", "issue-panel", "canonical-issue-control-plane"],
      },
    };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
