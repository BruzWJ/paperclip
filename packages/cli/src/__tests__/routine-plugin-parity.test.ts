import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPluginCommands } from "../commands/client/plugin.js";
import { registerRoutineApiCommands } from "../commands/client/routine-api.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const TRIGGER_ID = "55555555-5555-4555-8555-555555555555";
const PLUGIN_ID = "66666666-6666-4666-8666-666666666666";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRoutineApiCommands(program);
  registerPluginCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

describe("routine and plugin parity commands", () => {
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

  it("wraps routine API endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["routine", "list", "--company-id", COMPANY_ID, "--project-id", "p1"]);
    await run(["routine", "create", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["routine", "get", ROUTINE_ID]);
    await run(["routine", "update", ROUTINE_ID, "--payload-json", "{}"]);
    await run(["routine", "revisions", ROUTINE_ID]);
    await run(["routine", "revision:restore", ROUTINE_ID, REVISION_ID]);
    await run(["routine", "runs", ROUTINE_ID, "--limit", "5"]);
    await run(["routine", "run", ROUTINE_ID]);
    await run(["routine", "trigger:create", ROUTINE_ID, "--payload-json", "{}"]);
    await run(["routine", "trigger:update", TRIGGER_ID, "--payload-json", "{}"]);
    await run(["routine", "trigger:delete", TRIGGER_ID]);
    await run(["routine", "trigger:rotate-secret", TRIGGER_ID]);
    await run(["routine", "trigger:fire", "public-id"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/routines?projectId=p1`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/routines`],
      ["GET", `http://localhost:3100/api/routines/${ROUTINE_ID}`],
      ["PATCH", `http://localhost:3100/api/routines/${ROUTINE_ID}`],
      ["GET", `http://localhost:3100/api/routines/${ROUTINE_ID}/revisions`],
      ["POST", `http://localhost:3100/api/routines/${ROUTINE_ID}/revisions/${REVISION_ID}/restore`],
      ["GET", `http://localhost:3100/api/routines/${ROUTINE_ID}/runs?limit=5`],
      ["POST", `http://localhost:3100/api/routines/${ROUTINE_ID}/run`],
      ["POST", `http://localhost:3100/api/routines/${ROUTINE_ID}/triggers`],
      ["PATCH", `http://localhost:3100/api/routine-triggers/${TRIGGER_ID}`],
      ["DELETE", `http://localhost:3100/api/routine-triggers/${TRIGGER_ID}`],
      ["POST", `http://localhost:3100/api/routine-triggers/${TRIGGER_ID}/rotate-secret`],
      ["POST", "http://localhost:3100/api/routine-triggers/public/public-id/fire"],
    ]);
  });

  it("wraps deeper plugin endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["plugin", "ui-contributions"]);
    await run(["plugin", "logs", PLUGIN_ID]);
    await run(["plugin", "upgrade", PLUGIN_ID]);
    await run(["plugin", "config", PLUGIN_ID]);
    await run(["plugin", "config:set", PLUGIN_ID, "--payload-json", "{}"]);
    await run(["plugin", "config:test", PLUGIN_ID, "--payload-json", "{}"]);
    await run(["plugin", "jobs", PLUGIN_ID]);
    await run(["plugin", "job:runs", PLUGIN_ID, "job1"]);
    await run(["plugin", "job:trigger", PLUGIN_ID, "job1"]);
    await run(["plugin", "webhook", PLUGIN_ID, "endpoint", "--payload-json", "{}"]);
    await run(["plugin", "dashboard", PLUGIN_ID]);
    await run(["plugin", "local-folders", PLUGIN_ID, "--company-id", COMPANY_ID]);
    await run(["plugin", "local-folder:status", PLUGIN_ID, "source", "--company-id", COMPANY_ID]);
    await run(["plugin", "local-folder:validate", PLUGIN_ID, "source", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["plugin", "local-folder:set", PLUGIN_ID, "source", "--company-id", COMPANY_ID, "--payload-json", "{}"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/plugins/ui-contributions"],
      ["GET", `http://localhost:3100/api/plugins/${PLUGIN_ID}/logs`],
      ["POST", `http://localhost:3100/api/plugins/${PLUGIN_ID}/upgrade`],
      ["GET", `http://localhost:3100/api/plugins/${PLUGIN_ID}/config`],
      ["POST", `http://localhost:3100/api/plugins/${PLUGIN_ID}/config`],
      ["POST", `http://localhost:3100/api/plugins/${PLUGIN_ID}/config/test`],
      ["GET", `http://localhost:3100/api/plugins/${PLUGIN_ID}/jobs`],
      ["GET", `http://localhost:3100/api/plugins/${PLUGIN_ID}/jobs/job1/runs`],
      ["POST", `http://localhost:3100/api/plugins/${PLUGIN_ID}/jobs/job1/trigger`],
      ["POST", `http://localhost:3100/api/plugins/${PLUGIN_ID}/webhooks/endpoint`],
      ["GET", `http://localhost:3100/api/plugins/${PLUGIN_ID}/dashboard`],
      ["GET", `http://localhost:3100/api/plugins/${PLUGIN_ID}/companies/${COMPANY_ID}/local-folders`],
      ["GET", `http://localhost:3100/api/plugins/${PLUGIN_ID}/companies/${COMPANY_ID}/local-folders/source/status`],
      ["POST", `http://localhost:3100/api/plugins/${PLUGIN_ID}/companies/${COMPANY_ID}/local-folders/source/validate`],
      ["PUT", `http://localhost:3100/api/plugins/${PLUGIN_ID}/companies/${COMPANY_ID}/local-folders/source`],
    ]);
  });

  it("keeps plugin config instance-wide when a company context is present", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    process.env.PAPERCLIP_BOARD_COMPANY_ID = COMPANY_ID;

    await run(["plugin", "config", PLUGIN_ID]);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3100/api/plugins/${PLUGIN_ID}/config`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends exact npm and local plugin install union members", async () => {
    const installedPlugin = {
      id: PLUGIN_ID,
      pluginKey: "acme.example",
      packageName: "@acme/plugin-example",
      source: "npm",
      manifestJson: {
        apiVersion: 1,
        id: "acme.example",
        version: "1.2.3",
        displayName: "Example",
        description: "Example plugin",
        author: "Acme",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
      packagePath: "/plugins/acme-example",
      lastError: null,
      installedAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse(installedPlugin)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "plugin",
      "install",
      "@acme/plugin-example",
      "--version",
      "1.2.3",
      "--no-verify-target",
    ]);
    await run([
      "plugin",
      "install",
      "/tmp/acme-plugin-example",
      "--local",
      "--no-verify-target",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      source: "npm",
      packageName: "@acme/plugin-example",
      version: "1.2.3",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      source: "local",
      path: "/tmp/acme-plugin-example",
    });
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
