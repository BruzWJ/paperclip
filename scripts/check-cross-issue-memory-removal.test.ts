import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  ACPX_STATE_TERMS,
  DIRECT_RETIRED_TOKENS,
  assertCrossIssueMemoryRemoval,
  crossIssueMemoryRemovalViolations,
  scanCrossIssueMemoryRemovalFiles,
} from "./check-cross-issue-memory-removal.ts";

const roots = new Set<string>();

function write(root: string, path: string, source: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-cross-memory-gate-"));
  roots.add(root);
  write(
    root,
    "packages/db/schema/agent_runtime_state.ts",
    [
      'export const table = "agent_runtime_state";',
      "export const fields = {",
      "  lastRunId: null,",
      "  lastContextUsedTokens: null,",
      "  lastContextWindowTokens: null,",
      "  peakContextUsedTokens: 0,",
      "  aggregateKnownCostAmount: '0',",
      "  unpricedPromptCount: 0,",
      "};",
    ].join("\n"),
  );
  write(
    root,
    "packages/shared/src/validators/agent-adapter-revision.ts",
    [
      "const z = { literal: (value: string) => value };",
      "export const agentAdapterAcpConfigurationSchema =",
      '  z.literal("acp-subprocess/v1");',
      "const sessionConfigSelections = [];",
      "const closed = '.strict()';",
    ].join("\n"),
  );
  write(
    root,
    "packages/adapter-utils/src/acp-subprocess/agent-registry.ts",
    [
      'import { createAgentRegistry, type AcpAgentRegistry } from "acpx/runtime";',
      "export function resolveApprovedAcpLaunch(registry: AcpAgentRegistry) {",
      "  return createAgentRegistry(registry);",
      "}",
    ].join("\n"),
  );
  write(
    root,
    "packages/adapter-utils/src/acp-subprocess/correlation.ts",
    [
      'export const kind = "acp-session/v1";',
      "export interface AcpSessionCorrelation {",
      "  sessionId: string;",
      "}",
    ].join("\n"),
  );
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts the canonical accounting, registry-only, and opaque-correlation owners", () => {
  const root = fixtureRoot();
  write(
    root,
    "packages/shared/src/telemetry/state.ts",
    "export function loadTelemetry(stateDir: string) { return stateDir; }\n",
  );
  write(
    root,
    "server/src/services/durable-audit.ts",
    "export const persistent = true;\n",
  );
  write(
    root,
    "packages/provider-native/runtime.ts",
    "export const nativeRecord = { sessionId: 'opaque-provider-value' };\n",
  );
  write(
    root,
    "server/src/provider-environment.ts",
    "export const env = { CODEX_HOME: operatorEnvironment.CODEX_HOME };\n",
  );
  assert.deepEqual(crossIssueMemoryRemovalViolations(root), []);
});

for (const token of DIRECT_RETIRED_TOKENS) {
  test(`rejects exact retired identifier ${token}`, () => {
    const violations = scanCrossIssueMemoryRemovalFiles([
      {
        path: "server/src/legacy.ts",
        source: `export const retired = ${JSON.stringify(token)};`,
      },
    ]);
    assert.ok(
      violations.some((violation) => violation.term === token),
      `expected ${token} to fail`,
    );
  });
}

test("rejects each ACPX state symbol only inside the ACPX runtime graph", () => {
  for (const term of ACPX_STATE_TERMS) {
    const violations = scanCrossIssueMemoryRemovalFiles([
      {
        path: "packages/adapter-utils/src/acpx-engine/runtime.ts",
        source: `import { createAgentRegistry } from "acpx/runtime";\nconst value = { ${term}: true };`,
      },
    ]);
    assert.ok(
      violations.some((violation) => violation.term === term),
      `expected ACPX ${term} to fail`,
    );
  }
});

test("rejects aliased access to an ACPX stateful runtime export", () => {
  const violations = scanCrossIssueMemoryRemovalFiles([
    {
      path: "packages/adapter-utils/src/acp-subprocess/runtime-wrapper.ts",
      source:
        'import { createFileSessionStore as makeStore } from "acpx/runtime";\nexport const store = makeStore();',
    },
  ]);
  assert.ok(
    violations.some((violation) =>
      violation.reason.includes("stateful runtime import"),
    ),
  );
});

for (const [provider, source] of [
  ["openclaw", "const options = { sessionKey: issueId };"],
  ["hermes", "const argv = ['--resume', opaqueId];"],
  ["cursor", "const argv = ['--resume', opaqueId];"],
  ["grok", "const argv = ['--resume', opaqueId];"],
  ["gemini", "const argv = ['--resume', opaqueId];"],
  ["claude", "const argv = ['--session-id', opaqueId];"],
  ["pi", "const argv = ['--session', opaqueId];"],
  ["opencode", "const argv = ['--session', opaqueId];"],
  ["codex", "const argv = ['resume', nativeSessionId];"],
] as const) {
  test(`rejects ${provider} provider-specific continuation lowering`, () => {
    const violations = scanCrossIssueMemoryRemovalFiles([
      {
        path: `packages/adapters/${provider}/src/execute.ts`,
        source,
      },
    ]);
    assert.ok(violations.length > 0, `expected ${provider} to fail`);
  });
}

