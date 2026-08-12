import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAcpxAgentNames, probeAcpxAgent } from "./acpx-discovery.js";

const registryMocks = vi.hoisted(() => ({ load: vi.fn() }));
const probeMocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("./agent-registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./agent-registry.js")>(),
  loadAcpxAgentRegistry: registryMocks.load,
}));
vi.mock("./acpx-runtime-readiness.js", () => ({
  probeAcpxRuntimeReadiness: probeMocks.run,
}));

beforeEach(() => {
  registryMocks.load.mockReset();
  probeMocks.run.mockReset();
});

describe("dynamic ACPX discovery", () => {
  it("returns only locally available exact ACPX registry names", async () => {
    registryMocks.load.mockResolvedValue({
      list: () => ["runner-a", "runner-b", "runner-a", " malformed "],
      resolve: () => process.execPath,
    });

    await expect(listAcpxAgentNames(process.cwd())).resolves.toEqual([
      "runner-a",
      "runner-b",
    ]);
    expect(registryMocks.load).toHaveBeenCalledWith(process.cwd());
  });

  it("projects the canonical probe observation without owning runtime lifecycle", async () => {
    probeMocks.run.mockResolvedValue({
      capabilities: {
        controls: ["session/status", "session/set_config_option"],
        configOptionKeys: ["model", "enabled"],
      },
      status: {
        models: {
          currentModelId: "model-a",
          availableModelIds: ["model-a", "model-b", "model-a", " malformed "],
        },
        details: {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              category: "model",
              currentValue: "model-a",
              options: [
                { value: "model-a", name: "Model A" },
                { value: "model-b", name: "Model B" },
              ],
            },
            {
              id: "enabled",
              name: "Enabled",
              type: "boolean",
              currentValue: true,
            },
          ],
        },
      },
    });

    await expect(probeAcpxAgent({
      cwd: "/workspace",
      agentName: "fixture",
      timeoutMs: 4_000,
    })).resolves.toEqual({
      agentName: "fixture",
      controls: ["session/status", "session/set_config_option"],
      configOptionKeys: ["model", "enabled"],
      models: ["model-a", "model-b"],
      currentModelId: "model-a",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "model-a",
          options: [
            { value: "model-a", name: "Model A" },
            { value: "model-b", name: "Model B" },
          ],
        },
        {
          id: "enabled",
          name: "Enabled",
          type: "boolean",
          currentValue: true,
        },
      ],
    });
    expect(probeMocks.run).toHaveBeenCalledWith({
      cwd: "/workspace",
      agentName: "fixture",
      configSelections: [],
      timeoutMs: 4_000,
    });
  });

  it("rejects grouped or otherwise non-native ACPX config options", async () => {
    probeMocks.run.mockResolvedValue({
      capabilities: { controls: [], configOptionKeys: ["model"] },
      status: {
        details: {
          configOptions: [{
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "model-a",
            options: [{
              group: "recommended",
              name: "Recommended",
              options: [{ value: "model-a", name: "Model A" }],
            }],
          }],
        },
      },
    });

    await expect(probeAcpxAgent({
      cwd: "/workspace",
      agentName: "fixture",
    })).rejects.toThrow("ACPX select option value must use exact value and name strings");
  });
});
