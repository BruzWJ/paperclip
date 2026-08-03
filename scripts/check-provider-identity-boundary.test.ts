import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { providerIdentityBoundaryViolations } from "./check-provider-identity-boundary.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-provider-boundary-"));
  roots.add(root);
  write(root, "packages/shared/src/provider-child-boundary.ts", [
    "const PAPERCLIP_PROVIDER_CHILD_RESERVED_SUFFIXES = new Set();",
    "const SERVER_SECRET_ENV_KEYS = new Set();",
    "export function isProviderChildReservedEnvironmentKey(key: string) {",
    'const prefix = "PAPERCLIP_";',
    "return SERVER_SECRET_ENV_KEYS.has(normalized) || PAPERCLIP_PROVIDER_CHILD_RESERVED_SUFFIXES.has(key);",
    "}",
  ].join("\n"));
  write(root, "packages/shared/src/validators/agent.ts", [
    'import { isProviderChildReservedEnvironmentKey } from "../provider-child-boundary.js";',
    'if (typeof value === "string") return;',
    "if (isEnvironmentEntry && isProviderChildReservedEnvironmentKey(key)) reject();",
  ].join("\n"));
  write(root, "packages/adapter-utils/src/remote-execution-env.ts", [
    'import { isProviderChildReservedEnvironmentKey } from "@paperclipai/shared/provider-child-boundary";',
    "if (isProviderChildReservedEnvironmentKey(normalizedKey)) continue;",
    "sanitized[key] = value;",
  ].join("\n"));
  write(root, "packages/adapter-utils/src/server-utils.ts", [
    "export function sanitizeInheritedProviderChildEnv() {",
    'if (normalizedKey.startsWith("PAPERCLIP_")) delete env[key];',
    "}",
    "const child = { ...sanitizeInheritedProviderChildEnv(process.env), ...opts.env };",
  ].join("\n"));
  write(root, "packages/adapter-utils/src/acp-subprocess/process.ts", "const child = { ...sanitizeInheritedProviderChildEnv(process.env), ...hostLaunch.environment };\n");
  write(root, "server/src/services/issue-execution-attempt-executor.ts", "environment: Object.freeze({}),\nmessage: input.message,\n");
  write(root, "server/src/services/issue-session-compaction-provider.ts", "environment: Object.freeze({}),\nmcpServers: noAcpMcpServers(),\nmessage: input.prompt,\n");
  write(root, "server/src/services/runtime-agent-action-port.ts", [
    "type Options = { requestChangeConsent?: (input: unknown) => Promise<void> };",
    "export function create(service: any, options: Options) {",
    "  async function hire() {",
    "    await service.hireFromRun({});",
    '    return { status: "created" as const };',
    "  }",
    "  async function configure() {",
    "    await service.configureFromRun({});",
    '    return { status: "configured" as const };',
    "  }",
    "  async function consent() {",
    "    await options.requestChangeConsent({});",
    '    return { status: "change_consent_requested" as const };',
    "  }",
    "  return { hire, configure, consent };",
    "}",
    "",
  ].join("\n"));
  write(root, "server/src/index.ts", [
    "const assembly = {",
    "  async requestChangeConsent({ capability, targetAgentId, displayedDiff }: any) {",
    "    await changeConsents.request({ capability, targetAgentId, displayedDiff });",
    "  },",
    "};",
    "",
  ].join("\n"));
  write(root, "server/src/__tests__/runtime-agent-action-port.test.ts", [
    "persists and replays only the closed hire receipt",
    "persists and replays only the closed %s configure receipt",
    "persists and replays only the closed pending-consent receipt",
    'result: { status: "created" }',
    'result: { status: "configured" }',
    'result: { status: "change_consent_requested" }',
    "",
  ].join("\n"));
  write(root, "server/src/__tests__/run-tools-routes.test.ts", [
    "serializes the closed %s action receipt identically as text and structured content",
    "structuredContent: { status }",
    "text: JSON.stringify({ status })",
    "",
  ].join("\n"));
  write(root, "packages/adapter-utils/src/server-utils.test.ts", 'PAPERCLIP_CLOUD_PROD_PROVIDER_TOKEN "operator-selected" sanitizeSshRemoteEnv\n');
  write(root, "packages/shared/src/validators/runtime-agent-configuration.test.ts", "keeps explicit provider-native configuration opaque without a prefix ban\nPAPERCLIP_CLOUD_PROD_PROVIDER_TOKEN\nexpect(adapterConfigSchema.parse(adapterConfig)).toEqual(adapterConfig)\n");
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts exact provenance-aware ACP child input boundary", () => {
  assert.deepEqual(providerIdentityBoundaryViolations(fixtureRoot()), []);
});

test("rejects a retired Paperclip child environment channel", () => {
  const root = fixtureRoot();
  const retired = ["PAPERCLIP", "API", "URL"].join("_");
  write(root, "server/src/legacy.ts", `const injected = ${JSON.stringify(retired)};\n`);
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) => entry.includes(retired)));
});

