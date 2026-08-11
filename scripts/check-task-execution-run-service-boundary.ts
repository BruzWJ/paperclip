import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import ts from "typescript";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SCAN_ROOTS = [
  ".agents",
  ".github",
  "apps",
  "doc",
  "docker",
  "evals",
  "packages",
  "scripts",
  "tests",
] as const;
const ROOT_FILES = [
  "AGENTS.md",
  "Dockerfile",
  "README.md",
  "ROADMAP.md",
  "adapter-plugin.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
] as const;
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const SELF_TEST_PATH =
  "scripts/check-task-execution-run-service-boundary.test.ts";
const RUN_SERVICE_PATH =
  "apps/server/src/services/task-execution-run-service.ts";
const DISPATCHER_POSTGRES_PATH =
  "apps/server/src/services/task-execution-dispatcher-postgres.ts";
const ATTEMPT_EXECUTOR_PATH =
  "apps/server/src/services/task-execution-attempt-executor.ts";
const RUN_FINALIZER_PATH =
  "apps/server/src/services/task-execution-finalization-postgres.ts";
const RUN_SCHEMA_PATH =
  "packages/db/schema/task_execution_runs.ts";
const RUN_ROUTE_PATH = "apps/server/src/routes/runs.ts";
const TOOL_GATEWAY_PATH =
  "apps/server/src/services/runtime-tool-gateway.ts";
const TOOL_RETRIEVAL_PATH =
  "apps/server/src/services/context-retrieval-db.ts";
const TOOL_RETRIEVAL_CONTRACT_PATH =
  "apps/server/src/services/context-retrieval.ts";
const OPENAPI_PATH = "apps/server/src/routes/openapi.ts";

const LEGACY_TERMS = [
  ["heartbeat", "_runs"].join(""),
  ["heartbeat", "_run_events"].join(""),
  ["heartbeat", "_run_watchdog_decisions"].join(""),
  ["heart", "beatRuns"].join(""),
  ["heart", "beatRunEvents"].join(""),
  ["Heart", "beatRun"].join(""),
  ["heart", "beatRunId"].join(""),
  ["heart", "beatsApi"].join(""),
  ["/heart", "beat-runs"].join(""),
  ["HEART", "BEAT_RUN"].join(""),
  ["heart", "beat.run."].join(""),
  ["run", "TelemetryService"].join(""),
  ["append", "RunEvent"].join(""),
  ["write", "RunEvent"].join(""),
  ["append", "RunLog"].join(""),
  ["write", "RunLog"].join(""),
  ["read", "RunLog"].join(""),
  ["get", "RunLogAccess"].join(""),
  ["build", "RunOutputSilence"].join(""),
  ["decorate", "ActiveRunStatus"].join(""),
  ["finish", "AttemptRun"].join(""),
  ["report", "RunActivity"].join(""),
] as const;

const LEGACY_PATH_FRAGMENTS = [
  ["heart", "beat-run"].join(""),
  ["heart", "beat_runs"].join(""),
] as const;

const RUN_TABLE_IDENTIFIER = ["taskExecution", "Runs"].join("");
const RUN_TABLE_SQL_NAME = ["task_execution", "_runs"].join("");
const CURRENT_RUN_REF_ALIAS = ["current", "RunRefId"].join("");
const LIVENESS_TABLE_IDENTIFIER =
  ["taskExecutionRun", "LivenessFacts"].join("");

const RUN_ENVELOPE_COLUMNS = [
  "id",
  "companyId",
  "taskId",
  "sessionId",
  "executionScopeId",
  "kind",
  "status",
  "ownershipEpoch",
  "targetAgentId",
  "adapterConfigRevisionId",
  "executionWorkspaceBindingId",
  "executionMode",
  "taskExecutionAuthorityId",
  "consultExecutionId",
  "parentRunId",
  "retryOfRunId",
  "currentAttemptId",
  "currentLeaseId",
  "cancellationIntentId",
  "terminalFinalizationId",
  "startedAt",
  "finishedAt",
  "terminalClassification",
  "terminalReasonCode",
  "createdAt",
  "updatedAt",
] as const;

const RUN_CONTROL_COLUMNS = [
  "runId",
  "currentRefId",
  "currentOrdinal",
  "currentSegmentOrdinal",
] as const;

export interface CanonicalRunBoundaryFile {
  readonly path: string;
  readonly source: string;
}

export interface CanonicalRunBoundaryViolation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly rule: string;
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

