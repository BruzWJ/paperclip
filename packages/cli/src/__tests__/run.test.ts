import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";
import { registerRunCommands } from "../commands/client/run.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  const run = program.command("run").action(() => {});
  registerRunCommands(run);
  registerIssueCommands(program);
  return program;
}

describe("run inspection commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    delete process.env.PAPERCLIP_BOARD_API_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists and reads issue-execution runs through run subcommands", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [
          {
            id: RUN_ID,
            companyId: COMPANY_ID,
            issueId: ISSUE_ID,
            targetAgentId: AGENT_ID,
            kind: "productive",
            status: "running",
          },
        ],
        nextCursor: null,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        run: {
          id: RUN_ID,
          companyId: COMPANY_ID,
          issueId: ISSUE_ID,
          targetAgentId: AGENT_ID,
          kind: "productive",
          status: "running",
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: RUN_ID, status: "cancelled" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "run", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--agent-id", AGENT_ID,
      "--limit", "25",
    ], { from: "user" });

    await createProgram().parseAsync([
      "run", "get", RUN_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });

    await createProgram().parseAsync([
      "run", "cancel", RUN_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3100/api/companies/${COMPANY_ID}/runs?agentId=${AGENT_ID}&limit=25`,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://localhost:3100/api/runs/${RUN_ID}?limit=200`,
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `http://localhost:3100/api/runs/${RUN_ID}/cancel`,
    );
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("POST");
  });

  it("supports typed workspace logs and canonical watchdog decisions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "workspace" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "decision-1", decision: "continue" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "run", "workspace-log", "55555555-5555-4555-8555-555555555555",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });
    await createProgram().parseAsync([
      "run", "watchdog-decision", RUN_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--decision", "continue",
      "--reason", "operator reviewed",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3100/api/workspace-operations/55555555-5555-4555-8555-555555555555/log?offset=0",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/runs/${RUN_ID}/watchdog-decisions`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      decision: "continue",
      reason: "operator reviewed",
    });
  });

  it("exposes issue run helpers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ id: RUN_ID, status: "succeeded" }],
        nextCursor: null,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "issue", "runs", "PC-1",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3100/api/issues/PC-1/runs");
  });
});