test("rejects a retired instruction materializer", () => {
  const root = fixtureRoot();
  write(root, "server/src/services/agent-instructions.ts", "export const legacy = true;\n");
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) => entry.includes("retired instruction owner")));
});

test("rejects an explicit-environment prefix ban", () => {
  const root = fixtureRoot();
  write(root, "packages/adapter-utils/src/remote-execution-env.ts", 'if (normalizedKey.startsWith("PAPERCLIP_")) continue;\n');
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) => entry.includes("prefix-banned")));
});

test("rejects opaque provider string inspection", () => {
  const root = fixtureRoot();
  write(root, "packages/shared/src/validators/agent.ts", "const FORBIDDEN_ADAPTER_STRING_PATTERN = /bridge/;\n");
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) => entry.includes("inspected")));
});

test("rejects loss of inherited control-plane scrubbing", () => {
  const root = fixtureRoot();
  write(root, "packages/adapter-utils/src/server-utils.ts", "export function sanitizeInheritedProviderChildEnv() {}\n...sanitizeInheritedProviderChildEnv(process.env)\n...opts.env\n");
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) => entry.includes('normalizedKey.startsWith("PAPERCLIP_")')));
});

test("rejects explicit configuration layered before inherited state", () => {
  const root = fixtureRoot();
  write(root, "packages/adapter-utils/src/acp-subprocess/process.ts", "const child = { ...hostLaunch.environment, ...sanitizeInheritedProviderChildEnv(process.env) };\n");
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) => entry.includes("must precede")));
});

test("rejects a Paperclip-authored setup prompt override", () => {
  const root = fixtureRoot();
  write(root, "server/src/services/issue-execution-attempt-executor.ts", "environment: Object.freeze({}),\nmessage: input.message,\nsystemPrompt: generated,\n");
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) => entry.includes("prompt override")));
});

test("rejects a raw hire configuration result at the provider action boundary", () => {
  const root = fixtureRoot();
  write(root, "server/src/services/runtime-agent-action-port.ts", [
    "type Options = { requestChangeConsent?: (input: unknown) => Promise<void> };",
    "export function create(service: any, options: Options) {",
    "  async function hire() { return service.hireFromRun({}); }",
    "  async function configure() { await service.configureFromRun({}); return { status: \"configured\" as const }; }",
    "  async function consent() { await options.requestChangeConsent({}); return { status: \"change_consent_requested\" as const }; }",
    "}",
    "",
  ].join("\n"));
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) =>
    entry.includes("raw hire configuration result")
  ));
});

test("rejects a raw configure result at the provider action boundary", () => {
  const root = fixtureRoot();
  write(root, "server/src/services/runtime-agent-action-port.ts", [
    "type Options = { requestChangeConsent?: (input: unknown) => Promise<void> };",
    "export function create(service: any, options: Options) {",
    "  async function hire() { await service.hireFromRun({}); return { status: \"created\" as const }; }",
    "  async function configure() { return await service.configureFromRun({}); }",
    "  async function consent() { await options.requestChangeConsent({}); return { status: \"change_consent_requested\" as const }; }",
    "}",
    "",
  ].join("\n"));
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) =>
    entry.includes("raw configure result")
  ));
});

test("rejects a raw consent row at the provider action boundary", () => {
  const root = fixtureRoot();
  write(root, "server/src/services/runtime-agent-action-port.ts", [
    "type Options = { requestChangeConsent?: (input: unknown) => Promise<void> };",
    "export function create(service: any, options: Options) {",
    "  async function hire() { await service.hireFromRun({}); return { status: \"created\" as const }; }",
    "  async function configure() { await service.configureFromRun({}); return { status: \"configured\" as const }; }",
    "  async function consent() { const consent = await options.requestChangeConsent({}); return { status: \"change_consent_requested\" as const, consent }; }",
    "}",
    "",
  ].join("\n"));
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) =>
    entry.includes("raw consent result")
  ));
});

test("rejects returning the raw consent row from server assembly", () => {
  const root = fixtureRoot();
  write(root, "server/src/index.ts", [
    "const assembly = {",
    "  requestChangeConsent({ capability, targetAgentId, displayedDiff }: any) {",
    "    return changeConsents.request({ capability, targetAgentId, displayedDiff });",
    "  },",
    "};",
    "",
  ].join("\n"));
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) =>
    entry.includes("raw control-plane row")
  ));
});

test("rejects route-only redaction when the provider action projection is absent", () => {
  const root = fixtureRoot();
  write(
    root,
    "server/src/services/runtime-agent-action-port.ts",
    "export function create(service: any) { return { hire: () => service.hireFromRun({}) }; }\n",
  );
  write(
    root,
    "server/src/routes/run-tools.ts",
    "const redacted = { status: result.status };\n",
  );
  assert.ok(providerIdentityBoundaryViolations(root).some((entry) =>
    entry.includes("runtime-agent-action-port.ts")
  ));
});
