import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginToolDeclaration,
  type PluginToolRunContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import {
  AgentMemoryClient,
  normalizeAgentMemoryBaseUrl,
  renderSearchResult,
} from "./agentmemory-client.js";
import { captureCommentEvent, captureTerminalRun } from "./capture.js";
import manifest from "./manifest.js";
import { memoryPartition, type MemoryPartitionKind } from "./memory-partitions.js";

function readString(
  params: unknown,
  key: "query" | "issueId",
): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toolDeclaration(name: string): PluginToolDeclaration {
  const declaration = manifest.tools?.find((tool) => tool.name === name);
  if (!declaration) throw new Error(`Missing AgentMemory tool declaration: ${name}`);
  return declaration;
}

async function recall(input: {
  ctx: PluginContext;
  runContext: PluginToolRunContext;
  kind: MemoryPartitionKind;
  params: unknown;
}): Promise<ToolResult> {
  const query = readString(input.params, "query");
  if (!query) return { error: "query is required" };
  const resolved = await input.runContext.resolve();
  let issueId: string | undefined;
  if (input.kind === "issue_agent" || input.kind === "issue_shared") {
    issueId = readString(input.params, "issueId") ?? undefined;
    if (!issueId) return { error: "issueId is required" };
    const reach = await input.runContext.issueReach(issueId);
    if (!reach.visible) {
      return { error: "Issue memory is outside the current context-access reach" };
    }
  } else if (resolved.contextAccess.list_company_issues !== true) {
    return {
      error:
        "Company-wide memory requires list_company_issues in the current context-access matrix",
    };
  }

  const partition = memoryPartition(input.kind, {
    companyId: resolved.companyId,
    issueId,
    agentId:
      input.kind === "issue_agent" || input.kind === "company_agent"
        ? resolved.agentId
        : undefined,
  });
  const client = await AgentMemoryClient.connect(input.ctx, resolved.companyId);
  const result = await client.search(partition, query);
  return {
    content: renderSearchResult(result),
    data: result,
  };
}

function registerTool(
  ctx: PluginContext,
  name: string,
  kind: MemoryPartitionKind,
): void {
  const declaration = toolDeclaration(name);
  ctx.tools.register(
    name,
    {
      displayName: declaration.displayName,
      description: declaration.description,
      parametersSchema: declaration.parametersSchema,
    },
    async (params, runContext) => recall({ ctx, runContext, kind, params }),
  );
}

function registerCaptureHandler(
  ctx: PluginContext,
  eventType: "agent.run.finished" | "agent.run.failed" | "agent.run.cancelled",
): void {
  ctx.events.on(eventType, async (event: PluginEvent) => {
    try {
      await captureTerminalRun(ctx, event);
    } catch (error) {
      ctx.logger.error("AgentMemory run capture failed", {
        eventType,
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    registerTool(ctx, "read_issue_agent_memory", "issue_agent");
    registerTool(ctx, "read_issue_shared_memory", "issue_shared");
    registerTool(ctx, "read_company_agent_memory", "company_agent");
    registerTool(ctx, "read_company_shared_memory", "company_shared");

    registerCaptureHandler(ctx, "agent.run.finished");
    registerCaptureHandler(ctx, "agent.run.failed");
    registerCaptureHandler(ctx, "agent.run.cancelled");
    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      try {
        await captureCommentEvent(ctx, event);
      } catch (error) {
        ctx.logger.error("AgentMemory comment capture failed", {
          eventId: event.eventId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    try {
      normalizeAgentMemoryBaseUrl(config.baseUrl);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const secret = config.apiSecret;
    if (
      !secret
      || typeof secret !== "object"
      || Array.isArray(secret)
      || (secret as Record<string, unknown>).type !== "secret_ref"
      || typeof (secret as Record<string, unknown>).secretId !== "string"
    ) {
      errors.push("apiSecret must be a Paperclip secret reference");
    }
    return { ok: errors.length === 0, errors };
  },

  async onHealth() {
    return {
      status: "ok",
      message: "AgentMemory adapter worker is running; service health is checked per company on use",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
