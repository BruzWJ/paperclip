import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  listRepositoryTextFiles,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const SHARED_RUNTIME = "packages/shared/src/issue-runtime.ts";
const SHARED_CONSTANTS = "packages/shared/src/constants.ts";
const ISSUES_SCHEMA = "packages/db/schema/issues.ts";
const ISSUE_UPDATES_SCHEMA =
  "packages/db/schema/issue_creator_delivery.ts";
const OWNER_FORM_VALIDATOR = "packages/shared/src/validators/issue.ts";
const COMPANY_PORTABILITY = "server/src/services/company-portability.ts";
const RUNTIME_INTERFACE_COMPILER =
  "server/src/services/runtime-interface-compiler.ts";
const PLUGIN_TYPES = "packages/plugins/sdk/src/types.ts";
const PLUGIN_PROTOCOL = "packages/plugins/sdk/src/protocol.ts";
const PLUGIN_WORKER_HOST = "packages/plugins/sdk/src/worker-rpc-host.ts";
const PLUGIN_UI_COMPONENTS = "packages/plugins/sdk/src/ui/components.ts";
const UI_PLUGIN_BRIDGE = "ui/src/plugins/bridge-init.ts";
const UI_ISSUE_DETAIL = "ui/src/pages/IssueDetail.tsx";
const LIVENESS_SCHEMA =
  "packages/db/schema/issue_liveness_reconciliations.ts";
const RUN_SCHEMA = "packages/db/schema/issue_execution_runs.ts";
const LIVENESS_SERVICE =
  "server/src/services/issue-liveness-reconciliation.ts";
const FINALIZATION_OWNER =
  "server/src/services/issue-execution-finalization-postgres.ts";
const CANONICAL_ASSEMBLY = "server/src/services/issue-execution-postgres.ts";
const DISPATCHER =
  "server/src/services/issue-execution-dispatcher-postgres.ts";
const CANCELLATION_RECONCILER =
  "server/src/services/issue-execution-cancellation.ts";
const ATTENTION_OWNER = "server/src/services/attention.ts";
const DISMISSAL_OWNER = "server/src/services/inbox-dismissals.ts";
const ATTENTION_ROW = "ui/src/components/AttentionQueueRow.tsx";
const ATTENTION_PAGE = "ui/src/pages/WhatNeedsMe.tsx";
// Keep the lifecycle gate's production-table allowlist honest: this boundary
// names the separate fact owner only through a structural symbol assembled at
// runtime, rather than looking like another direct table consumer itself.
const RUN_LIVENESS_TABLE_SYMBOL = [
  "issueExecutionRun",
  "LivenessFacts",
].join("");

const AGENT_LIFECYCLE = ["open", "blocked", "done", "cancelled"] as const;
const BOARD_PRESENTATION = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;
const ACTION_KINDS = [
  "authenticated_human_comment",
  "issue_create_child",
  "mention_agent",
  "issue_assign",
  "issue_update",
  "creator_withdrawal",
  "board_lifecycle_command",
  "board_reopen",
] as const;
const RUN_LIVENESS_STATES = [
  "completed",
  "advanced",
  "plan_only",
  "empty_response",
  "blocked",
  "failed",
  "needs_followup",
] as const;

const OUTBOX_FIELDS = [
  "companyId",
  "issueId",
  "ownershipEpoch",
  "runId",
  "finalizationId",
  "createdAt",
  "processedAt",
] as const;

const RECONCILIATION_FIELDS = [
  "id",
  "companyId",
  "issueId",
  "ownershipEpoch",
  "frontierFinalizationId",
  "creatorEdgeId",
  "creatorEdgeAdmissionVersion",
  "staleTargetAgentId",
  "sourceRunId",
  "sourceMode",
  "sourceCommentId",
  "followupSystemReplyCommentId",
  "followupRefId",
  "followupRunId",
  "followupFinalizationId",
  "acceptedActionKind",
  "acceptedActionSourceId",
  "acceptedActionCommittedAt",
  "supersededBeforeAttentionAt",
  "boardAttentionEmittedAt",
  "boardAttentionReason",
  "exitActionKind",
  "exitActionSourceId",
  "exitActionCommittedAt",
  "admittedAt",
] as const;

const RUN_LIVENESS_FACT_FIELDS = [
  "id",
  "companyId",
  "runId",
  "livenessState",
  "livenessReason",
  "continuationAttempt",
  "lastUsefulActionAt",
  "nextAction",
] as const;

const SETTLEMENT_PRODUCERS = new Map<string, readonly string[]>([
  [
    "server/src/services/canonical-issue-aggregate.ts",
    ["recordIssueLivenessActionInTransaction(", "`issue:${persistedIssue.id}`"],
  ],
  [
    "server/src/services/ordinary-issue-runtime.ts",
    [
      "recordIssueLivenessActionInTransaction(",
      "`issue_execution_ref:${admission.ref.id}`",
      "`issue_board_reopen_command:${command.id}`",
      "`issue_board_user_comment:${command.id}`",
      "`issue_creator_withdrawal_command:${command.id}`",
    ],
  ],
  [
    "server/src/services/runtime-issue-action-port.ts",
    [
      "recordIssueLivenessActionInTransaction(",
      "`issue_update:${update.id}`",
      "`issue_consult_execution:${completedConsult[0]!.id}`",
    ],
  ],
  [
    "server/src/services/issue-board-lifecycle-command.ts",
    [
      "recordIssueLivenessActionInTransaction(",
      "`issue_board_lifecycle_command:${row.id}`",
    ],
  ],
  [
    "server/src/services/issue-execution-prompt-cycle-postgres.ts",
    [
      "recordIssueLivenessActionInTransaction(",
      "`issue_execution_prompt_segment:${prompt.identity.runId}:${prompt.identity.refId}:${prompt.identity.segmentOrdinal}`",
    ],
  ],
]);

