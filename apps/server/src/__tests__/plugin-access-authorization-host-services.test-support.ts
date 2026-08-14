import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { buildHostServices as buildHostServicesImport } from "../services/plugin-host-services.js";
import { PluginTaskAuthorizationRejected as PluginTaskAuthorizationRejectedImport } from "../services/plugin-task-authorization.js";
import { createMockDb as createMockDbImport } from "./helpers/mock-db.js";
import {
  createPluginHostServicesTestOptions as createPluginHostServicesTestOptionsImport,
  createPluginManifestFake as createPluginManifestFakeImport,
  createPluginRuntimeRecordsReaderFake as createPluginRuntimeRecordsReaderFakeImport,
  noopPluginEventDelivery as noopPluginEventDeliveryImport,
} from "./helpers/plugin-host-services.js";

export const buildHostServices = buildHostServicesImport;
export const PluginTaskAuthorizationRejected = PluginTaskAuthorizationRejectedImport;
export const createMockDb = createMockDbImport;
export const createPluginHostServicesTestOptions = createPluginHostServicesTestOptionsImport;
export const createPluginManifestFake = createPluginManifestFakeImport;
export const createPluginRuntimeRecordsReaderFake = createPluginRuntimeRecordsReaderFakeImport;
export const noopPluginEventDelivery = noopPluginEventDeliveryImport;
const hoistedMocks = vi.hoisted(() => ({
  assertPluginAvailable: vi.fn(),
  agentGetById: vi.fn(),
  authorizationDecide: vi.fn(),
  logActivity: vi.fn(),
}));
export const mocks = hoistedMocks;

vi.mock("../services/plugin-task-authorization.js", async () => ({
  ...(await vi.importActual<typeof import("../services/plugin-task-authorization.js")>(
    "../services/plugin-task-authorization.js",
  )),
  assertPluginInstallationRequestScope: hoistedMocks.assertPluginAvailable,
}));

vi.mock("../services/agents.js", async () => ({
  ...(await vi.importActual<typeof import("../services/agents.js")>("../services/agents.js")),
  agentService: () => ({ getById: hoistedMocks.agentGetById }),
}));

vi.mock("../services/authorization.js", async () => ({
  ...(await vi.importActual<typeof import("../services/authorization.js")>("../services/authorization.js")),
  authorizationService: () => ({ decide: hoistedMocks.authorizationDecide }),
}));

vi.mock("../services/activity-log.js", async () => ({
  ...(await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js")),
  logActivity: hoistedMocks.logActivity,
}));

export const pluginId = "00000000-0000-4000-8000-000000000100";
export const pluginKey = "permissions-extension";
export const companyId = "00000000-0000-4000-8000-000000000001";
export const actorAgentId = "00000000-0000-4000-8000-000000000010";
export const targetAgentId = "00000000-0000-4000-8000-000000000011";
export const createdAt = new Date("2026-01-02T00:00:00.000Z");

export function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as never;
}

export function services(db: Db) {
  return buildHostServices(
    db,
    pluginId,
    createEventBusStub(),
    noopPluginEventDelivery,
    createPluginHostServicesTestOptions({
      manifest: createPluginManifestFake({ id: pluginKey }),
    }),
  );
}

export function registerSuiteSetup() {
  beforeEach(() => {
    mocks.assertPluginAvailable.mockReset().mockResolvedValue(undefined);
    mocks.agentGetById.mockReset();
    mocks.authorizationDecide.mockReset();
    mocks.logActivity.mockReset().mockResolvedValue(undefined);
  });
}

export { describe, expect, it, vi };
