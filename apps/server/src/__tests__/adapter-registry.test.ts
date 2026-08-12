import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterModel, ServerAdapterModule } from "@paperclipai/adapter-utils";

const acpxFixture = vi.hoisted(() => {
  const agentName = "fixture-agent";
  const model: AdapterModel = Object.freeze({
    value: "fixture-model",
    label: "Fixture model",
  });
  const adapter: ServerAdapterModule = Object.freeze({
    type: agentName,
    definition: Object.freeze({
      version: "acpx-runtime/v1",
      launchProfile: Object.freeze({ registryName: agentName }),
      runtime: Object.freeze({
        controls: Object.freeze(["session/status", "session/set_config_option"]),
      }),
      ui: Object.freeze({
        label: agentName,
      }),
      configOptions: Object.freeze([
        Object.freeze({
          id: "model",
          label: "Model",
          type: "select" as const,
          values: Object.freeze([
            Object.freeze({ label: model.label, value: model.value }),
          ]),
          currentValue: model.value,
        }),
      ]),
      modelConfigOptionId: "model",
      models: Object.freeze([model]),
    }),
  });
  return Object.freeze({
    agentName,
    adapter,
    state: {
      snapshot: [adapter] as ServerAdapterModule[],
      failDiscovery: false,
    },
  });
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
  findServerAdapter,
  listServerAdapters,
  refreshAcpxAdapters,
} = await import("../adapters/registry.js");

describe("ACPX-supplied server adapter registry", () => {
  beforeEach(async () => {
    acpxFixture.state.snapshot = [acpxFixture.adapter];
    acpxFixture.state.failDiscovery = false;
    await refreshAcpxAdapters({ force: true });
  });

  it("surfaces only the currently discovered ACPX adapter and its opaque registry name", () => {
    expect(listServerAdapters()).toEqual([acpxFixture.adapter]);
    expect(findServerAdapter(acpxFixture.agentName)?.definition.launchProfile).toEqual({
      registryName: acpxFixture.agentName,
    });
  });

  it("replaces a stale snapshot when ACPX no longer reports an agent", async () => {
    acpxFixture.state.snapshot = [];
    await refreshAcpxAdapters({ force: true });

    expect(findServerAdapter(acpxFixture.agentName)).toBeNull();
  });

  it("fails closed instead of retaining a stale catalog when ACPX reload fails", async () => {
    acpxFixture.state.failDiscovery = true;

    await expect(refreshAcpxAdapters({ force: true })).rejects.toThrow(
      "ACPX registry reload failed",
    );
    expect(findServerAdapter(acpxFixture.agentName)).toBeNull();
  });
});
