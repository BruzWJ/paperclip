import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  listRepositoryTextFiles,
  literalRemovalViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const RUNTIME_SCHEMA = "packages/db/schema/agent_runtime_state.ts";
const ACCOUNTING_SCHEMA = "packages/db/schema/acp_prompt_accounting.ts";
const SESSION_SCHEMA = "packages/db/schema/issue_sessions.ts";
const SESSION_INFO = "packages/shared/src/issue-session/session.ts";
const SESSION_MESSAGE = "packages/shared/src/issue-session/session-message.ts";
const SESSION_EVENT = "packages/shared/src/issue-session/session-event.ts";
const CODEC_TEST = "packages/shared/src/issue-session/codec.test.ts";
const MESSAGE_UPDATER =
  "apps/server/src/services/issue-session/message-updater.ts";
const PROJECTOR = "apps/server/src/services/issue-session/projector.ts";
const ACP_EVENT_MAPPER =
  "apps/server/src/services/issue-execution-acp-events-postgres.ts";
const ACP_SETTLEMENT = "apps/server/src/services/acp-prompt-settlement.ts";

const RETIRED_ACCOUNTING_TOKENS = [
  "totalInputTokens",
  "totalOutputTokens",
  "totalCachedInputTokens",
  "totalReasoningTokens",
  "cumulativeInputTokens",
  "cumulativeOutputTokens",
  "cumulativeCachedInputTokens",
  "cumulativeReasoningTokens",
  "usageJson",
  "usage_json",
] as const;

