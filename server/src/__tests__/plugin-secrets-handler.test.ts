import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";

const secretServiceMocks = vi.hoisted(() => ({
  resolveSecretValue: vi.fn(),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => secretServiceMocks,
}));

import {
  createPluginSecretsHandler,
  extractSecretRefBindingsFromConfig,
} from "../services/plugin-secrets-handler.js";

const pluginId = "11111111-1111-4111-8111-111111111111";

describe("extractSecretRefBindingsFromConfig", () => {
  it("ignores UUID strings outside schema-declared secret fields", () => {
    const externalProjectId = "77777777-7777-4777-8777-777777777777";

    expect(extractSecretRefBindingsFromConfig(
      { externalProjectId },
      { type: "object", properties: { externalProjectId: { type: "string" } } },
    )).toEqual([]);
  });

  it("rejects legacy UUID strings at schema-declared secret fields", () => {
    const secretId = "77777777-7777-4777-8777-777777777777";

    expect(() => extractSecretRefBindingsFromConfig(
      { token: secretId },
      { type: "object", properties: { token: { format: "secret-ref" } } },
    )).toThrow(/must use.*secret_ref/i);
  });
});

describe("createPluginSecretsHandler fail-closed guards", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires company context before touching persistence", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({ secretRef: { type: "secret_ref", secretId: randomUUID() } }),
    ).rejects.toThrow(/companyId is required/i);
    expect(db.select).not.toHaveBeenCalled();
    expect(secretServiceMocks.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("rejects legacy string refs before provider resolution", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({ companyId: randomUUID(), secretRef: randomUUID() }),
    ).rejects.toThrow(/use \{ type: "secret_ref"/i);
    expect(db.select).not.toHaveBeenCalled();
    expect(secretServiceMocks.resolveSecretValue).not.toHaveBeenCalled();
  });
});

describe("createPluginSecretsHandler shared vault integration contract", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves bound plugin refs through secretService with plugin-worker access context", async () => {
    const companyId = randomUUID();
    const secretId = randomUUID();
    const harness = createMockDb({
      select: [[{
        companyId,
        targetType: "plugin",
        targetId: pluginId,
        secretId,
        configPath: "apiKey",
        versionSelector: "latest",
      }]],
    });
    secretServiceMocks.resolveSecretValue.mockResolvedValue("resolved-plugin-secret");
    const handler = createPluginSecretsHandler({ db: harness.db, pluginId });

    await expect(handler.resolve({
      companyId,
      secretRef: { type: "secret_ref", secretId, version: "latest" },
    })).resolves.toBe("resolved-plugin-secret");

    expect(secretServiceMocks.resolveSecretValue).toHaveBeenCalledWith(
      companyId,
      secretId,
      "latest",
      {
        bindingContext: {
          consumerType: "plugin",
          consumerId: pluginId,
          configPath: "apiKey",
          actorType: "plugin",
          actorId: pluginId,
          issueId: null,
          runId: null,
          pluginId,
        },
        accessContext: {
          consumerType: "plugin_worker",
          consumerId: pluginId,
          configPath: "apiKey",
          actorType: "plugin",
          actorId: pluginId,
          issueId: null,
          runId: null,
          pluginId,
        },
      },
    );
    expect(harness.remaining("select")).toBe(0);
  });

  it("fails closed for cross-company resolve before secret provider access", async () => {
    const companyId = randomUUID();
    const foreignSecretId = randomUUID();
    const harness = createMockDb({ select: [[]] });
    const handler = createPluginSecretsHandler({ db: harness.db, pluginId });

    await expect(handler.resolve({
      companyId,
      secretRef: {
        type: "secret_ref",
        secretId: foreignSecretId,
        version: "latest",
      },
    })).rejects.toThrow(/not bound/i);

    expect(secretServiceMocks.resolveSecretValue).not.toHaveBeenCalled();
    expect(harness.remaining("select")).toBe(0);
  });
});
