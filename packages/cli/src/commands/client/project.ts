import { Command } from "commander";
import type { Project } from "@paperclipai/shared";
import {
  createProjectSchema,
  updateProjectSchema,
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
import { parseExactCanonicalUuidList } from "./exact-uuid-list.js";

interface ProjectListOptions extends BaseClientOptions {
  companyId?: string;
}

interface ProjectCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  description?: string;
  status?: string;
  goalIds?: string;
  leadAgentId?: string;
  targetDate?: string;
  color?: string;
}

interface ProjectUpdateOptions extends BaseClientOptions {
  name?: string;
  description?: string;
  status?: string;
  goalIds?: string;
  leadAgentId?: string;
  targetDate?: string;
  color?: string;
  archivedAt?: string;
}

interface ProjectDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Project operations");

  addCommonClientOptions(
    project
      .command("list")
      .description("List projects for a company")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: ProjectListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Project[]>(apiPath`/api/companies/${ctx.companyId}/projects`)) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              id: row.id,
              name: row.name,
              status: row.status,
              goalIds: row.goalIds?.join(",") ?? "",
              leadAgentId: row.leadAgentId,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("get")
      .description("Get one project by UUID")
      .argument("<projectId>", "Project UUID")
      .action(async (projectId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Project>(apiPath`/api/projects/${projectId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("create")
      .description("Create a project")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Project name")
      .option("--description <text>", "Project description")
      .option("--status <status>", "Project status")
      .option("--goal-ids <csv>", "Comma-separated goal IDs")
      .option("--lead-agent-id <id>", "Lead agent ID")
      .option("--target-date <date>", "Target date")
      .option("--color <value>", "Project color")
      .action(async (opts: ProjectCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createProjectSchema.parse({
            name: opts.name,
            description: opts.description,
            status: opts.status,
            goalIds: parseExactCanonicalUuidList(opts.goalIds, "--goal-ids"),
            leadAgentId: parseNullableString(opts.leadAgentId),
            targetDate: parseNullableString(opts.targetDate),
            color: parseNullableString(opts.color),
          });
          const created = await ctx.api.post<Project>(apiPath`/api/companies/${ctx.companyId}/projects`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("update")
      .description("Update a project")
      .argument("<projectId>", "Project UUID")
      .option("--name <name>", "Project name")
      .option("--description <text|null>", "Project description")
      .option("--status <status>", "Project status")
      .option("--goal-ids <csv>", "Comma-separated goal IDs")
      .option("--lead-agent-id <id|null>", "Lead agent ID")
      .option("--target-date <date|null>", "Target date")
      .option("--color <value|null>", "Project color")
      .option("--archived-at <iso8601|null>", "Archive timestamp or null")
      .action(async (projectId: string, opts: ProjectUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateProjectSchema.parse({
            name: opts.name,
            description: parseNullableString(opts.description),
            status: opts.status,
            goalIds: parseExactCanonicalUuidList(opts.goalIds, "--goal-ids"),
            leadAgentId: parseNullableString(opts.leadAgentId),
            targetDate: parseNullableString(opts.targetDate),
            color: parseNullableString(opts.color),
            archivedAt: parseNullableString(opts.archivedAt),
          });
          const updated = await ctx.api.patch<Project>(apiPath`/api/projects/${projectId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("delete")
      .description("Delete a project")
      .argument("<projectId>", "Project UUID")
      .option("--yes", "Confirm deletion")
      .action(async (projectId: string, opts: ProjectDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("Deletion requires --yes.");
          const ctx = resolveCommandContext(opts);
          const deleted = await ctx.api.delete<Project>(apiPath`/api/projects/${projectId}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseNullableString(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === "null" ? null : value;
}