function read(repositoryRoot: string, path: string): string | null {
  const absolute = resolve(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function normalizedRelative(repositoryRoot: string, absolute: string): string {
  return relative(repositoryRoot, absolute).replaceAll("\\", "/");
}

function blockBetween(
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

function stableAcpTokenFabricationViolations(
  repositoryRoot: string,
): string[] {
  const violations: string[] = [];
  for (const path of [ACP_EVENT_MAPPER, ACP_SETTLEMENT]) {
    const source = read(repositoryRoot, path);
    if (source === null) continue;
    if (
      /(?:stepEndedData|IssueSession\.Event\.Step\.Ended)[\s\S]{0,1200}?\btokens\s*:/.test(
        source,
      )
    ) {
      violations.push(
        `${path}: stable ACP constructs donor Step.Ended token components`,
      );
    }
    if (
      /\b(?:input|output|reasoning|read|write)\s*:\s*(?:settlement\.occupancy|input\.contextUsedTokens|input\.contextWindowTokens)/.test(
        source,
      )
    ) {
      violations.push(
        `${path}: stable ACP derives donor token components from occupancy`,
      );
    }
  }
  return violations;
}

function throughputAggregationViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  for (const absolute of listRepositoryTextFiles(repositoryRoot, [
    "packages/db/schema",
    "apps/server/src",
  ])) {
    const path = normalizedRelative(repositoryRoot, absolute);
    if (/\.(?:test|spec)\.tsx?$/.test(path)) continue;
    const source = readFileSync(absolute, "utf8");
    if (
      /\b(?:sum|avg)\s*\([\s\S]{0,160}?(?:input|output|reasoning|cache|context)[A-Za-z_]*[Tt]okens/.test(
        source,
      ) ||
      /sql`[^`]{0,300}\bsum\([^)]*(?:input|output|reasoning|cache|context)[^)]*token/i.test(
        source,
      )
    ) {
      violations.push(`${path}: token occupancy is aggregated as throughput`);
    }
  }
  return violations;
}

/**
 * Keeps stable ACP accounting occupancy-only while retaining the complete
 * optional donor token object as a provenance-locked Session projection.
 */
export function aiAccountingBoundaryViolations(
  repositoryRoot: string,
): string[] {
  const violations: string[] = [
    ...literalRemovalViolations(repositoryRoot, {
      forbiddenTokens: RETIRED_ACCOUNTING_TOKENS,
      ignoredPaths: [
        "scripts/check-ai-accounting-boundary.ts",
        "scripts/check-ai-accounting-boundary.test.ts",
      ],
      roots: [
        "apps",
        "packages",
        "doc",
        "evals",
        "README.md",
        "ROADMAP.md",
      ],
    }),
    ...requireFileTokens(repositoryRoot, RUNTIME_SCHEMA, [
      'export const agentRuntimeState = pgTable(',
      '"agent_runtime_state"',
      "lastContextUsedTokens",
      "lastContextWindowTokens",
      "peakContextUsedTokens",
      "aggregateKnownCostAmount",
      "unpricedPromptCount",
      '"agent_runtime_state_context_occupancy_check"',
      '"agent_runtime_state_aggregates_check"',
    ]),
    ...requireFileTokens(repositoryRoot, ACCOUNTING_SCHEMA, [
      'export const acpPromptAccounting = pgTable(',
      '"acp_prompt_accounting"',
      "contextTokenLimit",
      "contextUsedTokens",
      "contextWindowTokens",
      '"acp_prompt_accounting_context_occupancy_check"',
      "table.contextUsedTokens} >= 0",
      "table.contextWindowTokens} > 0",
      "table.contextUsedTokens} <= ${table.contextWindowTokens}",
      "table.contextWindowTokens} = ${table.contextTokenLimit}",
    ]),
    ...requireFileTokens(repositoryRoot, SESSION_SCHEMA, [
      "tokensInput: bigint",
      "tokensOutput: bigint",
      "tokensReasoning: bigint",
      "tokensCacheRead: bigint",
      "tokensCacheWrite: bigint",
      '"issue_sessions_cost_and_tokens_check"',
      "table.tokensInput} is null",
      "table.tokensOutput} is null",
      "table.tokensReasoning} is null",
      "table.tokensCacheRead} is null",
      "table.tokensCacheWrite} is null",
      "table.tokensInput} >= 0",
      "table.tokensOutput} >= 0",
      "table.tokensReasoning} >= 0",
      "table.tokensCacheRead} >= 0",
      "table.tokensCacheWrite} >= 0",
      "sourceTotalTokens",
    ]),
    ...requireFileTokens(repositoryRoot, SESSION_INFO, [
      "tokens: Schema.Struct({",
      "input: Schema.Finite",
      "output: Schema.Finite",
      "reasoning: Schema.Finite",
      "read: Schema.Finite",
      "write: Schema.Finite",
      "}).pipe(optional)",
    ]),
    ...requireFileTokens(repositoryRoot, SESSION_MESSAGE, [
      "export const Assistant = Schema.Struct({",
      "tokens: Schema.Struct({",
      "input: Schema.Finite",
      "output: Schema.Finite",
      "reasoning: Schema.Finite",
      "cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite })",
      "}).pipe(optional)",
    ]),
    ...requireFileTokens(repositoryRoot, SESSION_EVENT, [
      "export const Ended = EventDefinition.define({",
      'type: "session.next.step.ended"',
      "tokens: Schema.Struct({",
      "input: Schema.Finite",
      "output: Schema.Finite",
      "reasoning: Schema.Finite",
      "read: Schema.Finite",
      "write: Schema.Finite",
      "}).pipe(optional)",
    ]),
    ...requireFileTokens(repositoryRoot, MESSAGE_UPDATER, [
      'case "session.next.step.ended"',
      "if (event.data.tokens !== undefined)",
      "message.tokens = event.data.tokens",
    ]),
    ...requireFileTokens(repositoryRoot, PROJECTOR, [
      "canonicalJson(assistant.tokens) !== canonicalJson(event.data.tokens)",
    ]),
    ...requireFileTokens(repositoryRoot, ACP_EVENT_MAPPER, [
      'input.event.kind === "usage"',
      "return;",
    ]),
    ...requireFileTokens(repositoryRoot, ACP_SETTLEMENT, [
      "contextUsedTokens: settlement.occupancy.used",
      "contextWindowTokens: settlement.occupancy.size",
      "lastContextUsedTokens: input.contextUsedTokens",
      "lastContextWindowTokens: input.contextWindowTokens",
      "peakContextUsedTokens = Math.max(",
      "sourceTotalTokens: settlement.occupancy.used",
      "const stepEndedData = {",
    ]),
    ...requireFileTokens(repositoryRoot, CODEC_TEST, [
      "preserves unavailable and explicit-zero Session accounting without sentinels",
      "uses only Step.Ended.3 and keeps its accounting objects all-or-none",
      "cache: { read: 0, write: 0 }",
      "tokens: { input: 0 }",
    ]),
    ...stableAcpTokenFabricationViolations(repositoryRoot),
    ...throughputAggregationViolations(repositoryRoot),
  ];

  const runtime = read(repositoryRoot, RUNTIME_SCHEMA);
  if (runtime !== null) {
    const table = blockBetween(
      runtime,
      "export const agentRuntimeState = pgTable(",
      ");",
    ) ?? runtime;
    const retiredRuntimeStateFields = [
      "sessionId",
      ["state", "Json"].join(""),
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "reasoningTokens",
      "usage",
    ];
    if (
      retiredRuntimeStateFields.some((field) =>
        new RegExp(`\\b${field}\\s*:`).test(table),
      )
    ) {
      violations.push(
        `${RUNTIME_SCHEMA}: runtime state contains conversational or throughput accounting`,
      );
    }
  }

  const accounting = read(repositoryRoot, ACCOUNTING_SCHEMA);
  if (
    accounting !== null &&
    /\b(?:inputTokens|outputTokens|cachedInputTokens|reasoningTokens|usageJson)\s*:/.test(
      accounting,
    )
  ) {
    violations.push(
      `${ACCOUNTING_SCHEMA}: stable ACP accounting stores fabricated token components or generic usage`,
    );
  }

  const sessionSchema = read(repositoryRoot, SESSION_SCHEMA);
  if (sessionSchema !== null) {
    for (const field of [
      "tokensInput",
      "tokensOutput",
      "tokensReasoning",
      "tokensCacheRead",
      "tokensCacheWrite",
    ]) {
      if (new RegExp(`${field}:[^\\n]+\\.default\\(`).test(sessionSchema)) {
        violations.push(
          `${SESSION_SCHEMA}: donor ${field} must remain nullable with no default`,
        );
      }
    }
  }

  const projector = read(repositoryRoot, PROJECTOR);
  if (
    projector !== null &&
    /(?:tokensInput|tokensOutput|tokensReasoning|tokensCacheRead|tokensCacheWrite)[\s\S]{0,120}?\+/.test(
      projector,
    )
  ) {
    violations.push(`${PROJECTOR}: Session root token components are aggregated`);
  }

  return [...new Set(violations)].sort();
}

export function assertAiAccountingBoundary(repositoryRoot: string): void {
  assertNoGateViolations(
    "AI accounting boundary check",
    aiAccountingBoundaryViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertAiAccountingBoundary(resolve(import.meta.dirname, ".."));
    console.log("AI accounting boundary check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
