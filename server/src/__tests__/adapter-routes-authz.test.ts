import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { createDeclarativeTestAdapter } from "./helpers/declarative-adapter.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const FIXTURE_AGENT_TYPE = "fixture-agent-alpha";

const catalog = vi.hoisted(() => ({
  adapter: null as ServerAdapterModule | null,
  refreshAcpxAdapters: vi.fn(async () => undefined),
}));

function registerRouteMocks() {
  vi.doMock("../adapters/index.js", () => ({
    findActiveServerAdapter: (type: string) =>
      catalog.adapter?.type === type ? catalog.adapter : null,
    findServerAdapter: (type: string) =>
      catalog.adapter?.type === type ? catalog.adapter : null,
    listServerAdapters: () => (catalog.adapter ? [catalog.adapter] : []),
    listAcpxAdapterProbeDiagnostics: () => [],
    refreshAcpxAdapters: catalog.refreshAcpxAdapters,
  }));
}

function boardMember(membershipRole: "admin" | "operator" | "viewer") {
  return testBoardSessionActor({
    userId: `${membershipRole}-user`,
    userName: null,
    userEmail: null,
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{
      companyId: "company-1",
      membershipRole,
      status: "active",
    }],
  });
}

const instanceAdmin = testBoardSessionActor({
  userId: "instance-admin",
  userName: null,
  userEmail: null,
  isInstanceAdmin: true,
  companyIds: [],
  memberships: [],
});

function createApp(
  actor: ReturnType<typeof testBoardSessionActor>,
  adapterRoutes: typeof import("../routes/adapters.js").adapterRoutes,
  errorHandler: typeof import("../middleware/index.js").errorHandler,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
}

function sendMutatingRequest(
  app: express.Express,
  name: "install" | "disable" | "override" | "delete" | "reload" | "reinstall",
) {
  switch (name) {
    case "install":
      return request(app)
        .post("/api/adapters/install")
        .send({ packageName: "irrelevant-adapter-package" });
    case "disable":
      return request(app)
        .patch(`/api/adapters/${FIXTURE_AGENT_TYPE}`)
        .send({ disabled: true });
    case "override":
      return request(app)
        .patch(`/api/adapters/${FIXTURE_AGENT_TYPE}/override`)
        .send({ paused: true });
    case "delete":
      return request(app).delete(`/api/adapters/${FIXTURE_AGENT_TYPE}`);
    case "reload":
      return request(app).post(`/api/adapters/${FIXTURE_AGENT_TYPE}/reload`);
    case "reinstall":
      return request(app).post(`/api/adapters/${FIXTURE_AGENT_TYPE}/reinstall`);
  }
}

describe.sequential("ACPX adapter route authorization", () => {
  let adapterRoutes: typeof import("../routes/adapters.js").adapterRoutes;
  let errorHandler: typeof import("../middleware/index.js").errorHandler;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/adapters.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    catalog.adapter = createDeclarativeTestAdapter({
      type: FIXTURE_AGENT_TYPE,
    });
    catalog.refreshAcpxAdapters.mockClear();
    registerRouteMocks();

    const [routes, middleware] = await Promise.all([
      import("../routes/adapters.js"),
      import("../middleware/index.js"),
    ]);
    adapterRoutes = routes.adapterRoutes;
    errorHandler = middleware.errorHandler;
  });

  afterEach(() => {
    catalog.adapter = null;
  });

  it("rejects every adapter mutation for a non-instance-admin board user", async () => {
    for (const routeName of [
      "install",
      "disable",
      "override",
      "delete",
      "reload",
      "reinstall",
    ] as const) {
      const res = await sendMutatingRequest(
        createApp(boardMember("admin"), adapterRoutes, errorHandler),
        routeName,
      );

      expect(res.status, `${routeName}: ${JSON.stringify(res.body)}`).toBe(403);
    }
  });

  it("lets instance admins receive retirement guidance but not replace ACPX's catalog", async () => {
    const expectedStatuses = {
      install: 410,
      disable: 410,
      override: 410,
      delete: 410,
      reload: 410,
      reinstall: 410,
    } as const;

    for (const [routeName, expectedStatus] of Object.entries(expectedStatuses) as Array<[
      keyof typeof expectedStatuses,
      number,
    ]>) {
      const res = await sendMutatingRequest(
        createApp(instanceAdmin, adapterRoutes, errorHandler),
        routeName,
      );

      expect(res.status, `${routeName}: ${JSON.stringify(res.body)}`).toBe(expectedStatus);
    }
  });

  it.each(["viewer", "operator"] as const)(
    "does not let a company %s manage or refresh ACPX agents",
    async (membershipRole) => {
      const app = createApp(
        boardMember(membershipRole),
        adapterRoutes,
        errorHandler,
      );

      const [install, reload] = await Promise.all([
        sendMutatingRequest(app, "install"),
        sendMutatingRequest(app, "reload"),
      ]);

      expect(install.status, JSON.stringify(install.body)).toBe(403);
      expect(reload.status, JSON.stringify(reload.body)).toBe(403);
      expect(catalog.refreshAcpxAdapters).not.toHaveBeenCalled();
    },
  );
});
