import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const COMPILER = "apps/server/src/services/runtime-interface-compiler.ts";
const DATABASE_OWNER =
  "apps/server/src/services/runtime-interface-compiler-db.ts";
const MANAGED_TOOL_REGISTRY =
  "apps/server/src/services/paperclip-managed-tool-registry.ts";
const MANAGED_TOOL_DEFINITIONS =
  "apps/server/src/services/paperclip-managed-tool-definitions.ts";
const MANAGED_TOOL_RUNTIME =
  "apps/server/src/services/paperclip-managed-tool-runtime.ts";
const MANAGED_TASK_TOOLS =
  "apps/server/src/services/paperclip-managed-task-tools.ts";
const DATABASE_SNAPSHOT =
  "apps/server/src/services/runtime-interface-compiler-snapshot.ts";
const RUNTIME_AGENT_VALIDATOR =
  "packages/shared/src/validators/runtime-agent-configuration.ts";
const CAPABILITY_GATEWAY =
  "apps/server/src/services/prompt-capability-gateway.ts";
const RUN_TOOLS_ROUTE = "apps/server/src/routes/run-tools.ts";

/**
 * The compiler assembles one provider interface. It must select the managed
 * portion from the registry rather than recreating a second Paperclip ABI.
 * Plugin/recovery descriptors and the digest of that fully assembled surface
 * remain compiler concerns.
 */
const COMPILER_REQUIRED = [
  "projectPaperclipManagedTools,",
  "extends PaperclipManagedToolRuntimeProjectionInput",
  "...projectPaperclipManagedTools(input),",
  "compileRuntimeInterface",
  "function compiledRuntimeInterfaceDigest",
  "runtimeInterfaceDigest",
] as const;

/** Canonical public names, metadata, and Board schemas have one owner. */
const DEFINITIONS_REQUIRED = [
  "export const PAPERCLIP_MANAGED_TOOL_NAMES",
  "export const PAPERCLIP_MANAGED_TOOL_METADATA",
  "export const boardMcpInputSchemas",
  "export const BOARD_MANAGED_TOOLS",
] as const;

/** Canonical runtime projection contracts have one owner. */
const RUNTIME_REQUIRED = [
  "export interface PaperclipManagedToolRuntimeProjectionInput",
  "contextDial: ContextDial",
  "actionGrants:",
  "isCurrentOwner: boolean",
  "taskCreateDirectChildren:",
  "taskAssignTargets:",
  "creatorUpdateTargets:",
  "mentionTargets:",
  "export interface ProjectedPaperclipManagedToolDescriptor",
] as const;

/** Task-specific descriptor projection has one owner. */
const TASK_TOOLS_REQUIRED = [
  "resolveContextRetrievalPolicy(input.contextDial)",
  "export function projectRuntimeTaskCreate(",
  "input.actionGrants.task_create !== true",
  "input.taskCreateDirectChildren",
  "export function projectRuntimeTaskAssign(",
  "input.taskAssignTargets",
  "export function projectRuntimeTaskUpdate(",
  "input.creatorUpdateTargets",
  "input.isCurrentOwner",
  "export function projectRuntimeMentionAgent(",
  "input.mentionTargets",
] as const;

/** The registry selects the closed tool set and owns non-task projections. */
const REGISTRY_REQUIRED = [
  "function projectRuntimeAgentConfigure(",
  "input.actionGrants.agent_configure !== true",
  "function projectRuntimeTool(",
  "export function projectPaperclipManagedTools(",
  "normalizeRuntimeCommand(payload, scope)",
] as const;

/** Database code derives a snapshot; it does not define a provider ABI. */
const DATABASE_REQUIRED = [
  'from "./paperclip-managed-tool-registry.js";',
  "export function buildRuntimeInterfaceCompileInput(",
  "actionGrants,",
  "mentionTargets,",
] as const;

const CAPABILITY_REQUIRED = ["compileRuntimeInterface"] as const;

const RUN_TOOLS_REQUIRED = [
  'method: "initialize" | "tools/list" | "tools/call"',
  "gateway.listTools(token)",
  "gateway.callTool({",
] as const;

const MANAGED_PROJECTION_FIELDS = [
  "contextDial",
  "isCurrentOwner",
  "taskCreateDirectChildren",
  "taskAssignTargets",
  "creatorUpdateTargets",
  "mentionTargets",
] as const;