test("rejects renamed provider continuation builders and result correlation", () => {
  const violations = scanCrossIssueMemoryRemovalFiles([
    {
      path: "packages/adapters/gemini/src/args.ts",
      source: "export function buildProviderSessionArguments() { return []; }",
    },
    {
      path: "packages/adapter-utils/src/types.ts",
      source:
        "interface AdapterExecutionResult { nativeCorrelation?: unknown }",
    },
  ]);
  assert.ok(
    violations.some((violation) =>
      violation.term === "provider-continuation-builder"),
  );
  assert.ok(
    violations.some((violation) =>
      violation.term === "AdapterExecutionResult.nativeCorrelation"),
  );
});

test("rejects a renamed parsed provider-session result branch", () => {
  const violations = scanCrossIssueMemoryRemovalFiles([
    {
      path: "packages/adapters/cursor/src/result.ts",
      source: [
        "const response = JSON.parse(stdout);",
        "const conversationId = response.agent.id;",
        "return { correlation: { conversationId } };",
      ].join("\n"),
    },
  ]);
  assert.ok(
    violations.some(
      (violation) => violation.term === "provider-parsed-session-result",
    ),
  );
});

test("rejects every legacy consumer class instead of checking only old filenames", () => {
  for (const path of [
    "packages/db/schema/runtime.ts",
    "packages/shared/src/validators/adapter.ts",
    "server/src/routes/agents.ts",
    "server/src/routes/openapi.ts",
    "cli/src/generated/client.ts",
    "ui/src/pages/AgentDetail.tsx",
    "skills/onboarding/AGENTS.md",
    "evals/promptfoo/tests/runtime.yaml",
    "docs/adapters/overview.md",
    "releases/v1.md",
  ]) {
    const violations = scanCrossIssueMemoryRemovalFiles([
      { path, source: "const legacy = 'sessionParams';" },
    ]);
    assert.ok(violations.length > 0, `expected ${path} to fail`);
  }
});

test("rejects a wildcard-loaded removed memory eval and removed asset path", () => {
  const violations = scanCrossIssueMemoryRemovalFiles([
    {
      path: "evals/promptfoo/promptfooconfig.yaml",
      source: "tests: tests/*.yaml\n",
    },
    {
      path: "evals/promptfoo/tests/phase5-memory-control-surfaces.yaml",
      source: "description: old memory evaluation\n",
    },
  ]);
  assert.ok(
    violations.some((violation) => violation.term === "removed-memory-asset"),
  );
});

test("rejects a hidden AGENTS or HEARTBEAT memory mandate", () => {
  for (const path of ["fixtures/AGENTS.md", "fixtures/HEARTBEAT.md"]) {
    const violations = scanCrossIssueMemoryRemovalFiles([
      {
        path,
        source: "You must recall saved memory before every task.",
      },
    ]);
    assert.ok(
      violations.some((violation) => violation.term === "memory-mandate"),
      `expected ${path} to fail`,
    );
  }
});

test("rejects Paperclip-managed provider homes but accepts opaque operator environment", () => {
  assert.ok(
    scanCrossIssueMemoryRemovalFiles([
      {
        path: "docs/legacy-provider-home.md",
        source: "Paperclip stages auth.json and skills beneath CODEX_HOME.",
      },
    ]).some((violation) => violation.term === "CODEX_HOME"),
  );
  assert.deepEqual(
    scanCrossIssueMemoryRemovalFiles([
      {
        path: "server/src/provider-environment.ts",
        source: "const child = { CODEX_HOME: input.env.CODEX_HOME };",
      },
      {
        path: "docs/operator-provider-home.md",
        source: [
          "The operator owns CODEX_HOME, including native auth.json and skills.",
          'Run mkdir -p "$CODEX_HOME" before starting Paperclip if needed.',
        ].join("\n"),
      },
    ]),
    [],
  );
});

test("allows only explicitly marker-scoped negative removal fixtures", () => {
  const marked = scanCrossIssueMemoryRemovalFiles([
    {
      path: "packages/shared/src/rejected-config.test.ts",
      source: [
        "// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: sessionParams",
        "expect(parse({ sessionParams: {} })).toFail();",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(marked, []);

  const unmarked = scanCrossIssueMemoryRemovalFiles([
    {
      path: "packages/shared/src/legacy-allowlist.test.ts",
      source: "expect(parse({ sessionParams: {} })).toFail();",
    },
  ]);
  assert.ok(unmarked.length > 0);
});

test("the repository satisfies the complete cross-issue-memory removal gate", () => {
  assert.doesNotThrow(() => assertCrossIssueMemoryRemoval());
});
