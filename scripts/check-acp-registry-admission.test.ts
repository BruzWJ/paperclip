import assert from "node:assert/strict";
// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: createAcpRuntime
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import {
  listAcpRegistryAdmissionFiles,
  resolveExactRegistryCandidate,
  scanAcpRegistryAdmissionFiles,
  type AcpRegistryAdmissionFile,
  type AcpRegistryAdmissionViolation,
} from "./check-acp-registry-admission.ts";
import {
  resolveApprovedAcpNativeAuthentication,
  resolveApprovedAcpLaunch,
} from "../packages/adapter-utils/src/acp-subprocess/agent-registry.ts";

const REGISTRY_PATH =
  "packages/adapter-utils/src/acp-subprocess/agent-registry.ts";
const CLIENT_PATH =
  "packages/adapter-utils/src/acp-subprocess/client.ts";
const PROCESS_PATH =
  "packages/adapter-utils/src/acp-subprocess/process.ts";
const EXECUTION_TARGET_PATH =
  "packages/adapter-utils/src/acp-subprocess/execution-target.ts";
const RUN_TOOLS_PATH =
  "packages/adapter-utils/src/acp-subprocess/run-tools.ts";
const EVENTS_PATH =
  "packages/adapter-utils/src/acp-subprocess/events.ts";
const TOOL_OUTPUT_PATH =
  "packages/adapter-utils/src/acp-subprocess/tool-output.ts";
const CODEX_ACP_CONFORMANCE_PATH =
  "packages/adapter-utils/src/acp-subprocess/codex-acp.conformance.test.ts";
const CODEX_APP_SERVER_FIXTURE_PATH =
  "packages/adapter-utils/src/acp-subprocess/fixtures/codex-app-server-conformance.mjs";
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
    return {
      ...file,
      source: file.source.replace(search, replacement),
    };
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

