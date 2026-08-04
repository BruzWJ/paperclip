import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentCommands } from "../commands/client/agent.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "33333333-3333-4333-8333-333333333333";
const IDEMPOTENCY_KEY = "runtime-agent-create-1";

const runtimeConfiguration = {
  name: "Builder",
  title: null,
  capabilities: null,
  reportsTo: null,
  contextGrants: {
    carry_context: false,
    read_issue_comments: false,
    read_issue_agent_run: false,
    list_sub_issues: false,
    read_sub_issue_comments: false,
    read_sub_issue_agent_run: false,
    list_company_issues: false,
    read_company_issue_comments: false,
    read_company_issue_agent_run: false,
  },
  actionGrants: {
    issue_create: false,
    issue_assign: false,
    issue_update: false,
    mention_agent: false,
    mention_board: false,
    agent_hire: false,
    agent_configure: false,
  },
  mentionReachGrants: {
    mention_any_descendant: false,
    mention_any_ancestor: false,
  },
  companyToolIds: [],
};

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerAgentCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(
    [
      ...args,
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "board-token",
    ],
    { from: "user" },
  );
}

describe("agent control-plane commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    delete process.env.PAPERCLIP_BOARD_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the runtime-agent owner for identity, grants, and tool selections", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "agent",
      "runtime:create",
      "--company-id",
      COMPANY_ID,
      "--payload-json",
      JSON.stringify(runtimeConfiguration),
      "--idempotency-key",
      IDEMPOTENCY_KEY,
    ]);
    await run(["agent", "runtime:get", AGENT_ID]);
    await run([
      "agent",
      "runtime:update",
      AGENT_ID,
      "--payload-json",
      JSON.stringify({ title: "Senior Builder" }),
      "--idempotency-key",
      "runtime-agent-update-1",
    ]);

    expect(
      fetchMock.mock.calls.map((call) => [
        call[1]?.method ?? "GET",
        call[0],
      ]),
    ).toEqual([
      [
        "POST",
        `http://localhost:3100/api/companies/${COMPANY_ID}/runtime-agents`,
      ],
      [
        "GET",
        `http://localhost:3100/api/agents/${AGENT_ID}/runtime-configuration`,
      ],
      [
        "PATCH",
        `http://localhost:3100/api/agents/${AGENT_ID}/runtime-configuration`,
      ],
    ]);

    expect(
      fetchMock.mock.calls[0]?.[1]?.headers,
    ).toMatchObject({
      "Idempotency-Key": IDEMPOTENCY_KEY,
    });
    expect(
      fetchMock.mock.calls[2]?.[1]?.headers,
    ).toMatchObject({
      "Idempotency-Key": "runtime-agent-update-1",
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toEqual(runtimeConfiguration);
    expect(
      JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)),
    ).toEqual({ title: "Senior Builder" });
  });

  it("keeps adapter revisions and operational updates on separate owners", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const adapterRevision = {
      adapterType: "codex",
      adapterConfig: { model: "gpt-5.6" },
      defaultEnvironmentId: ENVIRONMENT_ID,
      runtimeConfig: {},
      companySkillPins: [],
      skillChannel: "operator_native",
    };
    await run([
      "agent",
      "adapter-revision:create",
      AGENT_ID,
      "--payload-json",
      JSON.stringify(adapterRevision),
    ]);
    await run(["agent", "adapter-revisions", AGENT_ID]);
    await run(["agent", "adapter-revision:current", AGENT_ID]);
    await run([
      "agent",
      "operational:update",
      AGENT_ID,
      "--payload-json",
      JSON.stringify({
        budgetMonthlyAmount: "250",
      }),
    ]);

    expect(
      fetchMock.mock.calls.map((call) => [
        call[1]?.method ?? "GET",
        call[0],
      ]),
    ).toEqual([
      [
        "POST",
        `http://localhost:3100/api/agents/${AGENT_ID}/adapter-config-revisions`,
      ],
      [
        "GET",
        `http://localhost:3100/api/agents/${AGENT_ID}/adapter-config-revisions`,
      ],
      [
        "GET",
        `http://localhost:3100/api/agents/${AGENT_ID}/adapter-config-revisions/current`,
      ],
      [
        "PATCH",
        `http://localhost:3100/api/agents/${AGENT_ID}/operational-configuration`,
      ],
    ]);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toEqual(adapterRevision);
    expect(
      JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)),
    ).toEqual({
      budgetMonthlyAmount: "250",
    });
  });

  it("keeps lifecycle transitions on their dedicated commands", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["agent", "pause", AGENT_ID]);
    await run(["agent", "resume", AGENT_ID]);
    await run(["agent", "clear-error", AGENT_ID]);
    await run(["agent", "terminate", AGENT_ID]);

    expect(
      fetchMock.mock.calls.map((call) => [
        call[1]?.method ?? "GET",
        call[0],
      ]),
    ).toEqual([
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/pause`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/resume`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/clear-error`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/terminate`],
    ]);
  });

  it("does not register legacy mixed-writer or rollback commands", () => {
    const program = createProgram();
    const agent = program.commands.find(
      (command) => command.name() === "agent",
    );
    const names = agent?.commands.map((command) => command.name()) ?? [];

    expect(names).not.toEqual(
      expect.arrayContaining([
        "create",
        "hire",
        "update",
        "delete",
        "approve",
        "configuration",
        "config-revisions",
        "config-revision:get",
        "config-revision:rollback",
      ]),
    );
  });
});

function jsonResponse(
  body: unknown = { ok: true },
  init: ResponseInit = { status: 200 },
): Response {
  return new Response(JSON.stringify(body), init);
}
