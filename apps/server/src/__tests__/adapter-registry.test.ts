import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterModel, ServerAdapterModule } from "@paperclipai/adapter-utils";

const acpxFixture = vi.hoisted(() => {
  const agentName = "fixture-agent";
  const model: AdapterModel = Object.freeze({
    id: "fixture-model",
    label: "Fixture model",
    value: "fixture-model",
    limits: null,
  });
  const adapter: ServerAdapterModule = Object.freeze({
    type: agentName,
    definition: Object.freeze({
      version: "acpx-runtime/v1",
      launchProfile: Object.freeze({ registryName: agentName }),
      environment: Object.freeze({
        cwd: "execution-workspace",
        additionalDirectories: "authorized-workspace-only",
        drivers: Object.freeze(["local"] as const),
        environmentKeys: Object.freeze([]),
      }),
      runtime: Object.freeze({
        controls: Object.freeze(["session/status", "session/set_config_option"]),
      }),
      ui: Object.freeze({
        label: agentName,
        description: "ACPX test discovery fixture.",
      }),
      configSchema: Object.freeze({
        fields: Object.freeze([
          Object.freeze({
            key: "model",
            label: "Model",
            type: "select" as const,
            options: Object.freeze([
              Object.freeze({ label: model.label, value: model.value }),
            ]),
            required: true,
          }),
        ]),
      }),
      configOptions: Object.freeze([
        Object.freeze({
          id: "model",
          configKey: "model",
          label: "Model",
          required: true as const,
          values: Object.freeze([
            Object.freeze({ label: model.label, value: model.value }),
          ]),
        }),
      ]),
      modelConfigOptionId: "model",
      models: Object.freeze([model]),
      modelProfiles: Object.freeze([]),
      configurationDoc: "Provided by ACPX.",
    }),
  });
  return Object.freeze({
    agentName,
    registryResolve: vi.fn(() => {
      throw new Error("Paperclip must not inspect ACPX launch argv");
    }),
    adapter,
    state: {
      snapshot: [adapter] as ServerAdapterModule[],
      failDiscovery: false,
    },
  });
});

vi.mock("@paperclipai/adapter-utils/acp-subprocess", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@paperclipai/adapter-utils/acp-subprocess")
  >();
  return {
    ...actual,
    loadAcpxAgentRegistry: vi.fn(async () => ({
      list: () => acpxFixture.state.snapshot.map((adapter) => adapter.type),
      resolve: acpxFixture.registryResolve,
    })),
  };
});

vi.mock("../adapters/acpx-catalog.js", () => ({
  discoverLocalAcpxAdapterCatalog: vi.fn(async () => {
    if (acpxFixture.state.failDiscovery) {
      throw new Error("ACPX registry reload failed");
    }
    return {
      adapters: Object.freeze([...acpxFixture.state.snapshot]),
      unavailable: Object.freeze({}),
    };
  }),
}));

const {
  findSelectableServerAdapterImplementation,
  findServerAdapter,
  listAcpxAdapterProbeDiagnostics,
  listAdapterModels,
  listServerAdapters,
  refreshAcpxAdapters,
  registerServerAdapter,
  requireServerAdapter,
  resolveAvailableAdapterModel,
  setOverridePaused,
  unregisterServerAdapter,
} = await import("../adapters/registry.js");

describe("ACPX-supplied server adapter registry", () => {
  beforeEach(async () => {
    acpxFixture.state.snapshot = [acpxFixture.adapter];
    acpxFixture.state.failDiscovery = false;
    acpxFixture.registryResolve.mockClear();
    await refreshAcpxAdapters({ force: true });
  });

  it("surfaces only the currently discovered ACPX adapter and its opaque registry name", () => {
    expect(listServerAdapters()).toEqual([acpxFixture.adapter]);
    expect(requireServerAdapter(acpxFixture.agentName).definition.launchProfile).toEqual({
      registryName: acpxFixture.agentName,
    });
    expect(
      findSelectableServerAdapterImplementation(acpxFixture.agentName)?.identity,
    ).toMatchObject({
      adapterType: acpxFixture.agentName,
      origin: "builtin",
      packageName: "acpx",
      packageVersion: "runtime",
      buildIdentity: expect.stringMatching(
        new RegExp(`^acpx-runtime:${acpxFixture.agentName}:`),
      ),
      artifactDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(acpxFixture.registryResolve).not.toHaveBeenCalled();
  });

  it("uses the discovered model catalog without assigning Paperclip token limits", async () => {
    const models = await listAdapterModels(acpxFixture.agentName);
    expect(models).toEqual(acpxFixture.adapter.definition.models);
    await expect(resolveAvailableAdapterModel("fixture-model")).resolves.toEqual(
      acpxFixture.adapter.definition.models[0],
    );
  });

  it("replaces a stale snapshot when ACPX no longer reports an agent", async () => {
    acpxFixture.state.snapshot = [];
    await refreshAcpxAdapters({ force: true });

    expect(findServerAdapter(acpxFixture.agentName)).toBeNull();
    expect(() => requireServerAdapter(acpxFixture.agentName)).toThrow(
      /Unknown local agent type/,
    );
  });

  it("fails closed instead of retaining a stale catalog when ACPX reload fails", async () => {
    acpxFixture.state.failDiscovery = true;

    await expect(refreshAcpxAdapters({ force: true })).rejects.toThrow(
      "ACPX registry reload failed",
    );
    expect(findServerAdapter(acpxFixture.agentName)).toBeNull();
    expect(findSelectableServerAdapterImplementation(acpxFixture.agentName)).toBeNull();
  });

  it("quarantines one invalid ACPX candidate without hiding healthy agents", async () => {
    const invalidAgentName = "invalid-agent";
    const invalidAdapter: ServerAdapterModule = {
      ...acpxFixture.adapter,
      type: invalidAgentName,
      definition: {
        ...acpxFixture.adapter.definition,
        launchProfile: { registryName: invalidAgentName },
        configOptions: [{
          ...acpxFixture.adapter.definition.configOptions[0]!,
          values: [{
            ...acpxFixture.adapter.definition.configOptions[0]!.values[0]!,
            label: "Malformed label ",
          }],
        }],
      },
    };
    acpxFixture.state.snapshot = [acpxFixture.adapter, invalidAdapter];

    await expect(refreshAcpxAdapters({ force: true })).resolves.toBeUndefined();

    expect(findServerAdapter(acpxFixture.agentName)).toBe(acpxFixture.adapter);
    expect(findServerAdapter(invalidAgentName)).toBeNull();
    expect(listAcpxAdapterProbeDiagnostics()).toEqual([
      expect.objectContaining({
        type: invalidAgentName,
        code: "acpx_catalog_invalid",
        message: expect.stringContaining("exact non-empty string"),
      }),
    ]);
  });

  it("does not accept Paperclip-owned adapter registrations or override state", () => {
    expect(() => registerServerAdapter(acpxFixture.adapter)).toThrow(
      /discovers compatible local agents/,
    );
    expect(setOverridePaused(acpxFixture.agentName, true)).toBe(false);
    unregisterServerAdapter(acpxFixture.agentName);
    expect(findServerAdapter(acpxFixture.agentName)).toBe(acpxFixture.adapter);
  });
});
