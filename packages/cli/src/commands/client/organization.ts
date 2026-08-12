import { Command } from "commander";
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

interface OrgOutputOptions extends CompanyOptions {
  out?: string;
}

export function registerOrganizationCommands(program: Command): void {
  const org = program.command("org").description("Organization chart operations");
  addCompanyGet(org, "get", "Get org chart data", "org");
  addBinaryCompanyGet(org, "svg", "Download org chart SVG", "org.svg");
  addBinaryCompanyGet(org, "png", "Download org chart PNG", "org.png");
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

function addBinaryCompanyGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .option("-C, --company-id <id>", "Company ID")
      .option("--out <path>", "Write output to file")
      .action(async (opts: OrgOutputOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const response = await fetch(buildApiUrl(ctx.api.apiBase, `${apiPath`/api/companies/${ctx.companyId}`}/${path}`), {
            headers: ctx.api.apiKey ? { authorization: `Bearer ${ctx.api.apiKey}` } : undefined,
          });
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!response.ok) throw new Error(`API error ${response.status}: ${bytes.toString("utf8")}`);
          if (opts.out) {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(opts.out, bytes);
            printOutput({ out: opts.out, bytes: bytes.byteLength }, { json: ctx.json });
            return;
          }
          process.stdout.write(bytes);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}