const SETTLEMENT_REFERENCE_TOKENS = [
  "`issue_board_user_comment:${string}`",
  "`issue:${string}`",
  "`issue_consult_execution:${string}`",
  "`issue_execution_prompt_segment:${string}:${string}:${number}`",
  "`issue_execution_ref:${string}`",
  "`issue_update:${string}`",
  "`issue_creator_withdrawal_command:${string}`",
  "`issue_board_lifecycle_command:${string}`",
  "`issue_board_reopen_command:${string}`",
] as const;

function read(repositoryRoot: string, path: string): string | null {
  const absolute = resolve(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function normalizedRelative(repositoryRoot: string, absolute: string): string {
  return relative(repositoryRoot, absolute).replaceAll("\\", "/");
}

function sameValues(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function sameValueSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return sameValues([...actual].sort(), [...expected].sort());
}

function stringArray(source: string, name: string): string[] | null {
  const declaration = new RegExp(`\\b${name}\\s*=\\s*\\[`).exec(source);
  if (!declaration) return null;
  const start = source.indexOf("[", declaration.index);
  const end = source.indexOf("]", start + 1);
  if (start === -1 || end === -1) return null;
  return [...source.slice(start + 1, end).matchAll(/["']([^"']+)["']/g)].map(
    (match) => match[1]!,
  );
}

function namedCheckValues(source: string, checkName: string): string[] | null {
  const start = source.indexOf(`"${checkName}"`);
  if (start === -1) return null;
  const window = source.slice(start, start + 1_500);
  const end = window.indexOf("),");
  const check = end === -1 ? window : window.slice(0, end);
  return singleQuotedValues(check);
}

function occurrences(source: string, token: string): number {
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = source.indexOf(token, cursor);
    if (index === -1) return count;
    count += 1;
    cursor = index + token.length;
  }
}

function quotedValues(source: string): string[] {
  return [...source.matchAll(/["']([^"']+)["']/g)].map(
    (match) => match[1]!,
  );
}

function singleQuotedValues(source: string): string[] {
  return [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

function braceBlockAfter(source: string, ownerToken: string): string | null {
  if (occurrences(source, ownerToken) !== 1) return null;
  const owner = source.indexOf(ownerToken);
  const start = source.indexOf("{", owner + ownerToken.length);
  if (start === -1) return null;

  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function propertyUnion(
  block: string | null,
  property: string,
  optional: boolean,
): { values: string[]; nullable: boolean } | null {
  if (!block) return null;
  const matches = [
    ...block.matchAll(
      new RegExp(
        `\\b${property}${optional ? "\\?" : ""}\\s*:\\s*([^;\\n]+);`,
        "g",
      ),
    ),
  ];
  if (matches.length !== 1) return null;
  return {
    values: quotedValues(matches[0]![1]!),
    nullable: /(?:^|\W)null(?:$|\W)/.test(matches[0]![1]!),
  };
}

function enumArrayAfter(
  block: string | null,
  ownerToken: string,
): string[] | null {
  if (!block || occurrences(block, ownerToken) !== 1) return null;
  const owner = block.indexOf(ownerToken);
  const match = /\benum\s*:\s*\[([^\]]*)\]/s.exec(
    block.slice(owner + ownerToken.length),
  );
  return match ? quotedValues(match[1]!) : null;
}

function propertyEnumArrays(
  block: string | null,
  property: string,
): string[][] | null {
  if (!block) return null;
  const matches = [
    ...block.matchAll(
      new RegExp(
        `\\b${property}\\s*:\\s*\\{[^{}]*?\\benum\\s*:\\s*\\[([^\\]]*)\\]`,
        "gs",
      ),
    ),
  ];
  return matches.map((match) => quotedValues(match[1]!));
}

function sliceBetweenUnique(
  source: string,
  startToken: string,
  endToken: string,
): string | null {
  if (
    occurrences(source, startToken) !== 1 ||
    occurrences(source, endToken) !== 1
  ) {
    return null;
  }
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  return end === -1 ? null : source.slice(start, end);
}

function zodEnumAfter(
  block: string | null,
  property: string,
): string[] | null {
  if (!block) return null;
  const pattern = new RegExp(
    `\\b${property}\\s*:\\s*z\\s*\\.enum\\(\\[([^\\]]*)\\]\\)`,
    "s",
  );
  const matches = [...block.matchAll(new RegExp(pattern.source, "gs"))];
  return matches.length === 1 ? quotedValues(matches[0]![1]!) : null;
}

function ownerUnionViolation(
  path: string,
  source: string | null,
  ownerToken: string,
  property: string,
  optional: boolean,
  nullable: boolean,
  label: string,
): string[] {
  const union = source
    ? propertyUnion(braceBlockAfter(source, ownerToken), property, optional)
    : null;
  if (
    union &&
    union.nullable === nullable &&
    sameValues(union.values, AGENT_LIFECYCLE)
  ) {
    return [];
  }
  return [`${path}: ${label} must project exactly the four-value lifecycle`];
}

function dispatchableIssueLifecycleViolation(
  source: string | null,
): string[] {
  const owner = source
    ? braceBlockAfter(source, "async function assertRefDispatchable(")
    : null;
  const matches = owner
    ? [
        ...owner.matchAll(
          /\[([^\]]*)\]\.includes\(issue\.lifecycleStatus\)/gs,
        ),
      ]
    : [];
  if (
    matches.length === 1 &&
    sameValues(quotedValues(matches[0]![1]!), ["open", "blocked"])
  ) {
    return [];
  }
  return [
    `${DISPATCHER}: locked dispatchability must accept exactly open and blocked issues`,
  ];
}

function tableObject(source: string, exportName: string): string | null {
  const declaration = source.indexOf(`export const ${exportName} = pgTable(`);
  if (declaration === -1) return null;
  const start = source.indexOf("{", declaration);
  if (start === -1) return null;

  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function tableFields(source: string, exportName: string): string[] | null {
  const object = tableObject(source, exportName);
  if (!object) return null;
  return [...object.matchAll(/^    ([A-Za-z_$][A-Za-z0-9_$]*):/gm)].map(
    (match) => match[1]!,
  );
}

function exactFieldViolations(
  path: string,
  source: string | null,
  exportName: string,
  expected: readonly string[],
  label: string,
): string[] {
  if (source === null) return [`${path}: required ${label} owner is missing`];
  const fields = tableFields(source, exportName);
  if (fields === null) {
    return [`${path}: cannot resolve the ${label} table object`];
  }
  if (sameValues(fields, expected)) return [];
  const extras = fields.filter((field) => !expected.includes(field));
  const missing = expected.filter((field) => !fields.includes(field));
  return [
    `${path}: ${label} fields are not closed` +
      `${extras.length ? `; extra ${extras.join(", ")}` : ""}` +
      `${missing.length ? `; missing ${missing.join(", ")}` : ""}`,
  ];
}

function schemaTableNames(repositoryRoot: string): Array<{
  path: string;
  table: string;
}> {
  const tables: Array<{ path: string; table: string }> = [];
  for (const absolute of listRepositoryTextFiles(repositoryRoot, [
    "packages/db/schema",
  ])) {
    if (!absolute.endsWith(".ts")) continue;
    const path = normalizedRelative(repositoryRoot, absolute);
    const source = readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/pgTable\(\s*["']([^"']+)["']/g)) {
      tables.push({ path, table: match[1]! });
    }
  }
  return tables;
}

function productionServerFiles(repositoryRoot: string): Array<{
  path: string;
  source: string;
}> {
  return listRepositoryTextFiles(repositoryRoot, ["server/src"])
    .filter((absolute) => /\.(?:ts|tsx)$/.test(absolute))
    .map((absolute) => ({
      path: normalizedRelative(repositoryRoot, absolute),
      source: readFileSync(absolute, "utf8"),
    }))
    .filter(
      ({ path }) =>
        !path.includes("/__tests__/") &&
        !/\.(?:test|spec)\.[^.]+$/.test(path),
    );
}

function tableWriteKinds(source: string, symbol: string): string[] {
  return [
    ...source.matchAll(
      new RegExp(
        `\\.\\s*(insert|update|delete)\\s*\\(\\s*${symbol}\\s*\\)`,
        "g",
      ),
    ),
  ].map((match) => match[1]!);
}

function foreignKeyWindow(source: string, token: string): string {
  const end = source.indexOf(token);
  if (end === -1) return "";
  const start = source.lastIndexOf("foreignKey({", end);
  return source.slice(start === -1 ? end : start, end + token.length);
}

function requiredRegex(
  path: string,
  source: string | null,
  label: string,
  pattern: RegExp,
): string[] {
  if (source === null || !pattern.test(source)) {
    return [`${path}: missing ${label}`];
  }
  return [];
}

function lifecycleViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  const runtime = read(repositoryRoot, SHARED_RUNTIME);
  const constants = read(repositoryRoot, SHARED_CONSTANTS);
  const issues = read(repositoryRoot, ISSUES_SCHEMA);
  const issueUpdates = read(repositoryRoot, ISSUE_UPDATES_SCHEMA);

  const lifecycle = runtime
    ? stringArray(runtime, "AGENT_VISIBLE_ISSUE_STATUSES")
    : null;
  if (!lifecycle || !sameValues(lifecycle, AGENT_LIFECYCLE)) {
    violations.push(
      `${SHARED_RUNTIME}: agent-visible lifecycle must be exactly ${AGENT_LIFECYCLE.join(" | ")}`,
    );
  }
  const board = constants ? stringArray(constants, "ISSUE_STATUSES") : null;
  if (!board || !sameValues(board, BOARD_PRESENTATION)) {
    violations.push(
      `${SHARED_CONSTANTS}: board presentation must remain the distinct seven-value contract`,
    );
  }
  const lifecycleCheck = issues
    ? namedCheckValues(issues, "issues_lifecycle_status_check")
    : null;
  if (!lifecycleCheck || !sameValueSet(lifecycleCheck, AGENT_LIFECYCLE)) {
    violations.push(
      `${ISSUES_SCHEMA}: lifecycle constraint must close over only the four agent-visible values`,
    );
  }
  const boardCheck = issues
    ? namedCheckValues(issues, "issues_board_presentation_status_check")
    : null;
  if (!boardCheck || !sameValueSet(boardCheck, BOARD_PRESENTATION)) {
    violations.push(
      `${ISSUES_SCHEMA}: board-presentation constraint must retain exactly seven values`,
    );
  }

  const updateCheck = issueUpdates
    ? namedCheckValues(issueUpdates, "issue_updates_status_check")
    : null;
  if (!updateCheck || !sameValues(updateCheck, AGENT_LIFECYCLE)) {
    violations.push(
      `${ISSUE_UPDATES_SCHEMA}: issue_updates_status_check must close over only the four agent-visible values`,
    );
  }

  const validator = read(repositoryRoot, OWNER_FORM_VALIDATOR);
  const ownerFormValues = validator
    ? zodEnumAfter(
        braceBlockAfter(
          validator,
          "export const commitIssueOwnerFormSchema = z",
        ),
        "status",
      )
    : null;
  if (!ownerFormValues || !sameValues(ownerFormValues, AGENT_LIFECYCLE)) {
    violations.push(
      `${OWNER_FORM_VALIDATOR}: commitIssueOwnerFormSchema must enumerate exactly the four lifecycle values`,
    );
  }

  const portability = read(repositoryRoot, COMPANY_PORTABILITY);
  const portableInput = portability
    ? braceBlockAfter(
        portability,
        "interface PortableCanonicalIssueCreateInput",
      )
    : null;
  if (
    !portableInput ||
    occurrences(
      portableInput,
      "lifecycleStatus: AgentVisibleIssueStatus;",
    ) !== 1
  ) {
    violations.push(
      `${COMPANY_PORTABILITY}: canonical import input must use AgentVisibleIssueStatus without extension`,
    );
  }
  const portableParser = portability
    ? sliceBetweenUnique(
        portability,
        "const lifecycleStatus = asString(extension.lifecycleStatus);",
        "const boardPresentationStatus = asString(",
      )
    : null;
  const portableArrays = portableParser
    ? [
        ...portableParser.matchAll(
          /\[([^\]]*)\]\.includes\(\s*lifecycleStatus\s*,?\s*\)/gs,
        ),
      ].map((match) => quotedValues(match[1]!))
    : [];
  if (
    portableArrays.length !== 1 ||
    !sameValues(portableArrays[0]!, AGENT_LIFECYCLE)
  ) {
    violations.push(
      `${COMPANY_PORTABILITY}: manifest parser must accept exactly the four lifecycle values`,
    );
  }

  const compiler = read(repositoryRoot, RUNTIME_INTERFACE_COMPILER);
  const filterValues = compiler
    ? enumArrayAfter(
        braceBlockAfter(compiler, "function issueFilterSchema()"),
        "status:",
      )
    : null;
  if (!filterValues || !sameValues(filterValues, AGENT_LIFECYCLE)) {
    violations.push(
      `${RUNTIME_INTERFACE_COMPILER}: issueFilterSchema must expose exactly the four lifecycle values`,
    );
  }
  const updateStatusEnums = compiler
    ? propertyEnumArrays(
        braceBlockAfter(compiler, "function issueUpdateDescriptor("),
        "status",
      )
    : null;
  if (
    !updateStatusEnums ||
    updateStatusEnums.length !== 2 ||
    !sameValues(updateStatusEnums[0]!, ["open", "blocked"]) ||
    !sameValues(updateStatusEnums[1]!, ["done", "cancelled"])
  ) {
    violations.push(
      `${RUNTIME_INTERFACE_COMPILER}: owner-form runtime schema must retain exact nonterminal and terminal lifecycle partitions`,
    );
  }

  violations.push(
    ...dispatchableIssueLifecycleViolation(
      read(repositoryRoot, DISPATCHER),
    ),
    ...ownerUnionViolation(
      PLUGIN_TYPES,
      read(repositoryRoot, PLUGIN_TYPES),
      "export interface PluginRunIssuesClient",
      "status",
      true,
      false,
      "PluginRunIssuesClient filter",
    ),
    ...ownerUnionViolation(
      PLUGIN_TYPES,
      read(repositoryRoot, PLUGIN_TYPES),
      "export interface PluginCreatorCallbackDelivery",
      "status",
      false,
      true,
      "PluginCreatorCallbackDelivery status",
    ),
    ...ownerUnionViolation(
      PLUGIN_TYPES,
      read(repositoryRoot, PLUGIN_TYPES),
      "export interface PluginIssuesClient",
      "status",
      true,
      false,
      "PluginIssuesClient filter",
    ),
    ...ownerUnionViolation(
      PLUGIN_PROTOCOL,
      read(repositoryRoot, PLUGIN_PROTOCOL),
      '"issues.list": [',
      "status",
      true,
      false,
      "issues.list RPC filter",
    ),
    ...ownerUnionViolation(
      PLUGIN_PROTOCOL,
      read(repositoryRoot, PLUGIN_PROTOCOL),
      '"run.issues.listCompanyIssues": [',
      "status",
      true,
      false,
      "run.issues.listCompanyIssues RPC filter",
    ),
    ...ownerUnionViolation(
      PLUGIN_WORKER_HOST,
      read(repositoryRoot, PLUGIN_WORKER_HOST),
      "listCompanyIssues(input:",
      "status",
      true,
      false,
      "worker-host company-issue filter",
    ),
    ...ownerUnionViolation(
      PLUGIN_UI_COMPONENTS,
      read(repositoryRoot, PLUGIN_UI_COMPONENTS),
      "export interface IssuesListFilters",
      "status",
      true,
      false,
      "plugin UI IssuesListFilters",
    ),
    ...ownerUnionViolation(
      UI_PLUGIN_BRIDGE,
      read(repositoryRoot, UI_PLUGIN_BRIDGE),
      "type PluginIssuesListFilters =",
      "status",
      true,
      false,
      "host UI plugin bridge filter",
    ),
    ...ownerUnionViolation(
      UI_ISSUE_DETAIL,
      read(repositoryRoot, UI_ISSUE_DETAIL),
      "const commitHumanOwnerStatus = useMutation(",
      "status",
      false,
      false,
      "human owner status mutation",
    ),
  );
  return violations;
}

function schemaBoundaryViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  const schema = read(repositoryRoot, LIVENESS_SCHEMA);
  const runSchema = read(repositoryRoot, RUN_SCHEMA);

  violations.push(
    ...exactFieldViolations(
      LIVENESS_SCHEMA,
      schema,
      "issueExecutionFinalizationStaleCheckOutbox",
      OUTBOX_FIELDS,
      "reference-only finalization stale-check outbox",
    ),
    ...exactFieldViolations(
      LIVENESS_SCHEMA,
      schema,
      "issueLivenessReconciliations",
      RECONCILIATION_FIELDS,
      "issue-liveness reconciliation frontier",
    ),
    ...exactFieldViolations(
      RUN_SCHEMA,
      runSchema,
      RUN_LIVENESS_TABLE_SYMBOL,
      RUN_LIVENESS_FACT_FIELDS,
      "finalizer-owned run-liveness fact",
    ),
  );

  const tables = schemaTableNames(repositoryRoot);
  for (const canonical of [
    "issue_execution_finalization_stale_check_outbox",
    "issue_liveness_reconciliations",
    "issue_execution_run_liveness_facts",
  ]) {
    const owners = tables.filter(({ table }) => table === canonical);
    if (owners.length !== 1) {
      violations.push(
        `packages/db/schema: ${canonical} must have exactly one table owner (found ${owners.length})`,
      );
    }
  }
  const allowedLivenessTables = new Set([
    "issue_execution_finalization_stale_check_outbox",
    "issue_liveness_reconciliations",
    "issue_execution_run_liveness_facts",
  ]);
  for (const { path, table } of tables) {
    if (
      !allowedLivenessTables.has(table) &&
      /(?:issue|agent).*liveness|liveness.*(?:issue|agent|reconciliation|frontier|outcome)|(?:reconciliation|frontier|outcome).*liveness/i.test(
        table,
      )
    ) {
      violations.push(`${path}: duplicate issue-frontier/outcome table ${table}`);
    }
  }

  if (schema) {
    const accepted = namedCheckValues(
      schema,
      "issue_liveness_reconciliations_accepted_action_kind_check",
    );
    const exit = namedCheckValues(
      schema,
      "issue_liveness_reconciliations_exit_action_kind_check",
    );
    if (!accepted || !sameValues(accepted, ACTION_KINDS)) {
      violations.push(
        `${LIVENESS_SCHEMA}: accepted-action predicate must contain exactly eight kinds`,
      );
    }
    if (!exit || !sameValues(exit, ACTION_KINDS)) {
      violations.push(
        `${LIVENESS_SCHEMA}: exit-action predicate must reuse exactly the same eight kinds`,
      );
    }

    violations.push(
      ...requiredRegex(
        LIVENESS_SCHEMA,
        schema,
        "exact company/issue/epoch/finalization frontier uniqueness",
        /unique\("issue_liveness_reconciliations_frontier_uq"\)\.on\(\s*table\.companyId,\s*table\.issueId,\s*table\.ownershipEpoch,\s*table\.frontierFinalizationId,?\s*\)/s,
      ),
    );
    const creatorFk = foreignKeyWindow(
      schema,
      'name: "issue_liveness_reconciliations_creator_edge_fk"',
    );
    for (const token of [
      "table.companyId",
      "table.issueId",
      "table.ownershipEpoch",
      "table.creatorEdgeId",
      "table.creatorEdgeAdmissionVersion",
      "issueCreatorEdgeReceivability.companyId",
      "issueCreatorEdgeReceivability.issueId",
      "issueCreatorEdgeReceivability.ownershipEpoch",
      "issueCreatorEdgeReceivability.id",
      "issueCreatorEdgeReceivability.admissionVersion",
    ]) {
      if (!creatorFk.includes(token)) {
        violations.push(
          `${LIVENESS_SCHEMA}: creator-edge binding is missing ${token}`,
        );
      }
    }
    for (const fkName of [
      "issue_liveness_reconciliations_source_run_fk",
      "issue_liveness_reconciliations_followup_ref_fk",
      "issue_liveness_reconciliations_followup_run_fk",
    ]) {
      const window = foreignKeyWindow(schema, `name: "${fkName}"`);
      if (
        !window.includes("table.staleTargetAgentId") ||
        !window.includes("table.sourceMode")
      ) {
        violations.push(
          `${LIVENESS_SCHEMA}: ${fkName} must bind the same stale agent and execution mode`,
        );
      }
    }
    const exactReferenceFks = [
      [
        "issue_liveness_reconciliations_frontier_finalization_fk",
        [
          "table.companyId",
          "table.sourceRunId",
          "table.frontierFinalizationId",
          "issueExecutionFinalizations.companyId",
          "issueExecutionFinalizations.runId",
          "issueExecutionFinalizations.id",
        ],
      ],
      [
        "issue_liveness_reconciliations_source_comment_fk",
        [
          "table.companyId",
          "table.issueId",
          "table.sourceRunId",
          "table.sourceCommentId",
          "issueComments.companyId",
          "issueComments.issueId",
          "issueComments.runId",
          "issueComments.id",
        ],
      ],
      [
        "issue_liveness_reconciliations_followup_reply_fk",
        [
          "table.companyId",
          "table.issueId",
          "table.followupSystemReplyCommentId",
          "table.sourceCommentId",
          "issueComments.companyId",
          "issueComments.issueId",
          "issueComments.id",
          "issueComments.replyToCommentId",
        ],
      ],
      [
        "issue_liveness_reconciliations_followup_finalization_fk",
        [
          "table.companyId",
          "table.followupRunId",
          "table.followupFinalizationId",
          "issueExecutionFinalizations.companyId",
          "issueExecutionFinalizations.runId",
          "issueExecutionFinalizations.id",
        ],
      ],
    ] as const;
    for (const [fkName, tokens] of exactReferenceFks) {
      const window = foreignKeyWindow(schema, `name: "${fkName}"`);
      for (const token of tokens) {
        if (!window.includes(token)) {
          violations.push(`${LIVENESS_SCHEMA}: ${fkName} is missing ${token}`);
        }
      }
    }
    for (const token of [
      '"issue_liveness_reconciliations_followup_chain_check"',
      '"issue_liveness_reconciliations_initial_settlement_check"',
      '"issue_liveness_reconciliations_followup_comment_uq"',
      '"issue_liveness_reconciliations_followup_ref_uq"',
      '"issue_liveness_reconciliations_followup_run_uq"',
      '"issue_liveness_reconciliations_followup_finalization_uq"',
    ]) {
      if (!schema.includes(token)) {
        violations.push(`${LIVENESS_SCHEMA}: missing same-agent chain token ${token}`);
      }
    }
  }

  if (runSchema) {
    const livenessStates = namedCheckValues(
      runSchema,
      "issue_execution_run_liveness_facts_state_check",
    );
    if (!livenessStates || !sameValues(livenessStates, RUN_LIVENESS_STATES)) {
      violations.push(
        `${RUN_SCHEMA}: terminal-run liveness classification must retain its exact seven-value closure`,
      );
    }
    for (const token of [
      '"issue_execution_run_liveness_facts_run_uq"',
      '"issue_execution_run_liveness_facts_run_id_uq"',
      "runLivenessFactId: uuid(\"run_liveness_fact_id\")",
      'name: "issue_execution_finalizations_liveness_fact_fk"',
      `${RUN_LIVENESS_TABLE_SYMBOL}.runId`,
      `${RUN_LIVENESS_TABLE_SYMBOL}.id`,
    ]) {
      if (!runSchema.includes(token)) {
        violations.push(
          `${RUN_SCHEMA}: finalizer-owned run-liveness fact is missing ${token}`,
        );
      }
    }
  }

  return violations;
}

function writerAndCallerViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  const files = productionServerFiles(repositoryRoot);
  let outboxInserts = 0;
  let reconciliationInserts = 0;
  let factInserts = 0;

  for (const { path, source } of files) {
    for (const kind of tableWriteKinds(
      source,
      "issueExecutionFinalizationStaleCheckOutbox",
    )) {
      if (kind === "insert") outboxInserts += 1;
      if (
        (kind === "insert" && path !== FINALIZATION_OWNER) ||
        (kind !== "insert" && path !== LIVENESS_SERVICE)
      ) {
        violations.push(`${path}: noncanonical ${kind} of the liveness outbox`);
      }
    }
    for (const kind of tableWriteKinds(source, "issueLivenessReconciliations")) {
      if (kind === "insert") reconciliationInserts += 1;
      if (path !== LIVENESS_SERVICE) {
        violations.push(
          `${path}: alternate ${kind} writer of the issue-liveness frontier`,
        );
      }
    }
    for (const kind of tableWriteKinds(
      source,
      RUN_LIVENESS_TABLE_SYMBOL,
    )) {
      if (kind === "insert") factInserts += 1;
      if (path !== FINALIZATION_OWNER || kind !== "insert") {
        violations.push(
          `${path}: ${kind} is not the sole finalizer-owned run-liveness fact write`,
        );
      }
    }

    if (
      source.includes("issueExecutionFinalizationStaleCheckOutbox") &&
      path !== FINALIZATION_OWNER &&
      path !== LIVENESS_SERVICE
    ) {
      violations.push(`${path}: direct access to the finalization liveness outbox`);
    }
    if (
      source.includes("issueLivenessReconciliations") &&
      path !== LIVENESS_SERVICE
    ) {
      violations.push(
        `${path}: direct access to the issue-liveness reconciliation frontier`,
      );
    }
    if (
      source.includes("processFinalizationInTransaction") &&
      path !== LIVENESS_SERVICE
    ) {
      violations.push(`${path}: alternate liveness frontier processor`);
    }
    if (
      /\.consumeFinalizationOutbox\s*\(/.test(source) &&
      path !== LIVENESS_SERVICE &&
      path !== FINALIZATION_OWNER
    ) {
      violations.push(`${path}: alternate direct liveness outbox consumer`);
    }
    if (
      /\.consumeFinalizationOutboxForRun\s*\(/.test(source) &&
      path !== DISPATCHER &&
      path !== CANCELLATION_RECONCILER
    ) {
      violations.push(
        `${path}: per-run stale-check consumption is not a dispatcher settlement/recovery or typed cancellation trigger`,
      );
    }
    if (
      source.includes("createIssueLivenessReconciliationService") &&
      path !== LIVENESS_SERVICE &&
      path !== CANONICAL_ASSEMBLY &&
      path !== "server/src/services/index.ts"
    ) {
      violations.push(`${path}: alternate liveness processor assembly`);
    }
    if (
      /(?:timer|scanner|startup|watchdog|routine|maintenance|reader?|routes?)/i.test(
        path,
      ) &&
      /(?:consumeFinalizationOutbox|processFinalizationInTransaction|issueExecutionFinalizationStaleCheckOutbox)/.test(
        source,
      )
    ) {
      violations.push(`${path}: forbidden timer/read/startup/route stale-check caller`);
    }
  }

  if (outboxInserts !== 1) {
    violations.push(
      `${FINALIZATION_OWNER}: stale-check outbox must have one insert owner (found ${outboxInserts})`,
    );
  }
  if (reconciliationInserts !== 1) {
    violations.push(
      `${LIVENESS_SERVICE}: reconciliation frontier must have one insert site (found ${reconciliationInserts})`,
    );
  }
  if (factInserts !== 1) {
    violations.push(
      `${FINALIZATION_OWNER}: productive run-liveness fact must have one insert owner (found ${factInserts})`,
    );
  }

  violations.push(
    ...requireFileTokens(repositoryRoot, CANONICAL_ASSEMBLY, [
      "createIssueLivenessReconciliationService(database, {",
      "createPostgresIssueExecutionFinalizationWriter({",
      "liveness,",
    ]),
    ...requireFileTokens(repositoryRoot, DISPATCHER, [
      "consumeFinalizationOutboxForRun",
      "options.finalizer.consumeFinalizationOutboxForRun",
    ]),
    ...requireFileTokens(repositoryRoot, CANCELLATION_RECONCILER, [
      "consumeFinalizationOutboxForRun(input: {",
      "await options.settlement.consumeFinalizationOutboxForRun({",
    ]),
  );
  return violations;
}

function settlementProducerViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  const allowed = new Set([
    LIVENESS_SERVICE,
    "server/src/services/index.ts",
    ...SETTLEMENT_PRODUCERS.keys(),
  ]);
  for (const { path, source } of productionServerFiles(repositoryRoot)) {
    if (
      source.includes("recordIssueLivenessActionInTransaction") &&
      !allowed.has(path)
    ) {
      violations.push(`${path}: noncanonical liveness settlement producer`);
    }
  }
  for (const [path, tokens] of SETTLEMENT_PRODUCERS) {
    violations.push(...requireFileTokens(repositoryRoot, path, tokens));
  }
  violations.push(
    ...requireFileTokens(repositoryRoot, LIVENESS_SERVICE, [
      ...SETTLEMENT_REFERENCE_TOKENS,
      "resolveIssueLivenessActionSourceInTransaction(",
      "recordIssueLivenessActionInTransaction(",
    ]),
  );
  return violations;
}

function sameAgentBoundaryViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  const service = read(repositoryRoot, LIVENESS_SERVICE);
  if (!service) return [`${LIVENESS_SERVICE}: required canonical owner is missing`];

  const runtime = read(repositoryRoot, SHARED_RUNTIME);
  const kinds = runtime ? stringArray(runtime, "AGENT_LIVENESS_ACTION_KINDS") : null;
  if (!kinds || !sameValues(kinds, ACTION_KINDS)) {
    violations.push(
      `${SHARED_RUNTIME}: agent-liveness action kind closure must contain exactly eight values`,
    );
  }

  for (const [path, source] of [
    [SHARED_RUNTIME, runtime],
    [LIVENESS_SCHEMA, read(repositoryRoot, LIVENESS_SCHEMA)],
    [LIVENESS_SERVICE, service],
  ] as const) {
    if (
      source &&
      /\b(?:(?:Issue|Agent)?Liveness)(?:Reconciliation)?(?:State|Status|Outcome)s?\b|\b(?:(?:ISSUE|AGENT)_)?LIVENESS_(?:RECONCILIATION_)?(?:STATE|STATUS|OUTCOME)S?\b/.test(
        source,
      )
    ) {
      violations.push(`${path}: forbidden liveness reconciliation enum owner`);
    }
  }

  for (const token of [
    "run.terminalFinalizationId !== finalization.id",
    "run.targetAgentId === null",
    "staleTargetAgentId: run.targetAgentId",
    "sourceRunId: run.runId",
    "sourceCommentId: finalization.progressCommentId",
    "replyToCommentId: finalization.progressCommentId",
    'sourceKind: "agent_liveness_followup"',
    "row.staleTargetAgentId !== run.targetAgentId",
    "binding.ref.targetAgentId !== run.targetAgentId",
  ]) {
    if (!service.includes(token)) {
      violations.push(`${LIVENESS_SERVICE}: missing same-agent invariant ${token}`);
    }
  }

  const targetAssignments = [
    ...service.matchAll(/\b(?:staleTargetAgentId|targetAgentId):\s*([^,\n}]+)/g),
  ];
  if (targetAssignments.length !== 3) {
    violations.push(
      `${LIVENESS_SERVICE}: stale/ref/run/admission target must have exactly three derived assignments`,
    );
  }
  for (const match of targetAssignments) {
    if (match[1]!.trim() !== "run.targetAgentId") {
      violations.push(
        `${LIVENESS_SERVICE}: alternate liveness recipient ${match[1]!.trim()}`,
      );
    }
  }

  const forbidden = [
    ["generated mention", /\b(?:mentionAgent|mention_agent)\s*\(|sourceKind:\s*["']consult_mention["']/],
    ["upward/creator recipient", /\b(?:reportsTo|creatorAgentId|parentAgentId|managerAgentId|upwardRecipientId)\b/],
    ["system escalation", /\b(?:systemEscalationIdentities|ensureSystemEscalation|resolveSystemEscalationOwner|escalatedFrom)\b/],
  ] as const;
  for (const [label, pattern] of forbidden) {
    if (pattern.test(service)) {
      violations.push(`${LIVENESS_SERVICE}: forbidden ${label} coupling`);
    }
  }
  return violations;
}

function attentionBoundaryViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  const attention = read(repositoryRoot, ATTENTION_OWNER);
  if (
    !attention ||
    !/sourceKind:\s*"agent_liveness"[\s\S]{0,500}?decisionVerbs:\s*\[\][\s\S]{0,250}?inlineResolvable:\s*false[\s\S]{0,1500}?\{\s*suppressible:\s*false\s*\}/.test(
      attention,
    )
  ) {
    violations.push(
      `${ATTENTION_OWNER}: agent_liveness must have empty verbs, inlineResolvable false, and suppressible false`,
    );
  }

  violations.push(
    ...requireFileTokens(repositoryRoot, DISMISSAL_OWNER, [
      'const AGENT_LIVENESS_DISMISSAL_PREFIX = "attention:agent-liveness:";',
      "if (itemKey.startsWith(AGENT_LIVENESS_DISMISSAL_PREFIX))",
      "throw badRequest(",
      "Agent-liveness Attention items remain until an explicit issue action advances the issue",
    ]),
    ...requireFileTokens(repositoryRoot, ATTENTION_ROW, [
      'const suppressionAllowed = item.sourceKind !== "agent_liveness";',
      "const dismissHandler = suppressionAllowed ? onDismiss : undefined;",
      "const snoozeHandler = suppressionAllowed ? onSnooze : undefined;",
    ]),
    ...requireFileTokens(repositoryRoot, ATTENTION_PAGE, [
      'onDismiss={item.sourceKind === "agent_liveness" ? undefined : handleDismiss}',
      'onSnooze={item.sourceKind === "agent_liveness" ? undefined : handleSnooze}',
    ]),
  );
  const dismissals = read(repositoryRoot, DISMISSAL_OWNER);
  const guardCalls = dismissals?.match(/assertDismissibleItemKey\(itemKey\);/g)
    ?.length ?? 0;
  if (guardCalls !== 2) {
    violations.push(
      `${DISMISSAL_OWNER}: dismissal/snooze and restore must both reject agent_liveness keys`,
    );
  }
  return violations;
}

function runLivenessFactViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  const finalizer = read(repositoryRoot, FINALIZATION_OWNER);
  if (!finalizer) return [`${FINALIZATION_OWNER}: required canonical owner is missing`];
  for (const token of [
    `transaction.insert(${RUN_LIVENESS_TABLE_SYMBOL}).values({`,
    "id,",
    "companyId: input.companyId",
    "runId: input.runId",
    "livenessState: classification.livenessState",
    "livenessReason: classification.livenessReason",
    "continuationAttempt: classification.continuationAttempt",
    "lastUsefulActionAt: classification.lastUsefulActionAt",
    "nextAction: classification.nextAction",
    "runLivenessFactId: livenessId",
  ]) {
    if (!finalizer.includes(token)) {
      violations.push(
        `${FINALIZATION_OWNER}: missing canonical run-liveness ownership token ${token}`,
      );
    }
  }
  return violations;
}

/**
 * Structural P14-P17 boundary: one completion-driven same-agent frontier,
 * never issue state, escalation, recipient selection, or a second liveness
 * owner. The separate five-field productive-run fact is intentionally kept.
 */
export function issueLivenessBoundaryViolations(
  repositoryRoot: string,
): string[] {
  return [
    ...lifecycleViolations(repositoryRoot),
    ...schemaBoundaryViolations(repositoryRoot),
    ...writerAndCallerViolations(repositoryRoot),
    ...settlementProducerViolations(repositoryRoot),
    ...sameAgentBoundaryViolations(repositoryRoot),
    ...attentionBoundaryViolations(repositoryRoot),
    ...runLivenessFactViolations(repositoryRoot),
  ].filter((value, index, all) => all.indexOf(value) === index).sort();
}

export function assertIssueLivenessBoundary(repositoryRoot: string): void {
  assertNoGateViolations(
    "Issue-liveness structural boundary check",
    issueLivenessBoundaryViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertIssueLivenessBoundary(resolve(import.meta.dirname, ".."));
    console.log("Issue-liveness structural boundary check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
