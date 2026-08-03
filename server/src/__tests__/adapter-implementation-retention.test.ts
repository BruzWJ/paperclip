import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveApprovedAcpLaunch } from "@paperclipai/adapter-utils/acp-subprocess";
import {
  buildRetainedExternalAdapters,
  loadExternalAdapterPackage,
} from "../adapters/plugin-loader.js";
import {
  attachedAdapterImplementationIdentity,
} from "../adapters/implementation-identity.js";

const originalPaperclipHome = process.env.PAPERCLIP_HOME;
const temporaryRoots: string[] = [];
const launchProfile = resolveApprovedAcpLaunch("codex");

function fixtureSource(label: string): string {
  return `
export function createServerAdapter() {
  return {
    type: "retained_fixture",
    definition: {
      version: "acp-subprocess/v1",
      launchProfile: ${JSON.stringify(launchProfile)},
      environment: {
        cwd: "execution-workspace",
        additionalDirectories: "authorized-workspace-only",
        drivers: ["local", "ssh", "sandbox", "plugin"],
        environmentKeys: []
      },
      readiness: {
        protocolVersion: 1,
        resume: true,
        cancel: true,
        sessionConfig: true,
        sessionScopedMcpReplacement: true,
        cliNativeAuthentication: true
      },
      ui: {
        label: ${JSON.stringify(label)},
        description: "Retained declarative ACP fixture"
      },
      configSchema: {
        fields: [{
          key: "model",
          label: "Model",
          type: "select",
          required: true,
          options: [{ label: "Model", value: "model" }]
        }]
      },
      configOptions: [{
        id: "model",
        configKey: "model",
        label: "Model",
        required: true,
        values: [{ label: "Model", value: "model" }]
      }],
      modelConfigOptionId: "model",
      models: [{
        id: "model",
        label: ${JSON.stringify(label)},
        value: "model",
        limits: { contextTokenLimit: 1000, outputTokenLimit: 100 }
      }],
      modelProfiles: [],
      configurationDoc: "Authenticate through the target CLI."
    }
  };
}
`;
}

function createFixturePackage(root: string, label: string): string {
  const packageDir = path.join(root, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@paperclip-test/retained-fixture",
      version: "1.2.3",
      type: "module",
      exports: { ".": "./index.js" },
    }),
  );
  fs.writeFileSync(path.join(packageDir, "index.js"), fixtureSource(label));
  return packageDir;
}

afterEach(() => {
  if (originalPaperclipHome === undefined) {
    delete process.env.PAPERCLIP_HOME;
  } else {
    process.env.PAPERCLIP_HOME = originalPaperclipHome;
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("external adapter implementation retention", () => {
  it("rejects symlinks that could redirect an unchanged artifact identity", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "paperclip-adapter-symlink-"),
    );
    temporaryRoots.push(root);
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    const packageDir = createFixturePackage(root, "symlink");
    fs.writeFileSync(path.join(root, "outside.js"), "export default 1;\n");
    fs.symlinkSync(
      path.join(root, "outside.js"),
      path.join(packageDir, "redirect.js"),
    );

    await expect(
      loadExternalAdapterPackage(
        "@paperclip-test/retained-fixture",
        packageDir,
      ),
    ).rejects.toThrow(/unsupported symbolic link/i);
  });

  it("materializes same-version content changes as distinct reloadable identities", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "paperclip-adapter-retention-"),
    );
    temporaryRoots.push(root);
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    const packageDir = createFixturePackage(root, "first");

    const first = await loadExternalAdapterPackage(
      "@paperclip-test/retained-fixture",
      packageDir,
    );
    const firstIdentity = attachedAdapterImplementationIdentity(first)!;

    fs.writeFileSync(
      path.join(packageDir, "index.js"),
      fixtureSource("second"),
    );
    const second = await loadExternalAdapterPackage(
      "@paperclip-test/retained-fixture",
      packageDir,
    );
    const secondIdentity = attachedAdapterImplementationIdentity(second)!;

    expect(firstIdentity).toMatchObject({
      adapterType: "retained_fixture",
      packageName: "@paperclip-test/retained-fixture",
      packageVersion: "1.2.3",
      buildIdentity: "@paperclip-test/retained-fixture@1.2.3",
    });
    expect(firstIdentity.artifactDigest).not.toBe(
      secondIdentity.artifactDigest,
    );

    fs.rmSync(packageDir, { recursive: true, force: true });
    const retained = await buildRetainedExternalAdapters();
    expect(retained).toHaveLength(2);
    expect(
      retained
        .map((adapter) => adapter.definition.models[0]?.label)
        .sort(),
    ).toEqual(["first", "second"]);
    expect(
      retained.map(
        (adapter) =>
          attachedAdapterImplementationIdentity(adapter)?.artifactDigest,
      ),
    ).toEqual(
      expect.arrayContaining([
        firstIdentity.artifactDigest,
        secondIdentity.artifactDigest,
      ]),
    );
  });
});
