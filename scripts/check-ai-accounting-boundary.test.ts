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
import { aiAccountingBoundaryViolations } from "./check-ai-accounting-boundary.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-ai-accounting-"));
  roots.add(root);
  write(root, "packages/db/schema/agent_runtime_state.ts", [
    'export const agentRuntimeState = pgTable("agent_runtime_state", {',
    "lastContextUsedTokens: bigint(), lastContextWindowTokens: bigint(), peakContextUsedTokens: bigint(),",
    "aggregateKnownCostAmount: numeric(), unpricedPromptCount: bigint(),",
    '}); check("agent_runtime_state_context_occupancy_check"); check("agent_runtime_state_aggregates_check");',
  ].join("\n"));
  write(root, "packages/db/schema/acp_prompt_accounting.ts", [
    'export const acpPromptAccounting = pgTable("acp_prompt_accounting", {',
    "contextTokenLimit: bigint(), contextUsedTokens: bigint(), contextWindowTokens: bigint(),",
    '}); check("acp_prompt_accounting_context_occupancy_check", sql`${table.contextUsedTokens} >= 0 and ${table.contextWindowTokens} > 0 and ${table.contextUsedTokens} <= ${table.contextWindowTokens} and ${table.contextWindowTokens} = ${table.contextTokenLimit}`);',
  ].join("\n"));
  write(root, "packages/db/schema/issue_sessions.ts", [
    "tokensInput: bigint(), tokensOutput: bigint(), tokensReasoning: bigint(), tokensCacheRead: bigint(), tokensCacheWrite: bigint(),",
    'check("issue_sessions_cost_and_tokens_check", sql`${table.tokensInput} is null and ${table.tokensOutput} is null and ${table.tokensReasoning} is null and ${table.tokensCacheRead} is null and ${table.tokensCacheWrite} is null or ${table.tokensInput} >= 0 and ${table.tokensOutput} >= 0 and ${table.tokensReasoning} >= 0 and ${table.tokensCacheRead} >= 0 and ${table.tokensCacheWrite} >= 0`);',
  ].join("\n"));
  const tokenShape = [
    "tokens: Schema.Struct({",
    "input: Schema.Finite, output: Schema.Finite, reasoning: Schema.Finite,",
    "cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),",
    "}).pipe(optional)",
  ].join("\n");
  write(root, "packages/shared/src/issue-session/session.ts", tokenShape);
  write(root, "packages/shared/src/issue-session/session-message.ts", `export const Assistant = Schema.Struct({\n${tokenShape}\n});`);
  write(root, "packages/shared/src/issue-session/session-event.ts", `export const Ended = EventDefinition.define({\ntype: "session.next.step.ended",\n${tokenShape}\n});`);
  write(root, "packages/shared/src/issue-session/codec.test.ts", [
    "preserves unavailable and explicit-zero Session accounting without sentinels",
    "uses only Step.Ended.3 and keeps its accounting objects all-or-none",
    "cache: { read: 0, write: 0 }",
    "tokens: { input: 0 }",
  ].join("\n"));
  write(root, "apps/server/src/services/issue-session/message-updater.ts", 'case "session.next.step.ended": if (event.data.tokens !== undefined) message.tokens = event.data.tokens;\n');
  write(root, "apps/server/src/services/issue-session/projector.ts", "canonicalJson(assistant.tokens) !== canonicalJson(event.data.tokens);\n");
  write(root, "apps/server/src/services/issue-execution-acp-events-postgres.ts", 'if (input.event.kind === "usage") { return; }\n');
  write(root, "apps/server/src/services/acp-prompt-settlement.ts", [
    "contextUsedTokens: settlement.occupancy.used,",
    "contextWindowTokens: settlement.occupancy.size,",
    "lastContextUsedTokens: input.contextUsedTokens,",
    "lastContextWindowTokens: input.contextWindowTokens,",
    "const peakContextUsedTokens = Math.max(existing.peakContextUsedTokens, input.contextUsedTokens);",
    "const stepEndedData = { finish: settlement.stopReason };",
  ].join("\n"));
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts occupancy-only ACP with nullable Session token columns", () => {
  assert.deepEqual(aiAccountingBoundaryViolations(fixtureRoot()), []);
});

test("rejects a legacy runtime throughput aggregate", () => {
  const root = fixtureRoot();
  const path = "packages/db/schema/agent_runtime_state.ts";
  const retiredField = ["total", "InputTokens"].join("");
  write(root, path, readFileSync(join(root, path), "utf8").replace("lastContextUsedTokens:", `${retiredField}: bigint(), lastContextUsedTokens:`));
  assert.ok(aiAccountingBoundaryViolations(root).some((entry) => entry.includes(retiredField)));
});

test("rejects stable-ACP Step.Ended token fabrication", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/acp-prompt-settlement.ts";
  write(root, path, `${readFileSync(join(root, path), "utf8")}\nconst stepEndedData = { tokens: { input: 1 } };\n`);
  assert.ok(aiAccountingBoundaryViolations(root).some((entry) => entry.includes("constructs donor")));
});

test("rejects donor components derived from occupancy", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/acp-prompt-settlement.ts";
  write(root, path, `${readFileSync(join(root, path), "utf8")}\nconst fabricated = { input: settlement.occupancy.used };\n`);
  assert.ok(aiAccountingBoundaryViolations(root).some((entry) => entry.includes("derives donor")));
});

test("rejects token-throughput summation", () => {
  const root = fixtureRoot();
  write(root, "apps/server/src/services/throughput.ts", "const total = sum(inputTokens);\n");
  assert.ok(aiAccountingBoundaryViolations(root).some((entry) => entry.includes("throughput")));
});

test("rejects a default on optional donor token storage", () => {
  const root = fixtureRoot();
  const path = "packages/db/schema/issue_sessions.ts";
  write(root, path, readFileSync(join(root, path), "utf8").replace("tokensInput: bigint()", "tokensInput: bigint().default(0)"));
  assert.ok(aiAccountingBoundaryViolations(root).some((entry) => entry.includes("no default")));
});

test("rejects incomplete donor token objects", () => {
  const root = fixtureRoot();
  const path = "packages/shared/src/issue-session/session-message.ts";
  write(root, path, readFileSync(join(root, path), "utf8").replace("reasoning: Schema.Finite,", ""));
  assert.ok(aiAccountingBoundaryViolations(root).some((entry) => entry.includes("reasoning")));
});

test("rejects zero-hostile donor storage", () => {
  const root = fixtureRoot();
  const path = "packages/db/schema/issue_sessions.ts";
  write(root, path, readFileSync(join(root, path), "utf8").replace("table.tokensInput} >= 0", "table.tokensInput} > 0"));
  assert.ok(aiAccountingBoundaryViolations(root).some((entry) => entry.includes("tokensInput")));
});

test("rejects mapping stable ACP usage into Session events", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/issue-execution-acp-events-postgres.ts";
  write(root, path, readFileSync(join(root, path), "utf8").replace('input.event.kind === "usage"', 'input.event.kind === "never"'));
  assert.ok(aiAccountingBoundaryViolations(root).some((entry) => entry.includes("usage")));
});

test("rejects retired ACP token provenance fields", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/acp-prompt-settlement.ts";
  write(
    root,
    path,
    `${readFileSync(join(root, path), "utf8")}\nconst retired = { sourceTotalTokens: settlement.occupancy.used };\n`,
  );
  assert.ok(
    aiAccountingBoundaryViolations(root).some((entry) =>
      entry.includes("sourceTotalTokens"),
    ),
  );
});