function replaceAllSource(
  files: readonly AcpRegistryAdmissionFile[],
  filePath: string,
  search: string,
  replacement: string,
): AcpRegistryAdmissionFile[] {
  const file = files.find((candidate) => candidate.path === filePath);
  assert.ok(file, `missing canonical fixture ${filePath}`);
  assert.ok(
    file.source.includes(search),
    `canonical ${filePath} must contain ${JSON.stringify(search)}`,
  );
  return files.map((candidate) =>
    candidate.path === filePath
      ? {
          ...candidate,
          source: candidate.source.split(search).join(replacement),
        }
      : candidate,
  );
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

describe("canonical ACP registry and dependency pins", () => {
  it("accepts the checked-in official-SDK/registry-only foundation", () => {
    assert.deepEqual(scanAcpRegistryAdmissionFiles(canonicalFiles), []);
  });

  it("rejects every semver range or version drift", () => {
    for (const [packageName, version] of [
      ["@agentclientprotocol/sdk", "^1.3.0"],
      ["acpx", "~0.13.0"],
      ["@agentclientprotocol/codex-acp", "1.1.x"],
    ] as const) {
      const mutation = editJson(canonicalFiles, MANIFEST_PATH, (manifest) => {
        manifest.dependencies[packageName] = version;
      });
      expectViolation(
        mutation,
        "dependency",
        `${packageName} ${version}`,
      );
    }
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

  it("rejects an importer lockfile version drift", () => {
    const mutation = replaceSource(
      canonicalFiles,
      "pnpm-lock.yaml",
      "      acpx:\n        specifier: 0.13.0\n        version: 0.13.0",
      "      acpx:\n        specifier: ^0.13.0\n        version: 0.13.1",
    );
    expectViolation(mutation, "dependency", "lockfile drift");
  });

  it("rejects ACPX runtime imports and imports outside the sole wrapper", () => {
    const runtimeMutation = replaceSource(
      canonicalFiles,
      REGISTRY_PATH,
      "createAgentRegistry, type AcpAgentRegistry",
      "createAgentRegistry, createAcpRuntime, type AcpAgentRegistry",
    );
    expectViolation(
      runtimeMutation,
      "registry_import",
      "ACPX runtime symbol",
    );

    const secondImport = addFile(canonicalFiles, {
      path: "server/src/services/acpx-escape.ts",
      source: 'import { createAgentRegistry } from "acpx/runtime";',
    });
    expectViolation(
      secondImport,
      "registry_import",
      "second ACPX importer",
    );
  });
});

describe("canonical ACP execution-target boundary", () => {
  it("rejects a missing target-neutral subprocess factory", () => {
    expectViolation(
      canonicalFiles.filter(
        (file) => file.path !== EXECUTION_TARGET_PATH,
      ),
      "execution_target",
      "missing execution-target factory",
    );
  });

  it("rejects target transport, cwd-fence, materialization, and cleanup mutations", () => {
    for (const [search, replacement, description] of [
      [
        "buildSshSpawnTarget",
        "disabledSshSpawnTarget",
        "SSH target bypass",
      ],
      [
        "startAdapterExecutionTargetProcessSessionBridge",
        "disabledProcessSessionBridge",
        "sandbox/plugin target bypass",
      ],
      [
        "materializeAdapterExecutionTargetTextFiles",
        "disabledTargetTextFileMaterialization",
        "target file materialization bypass",
      ],
      [
        "readApprovedAcpFrontendArtifact",
        "disabledApprovedFrontendRead",
        "source artifact verification bypass",
      ],
      [
        "resolveTargetNodeExecutable",
        "disabledTargetNodeResolution",
        "target Node resolution bypass",
      ],
      [
        "verifyTargetFrontendArtifact",
        "disabledTargetFrontendVerification",
        "target frontend digest bypass",
      ],
      [
        "targetArgs: [targetFrontendEntrypoint]",
        "targetArgs: launch.launch.args",
        "worker-local launch lowering",
      ],
      [
        "launch.cwd !== targetCwd",
        "false",
        "target cwd fence removal",
      ],
      [
        "async function finishWithCleanup",
        "async function finishWithoutTargetCleanup",
        "target cleanup boundary removal",
      ],
    ] as const) {
      expectViolation(
        replaceAllSource(
          canonicalFiles,
          EXECUTION_TARGET_PATH,
          search,
          replacement,
        ),
        "execution_target",
        description,
      );
    }
  });

  it("rejects worker-local Node for request-scoped run-tools", () => {
    expectViolation(
      replaceSource(
        canonicalFiles,
        RUN_TOOLS_PATH,
        "input.nodeExecutable",
        "process.execPath",
      ),
      "execution_target",
      "worker-local run-tools Node",
    );
  });

  it("rejects a production dependency-injection escape around target preparation", () => {
    expectViolation(
      replaceSource(
        canonicalFiles,
        EXECUTION_TARGET_PATH,
        "const DEFAULT_TARGET_CLEANUP_TIMEOUT_MS = 5_000;",
        "const DEFAULT_TARGET_CLEANUP_TIMEOUT_MS = 5_000;\ninterface AcpExecutionTargetSubprocessDependencies {}",
      ),
      "execution_target",
      "injectable target transport",
    );
  });

  it("requires the distinct prepared real-frontend conformance suite", () => {
    expectViolation(
      canonicalFiles.filter(
        (file) => file.path !== CODEX_ACP_CONFORMANCE_PATH,
      ),
      "installed_runtime",
      "missing real codex-acp suite",
    );
    expectViolation(
      replaceAllSource(
        canonicalFiles,
        CODEX_ACP_CONFORMANCE_PATH,
        "prepareAcpExecutionTargetSubprocess",
        "bypassAcpExecutionTargetSubprocess",
      ),
      "installed_runtime",
      "real frontend target-preparation bypass",
    );
    expectViolation(
      replaceAllSource(
        canonicalFiles,
        CODEX_APP_SERVER_FIXTURE_PATH,
        '"turn/interrupt"',
        '"turn/interrupt-disabled"',
      ),
      "installed_runtime",
      "native cancellation fixture removal",
    );
  });
});

describe("byte-exact registry admission", () => {
  it("resolves exact codex to the installed immutable frontend argv", () => {
    const anchoredRequire = createRequire(
      new URL("../packages/adapter-utils/package.json", import.meta.url),
    );
    const entrypoint = anchoredRequire.resolve(
      "@agentclientprotocol/codex-acp",
    );
    let resolveCalls = 0;
    const launch = resolveApprovedAcpLaunch("codex", {
      list: () => ["codex"],
      resolve: (name) => {
        resolveCalls += 1;
        assert.equal(name, "codex");
        return [process.execPath, entrypoint];
      },
    });
    assert.equal(resolveCalls, 1);
    assert.equal(launch.targetNativeCli, "codex");
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [entrypoint]);
    assert.equal(launch.frontendPackage, "@agentclientprotocol/codex-acp");
    assert.equal(launch.frontendVersion, "1.1.7");
    assert.equal(launch.frontendDigest, "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a");
    assert.deepEqual(resolveApprovedAcpNativeAuthentication(launch), {
      statusArgs: ["login", "status"],
      loginGuidance: "codex login",
    });
  });

  it("rejects unknown, whitespace, case, punctuation, and uncataloged aliases before resolve", () => {
    for (const submittedName of [
      "unknown",
      " codex",
      "codex ",
      "Codex",
      "codex!",
      "code",
    ]) {
      let resolveCalls = 0;
      assert.throws(() =>
        resolveApprovedAcpLaunch(submittedName, {
          list: () => ["codex", submittedName],
          resolve: () => {
            resolveCalls += 1;
            return [process.execPath, "/must-not-run"];
          },
        }),
      );
      assert.equal(resolveCalls, 0, submittedName);
    }
  });

  it("admits a fixture-only alias only as independent closed data", () => {
    let resolveCalls = 0;
    const result = resolveExactRegistryCandidate({
      submittedName: "codex-reviewed",
      registryNames: ["codex", "codex-reviewed"],
      approvedNames: ["codex", "codex-reviewed"],
      resolve: (unchangedName) => {
        resolveCalls += 1;
        return unchangedName;
      },
    });
    assert.equal(result, "codex-reviewed");
    assert.equal(resolveCalls, 1);

    resolveCalls = 0;
    assert.throws(() =>
      resolveExactRegistryCandidate({
        submittedName: "codex-reviewed",
        registryNames: ["codex", "codex-reviewed"],
        approvedNames: ["codex"],
        resolve: () => {
          resolveCalls += 1;
          return "unexpected";
        },
      }),
    );
    assert.equal(resolveCalls, 0);
  });

  it("rejects normalization, early resolution, and raw-command escapes", () => {
    const mutations = [
      replaceSource(
        canonicalFiles,
        REGISTRY_PATH,
        "candidateRegistry.resolve(requestedName)",
        "candidateRegistry.resolve(requestedName.trim())",
      ),
      replaceSource(
        canonicalFiles,
        REGISTRY_PATH,
        "if (!listed.includes(requestedName) || !approved)",
        "if (!approved)",
      ),
      replaceSource(
        canonicalFiles,
        REGISTRY_PATH,
        "const listed = candidateRegistry.list();",
        "const listed = candidateRegistry.list();\n  candidateRegistry.resolve(requestedName);",
      ),
    ];
    for (const mutation of mutations) {
      expectViolation(
        mutation,
        "registry_admission",
        "registry admission mutation",
      );
    }

    expectViolation(
      replaceSource(
        canonicalFiles,
        REGISTRY_PATH,
        "const codexLaunchArgv = Object.freeze([process.execPath, codexAcpEntrypoint]);",
        'const codexLaunchArgv = Object.freeze(["npx", "@agentclientprotocol/codex-acp@^1"]);',
      ),
      "raw_command",
      "npx raw command",
    );
    expectViolation(
      replaceSource(
        canonicalFiles,
        REGISTRY_PATH,
        "const registry = createAgentRegistry({",
        "const registry = createAgentRegistry({ shell: true,",
      ),
      "raw_command",
      "shell launch",
    );
  });

  it("rejects removal of installed-entrypoint and resolved-argv verification", () => {
    expectViolation(
      replaceSource(
        canonicalFiles,
        REGISTRY_PATH,
        "require.resolve(CODEX_ACP_FRONTEND_PACKAGE)",
        '"/tmp/codex-acp"',
      ),
      "registry_admission",
      "literal frontend path",
    );
    expectViolation(
      replaceSource(
        canonicalFiles,
        REGISTRY_PATH,
        "sameArgv(resolved, expected)",
        "resolved.length > 0",
      ),
      "registry_admission",
      "unverified registry argv",
    );
  });
});

describe("official ACP client and stream boundary", () => {
  it("rejects deprecated client and session load/fork mutations", () => {
    for (const mutation of [
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "export class PaperclipAcpClient",
        "const legacyClient = ClientSideConnection;\nexport class PaperclipAcpClient",
      ),
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "methods.agent.session.resume",
        "methods.agent.session.load",
      ),
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "methods.agent.session.resume",
        "methods.agent.session.fork",
      ),
    ]) {
      expectViolation(
        mutation,
        "official_client",
        "deprecated official-client mutation",
      );
    }
  });

  it("rejects advertised filesystem, terminal, and experimental plan capabilities", () => {
    for (const capability of [
      "plan: true,",
      "fs: { readTextFile: true },",
      "terminal: true,",
    ]) {
      const mutation = replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "clientCapabilities: {",
        `clientCapabilities: { ${capability}`,
      );
      expectViolation(
        mutation,
        "client_capability",
        capability,
      );
    }
    const missingSessionCapability = replaceSource(
      canonicalFiles,
      CLIENT_PATH,
      "session: { configOptions: { boolean: {} } },",
      "",
    );
    expectViolation(
      missingSessionCapability,
      "client_capability",
      "missing stable session config capability",
    );
  });

  it("rejects optional config selections and nonterminal usage settlement", () => {
    expectViolation(
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "if (values.length === 0)",
        "if (values.length < 0)",
      ),
      "official_client",
      "empty config selections",
    );
    expectViolation(
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        'event?.kind === "usage"',
        "event != null",
      ),
      "official_client",
      "non-usage terminal settlement",
    );
  });

  it("requires target-neutral process injection and the pre-prompt activation fence", () => {
    expectViolation(
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "subprocess = await input.startSubprocess(input.launch",
        "subprocess = spawnAcpSubprocess(input.launch",
      ),
      "official_client",
      "hard-coded local subprocess start",
    );
    expectViolation(
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "await input.activatePrompt({ sessionId })",
        "void sessionId",
      ),
      "official_client",
      "missing prompt activation fence",
    );
    expectViolation(
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "await input.beginPromptTransmission({ sessionId })",
        "void sessionId",
      ),
      "official_client",
      "missing durable prompt-transmission fence",
    );
    expectViolation(
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "await input.beginPromptTransmission({ sessionId });\n    promptTransmitted = true;",
        "promptTransmitted = true;\n    await input.beginPromptTransmission({ sessionId });",
      ),
      "official_client",
      "prompt transmission ordering drift",
    );
    expectViolation(
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "await input.closePrompt(closureOutcome)",
        "void closureOutcome",
      ),
      "official_client",
      "missing pre-cleanup prompt closure fence",
    );
    expectViolation(
      replaceSource(
        canonicalFiles,
        CLIENT_PATH,
        "cancellationForceTimer = setTimeout",
        "void setTimeout",
      ),
      "official_client",
      "missing bounded cancellation settlement",
    );
    expectViolation(
      replaceSource(
        canonicalFiles,
        PROCESS_PATH,
        "export function spawnPreparedAcpSubprocess",
        "export function spawnAcpSubprocess",
      ),
      "official_client",
      "public local-only ACP starter",
    );
  });

  it("rejects direct Node-stream casts and direct Node streams passed to ndJsonStream", () => {
    const castMutation = replaceSource(
      canonicalFiles,
      PROCESS_PATH,
      "const input = Readable.toWeb(child.stdout);",
      "const input = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;",
    );
    expectViolation(castMutation, "stream_bridge", "direct bridge cast");

    const directMutation = replaceSource(
      canonicalFiles,
      PROCESS_PATH,
      "ndJsonStream(output, input)",
      "ndJsonStream(child.stdin, child.stdout)",
    );
    expectViolation(
      directMutation,
      "stream_bridge",
      "direct Node stream transport",
    );
  });

  it("rejects experimental named-plan acceptance", () => {
    const mutation = replaceSource(
      canonicalFiles,
      EVENTS_PATH,
      'case "plan_removed":',
      'case "plan_removed_accepted":',
    );
    expectViolation(
      mutation,
      "experimental_plan",
      "experimental plan acceptance",
    );
  });

  it("rejects ACP tool-output ordering and text-join drift", () => {
    expectViolation(
      replaceSource(
        canonicalFiles,
        TOOL_OUTPUT_PATH,
        "Object.keys(record).sort(codeUnitCompare)",
        "Object.keys(record)",
      ),
      "tool_output",
      "unsorted canonical JSON object keys",
    );
    expectViolation(
      replaceSource(
        canonicalFiles,
        TOOL_OUTPUT_PATH,
        'content.map((entry) => entry.content.text).join("\\n")',
        'content.map((entry) => entry.content.text).join("")',
      ),
      "tool_output",
      "non-newline text fallback join",
    );
  });

  it("rejects provider-specific parsers in the closed ACP directory", () => {
    const mutation = addFile(canonicalFiles, {
      path: "packages/adapter-utils/src/acp-subprocess/codex-jsonl-parser.ts",
      source: `
        export function parseCodexJsonl(line: string) {
          return JSON.parse(line);
        }
      `,
    });
    expectViolation(
      mutation,
      "provider_parser",
      "provider-specific JSONL parser",
    );
  });
});
