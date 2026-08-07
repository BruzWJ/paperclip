import { randomUUID } from "node:crypto";
import { Command } from "commander";
import {
  agentAdapterRevisionConfigurationSchema,
  agentOperationalConfigurationUpdateSchema,
  runtimeAgentCreateConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
  type Agent,
  type Company,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AgentListOptions extends BaseClientOptions {
  companyId?: string;
}

interface AgentJsonPayloadOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson: string;
}

interface AgentRuntimeMutationOptions extends AgentJsonPayloadOptions {
  idempotencyKey?: string;
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent operations");

  addCommonClientOptions(
    agent
      .command("list")
      .description("List agents for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: AgentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows =
            (await ctx.api.get<Agent[]>(
              apiPath`/api/companies/${ctx.companyId}/agents`,
            )) ?? [];
          const company = await ctx.api.get<Company>(
            apiPath`/api/companies/${ctx.companyId}`,
          );
          if (!company) {
            throw new Error("Company not found");
          }

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                name: row.name,
                title: row.title,
                status: row.status,
                reportsTo: row.reportsTo,
                budgetCurrency: company.budgetCurrency,
                budgetMonthlyAmount: row.budgetMonthlyAmount,
                knownSpendAmount: row.knownSpendAmount,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("get")
      .description("Get one agent")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Agent>(
            apiPath`/api/agents/${agentId}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("runtime:create")
      .description(
        "Create an ordinary runtime-agent identity with complete explicit grants and runtime configuration",
      )
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption(
        "--payload-json <json>",
        "Complete RuntimeAgentCreateConfiguration JSON payload",
      )
      .option(
        "--idempotency-key <key>",
        "Retry key (generated when omitted)",
      )
      .action(async (opts: AgentRuntimeMutationOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = runtimeAgentCreateConfigurationSchema.parse(
            parseJson(opts.payloadJson),
          );
          const created = await ctx.api.post(
            apiPath`/api/companies/${ctx.companyId}/runtime-agents`,
            payload,
            {
              headers: {
                "Idempotency-Key": opts.idempotencyKey ?? randomUUID(),
              },
            },
          );
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("runtime:get")
      .description(
        "Get an agent's runtime identity and grants",
      )
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(
            apiPath`/api/agents/${agentId}/runtime-configuration`,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("runtime:update")
      .description(
        "Update only an agent's runtime identity or grants",
      )
      .argument("<agentId>", "Agent ID")
      .requiredOption(
        "--payload-json <json>",
        "Nonempty RuntimeAgentUpdateConfiguration JSON payload",
      )
      .option(
        "--idempotency-key <key>",
        "Retry key (generated when omitted)",
      )
      .action(
        async (agentId: string, opts: AgentRuntimeMutationOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const payload = runtimeAgentUpdateConfigurationSchema.parse(
              parseJson(opts.payloadJson),
            );
            const updated = await ctx.api.patch(
              apiPath`/api/agents/${agentId}/runtime-configuration`,
              payload,
              {
                headers: {
                  "Idempotency-Key":
                    opts.idempotencyKey ?? randomUUID(),
                },
              },
            );
            printOutput(updated, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        },
      ),
  );

  addCommonClientOptions(
    agent
      .command("adapter-revision:create")
      .description(
        "Append an immutable adapter/provider configuration revision",
      )
      .argument("<agentId>", "Agent ID")
      .requiredOption(
        "--payload-json <json>",
        "Adapter revision JSON with explicit adapterType, adapterConfig, runtimeConfig, companySkillPins, and skillChannel",
      )
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = parseAdapterRevisionPayload(opts.payloadJson);
          const result = await ctx.api.post(
            apiPath`/api/agents/${agentId}/adapter-config-revisions`,
            payload,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("adapter-revisions")
      .description(
        "List immutable adapter/provider configuration revisions",
      )
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(
            apiPath`/api/agents/${agentId}/adapter-config-revisions`,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("adapter-revision:current")
      .description(
        "Get the current immutable adapter/provider configuration revision",
      )
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(
            apiPath`/api/agents/${agentId}/adapter-config-revisions/current`,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("operational:update")
      .description(
        "Update only board-owned icon or monthly budget",
      )
      .argument("<agentId>", "Agent ID")
      .requiredOption(
        "--payload-json <json>",
        "Nonempty AgentOperationalConfigurationUpdate JSON payload",
      )
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload =
            agentOperationalConfigurationUpdateSchema.parse(
              parseJson(opts.payloadJson),
            );
          const result = await ctx.api.patch<Agent>(
            apiPath`/api/agents/${agentId}/operational-configuration`,
            payload,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, path, description] of [
    ["pause", "pause", "Pause an agent"],
    ["resume", "resume", "Resume an agent"],
    [
      "clear-error",
      "clear-error",
      "Clear an agent's recorded runtime error",
    ],
    [
      "terminate",
      "terminate",
      "Terminate an agent to an authority-inert tombstone",
    ],
  ] as const) {
    addCommonClientOptions(
      agent
        .command(name)
        .description(description)
        .argument("<agentId>", "Agent ID")
        .action(async (agentId: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const result = await ctx.api.post(
              `${apiPath`/api/agents/${agentId}`}/${path}`,
              {},
            );
            printOutput(result, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseAdapterRevisionPayload(value: string) {
  return agentAdapterRevisionConfigurationSchema.parse(parseJson(value));
}
