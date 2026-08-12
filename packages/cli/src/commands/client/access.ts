import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  assertExactAuthUserId,
  handleCommandError,
  printOutput,
  requireCurrentUserId,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyOptions extends BaseClientOptions {
  companyId?: string;
}

interface JsonPayloadOptions extends CompanyOptions {
  payloadJson?: string;
}

interface QueryOptions extends CompanyOptions {
  query?: string;
  status?: string;
  url?: string;
}

export function registerAccessCommands(program: Command): void {
  addWhoamiCommand(program);
  addCommonClientOptions(
    program
      .command("health")
      .description("Check API health")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/health"), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const access = program
    .command("access")
    .description("Access and auth inspection operations");
  addWhoamiCommand(access);

  addCommonClientOptions(
    program
      .command("openapi")
      .description("Print the OpenAPI document")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/openapi.json"), { json: true });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const profile = program
    .command("profile")
    .description("User profile operations");
  addSimpleGet(profile, "session", "Get auth session", "/api/auth/get-session");
  addCommonClientOptions(
    profile
      .command("company-user")
      .description("Get a company user profile by exact auth user ID")
      .argument("<userId>", "Exact auth user ID")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (userId: string, opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.get(
              apiPath`/api/companies/${ctx.companyId}/users/${assertExactAuthUserId(userId)}/profile`,
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const invite = program.command("invite").description("Invite operations");
  addCompanyList(invite, "list", "List company invites", "invites");
  addCompanyPost(invite, "create", "Create an invite", "invites");
  addCommonClientOptions(
    invite
      .command("revoke")
      .description("Revoke an invite")
      .argument("<inviteId>", "Invite ID")
      .action(async (inviteId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.post(apiPath`/api/invites/${inviteId}/revoke`, {}),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  for (const [name, suffix] of [
    ["show", ""],
    ["logo", "logo"],
  ] as const) {
    addCommonClientOptions(
      invite
        .command(name)
        .description(`Get invite ${name}`)
        .argument("<token>", "Invite token")
        .action(async (token: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const path = `${apiPath`/api/invites/${token}`}${suffix ? `/${suffix}` : ""}`;
            printOutput(await ctx.api.get(path), { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }
  addCommonClientOptions(
    invite
      .command("accept")
      .description("Accept an invite")
      .argument("<token>", "Invite token")
      .action(async (token: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.post(apiPath`/api/invites/${token}/accept`, {}),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const join = program.command("join").description("Join request operations");
  addCommonClientOptions(
    join
      .command("list")
      .description("List join requests")
      .option("-C, --company-id <id>", "Company ID")
      .option(
        "--status <status>",
        "Filter by status (pending_approval, approved, rejected)",
      )
      .action(async (opts: QueryOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          const query = params.toString();
          printOutput(
            await ctx.api.get(
              `${apiPath`/api/companies/${ctx.companyId}/join-requests`}${query ? `?${query}` : ""}`,
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
  addJoinAction(join, "approve");
  addJoinAction(join, "reject");

  const member = program
    .command("member")
    .description("Company member operations");
  addCompanyList(member, "list", "List company members", "members");
  addCompanyList(
    member,
    "user-directory",
    "List company user directory",
    "user-directory",
  );
  addMemberPatch(member, "update", "members");
  addMemberPatch(member, "role-and-grants", "members", "role-and-grants");
  addMemberPatch(member, "permissions", "members", "permissions");
  addMemberPost(member, "archive", "members", "archive");

  const admin = program
    .command("admin")
    .description("Instance admin operations");
  const user = admin.command("user").description("Admin user operations");
  addCommonClientOptions(
    user
      .command("list")
      .description("List users")
      .option("--query <text>", "Search query")
      .action(async (opts: QueryOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.query
            ? `?${new URLSearchParams({ query: opts.query }).toString()}`
            : "";
          printOutput(await ctx.api.get(`/api/admin/users${query}`), {
            json: ctx.json,
          });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addAdminUserPost(user, "promote", "promote-instance-admin");
  addAdminUserPost(user, "demote", "demote-instance-admin");
  addCommonClientOptions(
    user
      .command("company-access")
      .description("Get user company access")
      .argument("<userId>", "User ID")
      .action(async (userId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.get(
              apiPath`/api/admin/users/${assertExactAuthUserId(userId)}/company-access`,
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addCommonClientOptions(
    user
      .command("company-access:update")
      .description("Update user company access")
      .argument("<userId>", "User ID")
      .requiredOption(
        "--payload-json <json>",
        "UpdateUserCompanyAccess JSON payload",
      )
      .action(async (userId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.put(
              apiPath`/api/admin/users/${assertExactAuthUserId(userId)}/company-access`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const instance = program
    .command("instance")
    .description("Instance operations");
  addSimpleGet(
    instance,
    "settings:general",
    "Get general instance settings",
    "/api/instance/settings/general",
  );
  addJsonPatch(
    instance,
    "settings:general:update",
    "Update general instance settings",
    "/api/instance/settings/general",
  );

  const sidebar = program
    .command("sidebar")
    .description("Sidebar preference and badge operations");
  addCurrentUserGet(sidebar, "preferences", "Get current sidebar preferences");
  addCurrentUserPut(
    sidebar,
    "preferences:update",
    "Update current sidebar preferences",
  );
  addCompanyList(
    sidebar,
    "project-preferences",
    "Get current project sidebar preferences",
    (userId) => `users/${encodeURIComponent(userId)}/sidebar-preferences`,
  );
  addCompanyPut(
    sidebar,
    "project-preferences:update",
    "Update current project sidebar preferences",
    (userId) => `users/${encodeURIComponent(userId)}/sidebar-preferences`,
  );
  addCompanyList(sidebar, "badges", "Get sidebar badges", "sidebar-badges");

  const inbox = program.command("inbox").description("Board inbox operations");
  addCompanyList(
    inbox,
    "dismissals",
    "List dismissed inbox items",
    "inbox-dismissals",
  );
  addCompanyPost(inbox, "dismiss", "Dismiss an inbox item", "inbox-dismissals");
}

function addWhoamiCommand(parent: Command): void {
  addCommonClientOptions(
    parent
      .command("whoami")
      .description("Show current CLI auth identity")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const userId = requireCurrentUserId(ctx);
          printOutput(
            await ctx.api.get(apiPath`/api/cli-auth/users/${userId}`),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addCurrentUserGet(
  parent: Command,
  name: string,
  description: string,
): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const userId = requireCurrentUserId(ctx);
          printOutput(
            await ctx.api.get(
              apiPath`/api/users/${userId}/sidebar-preferences`,
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addCurrentUserPut(
  parent: Command,
  name: string,
  description: string,
): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const userId = requireCurrentUserId(ctx);
          printOutput(
            await ctx.api.put(
              apiPath`/api/users/${userId}/sidebar-preferences`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addSimpleGet(
  parent: Command,
  name: string,
  description: string,
  path: string,
): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(path), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addJsonPatch(
  parent: Command,
  name: string,
  description: string,
  path: string,
): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.patch(path, parseJson(opts.payloadJson ?? "{}")),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addCompanyList(
  parent: Command,
  name: string,
  description: string,
  path: string | ((userId: string) => string),
): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const resolvedPath =
            typeof path === "string" ? path : path(requireCurrentUserId(ctx));
          printOutput(
            await ctx.api.get(
              `${apiPath`/api/companies/${ctx.companyId}`}/${resolvedPath}`,
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addCompanyPut(
  parent: Command,
  name: string,
  description: string,
  path: string | ((userId: string) => string),
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
          const resolvedPath =
            typeof path === "string" ? path : path(requireCurrentUserId(ctx));
          printOutput(
            await ctx.api.put(
              `${apiPath`/api/companies/${ctx.companyId}`}/${resolvedPath}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addCompanyPost(
  parent: Command,
  name: string,
  description: string,
  path: string,
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
          printOutput(
            await ctx.api.post(
              `${apiPath`/api/companies/${ctx.companyId}`}/${path}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addJoinAction(parent: Command, action: "approve" | "reject"): void {
  const command = parent
    .command(action)
    .description(`${action} a join request`)
    .argument("<requestId>", "Join request ID")
    .option("-C, --company-id <id>", "Company ID");
  addCommonClientOptions(
    command.action(async (requestId: string, opts: CompanyOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        printOutput(
          await ctx.api.post(
            `${apiPath`/api/companies/${ctx.companyId}/join-requests/${requestId}`}/${action}`,
            {},
          ),
          { json: ctx.json },
        );
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addMemberPatch(
  parent: Command,
  name: string,
  path: string,
  suffix?: string,
): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(`${name} a member`)
      .argument("<memberId>", "Member ID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (memberId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const route = `${apiPath`/api/companies/${ctx.companyId}`}/${path}/${encodeURIComponent(memberId)}${suffix ? `/${suffix}` : ""}`;
          printOutput(
            await ctx.api.patch(route, parseJson(opts.payloadJson ?? "{}")),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addMemberPost(
  parent: Command,
  name: string,
  path: string,
  suffix: string,
): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(`${name} a member`)
      .argument("<memberId>", "Member ID")
      .option("-C, --company-id <id>", "Company ID")
      .option("--payload-json <json>", "JSON payload", "{}")
      .action(async (memberId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.post(
              `${apiPath`/api/companies/${ctx.companyId}`}/${path}/${encodeURIComponent(memberId)}/${suffix}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addAdminUserPost(parent: Command, name: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(`${name} instance admin`)
      .argument("<userId>", "User ID")
      .action(async (userId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.post(
              `${apiPath`/api/admin/users/${assertExactAuthUserId(userId)}`}/${suffix}`,
              {},
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