function isIgnored(path: string): boolean {
  const normalized = `/${toPosix(path)}`;
  return (
    normalized.includes("/.git/") ||
    normalized.includes("/.next/") ||
    normalized.includes("/coverage/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/node_modules/") ||
    normalized.includes("/storybook-static/") ||
    toPosix(path) === SELF_TEST_PATH
  );
}

function isTestPath(path: string): boolean {
  const normalized = toPosix(path);
  const basename = normalized.split("/").at(-1) ?? "";
  return (
    normalized.includes("/__tests__/") ||
    /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(basename)
  );
}

function isProductionRuntimePath(path: string): boolean {
  const normalized = toPosix(path);
  if (isTestPath(normalized)) return false;
  if (normalized.startsWith("packages/db/schema/")) return false;
  return (
    normalized.startsWith("apps/server/src/") ||
    normalized.startsWith("packages/") ||
    normalized.startsWith("packages/cli/src/") ||
    normalized.startsWith("apps/ui/src/")
  );
}

function lineAndColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  const before = source.slice(0, offset);
  const previousNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - previousNewline,
  };
}

function addOccurrences(
  violations: CanonicalRunBoundaryViolation[],
  file: CanonicalRunBoundaryFile,
  term: string,
  rule: string,
): void {
  let offset = file.source.indexOf(term);
  while (offset !== -1) {
    violations.push({
      path: toPosix(file.path),
      ...lineAndColumn(file.source, offset),
      rule,
    });
    offset = file.source.indexOf(term, offset + term.length);
  }
}

export function scanCanonicalRunBoundaryFiles(
  files: readonly CanonicalRunBoundaryFile[],
): CanonicalRunBoundaryViolation[] {
  const violations: CanonicalRunBoundaryViolation[] = [];

  for (const file of files) {
    const path = toPosix(file.path);
    for (const term of LEGACY_TERMS) {
      addOccurrences(
        violations,
        { ...file, path },
        term,
        `retired run surface ${term}`,
      );
    }
    for (const fragment of LEGACY_PATH_FRAGMENTS) {
      const offset = path.indexOf(fragment);
      if (offset !== -1) {
        violations.push({
          path,
          line: 1,
          column: offset + 1,
          rule: `retired run path ${fragment}`,
        });
      }
    }
    const legacyRunTelemetry = ["run", "-telemetry"].join("");
    for (const source of [path, file.source]) {
      let offset = source.indexOf(legacyRunTelemetry);
      while (offset !== -1) {
        const preceding = source[offset - 1] ?? "";
        if (!/[A-Za-z0-9-]/.test(preceding)) {
          const location = source === path
            ? { line: 1, column: offset + 1 }
            : lineAndColumn(file.source, offset);
          violations.push({
            path,
            ...location,
            rule: `retired generic run telemetry ${legacyRunTelemetry}`,
          });
        }
        offset = source.indexOf(
          legacyRunTelemetry,
          offset + legacyRunTelemetry.length,
        );
      }
    }
    addOccurrences(
      violations,
      { ...file, path },
      CURRENT_RUN_REF_ALIAS,
      `forbidden run-ref association alias ${CURRENT_RUN_REF_ALIAS}`,
    );

    if (isProductionRuntimePath(path) && path !== RUN_SERVICE_PATH) {
      addOccurrences(
        violations,
        { ...file, path },
        RUN_TABLE_IDENTIFIER,
        `run table access outside ${RUN_SERVICE_PATH}`,
      );
      const rawRunQueryPattern = new RegExp(
        `(?:sql|execute)[\\s\\S]{0,200}[\"'\\x60]${RUN_TABLE_SQL_NAME}[\"'\\x60]`,
        "g",
      );
      for (const match of file.source.matchAll(rawRunQueryPattern)) {
        const tableOffset = (match.index ?? 0) + match[0].lastIndexOf(RUN_TABLE_SQL_NAME);
        violations.push({
          path,
          ...lineAndColumn(file.source, tableOffset),
          rule: `raw run table access outside ${RUN_SERVICE_PATH}`,
        });
      }
    }

    if (isProductionRuntimePath(path) && path !== RUN_FINALIZER_PATH) {
      const insertPattern = new RegExp(
        `\\.insert\\s*\\(\\s*${LIVENESS_TABLE_IDENTIFIER}\\s*\\)`,
        "g",
      );
      for (const match of file.source.matchAll(insertPattern)) {
        const offset = match.index ?? 0;
        violations.push({
          path,
          ...lineAndColumn(file.source, offset),
          rule: `run-liveness writer outside ${RUN_FINALIZER_PATH}`,
        });
      }
    }

    const mutableLivenessPattern = new RegExp(
      `\\.(?:update|delete)\\s*\\(\\s*${LIVENESS_TABLE_IDENTIFIER}\\s*\\)`,
      "g",
    );
    for (const match of file.source.matchAll(mutableLivenessPattern)) {
      const offset = match.index ?? 0;
      violations.push({
        path,
        ...lineAndColumn(file.source, offset),
        rule: "run-liveness facts are insert-only",
      });
    }

    const retiredTraceTerms =
      path === TOOL_RETRIEVAL_CONTRACT_PATH
        ? ["CanonicalRunTraceEvent"]
        : path === TOOL_RETRIEVAL_PATH
          ? [
              "CanonicalRunTraceEvent",
              "sanitizeCanonicalEventRow",
              "events: []",
            ]
          : path === OPENAPI_PATH
            ? ["canonicalRunTraceEventSchema", "canonicalRunTraceSchema"]
            : [];
    for (const term of retiredTraceTerms) {
      addOccurrences(
        violations,
        { ...file, path },
        term,
        `retired generic canonical run-trace event surface ${term}`,
      );
    }
  }

  return violations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      left.rule.localeCompare(right.rule),
  );
}

