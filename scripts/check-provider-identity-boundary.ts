import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  literalRemovalViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const SHARED_BOUNDARY = "packages/shared/src/provider-child-boundary.ts";
const ADAPTER_VALIDATOR = "packages/shared/src/validators/agent.ts";
const ATTEMPT_EXECUTOR =
  "apps/server/src/services/task-execution-attempt-executor.ts";
const AGENT_ACTION_PORT =
  "apps/server/src/services/runtime-agent-action-port.ts";
const SERVER_ENTRY = "apps/server/src/index.ts";
const AGENT_ACTION_PORT_TEST =
  "apps/server/src/__tests__/runtime-agent-action-port.test.ts";
const RUN_TOOLS_ROUTE_TEST =
  "apps/server/src/__tests__/run-tools-routes.test.ts";

const RETIRED_PROVIDER_IDENTITY_TOKENS = [
  "AdapterExecutionContext.agent",
  "buildPaperclipEnv",
  "buildPaperclipWakePayload",
  "PAPERCLIP_WAKE_PAYLOAD_KEY",
  "formatPaperclipWakePrompt",
  "renderPaperclipWakePrompt",
  "DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_TASK_WORK_MODE",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_APPROVAL_ID",
  "PAPERCLIP_APPROVAL_STATUS",
  "PAPERCLIP_LINKED_TASK_IDS",
  "PAPERCLIP_WAKE_PAYLOAD_JSON",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_WORKSPACE_CWD",
  "PAPERCLIP_WORKSPACE_SOURCE",
  "PAPERCLIP_WORKSPACE_STRATEGY",
  "PAPERCLIP_WORKSPACE_ID",
  "PAPERCLIP_WORKSPACE_REPO_URL",
  "PAPERCLIP_WORKSPACE_REPO_REF",
  "PAPERCLIP_WORKSPACE_BRANCH",
  "PAPERCLIP_WORKSPACE_WORKTREE_PATH",
  "PAPERCLIP_WORKSPACES_JSON",
  "/api/agents/me",
  "agentInstructionsService",
  "instructionsBundle",
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
  "agentsMdPath",
  "promptTemplate",
  "bootstrapPromptTemplate",
] as const;

const RETIRED_INSTRUCTION_OWNERS = [
  "apps/server/src/services/agent-instructions.ts",
  "apps/server/src/services/default-agent-instructions.ts",
] as const;

const RETIRED_PROVIDER_PROCESS_OWNERS = [
  "packages/adapter-utils/src/execution-target.ts",
  "packages/adapter-utils/src/server-utils.ts",
  "packages/adapter-utils/src/local-process-sandbox.ts",
] as const;

