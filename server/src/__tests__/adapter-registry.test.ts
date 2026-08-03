import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterModel,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { resolveApprovedAcpLaunch } from "@paperclipai/adapter-utils/acp-subprocess";
import {
  findActiveServerAdapter,
  findSelectableServerAdapterImplementation,
  findServerAdapter,
  findServerAdapterImplementation,
  listAdapterModelProfiles,
  listAdapterModels,
  listServerAdapters,
  registerServerAdapter,
  requireServerAdapter,
  requireServerAdapterImplementation,
  resolveAvailableAdapterModel,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { setOverridePaused } from "../adapters/registry.js";

const launchProfile = resolveApprovedAcpLaunch("codex");

function model(input: {
  id: string;
  label?: string;
  value?: string;
  contextTokenLimit?: number;
}): AdapterModel {
  return {
    id: input.id,
    label: input.label ?? input.id,
    value: input.value ?? input.id,
    limits: {
      contextTokenLimit: input.contextTokenLimit ?? 200_000,
      outputTokenLimit: 16_000,
    },
  };
}

function declarativeAdapter(
  type: string,
  models: readonly AdapterModel[] = [model({ id: `${type}-model` })],
): ServerAdapterModule {
  const modelOptions = models.map((entry) => ({
    label: entry.label,
    value: entry.value,
  }));
  return {
    type,
    definition: {
      version: "acp-subprocess/v1",
      launchProfile,
      environment: {
        cwd: "execution-workspace",
        additionalDirectories: "authorized-workspace-only",
        drivers: ["local", "ssh", "sandbox", "plugin"],
        environmentKeys: [],
      },
      readiness: {
        protocolVersion: 1,
        resume: true,
        cancel: true,
        sessionConfig: true,
        sessionScopedMcpReplacement: true,
        cliNativeAuthentication: true,
      },
      ui: {
        label: type,
        description: `${type} declarative ACP test adapter`,
      },
      configSchema: {
        fields: [{
          key: "model",
          label: "Model",
          type: "select",
          required: true,
          options: modelOptions,
        }],
      },
      configOptions: [{
        id: "model",
        configKey: "model",
        label: "Model",
        required: true,
        values: modelOptions,
      }],
      modelConfigOptionId: "model",
      models,
      modelProfiles: [],
      configurationDoc: "Authenticate through the target CLI.",
    },
  };
}

function externalIdentity(
  adapterType: string,
  artifactDigest = "d".repeat(64),
) {
  return {
    adapterType,
    definitionVersion: "acp-subprocess/v1" as const,
    protocolVersion: 1 as const,
    origin: "external" as const,
    packageName: "@paperclip-test/external",
    packageVersion: "1.0.0",
    buildIdentity: "@paperclip-test/external@1.0.0",
    artifactDigest,
  };
}

describe("server adapter registry", () => {
  beforeEach(() => {
    unregisterServerAdapter("external_test");
    unregisterServerAdapter("external_ambiguous");
    unregisterServerAdapter("codex");
    setOverridePaused("codex", false);
  });

  afterEach(() => {
    unregisterServerAdapter("external_test");
    unregisterServerAdapter("external_ambiguous");
    unregisterServerAdapter("codex");
    setOverridePaused("codex", false);
  });

  it("registers only the canonical built-in Codex definition", () => {
    expect(listServerAdapters().map((adapter) => adapter.type)).toEqual([
      "codex",
    ]);
    expect(requireServerAdapter("codex").definition).toMatchObject({
      version: "acp-subprocess/v1",
      launchProfile: {
        registryName: "codex",
        frontendPackage: "@agentclientprotocol/codex-acp",
        frontendVersion: "1.1.7",
        frontendDigest: "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a",
      },
    });
    expect(
      findSelectableServerAdapterImplementation("codex")?.identity,
    ).toMatchObject({
      adapterType: "codex",
      definitionVersion: "acp-subprocess/v1",
      protocolVersion: 1,
      origin: "builtin",
      packageName: "@paperclipai/server",
      packageVersion: "0.3.1",
      buildIdentity: "@paperclipai/server@0.3.1:codex",
      artifactDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("registers and removes a declarative external definition", async () => {
    const external = declarativeAdapter("external_test");
    const registered = registerServerAdapter(external);

    expect(requireServerAdapter("external_test")).toBe(external);
    expect(await listAdapterModels("external_test")).toEqual(
      external.definition.models,
    );
    expect(await listAdapterModelProfiles("external_test")).toEqual([]);

    unregisterServerAdapter("external_test");
    expect(findServerAdapter("external_test")).toBeNull();
    expect(
      findServerAdapterImplementation(
        "external_test",
        registered.identity,
      )?.adapter,
    ).toBe(external);
  });

  it("resolves one exact model id and rejects a conflicting catalog", async () => {
    const selected = model({ id: "external-model", label: "External" });
    registerServerAdapter(declarativeAdapter("external_test", [selected]));

    await expect(resolveAvailableAdapterModel("external-model")).resolves.toEqual(
      selected,
    );
    await expect(resolveAvailableAdapterModel(" external-model")).rejects.toThrow(
      /exact non-empty catalog key/,
    );

    registerServerAdapter(
      declarativeAdapter("external_ambiguous", [
        model({
          id: "external-model",
          label: "Different",
          value: "different-value",
        }),
      ]),
    );
    await expect(resolveAvailableAdapterModel("external-model")).rejects.toThrow(
      /ambiguous/,
    );
  });

  it("restores built-in Codex after pausing or removing an override", () => {
    const builtIn = requireServerAdapter("codex");
    const builtInIdentity =
      findSelectableServerAdapterImplementation("codex")!.identity;
    const override = declarativeAdapter("codex", [
      model({ id: "override-model" }),
    ]);
    const registeredOverride = registerServerAdapter(override, {
      identity: externalIdentity("codex"),
    });

    expect(findActiveServerAdapter("codex")).toBe(override);
    expect(setOverridePaused("codex", true)).toBe(true);
    expect(findActiveServerAdapter("codex")).toBe(builtIn);
    expect(
      requireServerAdapterImplementation(
        "codex",
        registeredOverride.identity,
      ),
    ).toBe(override);
    expect(requireServerAdapterImplementation("codex", builtInIdentity)).toBe(
      builtIn,
    );
    expect(setOverridePaused("codex", false)).toBe(true);
    expect(findActiveServerAdapter("codex")).toBe(override);
    unregisterServerAdapter("codex");
    expect(findActiveServerAdapter("codex")).toBe(builtIn);
  });

  it("keeps retained implementations pinned across same-version replacement", () => {
    const first = declarativeAdapter("external_test", [
      model({ id: "first-model" }),
    ]);
    const second = declarativeAdapter("external_test", [
      model({ id: "second-model" }),
    ]);
    const firstRegistration = registerServerAdapter(first, {
      identity: externalIdentity("external_test", "1".repeat(64)),
    });
    const secondRegistration = registerServerAdapter(second, {
      identity: externalIdentity("external_test", "2".repeat(64)),
    });

    expect(requireServerAdapter("external_test")).toBe(second);
    expect(
      requireServerAdapterImplementation(
        "external_test",
        firstRegistration.identity,
      ),
    ).toBe(first);
    expect(
      requireServerAdapterImplementation(
        "external_test",
        secondRegistration.identity,
      ),
    ).toBe(second);
  });

  it("fails closed for an unavailable pinned implementation", () => {
    expect(() =>
      requireServerAdapterImplementation(
        "external_test",
        externalIdentity("external_test", "f".repeat(64)),
      ),
    ).toThrow(/Unavailable pinned adapter implementation/);
  });
});

describe("server adapter registration validation", () => {
  it("rejects executable legacy fields", () => {
    expect(() =>
      registerServerAdapter({
        ...declarativeAdapter("invalid-external"),
        execute: async () => undefined,
      } as unknown as ServerAdapterModule),
    ).toThrow(/unknown field execute/);
  });

  it("rejects a missing declarative definition", () => {
    expect(() =>
      registerServerAdapter({ type: "invalid-external" } as ServerAdapterModule),
    ).toThrow(/missing required field definition/);
  });

  it("rejects launch bytes that differ from the approved registry entry", () => {
    const candidate = declarativeAdapter("invalid-external");
    expect(() =>
      registerServerAdapter({
        ...candidate,
        definition: {
          ...candidate.definition,
          launchProfile: {
            ...candidate.definition.launchProfile,
            args: ["unapproved"],
          },
        },
      }),
    ).toThrow(/launch does not match its approved ACP registry entry/);
    expect(() =>
      registerServerAdapter({
        ...candidate,
        definition: {
          ...candidate.definition,
          launchProfile: {
            ...candidate.definition.launchProfile,
            frontendDigest: "f".repeat(64),
          },
        },
      }),
    ).toThrow(/launch does not match its approved ACP registry entry/);
  });
});
