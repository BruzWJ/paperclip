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
import {
  legacyExecutionSurfaceRemovalViolations,
} from "./check-legacy-execution-surface-removal.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function append(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  writeFileSync(absolute, `${readFileSync(absolute, "utf8")}\n${content}\n`);
}

function replace(
  root: string,
  path: string,
  search: string,
  replacement: string,
): void {
  const absolute = join(root, path);
  const source = readFileSync(absolute, "utf8");
  assert.ok(source.includes(search), `missing fixture token ${search} in ${path}`);
  writeFileSync(absolute, source.split(search).join(replacement));
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-legacy-execution-gate-"));
  roots.add(root);
  write(
    root,
    "server/src/services/tool-gateway.ts",
    [
      "async function connectedMcpToolsForCompany() { return []; }",
      "export const gateway = {",
      "  listToolsForNamedGateway: async () => connectedMcpToolsForCompany(),",
      "  executeToolForNamedGateway: async () => null,",
      "};",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/runtime-interface-compiler.ts",
    [
      "interface CompiledRunToolDescriptor { name: string }",
      "interface RuntimeInterfaceCompileInput { actionGrants: unknown; selectedCompanyTools: unknown }",
      "export function compileRuntimeInterface(input: RuntimeInterfaceCompileInput) {",
      "  return { descriptors: [] as CompiledRunToolDescriptor[], input };",
      "}",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/summary-slots.ts",
    [
      "declare const routineService: unknown;",
      "declare const routinesSvc: { runRoutine(input: unknown): unknown };",
      "export function dispatchRefresh() {",
      "  const input = { source: \"manual\", key: \"summary-slot-refresh:\" };",
      "  return routinesSvc.runRoutine(input);",
      "}",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/summary-slot-finalization.ts",
    [
      "declare const issueUpdates: { form: unknown; status: unknown };",
      "declare const issueComments: unknown;",
      "declare const sourceIssueCommentId: unknown;",
      "declare function eq(left: unknown, right: unknown): unknown;",
      "export function finalizeSummarySlotsForTerminalIssue() {",
      "  return [eq(issueUpdates.form, \"owner\"), eq(issueUpdates.status, \"done\"), issueComments, sourceIssueCommentId];",
      "}",
    ].join("\n"),
  );
  write(
    root,
    "server/src/routes/summary-slots.ts",
    [
      "const path = \"/companies/:companyId/summary-slots/:scopeKind/:slotKey/refresh\";",
      "declare const refreshSummarySlotSchema: unknown;",
      "declare const svc: { dispatchRefresh(): unknown };",
      "const activity = { action: \"summary_slot.refresh_requested\" };",
      "void [path, refreshSummarySlotSchema, svc.dispatchRefresh, activity];",
    ].join("\n"),
  );
  write(
    root,
    "packages/shared/src/api.ts",
    "export const summarySlotRefresh = `/api/summary-slots/:slotKey/refresh`;\n",
  );
  write(
    root,
    "packages/shared/src/types/summary-slot.ts",
    "export interface RefreshSummarySlotRequest {}\nexport interface RefreshSummarySlotResponse {}\n",
  );
  write(
    root,
    "packages/shared/src/validators/summary-slot.ts",
    "export const refreshSummarySlotSchema = {};\nexport type RefreshSummarySlotInput = unknown;\n",
  );
  write(
    root,
    "ui/src/api/summarySlots.ts",
    [
      "interface RefreshSummarySlotResponse {}",
      "declare function summarySlotPath(a: unknown, b: string): string;",
      "declare const selector: unknown;",
      "export const api = { refresh: () => summarySlotPath(selector, \"/refresh\") as unknown as RefreshSummarySlotResponse };",
    ].join("\n"),
  );
  write(
    root,
    "packages/plugins/plugin-llm-wiki/src/wiki/core.ts",
    [
      "declare const WIKI_CREATOR_CALLBACK_KEY: string;",
      "declare const ctx: any;",
      "export async function createOperationIssue() {",
      "  return ctx.issues.create({ callbackKey: WIKI_CREATOR_CALLBACK_KEY });",
      "}",
      "export function register() { return ctx.issues.registerCreatorCallback({}, () => null); }",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/issue-execution-dispatcher.ts",
    [
      "// Dispatcher accepts only a persisted IssueExecutionRef",
      "declare const coordinator: { wake(lane: unknown): void };",
      "declare const persisted: { lane: unknown };",
      "declare function listDispatchableOwnerRefIds(): string[];",
      "export function notifyPersistedRef() {",
      "  coordinator.wake(persisted.lane);",
      "  return listDispatchableOwnerRefIds();",
      "}",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    [
      "declare const issueExecutionLeases: any;",
      "declare const lease: any;",
      "declare const at: Date;",
      "declare function eq(a: unknown, b: unknown): unknown;",
      "declare const query: { set(value: unknown): unknown };",
      "function releaseAttempt() {",
      "  query.set({ state: \"released\", releasedAt: at });",
      "  return [eq(issueExecutionLeases.id, lease.leaseId), eq(issueExecutionLeases.attemptId, lease.attemptId)];",
      "}",
      "export function leaseNextOwnerRef() { return releaseAttempt(); }",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/issue-execution-postgres.ts",
    "export async function start(dispatcher: any, input: any) { await dispatcher.notifyPersistedRef(input.refId); }\n",
  );
  write(
    root,
    "server/src/services/system-escalation-postgres.ts",
    [
      "declare function appendNonDispatchControlNotice(input: unknown): void;",
      "export function escalation() {",
      "  const direct = { sourceKind: \"system_nudge\", dispatchRefId: null };",
      "  const notice = { sourceKind: \"system_escalation_nudge\" };",
      "  appendNonDispatchControlNotice(notice);",
      "  return direct;",
      "}",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/ordinary-issue-runtime.ts",
    [
      "declare function appendNonDispatchUserComment(input: unknown): unknown;",
      "declare function dispatch(id: string): Promise<void>;",
      "export async function comment(result: { ref?: { id: string } }, replyToCommentId?: string) {",
      "  appendNonDispatchUserComment(replyToCommentId);",
      "  if (result.ref) {",
      "    await dispatch(result.ref.id);",
      "  }",
      "}",
    ].join("\n"),
  );
  return root;
}

function expectViolation(
  root: string,
  fragment: string,
  description = fragment,
): void {
  const violations = legacyExecutionSurfaceRemovalViolations(root);
  assert.ok(
    violations.some((violation) => violation.includes(fragment)),
    `${description}: expected matching violation, received ${JSON.stringify(violations)}`,
  );
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts only the canonical compiler, routine, callback, ref, re-lease, escalation, and no-dispatch owners", () => {
  const root = fixtureRoot();
  write(
    root,
    "server/src/services/plugin-tool-registry.ts",
    "const pluginTools = new Set<string>();\npluginTools.add('selected-company-row');\n",
  );
  write(
    root,
    "server/src/services/plugin-worker-manager.ts",
    "export function sendMessage(message: unknown) { return message; }\n",
  );
  assert.deepEqual(legacyExecutionSurfaceRemovalViolations(root), []);
});

for (const token of [
  "BUILTIN_TOOLS",
  "VIRTUAL_SEARCH_TOOLS",
  "VIRTUAL_RUN_TOOL",
  "search_tools",
  "run_tool",
  "onDemandToolsConfig",
  "loadToolsOnDemand",
  "paperclip-self:list_my_issues",
  "paperclip-self:get_issue_context",
  "SUMMARIZER_BUILT_IN_KEY",
  "summarize-status",
  "summarySlotSessionTaskKey",
  "summarySlotService.generate",
  "GenerateSummarySlot",
  "generateSummarySlot",
  "summarySlotGenerate",
  "summary_slot.generate_requested",
  "issueThreadInteractionContinuationPolicy",
  "issueThreadInteractions",
  "issue_thread_interactions",
  ["accepted", "InteractionId"].join(""),
  ["accepted", "_interaction_id"].join(""),
  "enqueueWakeup",
  "heartbeat.wakeup",
  "heartbeat.invoke",
  "heartbeatService",
  "services/heartbeat",
  "issue-assignment-wakeup",
  "queueIssueAssignmentWakeup",
  "agentWakeupRequests",
  "AgentWakeupRequest",
  "agent_wakeup_requests",
  "wake_owner",
  "agent_wake",
  "queued_wakes",
  "wakeAgents",
  "OwnerWakeRow",
  "wakeText",
  "/agents/:id/wakeup",
  "/agents/:id/heartbeat/invoke",
  "ctx.agents.invoke",
  "agentSessions",
  "ctx.agents.sessions",
  "agents.sessions",
] as const) {
  test(`rejects retired exact identity ${token}`, () => {
    const root = fixtureRoot();
    write(root, "server/src/retired.ts", `export const retired = ${JSON.stringify(token)};\n`);
    expectViolation(root, token);
  });
}

for (const collector of ["allTools", "pluginTools"] as const) {
  test(`rejects ${collector} only as a static Tool Gateway collector`, () => {
    const root = fixtureRoot();
    append(
      root,
      "server/src/services/tool-gateway.ts",
      `function ${collector}() { return []; }\n${collector}();`,
    );
    expectViolation(root, "retired static Tool Gateway");
  });
}

test("rejects static Paperclip descriptors in the Tool Gateway", () => {
  const root = fixtureRoot();
  append(
    root,
    "server/src/services/tool-gateway.ts",
    "const descriptor = { source: \"paperclip\", name: \"issue_update\", inputSchema: {} };",
  );
  expectViolation(root, "static Paperclip run-tool descriptors");
});

test("rejects collector re-exports while allowing selected-company pluginTools locals", () => {
  const root = fixtureRoot();
  write(
    root,
    "server/src/services/static-tools.ts",
    "export { allTools as staticTools } from './tool-gateway.js';\n",
  );
  expectViolation(root, "aliased or re-exported");
});

test("rejects renamed static Paperclip tool catalogs", () => {
  const root = fixtureRoot();
  write(
    root,
    "server/src/services/static-tools.ts",
    "export function buildStaticPaperclipToolCatalog() { return []; }\n",
  );
  expectViolation(root, "renamed static Paperclip run-tool catalog");
});

test("rejects old and renamed direct summary generation", () => {
  const generateRoot = fixtureRoot();
  append(
    generateRoot,
    "server/src/services/summary-slots.ts",
    "declare const svc: any;\nsvc.generate({});",
  );
  expectViolation(generateRoot, "summary-slot generate wrapper");

  const providerRoot = fixtureRoot();
  append(
    providerRoot,
    "server/src/services/summary-slots.ts",
    "declare const provider: any;\nprovider.execute({});",
  );
  expectViolation(providerRoot, "cannot call a provider or adapter directly");

  const aliasRoot = fixtureRoot();
  write(
    aliasRoot,
    "server/src/services/summary-provider.ts",
    "export function refreshSummaryWithProvider() {}\n",
  );
  expectViolation(aliasRoot, "renamed direct summary-provider generation");
});

for (const alias of [
  "resumeInteractionContinuation",
  "dispatchInteractionResult",
  "interactionWakeupHandler",
] as const) {
  test(`rejects interaction continuation alias ${alias}`, () => {
    const root = fixtureRoot();
    write(root, "server/src/services/interaction.ts", `export function ${alias}() {}\n`);
    expectViolation(root, "interaction continuation aliases");
  });
}

for (const alias of [
  "queueAgentWakeup",
  "requestIssueWake",
  "dispatchWakeupRequest",
] as const) {
  test(`rejects generic wake alias ${alias}`, () => {
    const root = fixtureRoot();
    write(root, "server/src/services/wake.ts", `export function ${alias}() {}\n`);
    expectViolation(root, "generic wake wrapper aliases");
  });
}

test("rejects an injected wake dependency but preserves the dispatcher's internal coordinator signal", () => {
  const root = fixtureRoot();
  write(root, "server/src/services/injected.ts", "export const deps = { wakeup: () => null };\n");
  expectViolation(root, "injected generic wake dependencies");
});

for (const alias of [
  "createAgentSession",
  "sendPluginAgentSession",
  "AgentSessionResumeHandler",
] as const) {
  test(`rejects plugin agent-session alias ${alias}`, () => {
    const root = fixtureRoot();
    write(root, "packages/plugins/example/src/session.ts", `export function ${alias}() {}\n`);
    expectViolation(root, "plugin agent-session aliases");
  });
}

for (const [path, token] of [
  ["server/src/services/runtime-interface-compiler.ts", "compileRuntimeInterface"],
  ["server/src/services/summary-slots.ts", "dispatchRefresh"],
  ["server/src/services/summary-slot-finalization.ts", "finalizeSummarySlotsForTerminalIssue"],
  ["server/src/routes/summary-slots.ts", "svc.dispatchRefresh"],
  ["packages/shared/src/api.ts", "summarySlotRefresh"],
  ["packages/shared/src/types/summary-slot.ts", "RefreshSummarySlotResponse"],
  ["packages/shared/src/validators/summary-slot.ts", "refreshSummarySlotSchema"],
  ["ui/src/api/summarySlots.ts", "refresh:"],
  ["packages/plugins/plugin-llm-wiki/src/wiki/core.ts", "ctx.issues.registerCreatorCallback"],
  ["server/src/services/issue-execution-dispatcher.ts", "notifyPersistedRef"],
  ["server/src/services/issue-execution-dispatcher-postgres.ts", "releaseAttempt"],
  ["server/src/services/issue-execution-postgres.ts", "dispatcher.notifyPersistedRef(input.refId)"],
  ["server/src/services/system-escalation-postgres.ts", "appendNonDispatchControlNotice"],
  ["server/src/services/ordinary-issue-runtime.ts", "appendNonDispatchUserComment"],
] as const) {
  test(`rejects missing canonical owner token ${token}`, () => {
    const root = fixtureRoot();
    replace(root, path, token, "removedCanonicalOwner");
    expectViolation(root, `missing canonical ownership token ${token}`);
  });
}

test("allows marker-scoped removal assertions only in tests", () => {
  const root = fixtureRoot();
  write(
    root,
    "server/src/removal.test.ts",
    [
      "// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: enqueueWakeup, agentSessions",
      "const removed = ['enqueueWakeup', 'agentSessions'];",
    ].join("\n"),
  );
  assert.deepEqual(legacyExecutionSurfaceRemovalViolations(root), []);

  write(
    root,
    "server/src/unmarked.test.ts",
    "const removed = 'heartbeat.invoke';\n",
  );
  expectViolation(root, "heartbeat.invoke");
});

for (const claim of [
  "Paperclip owns generic `process` and `http` transports.",
  "Every external adapter implements the full ABI.",
  "Built-in adapters include local CLI providers and HTTP/gateway providers.",
  "Local and remote adapters receive a closed execution request.",
  "The adapter's restore step copies commits back.",
  "An adapter lowers the closed issue-execution request into a provider-native attempt.",
  "Local CLIs, gateways, HTTP, plugins",
  "compatibleAdapters: ['process', 'http']",
] as const) {
  test(`rejects active documentation claim: ${claim}`, () => {
    const root = fixtureRoot();
    write(root, "docs/start/architecture.md", `${claim}\n`);
    expectViolation(root, "active documentation cannot advertise a retired AI execution path");
  });
}

test("does not scan historical plan prose as active execution documentation", () => {
  const root = fixtureRoot();
  write(
    root,
    "doc/plans/2025-01-01-historical-adapter.md",
    "Built-in adapters include local CLI providers and HTTP/gateway providers.\n",
  );
  assert.deepEqual(legacyExecutionSurfaceRemovalViolations(root), []);
});
