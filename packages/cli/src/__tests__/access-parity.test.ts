import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAccessCommands } from "../commands/client/access.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const INVITE_ID = "44444444-4444-4444-8444-444444444444";
const JOIN_ID = "55555555-5555-4555-8555-555555555555";
const MEMBER_ID = "66666666-6666-4666-8666-666666666666";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAccessCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

describe("access parity commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    delete process.env.PAPERCLIP_BOARD_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps auth, invites, joins, members, and admin endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["health"]);
    await run(["whoami"]);
    await run(["access", "whoami"]);
    await run(["profile", "session"]);
    await run(["invite", "list", "--company-id", COMPANY_ID]);
    await run(["invite", "create", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["invite", "revoke", INVITE_ID]);
    await run(["invite", "show", "token-1"]);
    await run(["invite", "accept", "token-1"]);
    await run(["join", "list", "--company-id", COMPANY_ID, "--status", "pending_approval"]);
    await run(["join", "approve", JOIN_ID, "--company-id", COMPANY_ID]);
    await run(["join", "reject", JOIN_ID, "--company-id", COMPANY_ID]);
    await run(["member", "list", "--company-id", COMPANY_ID]);
    await run(["member", "update", MEMBER_ID, "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["member", "archive", MEMBER_ID, "--company-id", COMPANY_ID]);
    await run(["admin", "user", "list"]);
    await run(["admin", "user", "promote", USER_ID]);
    await run(["admin", "user", "company-access:update", USER_ID, "--payload-json", "{}"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/health"],
      ["GET", "http://localhost:3100/api/cli-auth/me"],
      ["GET", "http://localhost:3100/api/cli-auth/me"],
      ["GET", "http://localhost:3100/api/auth/get-session"],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/invites`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/invites`],
      ["POST", `http://localhost:3100/api/invites/${INVITE_ID}/revoke`],
      ["GET", "http://localhost:3100/api/invites/token-1"],
      ["POST", "http://localhost:3100/api/invites/token-1/accept"],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/join-requests?status=pending_approval`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/join-requests/${JOIN_ID}/approve`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/join-requests/${JOIN_ID}/reject`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/members`],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}/members/${MEMBER_ID}`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/members/${MEMBER_ID}/archive`],
      ["GET", "http://localhost:3100/api/admin/users"],
      ["POST", `http://localhost:3100/api/admin/users/${USER_ID}/promote-instance-admin`],
      ["PUT", `http://localhost:3100/api/admin/users/${USER_ID}/company-access`],
    ]);
    expect(fetchMock.mock.calls[10]?.[1]?.body).toBe(JSON.stringify({}));
  });

  it("exposes only Better Auth session inspection and company authorization profiles", () => {
    const profile = createProgram().commands.find(
      (command) => command.name() === "profile",
    );

    expect(profile?.commands.map((command) => command.name())).toEqual([
      "session",
      "company-user",
    ]);
  });

  it("wraps instance, sidebar, llm, and openapi endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["openapi"]);
    await run(["instance", "settings:general"]);
    await run(["instance", "settings:general:update", "--payload-json", "{}"]);
    await run(["sidebar", "preferences"]);
    await run(["sidebar", "preferences:update", "--payload-json", "{}"]);
    await run(["sidebar", "project-preferences", "--company-id", COMPANY_ID]);
    await run(["sidebar", "project-preferences:update", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["sidebar", "badges", "--company-id", COMPANY_ID]);
    await run(["inbox", "dismissals", "--company-id", COMPANY_ID]);
    await run(["inbox", "dismiss", "--company-id", COMPANY_ID, "--payload-json", "{\"itemKey\":\"run:1\"}"]);
    await run(["llm", "agent-configuration"]);
    await run(["llm", "agent-configuration:adapter", "codex"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/openapi.json"],
      ["GET", "http://localhost:3100/api/instance/settings/general"],
      ["PATCH", "http://localhost:3100/api/instance/settings/general"],
      ["GET", "http://localhost:3100/api/sidebar-preferences/me"],
      ["PUT", "http://localhost:3100/api/sidebar-preferences/me"],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/sidebar-preferences/me`],
      ["PUT", `http://localhost:3100/api/companies/${COMPANY_ID}/sidebar-preferences/me`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/sidebar-badges`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/inbox-dismissals`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/inbox-dismissals`],
      ["GET", "http://localhost:3100/api/llms/agent-configuration.txt"],
      ["GET", "http://localhost:3100/api/llms/agent-configuration/codex.txt"],
    ]);
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
