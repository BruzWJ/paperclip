import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  PluginCreatorCallbackHandler,
  PluginRoutinesClient,
} from "../src/index.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  exports: Record<string, unknown>;
  publishConfig: Record<string, unknown>;
  dependencies: Record<string, string>;
};

describe("package surface", () => {
  it("publishes only the four canonical entrypoints", () => {
    expect(Object.keys(packageJson.exports)).toEqual([
      ".",
      "./ui",
      "./testing",
      "./bundlers",
    ]);
    expect(packageJson.publishConfig).not.toHaveProperty("exports");
    expect(packageJson.dependencies).not.toHaveProperty("zod");
  });

  it("does not expose worker-host implementation helpers from the worker SDK", async () => {
    const sdk = await import("../src/index.js");
    expect(sdk.pluginManifestV1Schema).toBeDefined();
    for (const name of [
      "CapabilityDeniedError",
      "InvocationScopeDeniedError",
      "MESSAGE_DELIMITER",
      "createSuccessResponse",
      "isJsonRpcRequest",
      "isJsonRpcErrorResponse",
      "decodePluginPerformActionActorContext",
      "JsonRpcParseError",
    ]) {
      expect(sdk).not.toHaveProperty(name);
    }
  });

  it("exports every client and callback type used by PluginContext", () => {
    expectTypeOf<PluginRoutinesClient>().toHaveProperty("managed");
    expectTypeOf<PluginCreatorCallbackHandler>().toBeFunction();
  });
});
