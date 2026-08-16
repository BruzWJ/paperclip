import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { runtimeInterfaceCompilerBoundaryViolations } from "./check-runtime-interface-compiler-boundary.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-runtime-interface-gate-"));
  roots.add(root);
  write(
    root,
    "apps/server/src/services/runtime-interface-compiler.ts",
    [
      "type AgentMentionReachGrantKey = string;",
      "type PaperclipManagedToolRuntimeProjectionInput = {};",
      "type CompiledRunToolDescriptor = { name: string };",
      "import { projectPaperclipManagedTools, } from './paperclip-managed-tool-registry.js';",
      "export interface RuntimeInterfaceCompileInput extends PaperclipManagedToolRuntimeProjectionInput {",
      "  mentionReachGrants?: Readonly<Partial<Record<AgentMentionReachGrantKey, boolean>>>;",
      "}",
      "interface CompiledRuntimeInterface { mode: string; descriptors: readonly CompiledRunToolDescriptor[] }",
      "export function compileRuntimeInterface(input: RuntimeInterfaceCompileInput): CompiledRuntimeInterface {",
      "  const descriptors = [",
      "    ...projectPaperclipManagedTools(input),",
      "  ];",
      "  return { mode: 'owner', descriptors };",
      "}",
      "function compiledRuntimeInterfaceDigest(compiled: CompiledRuntimeInterface): string {",
      "  const contract = { descriptors: compiled.descriptors }; return JSON.stringify(contract);",
      "}",
      "export function runtimeInterfaceDigest(input: RuntimeInterfaceCompileInput): string { return compiledRuntimeInterfaceDigest(compileRuntimeInterface(input)); }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/paperclip-managed-tool-definitions.ts",
    [
      "export const PAPERCLIP_MANAGED_TOOL_NAMES = [];",
      "export const PAPERCLIP_MANAGED_TOOL_METADATA = {};",
      "export const boardMcpInputSchemas = {};",
      "export const BOARD_MANAGED_TOOLS = [];",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/paperclip-managed-tool-runtime.ts",
    [
      "type TaskExecutionRefMode = 'owner' | 'consult';",
      "type ContextDial = {}; type PaperclipActionKey = string;",
      "export interface PaperclipManagedToolRuntimeProjectionInput {",
      "  mode: TaskExecutionRefMode; contextDial: ContextDial;",
      "  actionGrants: Readonly<Partial<Record<PaperclipActionKey, boolean>>>;",
      "  isCurrentOwner: boolean; taskCreateDirectChildren: readonly unknown[];",
      "  taskAssignTargets: readonly unknown[]; creatorUpdateTargets: readonly unknown[];",
      "  mentionTargets: readonly unknown[];",
      "}",
      "export interface ProjectedPaperclipManagedToolDescriptor { normalizeRuntimeCommand(): unknown }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/paperclip-managed-task-tools.ts",
    [
      "function resolveContextRetrievalPolicy(input: unknown) { return input; }",
      "export function projectRuntimeTaskCreate(input: any) { resolveContextRetrievalPolicy(input.contextDial); if (input.actionGrants.task_create !== true) return null; return input.taskCreateDirectChildren; }",
      "export function projectRuntimeTaskAssign(input: any) { return input.taskAssignTargets; }",
      "export function projectRuntimeTaskUpdate(input: any) { return [input.creatorUpdateTargets, input.isCurrentOwner]; }",
      "export function projectRuntimeMentionAgent(input: any) { return input.mentionTargets; }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/paperclip-managed-tool-registry.ts",
    [
      "function projectRuntimeAgentConfigure(input: any) { if (input.actionGrants.agent_configure !== true) return null; return {}; }",
      "function projectRuntimeTool() {}",
      "export function projectPaperclipManagedTools(input: PaperclipManagedToolRuntimeProjectionInput) { return [{ normalizeRuntimeCommand(payload, scope) {} }]; }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/runtime-interface-compiler-db.ts",
    [
      'import type { PaperclipManagedToolRuntimeProjectionInput } from "./paperclip-managed-tool-registry.js";',
      "export function buildRuntimeInterfaceCompileInput(actionGrants: Record<string, boolean>, mentionTargets: unknown[]) {",
      "  return { actionGrants, mentionTargets, };",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/prompt-capability-gateway.ts",
    [
      "declare function compileRuntimeInterface(value: unknown): { descriptors: unknown[] };",
      "declare function compiledRuntimeInterfaceDigest(value: unknown): string;",
      "export function list(value: unknown) { return compileRuntimeInterface(value).descriptors; }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/routes/run-tools.ts",
    [
      'interface Request { method: "initialize" | "tools/list" | "tools/call" }',
      "export async function route(gateway: any, token: string) {",
      "  await gateway.listTools(token);",
      "  return gateway.callTool({ token });",
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

test("accepts the closed compiler/database/gateway graph", () => {
  assert.deepEqual(
    runtimeInterfaceCompilerBoundaryViolations(fixtureRoot()),
    [],
  );
});

test("rejects management rows in compile input and digest", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/runtime-interface-compiler.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(
    root,
    path,
    original
      .replace(
        "extends PaperclipManagedToolRuntimeProjectionInput {",
        "extends PaperclipManagedToolRuntimeProjectionInput {\n  configureGrants: readonly unknown[];",
      )
      .replace(
        "const contract = { descriptors: compiled.descriptors }",
        "const contract = { descriptors: compiled.descriptors, configureGrants: [] }",
      ),
  );
  const violations = runtimeInterfaceCompilerBoundaryViolations(root);
  assert.ok(
    violations.some((violation) =>
      violation.includes(
        "raw management permission rows entered RuntimeInterfaceCompileInput",
      ),
    ),
  );
  assert.ok(
    violations.some((violation) =>
      violation.includes(
        "raw managed authority entered the assembled runtime-interface digest",
      ),
    ),
  );
});

test("rejects configure authority in provider-interface compilation", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/runtime-interface-compiler-db.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(root, path, `${original}\nconst configureTargets = principalPermissionGrants;\n`);
  assert.ok(
    runtimeInterfaceCompilerBoundaryViolations(root).some((violation) =>
      violation.includes("legacy agent_configure target-catalog path remains"),
    ),
  );
});

test("rejects an agent_configure projection without the action grant", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/paperclip-managed-tool-registry.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(
    root,
    path,
    original.replace("if (input.actionGrants.agent_configure !== true) return null;", ""),
  );
  assert.ok(
    runtimeInterfaceCompilerBoundaryViolations(root).some((violation) =>
      violation.includes("input.actionGrants.agent_configure !== true"),
    ),
  );
});

test("rejects a compiler that rebuilds a managed descriptor", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/runtime-interface-compiler.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(root, path, `${original}\nfunction configureDescriptor() {}\n`);
  assert.ok(
    runtimeInterfaceCompilerBoundaryViolations(root).some((violation) =>
      violation.includes(
        "rebuilds managed descriptor ABI via configureDescriptor",
      ),
    ),
  );
});

test("rejects management rows in the run capability surface", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/prompt-capability-gateway.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(root, path, `${original}\nconst configureGrants = [];\n`);
  assert.ok(
    runtimeInterfaceCompilerBoundaryViolations(root).some((violation) =>
      violation.includes(
        "raw management permission rows entered the run capability surface",
      ),
    ),
  );
});
