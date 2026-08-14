import expressModule from "express";
import osModule from "node:os";
import pathModule from "node:path";
import { promises as fsModule } from "node:fs";
import requestModule from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginConfig, PluginRecord } from "@paperclipai/shared";
import { testBoardSessionActor as testBoardSessionActorImport } from "./helpers/request-actor.js";

const express = expressModule;
export const os = osModule;
export const path = pathModule;
export const fs = fsModule;
export const request = requestModule;
const testBoardSessionActor = testBoardSessionActorImport;
const hoistedMockRegistry = vi.hoisted(() => ({
  list: vi.fn(),
  listByStatus: vi.fn(),
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));
export const mockRegistry = hoistedMockRegistry;

const hoistedMockCatalog = vi.hoisted(() => ({
  list: vi.fn(),
  install: vi.fn(),
}));
export const mockCatalog = hoistedMockCatalog;

const hoistedMockLogActivity = vi.hoisted(() => vi.fn());
export const mockLogActivity = hoistedMockLogActivity;

const hoistedMockLifecycle = vi.hoisted(() => ({
  install: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  updateConfig: vi.fn(),
  markError: vi.fn(),
}));
export const mockLifecycle = hoistedMockLifecycle;

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => hoistedMockRegistry,
}));

vi.mock("../services/plugin-catalog.js", () => ({
  PluginCatalogOperationError: class PluginCatalogOperationError extends Error {},
  pluginCatalogService: () => hoistedMockCatalog,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: hoistedMockLogActivity,
}));

function createAuditDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn().mockResolvedValue([]),
    })),
  };
}

export async function createApp(
  actor: Record<string, unknown>,
  routeOverrides: {
    db?: unknown;
    runtime?: unknown;
    captureJsonContext?: (context: unknown, body: unknown) => void;
  } = {},
) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(
    express.json({
      verify(req, _res, buf) {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  if (routeOverrides.captureJsonContext) {
    app.use((_req, res, next) => {
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        routeOverrides.captureJsonContext?.((res as any).__errorContext, body);
        return originalJson(body);
      }) as typeof res.json;
      next();
    });
  }
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      (routeOverrides.db ?? createAuditDb()) as never,
      mockLifecycle as never,
      routeOverrides.runtime as never,
    ),
  );
  app.use(errorHandler);

  return { app };
}

export const companyA = "22222222-2222-4222-8222-222222222222";
export const companyB = "33333333-3333-4333-8333-333333333333";
export const pluginId = "11111111-1111-4111-8111-111111111111";
export const scopedCompanyId = "22222222-2222-4222-8222-222222222222";
export const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const jobRunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const installedAt = new Date("2026-08-05T01:02:03.000Z");
export const updatedAt = new Date("2026-08-06T04:05:06.000Z");

export function pluginRecord(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: pluginId,
    pluginKey: "paperclip.example",
    packageName: "paperclip-plugin-example",
    source: "npm",
    packagePath: "/plugins/paperclip-plugin-example",
    status: "ready",
    installOrder: 1,
    manifestJson: {
      id: "paperclip.example",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Example",
      description: "Example plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "dist/worker.js" },
    },
    lastError: null,
    installedAt,
    updatedAt,
    ...overrides,
  };
}

export function pluginConfig(
  configJson: Record<string, unknown>,
  overrides: Partial<PluginConfig> = {},
): PluginConfig {
  return {
    id: "config-1",
    pluginId,
    configJson,
    createdAt: installedAt,
    updatedAt,
    ...overrides,
  };
}

export function boardActor(overrides: Parameters<typeof testBoardSessionActor>[0] = {}) {
  return testBoardSessionActor({
    userId: "user-1",
    userName: "User One",
    userEmail: "user-1@paperclip.test",
    sessionId: "session-user-1",
    isInstanceAdmin: false,
    companyIds: [companyA],
    ...overrides,
  });
}

export function readyPlugin() {
  mockRegistry.getById.mockResolvedValue(pluginRecord());
}

export function readyLocalFolderPlugin() {
  mockRegistry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey: "paperclip.example",
    status: "ready",
    manifestJson: {
      id: "paperclip.example",
      capabilities: ["local.folders"],
      localFolders: [
        {
          folderKey: "content-root",
          displayName: "Content root",
          access: "readWrite",
          requiredDirectories: ["docs"],
          requiredFiles: ["README.md"],
        },
      ],
    },
  });
}

export function registerSuiteSetup(
  options: {
    emptyRegistryList?: boolean;
    emptyCompanySettings?: boolean;
  } = {},
) {
  beforeEach(() => {
    vi.clearAllMocks();
    if (options.emptyRegistryList) {
      mockRegistry.list.mockResolvedValue([]);
    }
    if (options.emptyCompanySettings) {
      mockRegistry.getCompanySettings.mockResolvedValue(null);
    }
  });
}

export { describe, expect, it, vi };
