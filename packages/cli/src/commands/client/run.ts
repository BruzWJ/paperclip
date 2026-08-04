import type {
  IssueExecutionRunEnvelopeRecord,
  IssueExecutionRunListPageRecord,
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

interface RunLogOptions extends BaseClientOptions {
  offset?: string;
  limitBytes?: string;
  text?: boolean;
}

interface RunWatchdogOptions extends BaseClientOptions {
  decision: string;
  reason?: string;
  snoozedUntil?: string;
  evaluationIssueId?: string;
}

export function registerRunCommands(command: Command): void {
  addCommonClientOptions(
    command
      .command("list")
      .description("List canonical issue-execution run envelopes")
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
          const page = await ctx.api.get<IssueExecutionRunListPageRecord>(
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
      .description("Get the bounded joined detail for an issue-execution run")
      .argument("<runId>", "Issue-execution run ID")
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
      .description("Cancel an active issue-execution run")
      .argument("<runId>", "Issue-execution run ID")
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

  addCommonClientOptions(
    command
      .command("workspace-log")
      .description("Read a typed workspace-operation log")
      .argument("<operationId>", "Workspace operation ID")
      .option("--offset <bytes>", "Byte offset", "0")
      .option("--limit-bytes <bytes>", "Maximum bytes to read")
      .option("--text", "Print only the returned text field")
      .action(async (operationId: string, opts: RunLogOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await fetchWorkspaceLog(
            ctx.api,
            apiPath`/api/workspace-operations/${operationId}/log`,
            opts,
          );
          printLogResult(result, { json: ctx.json, text: opts.text });
        } catch (error) {
          handleCommandError(error);
        }
      }),
  );

  addCommonClientOptions(
    command
      .command("watchdog-decision")
      .description("Record a watchdog decision for an issue-execution run")
      .argument("<runId>", "Issue-execution run ID")
      .requiredOption(
        "--decision <decision>",
        "snooze, continue, or dismissed_false_positive",
      )
      .option("--reason <text>", "Decision reason")
      .option("--snoozed-until <iso8601>", "Required for snooze decisions")
      .option("--evaluation-issue-id <id>", "Related evaluation issue ID")
      .action(async (runId: string, opts: RunWatchdogOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const decision = await ctx.api.post(
            apiPath`/api/runs/${runId}/watchdog-decisions`,
            {
              decision: opts.decision,
              reason: opts.reason,
              snoozedUntil: opts.snoozedUntil,
              evaluationIssueId: opts.evaluationIssueId,
            },
          );
          printOutput(decision, { json: ctx.json });
        } catch (error) {
          handleCommandError(error);
        }
      }),
  );
}

async function fetchWorkspaceLog(
  api: { get<T>(path: string): Promise<T | null> },
  path: string,
  opts: RunLogOptions,
): Promise<unknown> {
  const params = new URLSearchParams();
  if (opts.offset) params.set("offset", opts.offset);
  if (opts.limitBytes) params.set("limitBytes", opts.limitBytes);
  return api.get(`${path}?${params.toString()}`);
}

function printRuns(
  rows: IssueExecutionRunEnvelopeRecord[],
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
        issueId: row.issueId,
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

function printLogResult(
  result: unknown,
  opts: { json: boolean; text?: boolean },
): void {
  if (opts.json) {
    printOutput(result, { json: true });
    return;
  }
  if (
    opts.text &&
    typeof result === "object" &&
    result !== null &&
    "text" in result
  ) {
    const text = (result as { text?: unknown }).text;
    process.stdout.write(typeof text === "string" ? text : String(text ?? ""));
    return;
  }
  printOutput(result, { json: false });
}
