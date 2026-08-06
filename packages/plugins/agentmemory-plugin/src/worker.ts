import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import {
  AgentMemoryClient,
  parseAgentMemoryConfig,
} from "./agentmemory-client.js";
import {
  captureTerminalRun,
} from "./capture.js";
import type { MemoryPartitionKind } from "./memory-partitions.js";
import { MEMORY_TOOL_DEFINITIONS } from "./memory-tools.js";
import { beforePrompt, recall } from "./runtime.js";

function registerTool(
  ctx: PluginContext,
  name: string,
  kind: MemoryPartitionKind,
): void {
  ctx.tools.register(
    name,
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
      await ctx.logger.error("AgentMemory run capture failed", {
        eventType,
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

let workerContext: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    workerContext = ctx;
    for (const { declaration, partitionKind } of MEMORY_TOOL_DEFINITIONS) {
      registerTool(ctx, declaration.name, partitionKind);
    }

    registerCaptureHandler(ctx, "agent.run.finished");
    registerCaptureHandler(ctx, "agent.run.failed");
    registerCaptureHandler(ctx, "agent.run.cancelled");
  },

  async onBeforePrompt(input) {
    if (!workerContext) {
      throw new Error("AgentMemory worker received beforePrompt before setup");
    }
    return beforePrompt(workerContext, input);
  },

  async onValidateConfig(config) {
    try {
      parseAgentMemoryConfig(config);
      return { ok: true, errors: [] };
    } catch (error) {
      return {
        ok: false,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  },

  async onHealth() {
    if (!workerContext) {
      throw new Error("AgentMemory worker received health before setup");
    }
    const client = await AgentMemoryClient.connect(workerContext);
    const health = await client.health();
    return {
      status: health.status === "healthy"
        ? "ok"
        : health.status === "degraded"
          ? "degraded"
          : "error",
      message: `AgentMemory ${health.version} reported ${health.status}`,
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
