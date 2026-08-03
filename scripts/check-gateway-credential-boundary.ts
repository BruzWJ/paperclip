import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  listRepositoryTextFiles,
  literalRemovalViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const ROUTES = "server/src/routes/tool-gateway.ts";
const NAMED_GATEWAY = "server/src/services/tool-gateway.ts";
const NAMED_SCHEMA = "packages/db/schema/tool_access.ts";
const RUN_ROUTE = "server/src/routes/run-tools.ts";
const RUN_GATEWAY = "server/src/services/prompt-capability-gateway.ts";
const RUN_MINT_OWNER =
  "server/src/services/issue-execution-prompt-cycle-postgres.ts";
const ATTEMPT_EXECUTOR =
  "server/src/services/issue-execution-attempt-executor.ts";
const COMPILER = "server/src/services/runtime-interface-compiler.ts";
const SERVICES_INDEX = "server/src/services/index.ts";
const SELF = "scripts/check-gateway-credential-boundary.ts";
const SELF_TEST = "scripts/check-gateway-credential-boundary.test.ts";

const GENERIC_SESSION_TOKENS = [
  "/api/tool-gateway/sessions",
  '"/tool-gateway/sessions',
  "toolGatewaySessions",
  "ToolGatewaySessions",
  "createToolGatewaySession",
  "revokeToolGatewaySession",
  "createGatewaySession",
  "revokeGatewaySession",
  "CreateToolGatewaySession",
  "RevokeToolGatewaySession",
] as const;