function walk(
  directory: string,
  repositoryRoot: string,
  files: CanonicalRunBoundaryFile[],
): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = toPosix(relative(repositoryRoot, absolutePath));
    if (isIgnored(relativePath)) continue;
    if (entry.isDirectory()) {
      walk(absolutePath, repositoryRoot, files);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    files.push({
      path: relativePath,
      source: readFileSync(absolutePath, "utf8"),
    });
  }
}

export function listCanonicalRunBoundaryFiles(
  repositoryRoot = REPOSITORY_ROOT,
): CanonicalRunBoundaryFile[] {
  const files: CanonicalRunBoundaryFile[] = [];
  for (const root of SCAN_ROOTS) {
    walk(resolve(repositoryRoot, root), repositoryRoot, files);
  }
  for (const path of ROOT_FILES) {
    const absolutePath = resolve(repositoryRoot, path);
    if (!existsSync(absolutePath) || isIgnored(path)) continue;
    files.push({ path, source: readFileSync(absolutePath, "utf8") });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function getVariableCall(
  sourceFile: ts.SourceFile,
  variableName: string,
): ts.CallExpression {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === variableName &&
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer)
      ) {
        return declaration.initializer;
      }
    }
  }
  throw new Error(`${RUN_SCHEMA_PATH} is missing ${variableName}`);
}

function objectPropertyNames(
  sourceFile: ts.SourceFile,
  variableName: string,
): string[] {
  const call = getVariableCall(sourceFile, variableName);
  const object = call.arguments[1];
  if (!object || !ts.isObjectLiteralExpression(object)) {
    throw new Error(`${variableName} must use a literal column object`);
  }
  return object.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${variableName} columns must be property assignments`);
    }
    if (
      ts.isIdentifier(property.name) ||
      ts.isStringLiteral(property.name) ||
      ts.isNumericLiteral(property.name)
    ) {
      return property.name.text;
    }
    throw new Error(`${variableName} has a computed column name`);
  });
}

function assertExactColumns(
  sourceFile: ts.SourceFile,
  variableName: string,
  expected: readonly string[],
): void {
  const actual = objectPropertyNames(sourceFile, variableName);
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(
      `${variableName} columns must be exactly ${expected.join(", ")}; found ${actual.join(", ")}`,
    );
  }
}

function assertControlForeignKeyShape(sourceFile: ts.SourceFile): void {
  const call = getVariableCall(sourceFile, "taskExecutionRunControls");
  const columnCounts: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "foreignKey"
    ) {
      const input = node.arguments[0];
      if (input && ts.isObjectLiteralExpression(input)) {
        const columns = input.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === "columns",
        );
        if (columns && ts.isArrayLiteralExpression(columns.initializer)) {
          columnCounts.push(columns.initializer.elements.length);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(call);
  if (columnCounts.length !== 1 || columnCounts[0] !== 3) {
    throw new Error(
      "taskExecutionRunControls must have exactly one three-column member FK and no unconditional segment FK",
    );
  }
}

function assertCanonicalSchema(repositoryRoot: string): void {
  const runSchemaSource = readFileSync(
    resolve(repositoryRoot, RUN_SCHEMA_PATH),
    "utf8",
  );
  const sourceFile = ts.createSourceFile(
    RUN_SCHEMA_PATH,
    runSchemaSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assertExactColumns(sourceFile, "taskExecutionRuns", RUN_ENVELOPE_COLUMNS);
  assertExactColumns(
    sourceFile,
    "taskExecutionRunControls",
    RUN_CONTROL_COLUMNS,
  );
  assertControlForeignKeyShape(sourceFile);

  for (const required of [
    `\"${RUN_TABLE_SQL_NAME}\"`,
    "task_execution_run_refs_run_ordinal_ref_uq",
    "task_execution_run_controls_current_member_fk",
    "current_prompt_shape_check",
  ]) {
    if (!runSchemaSource.includes(required)) {
      throw new Error(`${RUN_SCHEMA_PATH} is missing ${required}`);
    }
  }
}

