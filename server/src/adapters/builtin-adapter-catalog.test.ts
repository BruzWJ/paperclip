import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveAcpAdapterRevisionConfiguration,
  validateServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import { BUILTIN_ADAPTER_CATALOG } from "./builtin-adapter-catalog.js";

const adaptersRoot = path.dirname(fileURLToPath(import.meta.url));

describe("built-in declarative ACP adapter catalog", () => {
  it("contains only the canonical Codex adapter", () => {
    expect(
      BUILTIN_ADAPTER_CATALOG.map(
        ({ adapterType, packageName, packageRoot }) => ({
          adapterType,
          packageName,
          packageRoot,
        }),
      ),
    ).toEqual([
      {
        adapterType: "codex",
        packageName: "@paperclipai/server",
        packageRoot: path.join(adaptersRoot, "codex.ts"),
      },
    ]);
  });

  it("exposes data-only, pinned ACP launch/config/model facts", () => {
    const adapter = validateServerAdapterModule(
      BUILTIN_ADAPTER_CATALOG[0]!.adapter,
    );
    expect(Object.keys(adapter).sort()).toEqual(["definition", "type"]);
    expect(adapter.definition).toMatchObject({
      version: "acp-subprocess/v1",
      launchProfile: {
        registryName: "codex",
        frontendPackage: "@agentclientprotocol/codex-acp",
        frontendVersion: "1.1.7",
        frontendDigest: "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a",
      },
      readiness: {
        protocolVersion: 1,
        resume: true,
        cancel: true,
        sessionConfig: true,
        sessionScopedMcpReplacement: true,
        cliNativeAuthentication: true,
      },
    });
    expect(adapter.definition.environment.environmentKeys).toEqual([]);
    expect(adapter.definition.models).toHaveLength(2);

    const selected = resolveAcpAdapterRevisionConfiguration({
      adapter,
      config: { model: "gpt-5.6" },
    });
    expect(selected).toMatchObject({
      contractVersion: "acp-subprocess/v1",
      sessionConfigSelections: [
        { configId: "model", value: "gpt-5.6" },
      ],
      model: {
        id: "gpt-5.6",
        limits: {
          contextTokenLimit: 1_050_000,
          inputTokenLimit: 922_000,
          outputTokenLimit: 128_000,
        },
      },
    });
  });
});