function read(repositoryRoot: string, path: string): string | null {
  const absolute = resolve(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

/**
 * Proves provider children receive only provider-native configuration plus the
 * canonical ACP request, never Paperclip identity, REST, instruction, or task
 * context channels.
 */
export function providerIdentityBoundaryViolations(
  repositoryRoot: string,
): string[] {
  const violations = [
    ...literalRemovalViolations(repositoryRoot, {
      forbiddenTokens: RETIRED_PROVIDER_IDENTITY_TOKENS,
      ignoredPaths: [
        "scripts/check-provider-identity-boundary.ts",
        "scripts/check-provider-identity-boundary.test.ts",
        "scripts/check-cross-task-memory-removal.ts",
        "scripts/check-cross-task-memory-removal.test.ts",
      ],
      roots: [
        ".agents",
        ".github",
        "apps",
        "packages",
        "doc",
        "evals",
        "releases",
        "README.md",
        "ROADMAP.md",
      ],
    }),
    ...requireFileTokens(repositoryRoot, SHARED_BOUNDARY, [
      "export function isProviderChildReservedEnvironmentKey",
      'const prefix = "PAPERCLIP_"',
      "PAPERCLIP_PROVIDER_CHILD_RESERVED_SUFFIXES.has(",
      "SERVER_SECRET_ENV_KEYS.has(normalized)",
    ]),
    ...requireFileTokens(repositoryRoot, ADAPTER_VALIDATOR, [
      'from "../provider-child-boundary.js"',
      "isEnvironmentEntry && isProviderChildReservedEnvironmentKey(key)",
      "if (typeof value === \"string\") return;",
    ]),
    ...requireFileTokens(repositoryRoot, ATTEMPT_EXECUTOR, [
      "executeAcpxOneShotPrompt",
      "mcpServers: Object.freeze([",
      "message: input.request.message",
    ]),
    ...requireFileTokens(repositoryRoot, AGENT_ACTION_PORT, [
      ") => Promise<void>",
      "await service.hireFromRun({",
      'return { status: "created" as const };',
      "await service.configureFromRun({",
      'return { status: "configured" as const };',
      "await options.requestChangeConsent({",
      'return { status: "change_consent_requested" as const };',
    ]),
    ...requireFileTokens(repositoryRoot, SERVER_ENTRY, [
      "async requestChangeConsent({",
      "await changeConsents.request({",
    ]),
    ...requireFileTokens(repositoryRoot, AGENT_ACTION_PORT_TEST, [
      "persists and replays only the closed hire receipt",
      "persists and replays only the closed %s configure receipt",
      "persists and replays only the closed pending-consent receipt",
      'result: { status: "created" }',
      'result: { status: "configured" }',
      'result: { status: "change_consent_requested" }',
    ]),
    ...requireFileTokens(repositoryRoot, RUN_TOOLS_ROUTE_TEST, [
      "serializes the closed %s action receipt identically as text and structured content",
      "structuredContent: { status }",
      "text: JSON.stringify({ status })",
    ]),
    ...requireFileTokens(
      repositoryRoot,
      "packages/shared/src/validators/runtime-agent-configuration.test.ts",
      [
        "keeps explicit provider-native configuration opaque without a prefix ban",
        "PAPERCLIP_CLOUD_PROD_PROVIDER_TOKEN",
        "expect(adapterConfigSchema.parse(adapterConfig)).toEqual(adapterConfig)",
      ],
    ),
  ];

  for (const path of RETIRED_INSTRUCTION_OWNERS) {
    if (read(repositoryRoot, path) !== null) {
      violations.push(`${path}: retired instruction owner still exists`);
    }
  }
  for (const path of RETIRED_PROVIDER_PROCESS_OWNERS) {
    if (read(repositoryRoot, path) !== null) {
      violations.push(`${path}: retired provider-process owner still exists`);
    }
  }

  const validator = read(repositoryRoot, ADAPTER_VALIDATOR);
  if (
    validator !== null &&
    (/FORBIDDEN_ADAPTER_STRING_PATTERN/.test(validator) ||
      /key\.startsWith\(["']PAPERCLIP_/.test(validator))
  ) {
    violations.push(
      `${ADAPTER_VALIDATOR}: provider-native configuration is inspected or prefix-banned`,
    );
  }

  for (const path of [ATTEMPT_EXECUTOR]) {
    const source = read(repositoryRoot, path);
    if (
      source !== null &&
      /(?:systemPrompt|setupPrompt|promptPrefix|instructionOverride)\s*:/.test(
        source,
      )
    ) {
      violations.push(`${path}: Paperclip-authored prompt override survives`);
    }
  }

  const actionPort = read(repositoryRoot, AGENT_ACTION_PORT);
  if (actionPort !== null) {
    for (const [label, pattern] of [
      [
        "raw hire configuration result",
        /return\s+(?:await\s+)?service\.hireFromRun\s*\(/,
      ],
      [
        "raw configure result",
        /return\s+await\s+service\.configureFromRun\s*\(/,
      ],
      [
        "raw consent result",
        /\b(?:const|let)\s+consent\s*=\s*await\s+options\.requestChangeConsent\s*\(/,
      ],
    ] as const) {
      if (pattern.test(actionPort)) {
        violations.push(
          `${AGENT_ACTION_PORT}: provider action boundary returns ${label}`,
        );
      }
    }
  }

  const serverEntry = read(repositoryRoot, SERVER_ENTRY);
  if (
    serverEntry !== null &&
    /requestChangeConsent\s*\([^)]*\)\s*\{[\s\S]{0,800}?return\s+changeConsents\.request\s*\(/.test(
      serverEntry,
    )
  ) {
    violations.push(
      `${SERVER_ENTRY}: change-consent assembly returns the raw control-plane row`,
    );
  }

  return [...new Set(violations)].sort();
}

export function assertProviderIdentityBoundary(repositoryRoot: string): void {
  assertNoGateViolations(
    "Provider identity boundary check",
    providerIdentityBoundaryViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertProviderIdentityBoundary(resolve(import.meta.dirname, ".."));
    console.log("Provider identity boundary check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
