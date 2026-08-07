import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCostCommands } from "../commands/client/cost.js";
import { registerOrganizationCommands } from "../commands/client/organization.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const INCIDENT_ID = "99999999-9999-4999-8999-999999999999";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCostCommands(program);
  registerOrganizationCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

describe("operations parity commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    delete process.env.PAPERCLIP_BOARD_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps cost, finance, and budget endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["cost", "summary", "--company-id", COMPANY_ID]);
    await run(["cost", "by-agent", "--company-id", COMPANY_ID]);
    await run(["cost", "by-project", "--company-id", COMPANY_ID]);
    await run(["cost", "issue", ISSUE_ID]);
    await run(["cost", "events", "--company-id", COMPANY_ID]);
    await run([
      "finance",
      "event:create",
      "--company-id",
      COMPANY_ID,
      "--payload-json",
      JSON.stringify({
        eventKind: "manual_adjustment",
        biller: "paperclip",
        amount: "5",
        currency: "USD",
        occurredAt: "2026-07-31T00:00:00.000Z",
      }),
    ]);
    await run(["finance", "summary", "--company-id", COMPANY_ID]);
    await run(["budget", "overview", "--company-id", COMPANY_ID]);
    await run([
      "budget",
      "policy:upsert",
      "--company-id",
      COMPANY_ID,
      "--payload-json",
      JSON.stringify({ scopeType: "company", scopeId: COMPANY_ID, limitAmount: "250" }),
    ]);
    await run([
      "budget",
      "company:update",
      "--company-id",
      COMPANY_ID,
      "--payload-json",
      JSON.stringify({ budgetMonthlyAmount: "250" }),
    ]);
    await run([
      "budget",
      "agent:update",
      AGENT_ID,
      "--payload-json",
      JSON.stringify({ budgetMonthlyAmount: "250" }),
    ]);
    await run([
      "budget",
      "incident:resolve",
      INCIDENT_ID,
      "--company-id",
      COMPANY_ID,
      "--payload-json",
      JSON.stringify({ action: "keep_paused" }),
    ]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/summary`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/by-agent`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/by-project`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/cost-summary`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/cost-events`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/finance-events`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/finance-summary`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/budgets/overview`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/budgets/policies`],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}/budgets`],
      [
        "PATCH",
        `http://localhost:3100/api/agents/${AGENT_ID}/operational-configuration`,
      ],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/budget-incidents/${INCIDENT_ID}/resolve`],
    ]);
    expect(
      JSON.parse(String(fetchMock.mock.calls[10]?.[1]?.body)),
    ).toEqual({ budgetMonthlyAmount: "250" });
  });

  it("wraps org and agent configuration endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["org", "get", "--company-id", COMPANY_ID]);
    await run(["org", "svg", "--company-id", COMPANY_ID]);
    await run(["agent-config", "list", "--company-id", COMPANY_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/org`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/org.svg`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-configurations`],
    ]);
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
