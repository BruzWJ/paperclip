import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  listRepositoryTextFiles,
  literalRemovalViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const IGNORED_PATHS = [
  "scripts/check-legacy-execution-surface-removal.ts",
  "scripts/check-legacy-execution-surface-removal.test.ts",
] as const;

/** Exact retired public, schema, descriptor, and dependency identities. */
const FORBIDDEN_TOKENS = [
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
] as const;

const TOOL_GATEWAY = "apps/server/src/services/tool-gateway.ts";
const RUNTIME_COMPILER =
  "apps/server/src/services/runtime-interface-compiler.ts";
const SUMMARY_SERVICE = "apps/server/src/services/summary-slots.ts";
const SUMMARY_FINALIZER =
  "apps/server/src/services/summary-slot-finalization.ts";
const SUMMARY_ROUTE = "apps/server/src/routes/summary-slots.ts";
const SUMMARY_API = "packages/shared/src/api.ts";
const SUMMARY_TYPES = "packages/shared/src/types/summary-slot.ts";
const SUMMARY_VALIDATOR =
  "packages/shared/src/validators/summary-slot.ts";
const SUMMARY_UI_API = "apps/ui/src/api/summarySlots.ts";
const DISPATCHER = "apps/server/src/services/issue-execution-dispatcher.ts";
const POSTGRES_DISPATCHER =
  "apps/server/src/services/issue-execution-dispatcher-postgres.ts";
const POSTGRES_TRIGGER =
  "apps/server/src/services/issue-execution-postgres.ts";
const SYSTEM_ESCALATION =
  "apps/server/src/services/system-escalation-postgres.ts";
const ORDINARY_ISSUES = "apps/server/src/services/ordinary-issue-runtime.ts";

const ACTIVE_EXECUTION_DOCUMENTS = [
  "AGENTS.md",
  "adapter-plugin.md",
  "doc/DEVELOPING.md",
  "doc/GOAL.md",
  "doc/LOW-TRUST-PRESETS.md",
  "doc/PRODUCT.md",
  "doc/SPEC-implementation.md",
  "doc/SPEC.md",
  "doc/spec/agents-runtime.md",
  "apps/docs/adapters/creating-an-adapter.md",
  "apps/docs/adapters/external-adapters.md",
  "apps/docs/adapters/overview.md",
  "apps/docs/agents-runtime.md",
  "apps/docs/api/agents.md",
  "apps/docs/guides/board-operator/execution-workspaces-and-runtime-services.md",
  "apps/docs/specs/cliphub-plan.md",
  "apps/docs/start/architecture.md",
  "apps/docs/start/what-is-paperclip.md",
  "packages/adapters/AUTHORING.md",
] as const;

