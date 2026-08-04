import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  listAcpRegistryAdmissionFiles,
  assertExactRegistryCandidate,
  scanAcpRegistryAdmissionFiles,
  type AcpRegistryAdmissionFile,
  type AcpRegistryAdmissionViolation,
} from "./check-acp-registry-admission.ts";

const REGISTRY_PATH =
  "packages/adapter-utils/src/acp-subprocess/agent-registry.ts";
const RUNTIME_EXECUTION_PATH =
  "packages/adapter-utils/src/acp-subprocess/acpx-runtime-execution.ts";
const MANIFEST_PATH = "packages/adapter-utils/package.json";

const canonicalFiles = await listAcpRegistryAdmissionFiles();

function replaceSource(
  files: readonly AcpRegistryAdmissionFile[],
  filePath: string,
  search: string,
  replacement: string,
): AcpRegistryAdmissionFile[] {
  let replaced = false;
  const result = files.map((file) => {
    if (file.path !== filePath) return file;
    assert.ok(
      file.source.includes(search),
      `canonical ${filePath} must contain ${JSON.stringify(search)}`,
    );
    replaced = true;
    return { ...file, source: file.source.replace(search, replacement) };
  });
  assert.ok(replaced, `missing canonical fixture ${filePath}`);
  return result;
}

function editJson(
  files: readonly AcpRegistryAdmissionFile[],
  filePath: string,
  edit: (value: Record<string, any>) => void,
): AcpRegistryAdmissionFile[] {
  const file = files.find((candidate) => candidate.path === filePath);
  assert.ok(file, `missing canonical JSON fixture ${filePath}`);
  const value = JSON.parse(file.source) as Record<string, any>;
  edit(value);
  return files.map((candidate) =>
    candidate.path === filePath
      ? { ...candidate, source: `${JSON.stringify(value, null, 2)}\n` }
      : candidate,
  );
}

function addFile(
  files: readonly AcpRegistryAdmissionFile[],
  file: AcpRegistryAdmissionFile,
): AcpRegistryAdmissionFile[] {
  return [...files, file];
}

function expectViolation(
  files: readonly AcpRegistryAdmissionFile[],
  kind: AcpRegistryAdmissionViolation["kind"],
  description: string,
): void {
  const violations = scanAcpRegistryAdmissionFiles(files);
  assert.ok(
    violations.some((violation) => violation.kind === kind),
    `${description}: expected ${kind}, received ${JSON.stringify(violations)}`,
  );
}

describe("dynamic ACPX registry and dependency pins", () => {
  it("accepts the checked-in ACPX discovery and runtime foundation", () => {
    assert.deepEqual(scanAcpRegistryAdmissionFiles(canonicalFiles), []);
  });

  it("rejects every ACPX/SDK semver range or a Paperclip-selected frontend", () => {
    for (const [packageName, version] of [
      ["@agentclientprotocol/sdk", "^1.3.0"],
      ["acpx", "~0.13.0"],
    ] as const) {
      const mutation = editJson(canonicalFiles, MANIFEST_PATH, (manifest) => {
        manifest.dependencies[packageName] = version;
      });
      expectViolation(mutation, "dependency", `${packageName} ${version}`);
    }
    const selectedFrontend = editJson(canonicalFiles, MANIFEST_PATH, (manifest) => {
      manifest.dependencies["@agentclientprotocol/example-acp-frontend"] = "1.0.0";
    });
    expectViolation(selectedFrontend, "dependency", "selected frontend");
  });

  it("rejects a patched ACPX dependency", () => {
    const mutation = editJson(canonicalFiles, "package.json", (manifest) => {
      manifest.pnpm ??= {};
      manifest.pnpm.patchedDependencies = {
        "acpx@0.13.0": "patches/acpx.patch",
      };
    });
    expectViolation(mutation, "dependency", "patched ACPX");
  });

  it("rejects runtime values outside the registry/discovery owners", () => {
    const mutation = addFile(canonicalFiles, {
      path: "apps/server/src/services/acpx-escape.ts",
      source: 'import { createAcpRuntime } from "acpx/runtime";',
    });
    expectViolation(mutation, "registry_import", "second runtime owner");
  });
});

describe("dynamic ACPX admission", () => {
  it("requires exact ACPX membership before the runtime can receive an agent name", () => {
    const value = assertExactRegistryCandidate({
      submittedName: "locally-available-agent",
      registryNames: ["locally-available-agent"],
    });
    assert.equal(value, "locally-available-agent");
  });

  it("rejects unknown, normalized, or substituted names", () => {
    for (const submittedName of ["unknown", " local-agent", "local-agent ", "Local-Agent"]) {
      assert.throws(() =>
        assertExactRegistryCandidate({
          submittedName,
          registryNames: ["local-agent"],
        }));
    }
  });

  it("rejects an admission helper that loses membership verification", () => {
    expectViolation(
      replaceSource(
        canonicalFiles,
        REGISTRY_PATH,
        "includes(registryName)",
        "includes(anotherName)",
      ),
      "registry_admission",
      "membership guard",
    );
  });
});

describe("ACPX runtime configuration and provider-neutral boundaries", () => {
  it("requires stable ACPX one-shot session config application", () => {
    expectViolation(
      replaceSource(
        canonicalFiles,
        RUNTIME_EXECUTION_PATH,
        "await runtime.setConfigOption?.({",
        "await runtime.legacyConfigOption?.({",
      ),
      "runtime_execution",
      "stable session config",
    );
  });

  it("rejects importing a legacy raw ACP invocation from production server code", () => {
    expectViolation(
      addFile(canonicalFiles, {
        path: "apps/server/src/services/raw-acp-escape.ts",
        source:
          'import { executeAcpSubprocessPrompt } from "@paperclipai/adapter-utils/acp-subprocess";\n',
      }),
      "raw_invocation",
      "raw ACP invocation",
    );
  });

  it("rejects importing a legacy raw ACP launcher type from production server code", () => {
    expectViolation(
      addFile(canonicalFiles, {
        path: "apps/server/src/services/raw-acp-launcher-type-escape.ts",
        source:
          'import type { AcpSubprocessLaunch } from "@paperclipai/adapter-utils/acp-subprocess";\n',
      }),
      "raw_invocation",
      "raw ACP launcher type",
    );
  });

  it("rejects direct imports of a legacy raw ACP subprocess module", () => {
    expectViolation(
      addFile(canonicalFiles, {
        path: "apps/server/src/services/raw-acp-module-escape.ts",
        source:
          'import { PaperclipAcpClient } from "@paperclipai/adapter-utils/acp-subprocess/client";\n',
      }),
      "raw_invocation",
      "raw ACP module",
    );
  });

  it("rejects a Paperclip-owned static catalog or provider parser", () => {
    expectViolation(
      replaceSource(
        canonicalFiles,
        "apps/server/src/adapters/acpx-catalog.ts",
        "acpxDiscoveryToServerAdapter",
        "resolveApprovedAcpLaunch",
      ),
      "catalog",
      "static catalog",
    );
    expectViolation(
      addFile(canonicalFiles, {
        path: "packages/adapter-utils/src/acp-subprocess/provider-jsonl-parser.ts",
        source: "export function parseCodexJsonl() { return null; }",
      }),
      "provider_parser",
      "provider parser",
    );
  });
});
