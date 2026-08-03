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
import { gatewayCredentialBoundaryViolations } from "./check-gateway-credential-boundary.ts";

const roots = new Set<string>();

function write(root: string, path: string, source: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
}

function replace(root: string, path: string, from: string, to: string): void {
  write(root, path, readFileSync(join(root, path), "utf8").replace(from, to));
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-gateway-credential-gate-"));
  roots.add(root);
  write(
    root,
    "server/src/routes/tool-gateway.ts",
    [
      'router.post("/tool-gateway/gateways/:gatewayId/tokens", () => createNamedGatewayToken({}));',
      'router.post("/tool-gateway/gateway-tokens/:tokenId/revoke", () => revokeNamedGatewayToken({}));',
      'router.get("/tool-gateway/gateways/:gatewayId/mcp", () => assertRunBearerRejectedByNamedGateway(token));',
      'router.post("/tool-gateway/gateways/:gatewayId/mcp", () => assertRunBearerRejectedByNamedGateway(token));',
      "",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/tool-gateway.ts",
    [
      "generateNamedGatewayToken; namedGatewayTokenId; hashGatewayToken; consumeProtocolRateLimit;",
      "policyService.decide(); approval_requested; writeAudit();",
      "async function namedGatewaySessionFromBearer() {",
      "  namedGatewayTokenId; hashGatewayToken; toolMcpGatewayTokens; revokedAt; expiresAt;",
      "}",
      "  /**",
      '   * A "test-origin" invocation',
      " */",
      "return {",
      "async createNamedGateway(input: unknown) {},",
      "async updateNamedGateway(input: unknown) {},",
      "async createNamedGatewayToken(input: unknown) {},",
      "async revokeNamedGatewayToken(input: unknown) {},",
      "async initializeNamedGatewayProtocol(input: unknown) {},",
      "async listToolsForNamedGateway(input: unknown) {},",
      "};",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/tool_access.ts",
    [
      "export const toolMcpGateways = pgTable(",
      "export const toolMcpGatewayTokens = pgTable(",
      'tokenHash: text("token_hash").notNull(),',
      'expiresAt: timestamp("expires_at"),',
      'revokedAt: timestamp("revoked_at"),',
      "tool_mcp_gateway_tokens_token_hash_uq",
      "",
    ].join("\n"),
  );
  write(
    root,
    "server/src/routes/run-tools.ts",
    'router.post("/run-tools", () => { gateway.listTools(token); gateway.callTool({}); });\n',
  );
  write(
    root,
    "server/src/services/prompt-capability-gateway.ts",
    [
      'const PROMPT_CAPABILITY_BEARER_PREFIX = "pc_run_v1_";',
      'const PLUGIN_RUN_CONTEXT_HANDLE_PREFIX = "pc_plugin_ctx_v1_";',
      "const PROMPT_CAPABILITY_BEARER_PATTERN = /^pc_run_v1_x$/;",
      "const PLUGIN_RUN_CONTEXT_HANDLE_PATTERN = /^pc_plugin_ctx_v1_x$/;",
      "function mintPromptCapabilityBearer() {}",
      "function authenticate(bearer: string) { assertPromptCapabilityCredential(bearer); }",
      "function assertPluginRunContextHandle(handle: string) {}",
      "function plugin(handle: string) { assertPluginRunContextHandle(handle); resolvePluginRunContextHash(handle); }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/issue-execution-prompt-cycle-postgres.ts",
    [
      "import { mintPromptCapabilityBearer } from './prompt-capability-gateway.js';",
      "const repository = {",
      "async mintPendingCapability(prompt) {",
      "  const bearer = mintPromptCapabilityBearer();",
      "},",
      "};",
      "",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/issue-execution-attempt-executor.ts",
    "await repository.mintPendingCapability(input.prompt);\n",
  );
  write(
    root,
    "server/src/services/runtime-interface-compiler.ts",
    "export function compileRuntimeInterface() {}\n",
  );
  write(root, "server/src/services/index.ts", "export {};\n");
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts three disjoint credential owners and the retained named gateway", () => {
  assert.deepEqual(gatewayCredentialBoundaryViolations(fixtureRoot()), []);
});

test("rejects removal of a retained named gateway route", () => {
  const root = fixtureRoot();
  replace(
    root,
    "server/src/routes/tool-gateway.ts",
    'router.post("/tool-gateway/gateways/:gatewayId/tokens"',
    'router.post("/gone"',
  );
  assert.ok(gatewayCredentialBoundaryViolations(root).some((v) => v.includes("missing canonical ownership token")));
});

for (const token of [
  "/api/tool-gateway/sessions",
  "createToolGatewaySession",
] as const) {
  test(`rejects retired generic session surface ${token}`, () => {
    const root = fixtureRoot();
    write(root, "server/src/routes/legacy.ts", `export const legacy = ${JSON.stringify(token)};\n`);
    assert.ok(gatewayCredentialBoundaryViolations(root).some((v) => v.includes(token)));
  });
}

test("rejects a shared run/plugin credential classifier", () => {
  const root = fixtureRoot();
  write(
    root,
    "server/src/services/prompt-capability-gateway.ts",
    `${readFileSync(join(root, "server/src/services/prompt-capability-gateway.ts"), "utf8")}\nfunction classifyCapabilityCredential() {}\n`,
  );
  assert.ok(gatewayCredentialBoundaryViolations(root).some((v) => v.includes("classifier/union")));
});

test("rejects named-token authentication through the run gateway", () => {
  const root = fixtureRoot();
  write(
    root,
    "server/src/services/prompt-capability-gateway.ts",
    `${readFileSync(join(root, "server/src/services/prompt-capability-gateway.ts"), "utf8")}\nnamedGatewayTokenId(token);\n`,
  );
  assert.ok(gatewayCredentialBoundaryViolations(root).some((v) => v.includes("named-gateway credentials entered")));
});

test("rejects run authentication in the named-token owner", () => {
  const root = fixtureRoot();
  replace(
    root,
    "server/src/services/tool-gateway.ts",
    "  namedGatewayTokenId;",
    "  assertPromptCapabilityCredential; namedGatewayTokenId;",
  );
  assert.ok(gatewayCredentialBoundaryViolations(root).some((v) => v.includes("crosses into assertPromptCapabilityCredential")));
});

test("rejects named-token fallback in run-tools", () => {
  const root = fixtureRoot();
  write(
    root,
    "server/src/routes/run-tools.ts",
    'router.post("/run-tools", () => { namedGatewayTokenId(token); gateway.listTools(token); gateway.callTool({}); });\n',
  );
  assert.ok(gatewayCredentialBoundaryViolations(root).some((v) => v.includes("run-tools endpoint accepts")));
});

test("rejects a second production run-bearer mint caller", () => {
  const root = fixtureRoot();
  write(root, "server/src/services/rogue-mint.ts", "mintPromptCapabilityBearer();\n");
  assert.ok(gatewayCredentialBoundaryViolations(root).some((v) => v.includes("minted outside")));
});

test("rejects exporting the raw run-bearer mint", () => {
  const root = fixtureRoot();
  write(root, "server/src/services/index.ts", "export { mintPromptCapabilityBearer };\n");
  assert.ok(gatewayCredentialBoundaryViolations(root).some((v) => v.includes("raw run-bearer mint is exported")));
});

test("rejects loss of named token hash/expiry/revocation enforcement", () => {
  const root = fixtureRoot();
  replace(
    root,
    "server/src/services/tool-gateway.ts",
    "  namedGatewayTokenId; hashGatewayToken; toolMcpGatewayTokens; revokedAt; expiresAt;",
    "  namedGatewayTokenId; hashGatewayToken; toolMcpGatewayTokens; revokedAt;",
  );
  assert.ok(gatewayCredentialBoundaryViolations(root).some((v) => v.includes("missing expiresAt")));
});
