import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { invocationSurfaceRemovalViolations } from "./check-invocation-surface-removal.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-invocation-gate-"));
  roots.add(root);
  write(
    root,
    "apps/server/src/services/adapter-configuration-preflight.ts",
    [
      "declare function probeAcpxRuntimeReadiness(): unknown;",
      "declare function resolveCompanySkillMaterializationRevisionInTransaction(): unknown;",
      "declare function createIssueExecutionTargetAcquirer(): unknown;",
      "const agentAdapterAcpConfigurationSchema = { parse: (value: unknown) => value };",
      "const currentAdapterConfigRevisionId = 'revision';",
      "const executionWorkspaceBindingId = 'binding';",
      "const executionTarget = { kind: \"local\" };",
      "const acquired = { release() {} };",
      "async function loadExactBinding() { return { currentAdapterConfigRevisionId, executionWorkspaceBindingId }; }",
      "export function createPostgresAdapterConfigurationPreflightService() {",
      "  agentAdapterAcpConfigurationSchema.parse({});",
      "  resolveCompanySkillMaterializationRevisionInTransaction();",
      "  createIssueExecutionTargetAcquirer();",
      "  probeAcpxRuntimeReadiness({ registryCwd: process.cwd() });",
      "  if (executionTarget.kind !== \"local\") return { status: \"incomplete\" };",
      "  acquired.release();",
      "  return Math.random() > 0.5 ? { status: \"ready\" } : { status: \"incomplete\" };",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts disposable ACPX runtime readiness", () => {
  assert.deepEqual(invocationSurfaceRemovalViolations(fixtureRoot()), []);
});

for (const token of [
  "testEnvironment",
  "Respond with hello.",
  "onHireApproved",
  "HireApprovedPayload",
  "HireApprovedHookResult",
  "hire-hook.ts",
  "notifyHireApproved",
  "AdapterRuntimeConfigurationPreflight",
  "preflightRegisteredAdapterRuntimeConfiguration",
  "preflightExplicitAdapterConfiguration",
  "useAdapterRuntimeConfigurationPreflight",
  "useExplicitAdapterConfiguration",
  "/configuration-preflight",
] as const) {
  test(`rejects retired invocation surface ${token}`, () => {
    const root = fixtureRoot();
    write(root, "apps/server/src/adapters/retired.ts", `export const retired = ${JSON.stringify(token)};\n`);
    assert.ok(
      invocationSurfaceRemovalViolations(root).some((violation) =>
        violation.includes(token),
      ),
    );
  });
}

test("rejects a model-producing adapter readiness module by path", () => {
  const root = fixtureRoot();
  write(
    root,
    "packages/adapters/codex/src/server/test.ts",
    "export async function probe() {}\n",
  );
  assert.ok(
    invocationSurfaceRemovalViolations(root).some((violation) =>
      violation.includes("model-producing adapter readiness module"),
    ),
  );
});

for (const effect of [
  ".insert(",
  ".update(",
  ".delete(",
  "issueExecutionRefs",
  "issueSession",
  "nativeCorrelation",
  "transcript",
  "executeAcpSubprocessPrompt",
  "prepareAcpExecutionTargetSubprocess",
  "spawnPreparedAcpSubprocess",
  "createInitializeOnlyClient",
  "runTargetProcess",
  "targetNativeExecutable",
  "closeAndReap",
  "disposeBeforeStart",
  "resolveApprovedAcpNativeAuthentication",
  "resolveAdapterExecutionTargetNativeIdentityEnvironment",
  "startSession",
  "newSession",
  "resumeSession",
  "promptSession",
  "session/new",
  "session/resume",
  "session/prompt",
  "createIssueExecutionRun",
  "modelProbe",
  "model probe",
  "Respond with",
] as const) {
  test(`rejects productive preflight effect ${effect}`, () => {
    const root = fixtureRoot();
    write(
      root,
      "apps/server/src/services/adapter-configuration-preflight.ts",
      [
        "declare function probeAcpxRuntimeReadiness(): unknown;",
        "declare function resolveCompanySkillMaterializationRevisionInTransaction(): unknown;",
        "declare function createIssueExecutionTargetAcquirer(): unknown;",
        "const agentAdapterAcpConfigurationSchema = { parse: (value: unknown) => value };",
        "const currentAdapterConfigRevisionId = 'revision';",
        "const executionWorkspaceBindingId = 'binding';",
        "const executionTarget = { kind: \"local\" };",
        "const acquired = { release() {} };",
        "async function loadExactBinding() { return { currentAdapterConfigRevisionId, executionWorkspaceBindingId }; }",
        "export function createPostgresAdapterConfigurationPreflightService() {",
        `  const forbidden = ${JSON.stringify(effect)};`,
        "  agentAdapterAcpConfigurationSchema.parse({});",
        "  resolveCompanySkillMaterializationRevisionInTransaction(); createIssueExecutionTargetAcquirer();",
        "  probeAcpxRuntimeReadiness({ registryCwd: process.cwd() });",
        "  if (executionTarget.kind !== \"local\") return { status: \"incomplete\" };",
        "  acquired.release();",
        "  return forbidden ? { status: \"ready\" } : { status: \"incomplete\" };",
        "}",
      ].join("\n"),
    );
    assert.ok(
      invocationSurfaceRemovalViolations(root).some((violation) =>
        violation.includes("forbidden productive effect"),
      ),
    );
  });
}

test("allows a marked removal assertion but rejects an unmarked test", () => {
  const root = fixtureRoot();
  write(
    root,
    "scripts/adapter-contract.test.ts",
    [
      "// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: testEnvironment, onHireApproved",
      "const removed = ['testEnvironment', 'onHireApproved'];",
      "",
    ].join("\n"),
  );
  assert.deepEqual(invocationSurfaceRemovalViolations(root), []);

  write(
    root,
    "scripts/unmarked.test.ts",
    "const formerBehavior = 'notifyHireApproved';\n",
  );
  assert.ok(
    invocationSurfaceRemovalViolations(root).some((violation) =>
      violation.includes("notifyHireApproved"),
    ),
  );
});
