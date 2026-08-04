import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockListServerAdapters = vi.hoisted(() => vi.fn());
const mockRefreshAcpxAdapters = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../adapters/index.js", () => ({
  listServerAdapters: mockListServerAdapters,
  refreshAcpxAdapters: mockRefreshAcpxAdapters,
}));

function registerModuleMocks() {
  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    listServerAdapters: mockListServerAdapters,
    refreshAcpxAdapters: mockRefreshAcpxAdapters,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ llmRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/llms.js")>("../routes/llms.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", llmRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("llm routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/llms.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockListServerAdapters.mockReturnValue([
      {
        type: "fixture-acpx-agent",
        definition: {
          configurationDoc: "# Fixture ACPX agent configuration",
        },
      },
    ]);
  });

  it("documents persisted issue references and routines as the execution model", async () => {
    const app = await createApp(testBoardSessionActor({
      userId: "board-user",
      companyIds: ["company-1"],
      isInstanceAdmin: true,
    }));

    const res = await request(app).get("/api/llms/agent-configuration.txt");

    expect(res.status).toBe(200);
    expect(res.text).toContain(
      "Agents run only from persisted issue-execution references.",
    );
    expect(res.text).toContain(
      "Recurring work must be modeled as a routine that creates ordinary issues.",
    );
    expect(res.text).not.toContain("desiredSkills");
    expect(res.text).not.toContain("sourceIssueId");
    expect(res.text).not.toContain("heartbeat");
    expect(mockRefreshAcpxAdapters).toHaveBeenCalledOnce();
  }, 20_000);

  it("serves documentation from the declarative adapter definition", async () => {
    const app = await createApp(testBoardSessionActor({
      userId: "board-user",
      companyIds: ["company-1"],
      isInstanceAdmin: true,
    }));

    const res = await request(app).get(
      "/api/llms/agent-configuration/fixture-acpx-agent.txt",
    );

    expect(res.status).toBe(200);
    expect(res.text).toBe("# Fixture ACPX agent configuration");
    expect(mockRefreshAcpxAdapters).toHaveBeenCalledOnce();
  }, 20_000);

});
