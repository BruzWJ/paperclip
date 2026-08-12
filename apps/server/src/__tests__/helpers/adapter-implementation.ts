import type { AcpxAdapterDefinition } from "@paperclipai/adapter-utils";

/** A test-only ACPX discovery result; production never reads this fixture. */
export const CANONICAL_TEST_ADAPTER_TYPE = "fixture-agent";

export const CANONICAL_TEST_ADAPTER_DEFINITION: AcpxAdapterDefinition =
  Object.freeze({
    version: "acpx-runtime/v1",
    launchProfile: Object.freeze({
      registryName: CANONICAL_TEST_ADAPTER_TYPE,
    }),
    runtime: Object.freeze({
      controls: Object.freeze(["session/status", "session/set_config_option"]),
    }),
    ui: Object.freeze({
      label: "Fixture agent",
    }),
    configOptions: Object.freeze([
      Object.freeze({
        id: "model",
        label: "Model",
        type: "select" as const,
        values: Object.freeze([
          Object.freeze({ label: "Fixture model", value: "fixture-model" }),
        ]),
        currentValue: "fixture-model",
      }),
    ]),
    modelConfigOptionId: "model",
    models: Object.freeze([
      Object.freeze({
        value: "fixture-model",
        label: "Fixture model",
      }),
    ]),
  });

export function canonicalTestAdapterConfig() {
  return { model: "fixture-model" };
}
