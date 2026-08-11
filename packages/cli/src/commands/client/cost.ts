import { Command } from "commander";
import {
  agentOperationalConfigurationUpdateSchema,
  createFinanceEventSchema,
  resolveBudgetIncidentSchema,
  updateCompanyBudgetSchema,
  upsertBudgetPolicySchema,
  type MoneyAmount,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyOptions extends BaseClientOptions {
  companyId?: string;
}

interface JsonPayloadOptions extends CompanyOptions {
  payloadJson: string;
}

interface IncidentOptions extends CompanyOptions {
  payloadJson: string;
}

export function registerCostCommands(program: Command): void {
  const cost = program.command("cost").description("Cost and finance operations");

  for (const [name, path] of [
    ["summary", "costs/summary"],
    ["by-agent", "costs/by-agent"],
    ["by-project", "costs/by-project"],
    ["events", "cost-events"],
  ] as const) {
    addCompanyGet(cost, name, `Get ${name} cost data`, path);
  }

  addCommonClientOptions(
    cost
      .command("task")
      .description("Get cost summary for a task")
      .argument("<taskId>", "Task ID")
      .action(async (taskId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/tasks/${taskId}/cost-summary`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const finance = program.command("finance").description("Finance event and summary operations");
  addCompanyPostJson(
    finance,
    "event:create",
    "Record a finance event",
    "finance-events",
    (value) => createFinanceEventSchema.parse(value),
  );
  addCompanyGet(finance, "events", "List finance events", "costs/finance-events");
  addCompanyGet(finance, "summary", "Get finance summary", "costs/finance-summary");
  addCompanyGet(finance, "by-biller", "Get finance summary by biller", "costs/finance-by-biller");
  addCompanyGet(finance, "by-kind", "Get finance summary by kind", "costs/finance-by-kind");

  const budget = program.command("budget").description("Budget policy and incident operations");
  addCompanyGet(budget, "overview", "Get budget overview", "budgets/overview");
  addCompanyPostJson(
    budget,
    "policy:upsert",
    "Create or update a budget policy",
    "budgets/policies",
    (value) => upsertBudgetPolicySchema.parse(value),
  );

  addCommonClientOptions(
    budget
      .command("company:update")
      .description("Update company budget")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "UpdateBudget JSON payload")
      .action(async (opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = updateCompanyBudgetSchema.parse(
            parseJson(opts.payloadJson),
          );
          const result = await ctx.api.patch(
            apiPath`/api/companies/${ctx.companyId}/budgets`,
            payload,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    budget
      .command("agent:update")
      .description("Update an agent's monthly budget through its operational configuration")
      .argument("<agentId>", "Agent ID")
      .requiredOption(
        "--payload-json <json>",
        'Budget JSON payload: {"budgetMonthlyAmount":"<canonical nonnegative decimal>"}',
      )
      .action(async (agentId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = parseAgentBudgetPayload(opts.payloadJson);
          const result = await ctx.api.patch(
            apiPath`/api/agents/${agentId}/operational-configuration`,
            payload,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    budget
      .command("incident:resolve")
      .description("Resolve a budget incident")
      .argument("<incidentId>", "Budget incident ID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "ResolveBudgetIncident JSON payload")
      .action(async (incidentId: string, opts: IncidentOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = resolveBudgetIncidentSchema.parse(
            parseJson(opts.payloadJson),
          );
          const result = await ctx.api.post(
            apiPath`/api/companies/${ctx.companyId}/budget-incidents/${incidentId}/resolve`,
            payload,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addCompanyGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addCompanyPostJson(
  parent: Command,
  name: string,
  description: string,
  path: string,
  validatePayload: (value: unknown) => unknown,
): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(
            `${apiPath`/api/companies/${ctx.companyId}`}/${path}`,
            validatePayload(parseJson(opts.payloadJson)),
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseAgentBudgetPayload(
  value: string,
): { budgetMonthlyAmount: MoneyAmount } {
  const parsed = agentOperationalConfigurationUpdateSchema.parse(
    parseJson(value),
  );
  if (
    parsed.budgetMonthlyAmount === undefined ||
    Object.keys(parsed).some((key) => key !== "budgetMonthlyAmount")
  ) {
    throw new Error(
      "Agent budget payload must contain only budgetMonthlyAmount",
    );
  }
  return { budgetMonthlyAmount: parsed.budgetMonthlyAmount };
}
