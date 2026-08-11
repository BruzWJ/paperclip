import { randomUUID } from "node:crypto";
import { definePlugin, runWorker, type PluginApiRequestInput } from "@paperclipai/plugin-sdk";

type SmokeInput = {
  companyId: string;
  taskId: string;
  ownerAgentId?: string | null;
};

type SmokeSummary = {
  rootTaskId: string;
  childTaskId: string | null;
  ownerAgentId: string;
  request: string;
  childStatus: string | null;
  joinedRows: unknown[];
};

let readSmokeSummary: ((companyId: string, taskId: string) => Promise<SmokeSummary | null>) | null = null;
let initializeSmoke: ((input: SmokeInput) => Promise<SmokeSummary>) | null = null;

function tableName(namespace: string) {
  return `${namespace}.smoke_runs`;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const CREATOR_CALLBACK_KEY = "task-runtime-smoke";
const CREATOR_CALLBACK_VERSION = "1";

const plugin = definePlugin({
  async setup(ctx) {
    await ctx.tasks.registerCreatorCallback(
      {
        key: CREATOR_CALLBACK_KEY,
        version: CREATOR_CALLBACK_VERSION,
      },
      async (delivery) => ({
        deliveryId: delivery.deliveryId,
        accepted: true,
      }),
    );

    readSmokeSummary = async function readSummary(companyId: string, taskId: string): Promise<SmokeSummary | null> {
      const rows = await ctx.db.query<{
        root_task_id: string;
        child_task_id: string | null;
        owner_agent_id: string;
        request: string;
        task_title: string;
      }>(
        `SELECT s.root_task_id, s.child_task_id, s.owner_agent_id, s.request, i.title AS task_title
         FROM ${tableName(ctx.db.namespace)} s
         JOIN public.tasks i ON i.id = s.root_task_id
         WHERE s.root_task_id = $1`,
        [taskId],
      );
      const row = rows[0];
      if (!row) return null;
      const child = row.child_task_id
        ? await ctx.tasks.get(row.child_task_id, companyId)
        : null;
      return {
        rootTaskId: row.root_task_id,
        childTaskId: row.child_task_id,
        ownerAgentId: row.owner_agent_id,
        request: row.request,
        childStatus: child?.lifecycleStatus ?? null,
        joinedRows: rows,
      };
    };

    initializeSmoke = async function runSmoke(input: SmokeInput): Promise<SmokeSummary> {
      const root = await ctx.tasks.get(input.taskId, input.companyId);
      if (!root) throw new Error(`Task not found: ${input.taskId}`);

      const ownerAgentId = input.ownerAgentId ?? root.ownerAgentId;
      if (!ownerAgentId) {
        throw new Error("ownerAgentId is required when the root task has no assigned agent");
      }
      const request = "Verify canonical plugin task creation and task updates.";
      const child = await ctx.tasks.create({
        companyId: input.companyId,
        parentId: input.taskId,
        projectId: root.projectId ?? undefined,
        title: "Plugin task runtime smoke child",
        request,
        ownerAgentId,
        callbackKey: CREATOR_CALLBACK_KEY,
        callbackVersion: CREATOR_CALLBACK_VERSION,
        priority: "medium",
      });

      await ctx.db.execute(
        `INSERT INTO ${tableName(ctx.db.namespace)} (id, root_task_id, child_task_id, owner_agent_id, request)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           child_task_id = EXCLUDED.child_task_id,
           owner_agent_id = EXCLUDED.owner_agent_id,
           request = EXCLUDED.request,
           updated_at = now()`,
        [
          randomUUID(),
          input.taskId,
          child.id,
          ownerAgentId,
          request,
        ],
      );

      return {
        rootTaskId: input.taskId,
        childTaskId: child.id,
        ownerAgentId,
        request,
        childStatus: child.lifecycleStatus,
        joinedRows: await ctx.db.query(
          `SELECT s.id, s.owner_agent_id, i.title AS root_title
           FROM ${tableName(ctx.db.namespace)} s
           JOIN public.tasks i ON i.id = s.root_task_id
           WHERE s.root_task_id = $1`,
          [input.taskId],
        ),
      };
    };

    ctx.data.register("surface-status", async (params) => {
      const companyId = stringField(params.companyId);
      const taskId = stringField(params.taskId);
      return {
        status: "ok",
        checkedAt: new Date().toISOString(),
        databaseNamespace: ctx.db.namespace,
        routeKeys: (ctx.manifest.apiRoutes ?? []).map((route) => route.routeKey),
        capabilities: ctx.manifest.capabilities,
        summary: companyId && taskId ? await readSmokeSummary?.(companyId, taskId) ?? null : null,
      };
    });

    ctx.actions.register("initialize-smoke", async (params, context) => {
      const companyId = context.actor.companyId;
      const taskId = stringField(params.taskId);
      if (!companyId || !taskId) throw new Error("companyId and taskId are required");
      if (!initializeSmoke) throw new Error("Smoke initializer is not ready");
      return initializeSmoke({
        companyId,
        taskId,
        ownerAgentId: stringField(params.ownerAgentId),
      });
    });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    if (input.routeKey === "summary") {
      const taskId = input.params.taskId;
      return {
        body: await readSmokeSummary?.(input.companyId, taskId) ?? null,
      };
    }

    if (input.routeKey === "initialize") {
      if (!initializeSmoke) throw new Error("Smoke initializer is not ready");
      const body = input.body as Record<string, unknown> | null;
      return {
        status: 201,
        body: await initializeSmoke({
          companyId: input.companyId,
          taskId: input.params.taskId,
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
        surfaces: ["database", "scoped-api-route", "task-panel", "canonical-task-control-plane"],
      },
    };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
