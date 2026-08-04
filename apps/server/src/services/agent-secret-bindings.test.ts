import { describe, expect, it, vi } from "vitest";
import { syncAgentAdapterEnvBindings } from "./agent-secret-bindings.js";
import {
  adapterConfigPathHasRootKey,
  adapterConfigPathRootKey,
} from "./adapter-config-path.js";

describe("canonical adapter configuration paths", () => {
  it("decodes simple and JSON-bracket root keys without aliasing them", () => {
    expect(adapterConfigPathRootKey("access.API_KEY")).toBe(
      "access",
    );
    expect(adapterConfigPathRootKey('access["x.y"]')).toBe(
      "access",
    );
    expect(adapterConfigPathRootKey("access[0]")).toBe(
      "access",
    );
    expect(
      adapterConfigPathRootKey('["access.x"].credential'),
    ).toBe("access.x");
    expect(
      adapterConfigPathHasRootKey(
        '["access.x"].credential',
        "access",
      ),
    ).toBe(false);
  });
});

describe("syncAgentAdapterEnvBindings", () => {
  it("synchronizes secret references at every normalized adapter-config path", async () => {
    const companySecretId =
      "11111111-1111-4111-8111-111111111111";
    const syncSecretRefsForTarget = vi.fn(async () => undefined);
    const syncUserSecretDeclarationsForTarget = vi.fn(
      async () => undefined,
    );

    await syncAgentAdapterEnvBindings({
      secretsSvc: {
        syncSecretRefsForTarget,
        syncUserSecretDeclarationsForTarget,
      },
      companyId: "company-1",
      agentId: "agent-1",
      actor: { type: "system" },
      adapterConfig: {
        headers: {
          Authorization: {
            type: "secret_ref",
            secretId: companySecretId,
            version: 2,
          },
        },
        nested: [
          {
            credential: {
              type: "user_secret_ref",
              key: "provider_token",
              version: "latest",
              required: true,
            },
          },
        ],
      },
    });

    expect(syncSecretRefsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "agent", targetId: "agent-1" },
      [
        expect.objectContaining({
          secretId: companySecretId,
          configPath: "headers.Authorization",
          versionSelector: 2,
        }),
      ],
      { actor: { type: "system" }, replaceAll: true },
    );
    expect(
      syncUserSecretDeclarationsForTarget,
    ).toHaveBeenCalledWith(
      "company-1",
      { targetType: "agent", targetId: "agent-1" },
      [
        expect.objectContaining({
          definitionKey: "provider_token",
          configPath: "nested[0].credential",
          envKey: "nested[0].credential",
          required: true,
        }),
      ],
      { actor: { type: "system" }, replaceAll: true },
    );
  });

  it("keeps unsafe dotted and bracketed object keys as distinct canonical paths", async () => {
    const companySecretId =
      "11111111-1111-4111-8111-111111111111";
    const syncSecretRefsForTarget = vi.fn(async () => undefined);
    const syncUserSecretDeclarationsForTarget = vi.fn(
      async () => undefined,
    );

    await syncAgentAdapterEnvBindings({
      secretsSvc: {
        syncSecretRefsForTarget,
        syncUserSecretDeclarationsForTarget,
      },
      companyId: "company-1",
      agentId: "agent-1",
      actor: { type: "system" },
      adapterConfig: {
        headers: {
          "x.y": {
            type: "secret_ref",
            secretId: companySecretId,
            version: "latest",
          },
          "x[0]": {
            type: "secret_ref",
            secretId: companySecretId,
            version: "latest",
          },
        },
      },
    });

    expect(syncSecretRefsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "agent", targetId: "agent-1" },
      [
        expect.objectContaining({
          configPath: 'headers["x.y"]',
        }),
        expect.objectContaining({
          configPath: 'headers["x[0]"]',
        }),
      ],
      { actor: { type: "system" }, replaceAll: true },
    );
    expect(
      syncUserSecretDeclarationsForTarget,
    ).toHaveBeenCalledWith(
      "company-1",
      { targetType: "agent", targetId: "agent-1" },
      [],
      { actor: { type: "system" }, replaceAll: true },
    );
  });
});
