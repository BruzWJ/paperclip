import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { BUILTIN_ADAPTER_CATALOG } from "../adapters/builtin-adapter-catalog.js";
import { createDeclarativeTestAdapter } from "./helpers/declarative-adapter.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockAdapterPluginStore = vi.hoisted(() => ({
  listAdapterPlugins: vi.fn(),
  addAdapterPlugin: vi.fn(),
  removeAdapterPlugin: vi.fn(),
  getAdapterPluginByType: vi.fn(),
  getAdapterPluginsDir: vi.fn(),
  getDisabledAdapterTypes: vi.fn(),
  setAdapterDisabled: vi.fn(),
}));

const mockPluginLoader = vi.hoisted(() => ({
  buildExternalAdapters: vi.fn(),
  buildRetainedExternalAdapters: vi.fn(),
  loadExternalAdapterPackage: vi.fn(),
  reloadExternalAdapter: vi.fn(),
}));

let externalAdapter: ServerAdapterModule;
let registerServerAdapter: typeof import("../adapters/registry.js").registerServerAdapter;
let unregisterServerAdapter: typeof import("../adapters/registry.js").unregisterServerAdapter;
let findServerAdapter: typeof import("../adapters/registry.js").findServerAdapter;
let findActiveServerAdapter: typeof import("../adapters/registry.js").findActiveServerAdapter;
let findSelectableServerAdapterImplementation: typeof import("../adapters/registry.js").findSelectableServerAdapterImplementation;
let adapterRoutes: typeof import("../routes/adapters.js").adapterRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;

function registerModuleMocks() {
  vi.doMock("node:child_process", async () => vi.importActual("node:child_process"));
  vi.doMock("../adapters/plugin-loader.js", () => mockPluginLoader);
  vi.doMock("../services/adapter-plugin-store.js", () => mockAdapterPluginStore);
  vi.doMock("../routes/adapters.js", async () => vi.importActual("../routes/adapters.js"));
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../middleware/index.js", async () => vi.importActual("../middleware/index.js"));
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
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
}

describe("adapter routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("node:child_process");
    vi.doUnmock("../adapters/registry.js");
    vi.doUnmock("../adapters/plugin-loader.js");
    vi.doUnmock("../services/adapter-plugin-store.js");
    vi.doUnmock("../routes/adapters.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    mockAdapterPluginStore.listAdapterPlugins.mockReturnValue([]);
    mockAdapterPluginStore.addAdapterPlugin.mockResolvedValue(undefined);
    mockAdapterPluginStore.removeAdapterPlugin.mockReturnValue(false);
    mockAdapterPluginStore.getAdapterPluginByType.mockReturnValue(undefined);
    mockAdapterPluginStore.getAdapterPluginsDir.mockReturnValue(
      "/tmp/paperclip-adapter-routes-test",
    );
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue([]);
    mockAdapterPluginStore.setAdapterDisabled.mockReturnValue(false);
    mockPluginLoader.buildExternalAdapters.mockResolvedValue([]);
    mockPluginLoader.buildRetainedExternalAdapters.mockResolvedValue([]);
    mockPluginLoader.loadExternalAdapterPackage.mockResolvedValue(null);
    mockPluginLoader.reloadExternalAdapter.mockResolvedValue(null);

    const [registry, routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../adapters/registry.js")>(
        "../adapters/registry.js",
      ),
      import("../routes/adapters.js"),
      import("../middleware/index.js"),
    ]);
    registerServerAdapter = registry.registerServerAdapter;
    unregisterServerAdapter = registry.unregisterServerAdapter;
    findServerAdapter = registry.findServerAdapter;
    findActiveServerAdapter = registry.findActiveServerAdapter;
    findSelectableServerAdapterImplementation =
      registry.findSelectableServerAdapterImplementation;
    adapterRoutes = routes.adapterRoutes;
    errorHandler = middleware.errorHandler;
    externalAdapter = createDeclarativeTestAdapter({
      type: "external_test",
      label: "External Test",
    });
    unregisterServerAdapter(externalAdapter.type);
    registerServerAdapter(externalAdapter);
  });

  afterEach(() => {
    unregisterServerAdapter(externalAdapter.type);
    unregisterServerAdapter("installed_external_test");
    unregisterServerAdapter("invalid_external_test");
  });

  it("lists only canonical declarative definitions and installed externals", async () => {
    const res = await request(createApp()).get("/api/adapters");

    expect(res.status).toBe(200);
    expect(res.body.map((entry: { type: string }) => entry.type).sort()).toEqual(
      [
        ...BUILTIN_ADAPTER_CATALOG.map((entry) => entry.adapterType),
        externalAdapter.type,
      ].sort(),
    );
    for (const adapter of res.body) {
      expect(Object.keys(adapter.capabilities).sort()).toEqual([
        "cancel",
        "contractVersion",
        "protocolVersion",
        "resume",
        "sessionConfig",
        "sessionScopedMcpReplacement",
        "supportsModelProfiles",
      ]);
      expect(adapter).toMatchObject({
        registryName: "codex",
        frontendPackage: "@agentclientprotocol/codex-acp",
        frontendVersion: "1.1.7",
        frontendDigest: "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a",
      });
    }
  });

  it("serves definition metadata without executable or native-session fields", async () => {
    for (const type of ["codex", "external_test"]) {
      const res = await request(createApp()).get(`/api/adapters/${type}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("execute");
      expect(serialized).not.toContain("providerInput");
      expect(serialized).not.toContain("nativeCorrelation");
      expect(serialized).not.toContain("parser");
    }
  });

  it("serves the exact schema-owned ACP configuration form", async () => {
    const res = await request(createApp()).get(
      "/api/adapters/external_test/config-schema",
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(externalAdapter.definition.configSchema);
  });

  it("keeps disabled metadata resolvable but rejects new selection", () => {
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue([
      "external_test",
    ]);

    expect(findActiveServerAdapter("external_test")).toBe(externalAdapter);
    expect(
      findSelectableServerAdapterImplementation("external_test"),
    ).toBeNull();
  });

  it("installs a structurally complete declarative definition", async () => {
    const installedAdapter = createDeclarativeTestAdapter({
      type: "installed_external_test",
    });
    mockPluginLoader.loadExternalAdapterPackage.mockResolvedValue(installedAdapter);

    const res = await request(createApp(true))
      .post("/api/adapters/install")
      .send({
        packageName: "/tmp/fake-external-adapter",
        isLocalPath: true,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.type).toBe("installed_external_test");
    expect(findServerAdapter("installed_external_test")).toBe(installedAdapter);
  });

  it("rejects a legacy executable adapter instead of adding a fallback", async () => {
    mockPluginLoader.loadExternalAdapterPackage.mockResolvedValue({
      ...createDeclarativeTestAdapter({ type: "invalid_external_test" }),
      execute: async () => undefined,
    });

    const res = await request(createApp(true))
      .post("/api/adapters/install")
      .send({
        packageName: "/tmp/fake-invalid-adapter",
        isLocalPath: true,
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/unknown field execute/);
    expect(findServerAdapter("invalid_external_test")).toBeNull();
  });
});