const RETIRED_EXECUTION_DOCUMENTATION_CLAIMS = [
  /\bgeneric\s+`process`\s+and\s+`http`\s+transports\b/i,
  /\b(?:complete ordered typed|full)\s+ABI\b/i,
  /\bBuilt-in adapters include[\s\S]{0,160}\bHTTP\/gateway providers\b/i,
  /\bLocal and remote adapters receive\b/i,
  /\bLocal adapters (?:use|receive)[\s\S]{0,160}\bremote adapters (?:consume|receive)\b/i,
  /\bThe adapter's restore step\b/i,
  /\bAn adapter lowers the closed issue-execution request\b/i,
  /\bLocal CLIs,\s*gateways,\s*HTTP,\s*plugins\b/i,
  /\bcompatibleAdapters\b[^\n]*["']process["'][^\n]*["']http["']/i,
] as const;

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isProductionSource(path: string): boolean {
  return (
    SOURCE_EXTENSIONS.has(extname(path)) &&
    !path.includes("/__tests__/") &&
    !path.includes("/fixtures/") &&
    !/(?:^|\/)(?:__fixtures__)(?:\/|$)/.test(path) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}

function lineNumberAt(source: string, offset: number): number {
  return source.slice(0, Math.max(0, offset)).split("\n").length;
}

function addPatternViolations(
  violations: string[],
  path: string,
  source: string,
  expression: RegExp,
  reason: string,
): void {
  const flags = expression.flags.includes("g")
    ? expression.flags
    : `${expression.flags}g`;
  const matcher = new RegExp(expression.source, flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    violations.push(
      `${path}:${lineNumberAt(source, match.index)}: ${reason}: ${match[0]}`,
    );
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
}

function read(repositoryRoot: string, path: string): string | null {
  const absolute = resolve(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function structuralRemovalViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  const toolGateway = read(repositoryRoot, TOOL_GATEWAY);
  if (toolGateway !== null) {
    addPatternViolations(
      violations,
      TOOL_GATEWAY,
      toolGateway,
      /\b(?:allTools|pluginTools)\s*\(/,
      "retired static Tool Gateway collector is forbidden",
    );
    addPatternViolations(
      violations,
      TOOL_GATEWAY,
      toolGateway,
      /\b(?:const|let|var|function)\s+(?:allTools|pluginTools)\b/,
      "retired static Tool Gateway owner is forbidden",
    );
    addPatternViolations(
      violations,
      TOOL_GATEWAY,
      toolGateway,
      /(?:\b(?:source|providerType)\s*:\s*["']paperclip["'][\s\S]{0,600}\binputSchema\b|\binputSchema\b[\s\S]{0,600}\b(?:source|providerType)\s*:\s*["']paperclip["'])/,
      "Tool Gateway cannot own static Paperclip run-tool descriptors",
    );
    addPatternViolations(
      violations,
      TOOL_GATEWAY,
      toolGateway,
      /\bPAPERCLIP_(?:RUNTIME|RETRIEVAL)_TOOL_NAMES\b/,
      "Tool Gateway cannot import the compiler's Paperclip tool catalog",
    );
  }

  const productionFiles = listRepositoryTextFiles(repositoryRoot, [
    "packages/cli/src",
    "packages",
    "apps/server/src",
    "apps/ui/src",
  ]);
  for (const absolutePath of productionFiles) {
    const path = normalizePath(relative(repositoryRoot, absolutePath));
    if (!isProductionSource(path)) continue;
    const source = readFileSync(absolutePath, "utf8");

    if (path !== TOOL_GATEWAY) {
      addPatternViolations(
        violations,
        path,
        source,
        /(?:import|export)[\s\S]{0,300}\b(?:allTools|pluginTools)\b[\s\S]{0,300}from\s*["'][^"']*tool-gateway(?:\.[^"']*)?["']/,
        "retired Tool Gateway collector cannot be aliased or re-exported",
      );
    }
    if (path !== RUNTIME_COMPILER) {
      addPatternViolations(
        violations,
        path,
        source,
        /\b\w*(?:static\w*Paperclip|Paperclip\w*Static|builtin\w*Paperclip)\w*Tool\w*\b/i,
        "renamed static Paperclip run-tool catalog is forbidden",
      );
    }

    addPatternViolations(
      violations,
      path,
      source,
      /\b(?:\w*Interaction\w*(?:Continuation|Continue|Resume|Wakeup|Wake|Dispatch)\w*|\w*(?:Continuation|Continue|Resume|Wakeup|Wake|Dispatch)\w*Interaction\w*)\b/i,
      "interaction continuation aliases are forbidden",
    );
    addPatternViolations(
      violations,
      path,
      source,
      /\b(?:enqueue|queue|request|schedule|trigger|invoke|dispatch|build)\w*(?:Wakeup|Wake)\w*\b|\b\w*(?:Wakeup|Wake)\w*(?:enqueue|queue|request|schedule|trigger|invoke|dispatch|build)\w*\b/i,
      "generic wake wrapper aliases are forbidden",
    );
    addPatternViolations(
      violations,
      path,
      source,
      /\bwakeup\s*:\s*(?:async\s*)?(?:function|\(|[A-Za-z_$])/i,
      "injected generic wake dependencies are forbidden",
    );
    addPatternViolations(
      violations,
      path,
      source,
      /\b(?:create|open|send|resume|close|list|get)\w*AgentSessions?\b|\bAgentSessions?\w*(?:Create|Open|Send|Resume|Close|List|Get)\w*\b/i,
      "plugin agent-session aliases are forbidden",
    );
    addPatternViolations(
      violations,
      path,
      source,
      /\b(?:generate|render|complete|invoke|execute|refresh)\w*Summary\w*(?:Provider|Model|Adapter)\w*|\bSummary\w*(?:Provider|Model|Adapter)\w*(?:Generate|Render|Complete|Invoke|Execute|Refresh)\w*/i,
      "renamed direct summary-provider generation is forbidden",
    );
  }

  for (const path of [SUMMARY_SERVICE, SUMMARY_FINALIZER]) {
    const source = read(repositoryRoot, path);
    if (source === null) continue;
    addPatternViolations(
      violations,
      path,
      source,
      /\b(?:generateText|streamText|completeText|invokeModel|executeModel)\b|\b(?:provider|adapter)\s*\.\s*(?:generate|invoke|execute|complete)\s*\(/i,
      "summary slots cannot call a provider or adapter directly",
    );
    addPatternViolations(
      violations,
      path,
      source,
      /from\s*["'][^"']*(?:adapter|provider|acp)[^"']*["']/i,
      "summary slots cannot import a provider execution path",
    );
  }

  for (const path of [SUMMARY_SERVICE, SUMMARY_ROUTE, SUMMARY_UI_API]) {
    const source = read(repositoryRoot, path);
    if (source === null) continue;
    addPatternViolations(
      violations,
      path,
      source,
      /\.generate\s*\(|\bgenerate\s*:\s*(?:async\s*)?(?:\(|[A-Za-z_$])/,
      "retired summary-slot generate wrapper is forbidden",
    );
  }
  return violations;
}

function activeDocumentationViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  for (const path of ACTIVE_EXECUTION_DOCUMENTS) {
    const source = read(repositoryRoot, path);
    if (source === null) continue;
    for (const expression of RETIRED_EXECUTION_DOCUMENTATION_CLAIMS) {
      addPatternViolations(
        violations,
        path,
        source,
        expression,
        "active documentation cannot advertise a retired AI execution path",
      );
    }
  }
  return violations;
}

function canonicalOwnerViolations(repositoryRoot: string): string[] {
  return [
    ...requireFileTokens(repositoryRoot, TOOL_GATEWAY, [
      "listToolsForNamedGateway",
      "executeToolForNamedGateway",
      "connectedMcpToolsForCompany",
    ]),
    ...requireFileTokens(repositoryRoot, RUNTIME_COMPILER, [
      "RuntimeInterfaceCompileInput",
      "actionGrants",
      "selectedCompanyTools",
      "compileRuntimeInterface",
      "CompiledRunToolDescriptor",
    ]),
    ...requireFileTokens(repositoryRoot, SUMMARY_SERVICE, [
      "dispatchRefresh",
      "routineService",
      "runRoutine(",
      'source: "manual"',
      "summary-slot-refresh:",
    ]),
    ...requireFileTokens(repositoryRoot, SUMMARY_FINALIZER, [
      "finalizeSummarySlotsForTerminalIssue",
      "issueUpdates",
      "issueComments",
      "sourceIssueCommentId",
      'eq(issueUpdates.form, "owner")',
      'eq(issueUpdates.status, "done")',
    ]),
    ...requireFileTokens(repositoryRoot, SUMMARY_ROUTE, [
      "/companies/:companyId/summary-slots/:scopeKind/:slotKey/refresh",
      "refreshSummarySlotSchema",
      "svc.dispatchRefresh",
      'action: "summary_slot.refresh_requested"',
    ]),
    ...requireFileTokens(repositoryRoot, SUMMARY_API, [
      "summarySlotRefresh",
      "/refresh",
    ]),
    ...requireFileTokens(repositoryRoot, SUMMARY_TYPES, [
      "RefreshSummarySlotRequest",
      "RefreshSummarySlotResponse",
    ]),
    ...requireFileTokens(repositoryRoot, SUMMARY_VALIDATOR, [
      "refreshSummarySlotSchema",
      "RefreshSummarySlotInput",
    ]),
    ...requireFileTokens(repositoryRoot, SUMMARY_UI_API, [
      "RefreshSummarySlotResponse",
      "refresh:",
      'summarySlotPath(selector, "/refresh")',
    ]),
    ...requireFileTokens(repositoryRoot, DISPATCHER, [
      "Dispatcher accepts only a persisted IssueExecutionRef",
      "notifyPersistedRef",
      "coordinator.wake(persisted.lane)",
      "listDispatchableOwnerRefIds",
    ]),
    ...requireFileTokens(repositoryRoot, POSTGRES_DISPATCHER, [
      "releaseAttempt",
      '.set({ state: "released", releasedAt: at })',
      "eq(issueExecutionLeases.id, lease.leaseId)",
      "eq(issueExecutionLeases.attemptId, lease.attemptId)",
      "leaseNextOwnerRef",
    ]),
    ...requireFileTokens(repositoryRoot, POSTGRES_TRIGGER, [
      "dispatcher.notifyPersistedRef(input.refId)",
    ]),
    ...requireFileTokens(repositoryRoot, SYSTEM_ESCALATION, [
      'sourceKind: "system_nudge"',
      'sourceKind: "system_escalation_nudge"',
      "appendNonDispatchControlNotice",
      "dispatchRefId",
    ]),
    ...requireFileTokens(repositoryRoot, ORDINARY_ISSUES, [
      "appendNonDispatchUserComment",
      "if (result.ref)",
      "await dispatch(result.ref.id);",
      "replyToCommentId",
    ]),
  ];
}

export function legacyExecutionSurfaceRemovalViolations(
  repositoryRoot: string,
): string[] {
  return [...new Set([
    ...literalRemovalViolations(repositoryRoot, {
      forbiddenTokens: FORBIDDEN_TOKENS,
      ignoredPaths: IGNORED_PATHS,
    }),
    ...structuralRemovalViolations(repositoryRoot),
    ...activeDocumentationViolations(repositoryRoot),
    ...canonicalOwnerViolations(repositoryRoot),
  ])].sort();
}

export function assertLegacyExecutionSurfaceRemoval(
  repositoryRoot: string,
): void {
  assertNoGateViolations(
    "Legacy execution-surface removal check",
    legacyExecutionSurfaceRemovalViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertLegacyExecutionSurfaceRemoval(resolve(import.meta.dirname, ".."));
    console.log("Legacy execution-surface removal check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
