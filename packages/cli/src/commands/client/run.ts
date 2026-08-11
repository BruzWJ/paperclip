import type {
  TaskExecutionRunEnvelopeRecord,
  TaskExecutionRunListPageRecord,
} from "@paperclipai/shared";
import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface RunListOptions extends BaseClientOptions {
  agentId?: string;
  cursor?: string;
  limit?: string;
}

export function registerRunCommands(command: Command): void {
  addCommonClientOptions(
    command
      .command("list")
      .description("List canonical task-execution run envelopes")
      .option("-C, --company-id <id>", "Company ID")
      .option("--agent-id <id>", "Filter by target agent ID")
      .option("--cursor <cursor>", "Continue from a prior page")
      .option("--limit <n>", "Maximum runs to return")
      .action(async (opts: RunListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.agentId) params.set("agentId", opts.agentId);
          if (opts.cursor) params.set("cursor", opts.cursor);
          if (opts.limit) params.set("limit", opts.limit);
          const query = params.toString();
          const page = await ctx.api.get<TaskExecutionRunListPageRecord>(
            `${apiPath`/api/companies/${ctx.companyId}/runs`}${query ? `?${query}` : ""}`,
          );
          printRuns(page?.items ?? [], ctx.json, page?.nextCursor ?? null);
        } catch (error) {
          handleCommandError(error);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    command
      .command("get")
      .description("Get the bounded joined detail for a task-execution run")
      .argument("<runId>", "Task-execution run ID")
      .option("--limit <n>", "Maximum records per joined owner", "200")
      .action(
        async (
          runId: string,
          opts: BaseClientOptions & { limit?: string },
        ) => {
          try {
            const ctx = resolveCommandContext(opts);
            const params = new URLSearchParams();
            if (opts.limit) params.set("limit", opts.limit);
            const detail = await ctx.api.get<unknown>(
              `${apiPath`/api/runs/${runId}`}${params.size > 0 ? `?${params}` : ""}`,
            );
            printOutput(detail, { json: ctx.json });
          } catch (error) {
            handleCommandError(error);
          }
        },
      ),
  );

  addCommonClientOptions(
    command
      .command("cancel")
      .description("Cancel an active task-execution run")
      .argument("<runId>", "Task-execution run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post(
            apiPath`/api/runs/${runId}/cancel`,
            {},
          );
          printOutput(result, { json: ctx.json });
        } catch (error) {
          handleCommandError(error);
        }
      }),
  );

}

function printRuns(
  rows: TaskExecutionRunEnvelopeRecord[],
  json: boolean,
  nextCursor: string | null,
): void {
  if (json) {
    printOutput({ items: rows, nextCursor }, { json: true });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        id: row.id,
        kind: row.kind,
        status: row.status,
        taskId: row.taskId,
        targetAgentId: row.targetAgentId,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        terminalClassification: row.terminalClassification,
      }),
    );
  }
  if (rows.length === 0) printOutput([], { json: false });
  if (nextCursor) console.log(formatInlineRecord({ nextCursor }));
}
