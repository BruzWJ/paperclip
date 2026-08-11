import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AdapterOptions extends BaseClientOptions {
  companyId?: string;
}

export function registerAdapterCommands(program: Command): void {
  const adapter = program
    .command("adapter")
    .description("ACPX-discovered agent operations");

  addCommonClientOptions(
    adapter
      .command("list")
      .description("List ACPX-discovered agents")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/adapters"), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    adapter
      .command("get")
      .description("Get one adapter")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/adapters/${type}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    adapter
      .command("config-schema")
      .description("Get adapter config schema")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/adapters/${type}/config-schema`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    adapter
      .command("models")
      .description("List adapter models for a company")
      .argument("<type>", "Adapter type")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.get(
              apiPath`/api/companies/${ctx.companyId}/adapters/${type}/models`,
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCompanyAdapterGet(adapter, "model-profiles", "List adapter model profiles", "model-profiles");
}

function addCompanyAdapterGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<type>", "Adapter type")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/adapters/${type}`}/${suffix}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