const MANAGED_CATALOG_TYPES = [
  "AgentCatalogEntry",
  "TaskCreateOwnerCatalogEntry",
  "TaskAssignOwnerCatalog",
  "CreatorUpdateTargetCatalogEntry",
] as const;

const RAW_MANAGED_DESCRIPTOR_HELPERS = [
  "buildRuntimeRetrievalAbi",
  "actionDescriptors",
  "taskCreateDescriptor",
  "taskAssignDescriptor",
  "taskUpdateDescriptor",
  "mentionDescriptor",
  "mentionBoardDescriptor",
  "listAgentsDescriptor",
  "agentReadDescriptor",
  "hireDescriptor",
  "configureDescriptor",
  "canonicalActionDescriptor",
  "zodToRuntimeJsonSchema",
  "parseRuntimeMentionArguments",
  "RuntimeRetrievalAbi",
  "RuntimeRetrievalInvocation",
  "PAPERCLIP_RETRIEVAL_TOOL_NAMES",
] as const;

const RAW_MANAGED_TOOL_LITERAL =
  /["'](?:list_company_tasks|list_sub_tasks|read_task_comments|read_task_agent_run|task_create|task_assign|task_update|mention_agent|mention_board|agent_hire|agent_configure|list_agents|agent_read)["']/;

function read(repositoryRoot: string, path: string): string | null {
  const absolutePath = resolve(repositoryRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null;
}

function between(source: string, start: string, end: string): string | null {
  const startOffset = source.indexOf(start);
  if (startOffset < 0) return null;
  const endOffset = source.indexOf(end, startOffset + start.length);
  return endOffset < 0
    ? source.slice(startOffset)
    : source.slice(startOffset, endOffset);
}

function rejectPattern(
  violations: string[],
  path: string,
  source: string,
  label: string,
  pattern: RegExp,
): void {
  if (pattern.test(source)) violations.push(`${path}: ${label}`);
}

/**
 * Ensures each managed-tool concern has one canonical owner. The registry
 * selects those owned definitions and projections; the compiler only assembles
 * them, and the provider gateway only consumes the compiled result.
 */
export function runtimeInterfaceCompilerBoundaryViolations(
  repositoryRoot: string,
): string[] {
  const violations = [
    ...requireFileTokens(repositoryRoot, COMPILER, COMPILER_REQUIRED),
    ...requireFileTokens(
      repositoryRoot,
      MANAGED_TOOL_DEFINITIONS,
      DEFINITIONS_REQUIRED,
    ),
    ...requireFileTokens(
      repositoryRoot,
      MANAGED_TOOL_RUNTIME,
      RUNTIME_REQUIRED,
    ),
    ...requireFileTokens(
      repositoryRoot,
      MANAGED_TASK_TOOLS,
      TASK_TOOLS_REQUIRED,
    ),
    ...requireFileTokens(repositoryRoot, MANAGED_TOOL_REGISTRY, REGISTRY_REQUIRED),
    ...requireFileTokens(repositoryRoot, DATABASE_OWNER, DATABASE_REQUIRED),
    ...requireFileTokens(
      repositoryRoot,
      CAPABILITY_GATEWAY,
      CAPABILITY_REQUIRED,
    ),
    ...requireFileTokens(repositoryRoot, RUN_TOOLS_ROUTE, RUN_TOOLS_REQUIRED),
  ];

  const compiler = read(repositoryRoot, COMPILER);
  if (compiler !== null) {
    const input = between(
      compiler,
      "export interface RuntimeInterfaceCompileInput",
      "interface CompiledRuntimeInterface",
    );
    if (input === null) {
      violations.push(`${COMPILER}: RuntimeInterfaceCompileInput is missing`);
    } else {
      rejectPattern(
        violations,
        COMPILER,
        input,
        "raw management permission rows entered RuntimeInterfaceCompileInput",
        /\b(?:principalPermission|permissionGrants|configureGrants|managementPermission)\b/,
      );
      rejectPattern(
        violations,
        COMPILER,
        input,
        "managed projection fields were redeclared instead of inherited from the registry",
        new RegExp(`\\b(?:${MANAGED_PROJECTION_FIELDS.join("|")})\\s*:`),
      );
    }

    const digest = between(
      compiler,
      "function compiledRuntimeInterfaceDigest",
      "export function runtimeInterfaceDigest",
    );
    if (digest === null) {
      violations.push(
        `${COMPILER}: assembled runtime-interface digest is missing`,
      );
    } else {
      rejectPattern(
        violations,
        COMPILER,
        digest,
        "raw managed authority entered the assembled runtime-interface digest",
        /\b(?:contextDial|actionGrants|isCurrentOwner|taskCreateDirectChildren|taskAssignTargets|creatorUpdateTargets|mentionTargets|principalPermission|permissionGrants|configureGrants|managementPermission)\b/,
      );
    }

    for (const helper of RAW_MANAGED_DESCRIPTOR_HELPERS) {
      if (compiler.includes(helper)) {
        violations.push(
          `${COMPILER}: rebuilds managed descriptor ABI via ${helper}`,
        );
      }
    }
    rejectPattern(
      violations,
      COMPILER,
      compiler,
      "directly branches on a concrete managed action grant",
      /\binput\.actionGrants\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*["'][^"']+["']\s*\])/,
    );
    rejectPattern(
      violations,
      COMPILER,
      compiler,
      "directly reads a managed projection catalog",
      new RegExp(`\\binput\\.(?:${MANAGED_PROJECTION_FIELDS.join("|")})\\b`),
    );
    rejectPattern(
      violations,
      COMPILER,
      compiler,
      "declares a raw managed tool name instead of selecting the registry projection",
      RAW_MANAGED_TOOL_LITERAL,
    );
    rejectPattern(
      violations,
      COMPILER,
      compiler,
      "imports a managed action schema/parser",
      /from\s+["']zod["']|\b(?:createTaskSchema|runtimeAgentConfigureActionSchema|runtimeAgentHireConfigurationSchema)\b/,
    );
    for (const catalogType of MANAGED_CATALOG_TYPES) {
      if (compiler.includes(catalogType)) {
        violations.push(
          `${COMPILER}: owns managed catalog type ${catalogType} instead of consuming the registry projection input`,
        );
      }
    }
  }

  for (const path of [
    MANAGED_TOOL_DEFINITIONS,
    MANAGED_TOOL_RUNTIME,
    MANAGED_TASK_TOOLS,
    MANAGED_TOOL_REGISTRY,
  ]) {
    const source = read(repositoryRoot, path);
    if (source === null) continue;
    rejectPattern(
      violations,
      path,
      source,
      "managed-tool owner depends on the runtime-interface compiler",
      /from\s+["'][^"']*runtime-interface-compiler[^"']*["']/,
    );
  }

  for (const path of [
    DATABASE_OWNER,
    DATABASE_SNAPSHOT,
    MANAGED_TOOL_DEFINITIONS,
    MANAGED_TOOL_REGISTRY,
    MANAGED_TOOL_RUNTIME,
    MANAGED_TASK_TOOLS,
    RUNTIME_AGENT_VALIDATOR,
  ]) {
    const source = read(repositoryRoot, path);
    if (source === null) continue;
    rejectPattern(
      violations,
      path,
      source,
      "legacy agent_configure target-catalog path remains",
      /\b(?:configureTargets|configureGrants|principalPermissionGrants|RuntimeAgentConfigureTarget|explicitConfigureTargets|runtimeAgentConfigureActionSchemaForTargets)\b/,
    );
  }

  for (const path of [CAPABILITY_GATEWAY, RUN_TOOLS_ROUTE]) {
    const source = read(repositoryRoot, path);
    if (source === null) continue;
    rejectPattern(
      violations,
      path,
      source,
      "raw management permission rows entered the run capability surface",
      /\b(?:principalPermissionGrants|configureGrants|managementPermission)\b/,
    );
  }

  return [...new Set(violations)].sort();
}

export function assertRuntimeInterfaceCompilerBoundary(
  repositoryRoot: string,
): void {
  assertNoGateViolations(
    "Runtime-interface compiler boundary check",
    runtimeInterfaceCompilerBoundaryViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertRuntimeInterfaceCompilerBoundary(resolve(import.meta.dirname, ".."));
    console.log("Runtime-interface compiler boundary check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