/**
 * A provider trace is not the run-detail message page: it also includes the
 * exact source messages that were transmitted through run refs and prompt
 * segments. The run service still owns run identity and the joined envelope;
 * this reader owns the bounded Task Session transcript projection.
 */
export function assertCanonicalContextRunTraceReader(
  source: string,
): void {
  for (const required of [
    "resolveTaskExecutionRunIdentityById(db, runId)",
    "options.runService.readJoinedRunDetail",
    ".from(taskSessionMessages)",
    "prompt_transmission_phase = 'transmitted'",
    "source_ref.source_message_id",
    "segment.source_message_id",
    "sanitizeCanonicalMessage(decodeStoredTaskSessionMessage(row), row.seq)",
    "turns,",
  ]) {
    if (!source.includes(required)) {
      throw new Error(
        `${TOOL_RETRIEVAL_PATH} must resolve the canonical run and project its transmitted Task Session trace (${required})`,
      );
    }
  }
}

function assertCanonicalConsumers(repositoryRoot: string): void {
  const runServiceSource = readFileSync(
    resolve(repositoryRoot, RUN_SERVICE_PATH),
    "utf8",
  );
  for (const required of [
    "createRun",
    "lockRun",
    "readRun",
    "transitionRunStatus",
    "readJoinedRunDetail",
  ]) {
    if (!runServiceSource.includes(required)) {
      throw new Error(`${RUN_SERVICE_PATH} is missing ${required}`);
    }
  }
  const dispatcherPostgresSource = readFileSync(
    resolve(repositoryRoot, DISPATCHER_POSTGRES_PATH),
    "utf8",
  );
  assertCanonicalTargetLaneRunLocking(
    runServiceSource,
    dispatcherPostgresSource,
  );
  assertMissingCarryStartsFresh(
    dispatcherPostgresSource,
    readFileSync(resolve(repositoryRoot, ATTEMPT_EXECUTOR_PATH), "utf8"),
  );

  const routeSource = readFileSync(resolve(repositoryRoot, RUN_ROUTE_PATH), "utf8");
  if (!routeSource.includes("readJoinedRunDetail")) {
    throw new Error(`${RUN_ROUTE_PATH} must use readJoinedRunDetail`);
  }

  const toolGatewaySource = readFileSync(
    resolve(repositoryRoot, TOOL_GATEWAY_PATH),
    "utf8",
  );
  if (!toolGatewaySource.includes("options.managedTools.routeExecution(")) {
    throw new Error(
      `${TOOL_GATEWAY_PATH} must route Paperclip calls through the canonical managed-tool router`,
    );
  }
  const toolRetrievalSource = readFileSync(
    resolve(repositoryRoot, TOOL_RETRIEVAL_PATH),
    "utf8",
  );
  assertCanonicalContextRunTraceReader(toolRetrievalSource);
  for (const forbidden of [
    "CanonicalRunTraceEvent",
    "sanitizeCanonicalEventRow",
    "events: []",
  ]) {
    if (toolRetrievalSource.includes(forbidden)) {
      throw new Error(
        `${TOOL_RETRIEVAL_PATH} retains generic trace-event surface ${forbidden}`,
      );
    }
  }

}

