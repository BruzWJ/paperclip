import expressModule from "express";
import requestModule from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretRoutes as secretRoutesImport } from "../routes/secrets.js";
import { errorHandler as errorHandlerImport } from "../middleware/error-handler.js";
import { HttpError as HttpErrorImport, unprocessable as unprocessableImport } from "../errors.js";
import { testBoardSessionActor as testBoardSessionActorImport } from "./helpers/request-actor.js";
import { testSecretsRuntimeConfig as testSecretsRuntimeConfigImport } from "./helpers/secrets-runtime.js";

const express = expressModule;
export const request = requestModule;
const secretRoutes = secretRoutesImport;
const errorHandler = errorHandlerImport;
export const HttpError = HttpErrorImport;
export const unprocessable = unprocessableImport;
const testBoardSessionActor = testBoardSessionActorImport;
const testSecretsRuntimeConfig = testSecretsRuntimeConfigImport;
const hoistedMockSecretService = vi.hoisted(() => ({
  listProviders: vi.fn(),
  checkProviders: vi.fn(),
  listProviderConfigs: vi.fn(),
  previewProviderConfigDiscovery: vi.fn(),
  getProviderConfigById: vi.fn(),
  createProviderConfig: vi.fn(),
  updateProviderConfig: vi.fn(),
  disableProviderConfig: vi.fn(),
  removeProviderConfig: vi.fn(),
  setDefaultProviderConfig: vi.fn(),
  checkProviderConfigHealth: vi.fn(),
  getById: vi.fn(),
  getByKey: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listUserSecretDefinitions: vi.fn(),
  createUserSecretDefinition: vi.fn(),
  updateUserSecretDefinition: vi.fn(),
  removeUserSecretDefinition: vi.fn(),
  getUserSecretDefinitionCoverage: vi.fn(),
  listCurrentUserSecretValues: vi.fn(),
  createCurrentUserSecretValue: vi.fn(),
  updateCurrentUserSecretValue: vi.fn(),
  rotateCurrentUserSecretValue: vi.fn(),
  removeCurrentUserSecretValue: vi.fn(),
  previewRemoteImport: vi.fn(),
  importRemoteSecrets: vi.fn(),
  listBindingReferences: vi.fn(),
  listAccessEvents: vi.fn(),
}));
export const mockSecretService = hoistedMockSecretService;
const hoistedMockLogActivity = vi.hoisted(() => vi.fn());
export const mockLogActivity = hoistedMockLogActivity;

vi.mock("../services/index.js", () => ({
  secretService: () => hoistedMockSecretService,
  logActivity: hoistedMockLogActivity,
}));

export function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    ...testBoardSessionActor({
      userId: "user-1",
      userName: "User One",
      userEmail: "user-1@example.com",
      sessionId: "session-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    }),
    ...overrides,
  };
}

export function createApp(actor: Record<string, unknown> = boardActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", secretRoutes({} as any, testSecretsRuntimeConfig()));
  app.use(errorHandler);
  return app;
}

export function registerSuiteSetup() {
  beforeEach(() => {
    for (const mock of Object.values(mockSecretService)) {
      mock.mockReset();
    }
    mockLogActivity.mockReset();
  });
}

export { describe, expect, it };