function read(repositoryRoot: string, path: string): string | null {
  const absolute = resolve(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function block(
  source: string,
  start: string,
  end: string,
): string | null {
  const startOffset = source.indexOf(start);
  if (startOffset < 0) return null;
  const endOffset = source.indexOf(end, startOffset + start.length);
  return endOffset < 0
    ? source.slice(startOffset)
    : source.slice(startOffset, endOffset);
}

function isTestPath(path: string): boolean {
  return path.includes("/__tests__/") ||
    /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(path);
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function productionSourceFiles(repositoryRoot: string) {
  return listRepositoryTextFiles(repositoryRoot, ["server/src", "packages"])
    .map((absolute) => ({
      absolute,
      path: relative(repositoryRoot, absolute).replaceAll("\\", "/"),
    }))
    .filter(({ path }) => !isTestPath(path));
}

/**
 * Locks the three credential classes into disjoint owners and namespaces:
 * named external-gateway tokens, run prompt-capability bearers, and plugin
 * invocation run-context handles. It deliberately preserves the named gateway
 * while deleting the former caller-selected generic gateway-session surface.
 */
export function gatewayCredentialBoundaryViolations(
  repositoryRoot: string,
): string[] {
  const violations = [
    ...requireFileTokens(repositoryRoot, ROUTES, [
      'router.post("/tool-gateway/gateways/:gatewayId/tokens"',
      'router.post("/tool-gateway/gateway-tokens/:tokenId/revoke"',
      'router.get("/tool-gateway/gateways/:gatewayId/mcp"',
      'router.post("/tool-gateway/gateways/:gatewayId/mcp"',
      "createNamedGatewayToken({",
      "revokeNamedGatewayToken({",
      "assertRunBearerRejectedByNamedGateway(token)",
    ]),
    ...requireFileTokens(repositoryRoot, NAMED_GATEWAY, [
      "createNamedGateway(input:",
      "updateNamedGateway(input:",
      "createNamedGatewayToken(input:",
      "revokeNamedGatewayToken(input:",
      "initializeNamedGatewayProtocol(input:",
      "listToolsForNamedGateway(input:",
      "generateNamedGatewayToken",
      "namedGatewayTokenId",
      "hashGatewayToken",
      "consumeProtocolRateLimit",
      "policyService.decide",
      "approval_requested",
      "writeAudit",
    ]),
    ...requireFileTokens(repositoryRoot, NAMED_SCHEMA, [
      "export const toolMcpGateways = pgTable(",
      "export const toolMcpGatewayTokens = pgTable(",
      'tokenHash: text("token_hash").notNull()',
      'expiresAt: timestamp("expires_at"',
      'revokedAt: timestamp("revoked_at"',
      "tool_mcp_gateway_tokens_token_hash_uq",
    ]),
    ...requireFileTokens(repositoryRoot, RUN_ROUTE, [
      'router.post("/run-tools"',
      "gateway.listTools(token)",
      "gateway.callTool({",
    ]),
    ...requireFileTokens(repositoryRoot, RUN_GATEWAY, [
      'const PROMPT_CAPABILITY_BEARER_PREFIX = "pc_run_v1_"',
      'const PLUGIN_RUN_CONTEXT_HANDLE_PREFIX = "pc_plugin_ctx_v1_"',
      "PROMPT_CAPABILITY_BEARER_PATTERN",
      "PLUGIN_RUN_CONTEXT_HANDLE_PATTERN",
      "assertPromptCapabilityCredential(bearer)",
      "assertPluginRunContextHandle(handle)",
      "resolvePluginRunContextHash(",
    ]),
    ...requireFileTokens(repositoryRoot, RUN_MINT_OWNER, [
      "mintPromptCapabilityBearer",
      "async mintPendingCapability(prompt)",
      "const bearer = mintPromptCapabilityBearer()",
    ]),
    ...requireFileTokens(repositoryRoot, ATTEMPT_EXECUTOR, [
      "repository.mintPendingCapability(input.prompt)",
    ]),
    ...requireFileTokens(repositoryRoot, COMPILER, [
      "export function compileRuntimeInterface",
    ]),
    ...literalRemovalViolations(repositoryRoot, {
      forbiddenTokens: GENERIC_SESSION_TOKENS,
      ignoredPaths: [SELF, SELF_TEST],
      roots: [
        ".agents",
        ".github",
        "cli",
        "doc",
        "docs",
        "docker",
        "evals",
        "packages",
        "server",
        "ui",
      ],
    }),
  ];

  const runGateway = read(repositoryRoot, RUN_GATEWAY);
  if (runGateway !== null) {
    if (/\bclassifyCapabilityCredential\b/.test(runGateway)) {
      violations.push(
        `${RUN_GATEWAY}: shared credential classifier/union is forbidden`,
      );
    }
    if (
      /^.*PROMPT_CAPABILITY_BEARER_PREFIX.*(?:\|\||&&).*PLUGIN_RUN_CONTEXT_HANDLE_PREFIX.*$/m.test(
        runGateway,
      ) ||
      /^.*PLUGIN_RUN_CONTEXT_HANDLE_PREFIX.*(?:\|\||&&).*PROMPT_CAPABILITY_BEARER_PREFIX.*$/m.test(
        runGateway,
      )
    ) {
      violations.push(
        `${RUN_GATEWAY}: prompt bearers and plugin handles share a parser branch`,
      );
    }
    if (/\b(?:pcgw_|namedGatewayTokenId|hashGatewayToken)\b/.test(runGateway)) {
      violations.push(
        `${RUN_GATEWAY}: named-gateway credentials entered the run/plugin authenticator`,
      );
    }
  }

  const namedGateway = read(repositoryRoot, NAMED_GATEWAY);
  if (namedGateway !== null) {
    const namedAuthentication = block(
      namedGateway,
      "async function namedGatewaySessionFromBearer",
      '  /**\n   * A "test-origin" invocation',
    );
    if (namedAuthentication === null) {
      violations.push(
        `${NAMED_GATEWAY}: named gateway bearer authenticator is missing`,
      );
    } else {
      for (const forbidden of [
        "mintPromptCapabilityBearer",
        "assertPromptCapabilityCredential",
        "resolvePluginRunContext",
        "mintPluginRunContext",
        "authenticateBearerHash",
      ]) {
        if (namedAuthentication.includes(forbidden)) {
          violations.push(
            `${NAMED_GATEWAY}: named gateway authenticator crosses into ${forbidden}`,
          );
        }
      }
      for (const required of [
        "namedGatewayTokenId",
        "hashGatewayToken",
        "toolMcpGatewayTokens",
        "revokedAt",
        "expiresAt",
      ]) {
        if (!namedAuthentication.includes(required)) {
          violations.push(
            `${NAMED_GATEWAY}: named gateway authenticator is missing ${required}`,
          );
        }
      }
    }
  }

  const runRoute = read(repositoryRoot, RUN_ROUTE);
  if (
    runRoute !== null &&
    /\b(?:namedGatewayTokenId|initializeNamedGatewayProtocol|listToolsForNamedGateway|pcgw_)\b/.test(
      runRoute,
    )
  ) {
    violations.push(
      `${RUN_ROUTE}: run-tools endpoint accepts or falls back to named-gateway credentials`,
    );
  }

  const serviceIndex = read(repositoryRoot, SERVICES_INDEX);
  if (serviceIndex?.includes("mintPromptCapabilityBearer")) {
    violations.push(
      `${SERVICES_INDEX}: raw run-bearer mint is exported outside its internal owner`,
    );
  }

  for (const { absolute, path } of productionSourceFiles(repositoryRoot)) {
    if (path === RUN_GATEWAY || path === RUN_MINT_OWNER) continue;
    const source = readFileSync(absolute, "utf8");
    let offset = source.search(/\bmintPromptCapabilityBearer\s*\(/);
    if (offset >= 0) {
      violations.push(
        `${path}:${lineAt(source, offset)}: run capability bearer minted outside the trusted prompt-cycle owner`,
      );
    }
    offset = source.search(
      /(?:namedGatewayToken|pcgw_)[\s\S]{0,180}(?:resolvePluginRunContext|mintPluginRunContext)|(?:resolvePluginRunContext|mintPluginRunContext)[\s\S]{0,180}(?:namedGatewayToken|pcgw_)/,
    );
    if (offset >= 0) {
      violations.push(
        `${path}:${lineAt(source, offset)}: named and plugin credential paths contain a fallback/conversion branch`,
      );
    }
  }

  return [...new Set(violations)].sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  assertNoGateViolations(
    "gateway credential boundary",
    gatewayCredentialBoundaryViolations(repositoryRoot),
  );
  console.log("gateway credential boundary passed");
}