export function assertCanonicalTargetLaneRunLocking(
  runServiceSource: string,
  dispatcherPostgresSource: string,
): void {
  for (const forbidden of [
    "readActiveProductiveTaskExecutionLaneHeadInTransaction",
    "expectedCurrentRefId",
    "expectedRunId",
  ]) {
    if (runServiceSource.includes(forbidden)) {
      throw new Error(
        `${RUN_SERVICE_PATH} retains stale target-lane probe contract ${forbidden}`,
      );
    }
  }
  for (const required of [
    "export async function lockActiveProductiveRunForLaneInTransaction(",
    "input: TaskExecutionTargetLaneIdentity,",
  ]) {
    if (!runServiceSource.includes(required)) {
      throw new Error(
        `${RUN_SERVICE_PATH} is missing canonical target-lane lock ${required}`,
      );
    }
  }

  const ownerStart = dispatcherPostgresSource.indexOf(
    "async function findExistingRunForLane(",
  );
  const ownerEnd = dispatcherPostgresSource.indexOf(
    "async function createRunForRef(",
    ownerStart + 1,
  );
  if (ownerStart < 0 || ownerEnd < 0) {
    throw new Error(
      `${DISPATCHER_POSTGRES_PATH} is missing the exact target-lane run-lock owner`,
    );
  }
  const ownerSource = dispatcherPostgresSource.slice(ownerStart, ownerEnd);
  let previousOffset = -1;
  for (const required of [
    "await lockLaneParents(transaction, lane);",
    "await lockLane(transaction, lane);",
    "return lockActiveProductiveRunForLaneInTransaction(transaction, lane);",
  ]) {
    const offset = ownerSource.indexOf(required);
    if (offset <= previousOffset) {
      throw new Error(
        `${DISPATCHER_POSTGRES_PATH} must lock company, task, Session, exact lane, then freshly lock its active run`,
      );
    }
    previousOffset = offset;
  }
}

export function assertMissingCarryStartsFresh(
  dispatcherPostgresSource: string,
  attemptExecutorSource: string,
): void {
  const ownerStart = dispatcherPostgresSource.indexOf(
    "async function selectSessionOperation(",
  );
  const ownerEnd = dispatcherPostgresSource.indexOf(
    "async function assertRefDispatchable(",
    ownerStart + 1,
  );
  if (ownerStart < 0 || ownerEnd < 0) {
    throw new Error(
      `${DISPATCHER_POSTGRES_PATH} is missing canonical session-operation selection`,
    );
  }
  const ownerSource = dispatcherPostgresSource.slice(ownerStart, ownerEnd);
  const trueCarryStart = ownerSource.indexOf("const eligible =");
  const trueCarrySource = trueCarryStart >= 0
    ? ownerSource.slice(trueCarryStart)
    : "";
  if (
    !trueCarrySource.includes('return "new";') ||
    trueCarrySource.includes("recovery_new") ||
    trueCarrySource.includes("historical")
  ) {
    throw new Error(
      `${DISPATCHER_POSTGRES_PATH} must start a fresh session for every missing true-carry mapping`,
    );
  }

  const validationStart = attemptExecutorSource.indexOf(
    "const operation = prompt.sessionOperation;",
  );
  const validationEnd = attemptExecutorSource.indexOf(
    "if (!operationIsValid)",
    validationStart + 1,
  );
  const validationSource = validationStart >= 0 && validationEnd >= 0
    ? attemptExecutorSource.slice(validationStart, validationEnd)
    : "";
  if (
    !/\(operation\s*===\s*["']new["']\s*&&\s*prompt\.storedCorrelation\s*===\s*null\)/.test(
      validationSource,
    ) || validationSource.includes("!prompt.carryContext")
  ) {
    throw new Error(
      `${ATTEMPT_EXECUTOR_PATH} must allow session/new without a stored correlation regardless of carry_context`,
    );
  }
}

export function assertTaskExecutionRunServiceBoundary(
  repositoryRoot = REPOSITORY_ROOT,
): void {
  const violations = scanCanonicalRunBoundaryFiles(
    listCanonicalRunBoundaryFiles(repositoryRoot),
  );
  if (violations.length > 0) {
    throw new Error(
      `Canonical run boundary violations:\n${violations
        .map(
          (entry) =>
            `${entry.path}:${entry.line}:${entry.column} ${entry.rule}`,
        )
        .join("\n")}`,
    );
  }
  assertCanonicalSchema(repositoryRoot);
  assertCanonicalConsumers(repositoryRoot);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  assertTaskExecutionRunServiceBoundary();
  console.log("Task-execution run-service boundary check passed.");
}
