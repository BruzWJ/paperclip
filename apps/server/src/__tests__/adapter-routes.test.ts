import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { createDeclarativeTestAdapter } from "./helpers/declarative-adapter.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const catalog = vi.hoisted(() => ({
  adapters: [] as ServerAdapterModule[],
  probeDiagnostics: [] as Array<{
    type: string;
    code: "acpx_probe_failed" | "acpx_catalog_invalid";
    message: string;
  }>,
  refreshAcpxAdapters: vi.fn(async () => undefined),
}));

function registerModuleMocks() {
  vi.doMock("../adapters/index.js", () => ({
    findActiveServerAdapter: (type: string) =>
      catalog.adapters.find((adapter) => adapter.type === type) ?? null,
    findServerAdapter: (type: string) =>
      catalog.adapters.find((adapter) => adapter.type === type) ?? null,
    listServerAdapters: () => [...catalog.adapters],
    listAcpxAdapterProbeDiagnostics: () => [...catalog.probeDiagnostics],
    refreshAcpxAdapters: catalog.refreshAcpxAdapters,
  }));
}

function createApp(isInstanceAdmin = false) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = testBoardSessionActor({
      userId: "board-user",
      companyIds: ["company-1"],
      memberships: [{
        companyId: "company-1",
        membershipRole: "operator",
        status: "active",
      }],
      isInstanceAdmin,
    });
    next();
  });
  return app;
}

describe("ACPX adapter routes", () => {
  let adapterRoutes: typeof import("../routes/adapters.js").adapterRoutes;
  let errorHandler: typeof import("../middleware/index.js").errorHandler;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/adapters.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    catalog.adapters = [
      createDeclarativeTestAdapter({ type: "fixture-agent-alpha" }),
      createDeclarativeTestAdapter({ type: "fixture-agent-beta" }),
    ];
    catalog.probeDiagnostics = [];
    catalog.refreshAcpxAdapters.mockClear();
    registerModuleMocks();

    const [routes, middleware] = await Promise.all([
      import("../routes/adapters.js"),
      import("../middleware/index.js"),
    ]);
    adapterRoutes = routes.adapterRoutes;
    errorHandler = middleware.errorHandler;
  });

  function app(isInstanceAdmin = false) {
    const result = createApp(isInstanceAdmin);
    result.use("/api", adapterRoutes());
    result.use(errorHandler);
    return result;
  }

  it("lists only the current ACPX-supplied catalog", async () => {
    const res = await request(app()).get("/api/adapters");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((entry: { type: string }) => entry.type)).toEqual([
      "fixture-agent-alpha",
      "fixture-agent-beta",
    ]);
    expect(catalog.refreshAcpxAdapters).toHaveBeenCalledOnce();
    for (const adapter of res.body) {
      const definition = catalog.adapters.find(
        (candidate) => candidate.type === adapter.type,
      )!.definition;
      expect(adapter).toMatchObject({
        source: "acpx",
        registryName: adapter.type,
        loaded: true,
        drivers: definition.environment.drivers,
      });
      expect(adapter).not.toHaveProperty("disabled");
      expect(adapter).not.toHaveProperty("frontendPackage");
      expect(adapter).not.toHaveProperty("frontendVersion");
      expect(adapter).not.toHaveProperty("frontendDigest");
    }
  });

  it("serves an ACPX-discovered definition without executable metadata", async () => {
    const res = await request(app()).get("/api/adapters/fixture-agent-alpha");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("execute");
    expect(serialized).not.toContain("providerInput");
    expect(serialized).not.toContain("nativeCorrelation");
    expect(serialized).not.toContain("parser");
  });

  it("serves the exact ACPX-derived configuration schema", async () => {
    const adapter = catalog.adapters[0]!;
    const res = await request(app()).get(
      `/api/adapters/${adapter.type}/config-schema`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(adapter.definition.configSchema);
  });

  it("reports a failed ACPX probe without admitting it as a selectable adapter", async () => {
    catalog.probeDiagnostics = [{
      type: "fixture-agent-unavailable",
      code: "acpx_probe_failed",
      message: "fixture local CLI is not authenticated",
    }];
    const res = await request(app()).get("/api/adapters");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      res.body.find(
        (entry: { type: string }) => entry.type === "fixture-agent-unavailable",
      ),
    ).toEqual({
      type: "fixture-agent-unavailable",
      label: "fixture-agent-unavailable",
      source: "acpx",
      modelsCount: 0,
      loaded: false,
      diagnostic: {
        code: "acpx_probe_failed",
        message: "fixture local CLI is not authenticated",
      },
      registryName: "fixture-agent-unavailable",
    });

    const detail = await request(app()).get(
      "/api/adapters/fixture-agent-unavailable",
    );
    expect(detail.status, JSON.stringify(detail.body)).toBe(404);
  });

  it("reports rejected ACPX catalog metadata without hiding ready agents", async () => {
    catalog.probeDiagnostics = [{
      type: "fixture-agent-invalid",
      code: "acpx_catalog_invalid",
      message: "ACP config option at index 0.values[75].label must be an exact non-empty string",
    }];

    const res = await request(app()).get("/api/adapters");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      res.body.filter((entry: { loaded: boolean }) => entry.loaded),
    ).toHaveLength(2);
    expect(
      res.body.find(
        (entry: { type: string }) => entry.type === "fixture-agent-invalid",
      ),
    ).toMatchObject({
      type: "fixture-agent-invalid",
      loaded: false,
      diagnostic: {
        code: "acpx_catalog_invalid",
      },
    });
  });

  it("retires instance-level ACPX availability mutation", async () => {
    const type = catalog.adapters[0]!.type;
    const res = await request(app(true))
      .patch(`/api/adapters/${type}`)
      .send({ disabled: true });

    expect(res.status, JSON.stringify(res.body)).toBe(410);
    expect(res.body.error).toMatch(/supplied exclusively by ACPX/i);
  });

  it("rejects legacy adapter package management because ACPX owns the catalog", async () => {
    const res = await request(app(true))
      .post("/api/adapters/install")
      .send({ packageName: "irrelevant-adapter-package" });

    expect(res.status, JSON.stringify(res.body)).toBe(410);
    expect(res.body.error).toMatch(/supplied exclusively by ACPX/i);
  });
});
