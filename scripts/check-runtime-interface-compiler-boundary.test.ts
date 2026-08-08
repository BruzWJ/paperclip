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
  const root = mkdtempSync(
    join(tmpdir(), "paperclip-runtime-interface-gate-"),
  );
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
    "apps/server/src/services/paperclip-managed-tool-registry.ts",
    [
      "type IssueExecutionRefMode = 'owner' | 'consult';",
      "type ContextDial = {}; type PaperclipActionKey = string;",
      "export const PAPERCLIP_MANAGED_TOOL_NAMES = [];",
      "export const boardMcpInputSchemas = {};",
      "export const BOARD_MANAGED_TOOLS = [];",
      "export interface PaperclipManagedToolRuntimeProjectionInput {",
      "  mode: IssueExecutionRefMode; contextDial: ContextDial;",
      "  actionGrants: Readonly<Partial<Record<PaperclipActionKey, boolean>>>;",
      "  isCurrentOwner: boolean; issueCreateDirectChildren: readonly unknown[];",
      "  issueAssignTargets: readonly unknown[]; creatorUpdateTargets: readonly unknown[];",
      "  mentionTargets: readonly unknown[]; configureTargets: readonly unknown[];",
      "}",
      "function resolveContextRetrievalPolicy(input: unknown) { return input; }",
      "function projectRuntimeIssueCreate(input: any) { resolveContextRetrievalPolicy(input.contextDial); if (input.actionGrants.issue_create !== true) return null; return input.issueCreateDirectChildren; }",
      "function projectRuntimeIssueAssign(input: any) { return input.issueAssignTargets; }",
      "function projectRuntimeIssueUpdate(input: any) { return [input.creatorUpdateTargets, input.isCurrentOwner]; }",
      "function projectRuntimeMentionAgent(input: any) { return input.mentionTargets; }",
      "function projectRuntimeAgentConfigure(input: any) { if (input.actionGrants.agent_configure !== true || input.configureTargets.length === 0) return null; return {}; }",
      "function projectRuntimeTool() {}",
      "export interface ProjectedPaperclipManagedToolDescriptor { normalizeRuntimeCommand(): unknown }",
      "export function projectPaperclipManagedTools(input: PaperclipManagedToolRuntimeProjectionInput) { return [{ normalizeRuntimeCommand(payload, scope) {} }]; }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/runtime-interface-compiler-db.ts",
    [
      'import type { PaperclipManagedToolRuntimeProjectionInput } from "./paperclip-managed-tool-registry.js";',
      "type ConfigureGrant = {}; type RuntimeAgentConfigureTarget = {};",
      "interface Snapshot { configureGrants: readonly ConfigureGrant[] }",
      "function explicitConfigureTargets(source: unknown, agents: unknown[], grants: readonly ConfigureGrant[]) { return new Set<string>(); }",
      "export function build(snapshot: Snapshot, actionGrants: Record<string, boolean>, companyAgents: unknown[], sourceAgent: unknown) {",
      "  const configureTargets: RuntimeAgentConfigureTarget[] = actionGrants.agent_configure === true",
      "    ? (() => { const ids = explicitConfigureTargets(sourceAgent, companyAgents, snapshot.configureGrants); return [...ids].map(() => ({})); })()",
      "    : [];",
      "  return { configureTargets };",
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
      "interface Request { method: \"initialize\" | \"tools/list\" | \"tools/call\" }",
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
  assert.deepEqual(runtimeInterfaceCompilerBoundaryViolations(fixtureRoot()), []);
});

for (const mutation of [
  "companySkillPins: readonly string[];",
  "selectedCompanySkills: readonly string[];",
  "skillChannel: string;",
] as const) {
  test(`rejects compiler input mutation ${mutation}`, () => {
    const root = fixtureRoot();
    const path = "apps/server/src/services/runtime-interface-compiler.ts";
    const original = readFileSync(join(root, path), "utf8");
    write(
      root,
      path,
      original.replace(
        "extends PaperclipManagedToolRuntimeProjectionInput {",
        `extends PaperclipManagedToolRuntimeProjectionInput {\n  ${mutation}`,
      ),
    );
    assert.ok(
      runtimeInterfaceCompilerBoundaryViolations(root).some((violation) =>
        violation.includes("skills entered RuntimeInterfaceCompileInput"),
      ),
    );
  });
}

test("rejects a company-skill database import", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/runtime-interface-compiler-db.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(
    root,
    path,
    `import { companySkills } from \"./company-skills.js\";\n${original}`,
  );
  const violations = runtimeInterfaceCompilerBoundaryViolations(root);
  assert.ok(
    violations.some((violation) =>
      violation.includes("company-skill storage entered"),
    ),
  );
  assert.ok(
    violations.some((violation) =>
      violation.includes("imports a skill owner"),
    ),
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
      violation.includes("raw management permission rows entered RuntimeInterfaceCompileInput"),
    ),
  );
  assert.ok(
    violations.some((violation) =>
      violation.includes("raw managed authority entered the assembled runtime-interface digest"),
    ),
  );
});

test("rejects configure target derivation without the action grant", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/runtime-interface-compiler-db.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(
    root,
    path,
    original.replace(
      "actionGrants.agent_configure === true",
      "snapshot.configureGrants.length >= 0",
    ),
  );
  assert.ok(
    runtimeInterfaceCompilerBoundaryViolations(root).some((violation) =>
      violation.includes("behind actionGrants.agent_configure"),
    ),
  );
});

test("rejects an agent_configure projection without the action grant", () => {
  const root = fixtureRoot();
  const path =
    "apps/server/src/services/paperclip-managed-tool-registry.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(
    root,
    path,
    original.replace(
      "input.actionGrants.agent_configure !== true || ",
      "",
    ),
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
  write(
    root,
    path,
    `${original}\nfunction configureDescriptor() {}\n`,
  );
  assert.ok(
    runtimeInterfaceCompilerBoundaryViolations(root).some((violation) =>
      violation.includes("rebuilds managed descriptor ABI via configureDescriptor"),
    ),
  );
});

for (const path of [
  "apps/server/src/services/prompt-capability-gateway.ts",
  "apps/server/src/routes/run-tools.ts",
] as const) {
  test(`rejects company-skill data in ${path}`, () => {
    const root = fixtureRoot();
    const original = readFileSync(join(root, path), "utf8");
    write(root, path, `${original}\nconst selectedCompanySkills = [];\n`);
    assert.ok(
      runtimeInterfaceCompilerBoundaryViolations(root).some((violation) =>
        violation.includes("company-skill data entered the run capability surface"),
      ),
    );
  });
}

test("rejects management rows in the run capability surface", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/prompt-capability-gateway.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(root, path, `${original}\nconst configureGrants = [];\n`);
  assert.ok(
    runtimeInterfaceCompilerBoundaryViolations(root).some((violation) =>
      violation.includes("raw management permission rows entered the run capability surface"),
    ),
  );
});
