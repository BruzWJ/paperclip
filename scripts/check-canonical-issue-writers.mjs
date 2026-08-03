#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, "..");

const SOURCE_ROOTS = ["server/src", "cli/src", "packages"];
const SQL_ROOTS = [
  "packages/db/migrations",
  "packages/db/migrations",
  "packages/db/drizzle",
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const ISSUE_INSERT_OWNER = "server/src/services/canonical-issue-aggregate.ts";
const ISSUE_INSERT_FUNCTION = "persistCanonicalIssueAggregateInTx";
const ISSUE_DELETE_OWNER = "server/src/services/issue-session-lifecycle.ts";
const ISSUE_DELETE_FUNCTION = "purgeCompanySessionGraphInTx";
const ISSUE_CONTROL_OWNER = "server/src/services/issues.ts";
const COMPILER_OWNER = "server/src/services/runtime-interface-compiler.ts";
const ACTION_PORT_OWNER = "server/src/services/runtime-issue-action-port.ts";
const ISSUE_SCHEMA_OWNER = "packages/db/schema/issues.ts";

const IMMUTABLE_UPDATE_FIELDS = new Set([
  "request",
  "creatorKind",
  "creatorAuthorityId",
  "creatorAdapterConfigRevisionId",
  "creatorUserId",
  "creatorPluginInstallationId",
  "creatorPluginKey",
  "creatorCallbackKey",
  "creatorCallbackVersion",
  "creatorRoutineId",
  "creatorRoutineDispatchId",
  "creatorSystemSourceKind",
  "creatorSystemSourceId",
]);
const CREATOR_PAIR = ["creatorAuthorityId", "creatorAdapterConfigRevisionId"];
const SAFE_TABLE_ARGUMENT_METHODS = new Set([
  "from",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "insert",
  "update",
  "delete",
]);
const GENERIC_WRITER_NAME = /(?:insert|create|persist|write|save|upsert|store|mutat)/i;

function toPosix(value) {
  return value.split("\\").join("/");
}

function shouldSkip(relativePath) {
  const path = toPosix(relativePath);
  const segments = path.split("/");
  const base = segments.at(-1) ?? "";
  if (segments.includes("node_modules") || segments.includes("dist")) return true;
  if (segments.includes("__tests__")) return true;
  if (path.includes("/fixtures/") || path.includes("/test-support/")) return true;
  return /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(base);
}

function walk(directory, repoRoot, output, extensions) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(repoRoot, absolutePath);
    if (entry.isDirectory()) {
      if (!shouldSkip(`${relativePath}/`)) walk(absolutePath, repoRoot, output, extensions);
      continue;
    }
    if (!extensions.has(extname(entry.name)) || shouldSkip(relativePath)) continue;
    output.push(absolutePath);
  }
}

export function listCanonicalIssueWriterInputs(repoRoot = DEFAULT_REPO_ROOT) {
  const sourceFiles = [];
  for (const root of SOURCE_ROOTS) {
    walk(resolve(repoRoot, root), repoRoot, sourceFiles, SOURCE_EXTENSIONS);
  }
  const sqlFiles = [];
  for (const root of SQL_ROOTS) {
    walk(resolve(repoRoot, root), repoRoot, sqlFiles, new Set([".sql"]));
  }
  return {
    sourceFiles: [...new Set(sourceFiles)].sort(),
    sqlFiles: [...new Set(sqlFiles)].sort(),
  };
}

function propertyNameText(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function callMethodName(expression) {
  const target = unwrap(expression);
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target) && target.argumentExpression) {
    const argument = unwrap(target.argumentExpression);
    if (ts.isStringLiteralLike(argument)) return argument.text;
  }
  return null;
}

function functionLikeName(node) {
  if (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) &&
    node.name
  ) {
    return propertyNameText(node.name);
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isPropertyAssignment(node.parent)
  ) {
    return propertyNameText(node.parent.name);
  }
  return null;
}

function enclosingFunctionName(node) {
  let current = node.parent;
  while (current) {
    const name = functionLikeName(current);
    if (name) return name;
    current = current.parent;
  }
  return null;
}

function isInsideNamedFunction(node, expected) {
  let current = node.parent;
  while (current) {
    if (functionLikeName(current) === expected) return true;
    current = current.parent;
  }
  return false;
}

function scriptKind(relativePath) {
  if (relativePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (relativePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(relativePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function buildBindings(sourceFile) {
  const aliases = new Set();
  const namespaces = new Set();
  const initializers = new Map();
  const factories = new Set();

  const collect = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    }
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName?.text === "issues" || (!node.propertyName && node.name.text === "issues"))
    ) {
      aliases.add(node.name.text);
    }
    if (ts.isBindingElement(node)) {
      const imported = propertyNameText(node.propertyName) ?? propertyNameText(node.name);
      const local = propertyNameText(node.name);
      if (imported === "issues" && local) aliases.add(local);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const isTable = (expression, seen = new Set()) => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      if (aliases.has(node.text)) return true;
      if (seen.has(node.text)) return false;
      const initializer = initializers.get(node.text);
      if (!initializer) return false;
      seen.add(node.text);
      return isTable(initializer, seen);
    }
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text === "issues" &&
        ts.isIdentifier(unwrap(node.expression)) &&
        namespaces.has(unwrap(node.expression).text);
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const key = unwrap(node.argumentExpression);
      return ts.isStringLiteralLike(key) && key.text === "issues";
    }
    return ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression)) && factories.has(unwrap(node.expression).text);
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, initializer] of initializers) {
      if (isTable(initializer) && !aliases.has(name)) {
        aliases.add(name);
        changed = true;
      }
      const expression = unwrap(initializer);
      if (ts.isArrowFunction(expression) && !ts.isBlock(expression.body) && isTable(expression.body) && !factories.has(name)) {
        factories.add(name);
        changed = true;
      }
    }
    const findFactories = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const returnsTable = node.body.statements.some(
          (statement) => ts.isReturnStatement(statement) && statement.expression && isTable(statement.expression),
        );
        if (returnsTable && !factories.has(node.name.text)) {
          factories.add(node.name.text);
          changed = true;
        }
      }
      ts.forEachChild(node, findFactories);
    };
    findFactories(sourceFile);
  }
  return { aliases, initializers, factories, isTable };
}

function lineAndColumn(sourceFile, position) {
  const result = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: result.line + 1, column: result.character + 1 };
}

function makeViolation(sourceFile, relativePath, node, operation, message) {
  const { line, column } = lineAndColumn(sourceFile, node.getStart(sourceFile));
  return { path: toPosix(relativePath), line, column, operation, message };
}

function objectPropertyNames(expression, initializers, seen = new Set()) {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return { names: new Set(), dynamic: true, objectLiteral: false };
    const initializer = initializers.get(node.text);
    if (!initializer) return { names: new Set(), dynamic: true, objectLiteral: false };
    seen.add(node.text);
    return objectPropertyNames(initializer, initializers, seen);
  }
  if (!ts.isObjectLiteralExpression(node)) return { names: new Set(), dynamic: true, objectLiteral: false };
  const names = new Set();
  let dynamic = false;
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const nested = objectPropertyNames(property.expression, initializers, new Set(seen));
      for (const name of nested.names) names.add(name);
      dynamic ||= nested.dynamic;
      continue;
    }
    const name = propertyNameText(property.name);
    if (name) names.add(name);
  }
  return { names, dynamic, objectLiteral: true };
}

function tableMutationCallFromSet(call, bindings) {
  if (callMethodName(call.expression) !== "set") return null;
  const expression = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return null;
  const receiver = unwrap(expression.expression);
  if (!ts.isCallExpression(receiver) || callMethodName(receiver.expression) !== "update") return null;
  return receiver.arguments[0] && bindings.isTable(receiver.arguments[0]) ? receiver : null;
}

function rawSqlMutation(text) {
  const table = String.raw`(?:"?[\w-]+"?\.)?"?issues"?`;
  if (new RegExp(String.raw`\binsert\s+into\s+${table}\b`, "i").test(text)) return "insert";
  if (new RegExp(String.raw`\bdelete\s+from\s+${table}\b`, "i").test(text)) return "delete";
  const update = text.match(new RegExp(String.raw`\bupdate\s+${table}\s+set\s+([\s\S]*)`, "i"));
  if (!update) return null;
  const normalized = update[1].toLowerCase();
  const immutable = [...IMMUTABLE_UPDATE_FIELDS].some((field) => {
    const snake = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    return new RegExp(`(?:"${snake}"|\\b${snake}\\b|"${field}"|\\b${field}\\b)`, "i").test(normalized);
  });
  return immutable ? "immutable-update" : null;
}

function literalText(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("${…}");
  }
  return null;
}

function canonicalCallIssueObject(call, initializers) {
  const expression = unwrap(call.expression);
  const calledName = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : null;
  if (calledName !== ISSUE_INSERT_FUNCTION || call.arguments.length === 0) return null;
  let input = unwrap(call.arguments.at(-1));
  if (ts.isIdentifier(input)) input = unwrap(initializers.get(input.text) ?? input);
  if (!ts.isObjectLiteralExpression(input)) return null;
  const issueProperty = input.properties.find(
    (property) => ts.isPropertyAssignment(property) && propertyNameText(property.name) === "issue",
  );
  if (!issueProperty || !ts.isPropertyAssignment(issueProperty)) return null;
  let issue = unwrap(issueProperty.initializer);
  if (ts.isIdentifier(issue)) issue = unwrap(initializers.get(issue.text) ?? issue);
  return ts.isObjectLiteralExpression(issue) ? issue : null;
}

function hasClosedControlPatchContract(sourceText) {
  const required = [
    "type IssueControlStateUpdate",
    "data: IssueControlStateUpdate",
    '"request"',
    '"creatorAuthorityId"',
    '"creatorAdapterConfigRevisionId"',
  ];
  return required.every((marker) => sourceText.includes(marker));
}

export function inspectSourceText(relativePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(relativePath),
  );
  const path = toPosix(relativePath);
  const bindings = buildBindings(sourceFile);
  const violations = [];
  const allowedInsertCalls = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const operation = callMethodName(node.expression);
      if (
        operation &&
        ["insert", "delete"].includes(operation) &&
        node.arguments[0] &&
        bindings.isTable(node.arguments[0])
      ) {
        const functionName = enclosingFunctionName(node);
        const allowed = operation === "insert"
          ? path === ISSUE_INSERT_OWNER && functionName === ISSUE_INSERT_FUNCTION
          : path === ISSUE_DELETE_OWNER && functionName === ISSUE_DELETE_FUNCTION;
        if (operation === "insert" && allowed) allowedInsertCalls.push(node);
        if (!allowed) {
          violations.push(makeViolation(
            sourceFile,
            path,
            node,
            operation,
            operation === "insert"
              ? `Only ${ISSUE_INSERT_OWNER}::${ISSUE_INSERT_FUNCTION} may insert issues.`
              : `Only ${ISSUE_DELETE_OWNER}::${ISSUE_DELETE_FUNCTION} may delete issues.`,
          ));
        }
      }

      const updateCall = tableMutationCallFromSet(node, bindings);
      if (updateCall && node.arguments[0]) {
        const fields = objectPropertyNames(node.arguments[0], bindings.initializers);
        const forbidden = [...fields.names].filter((name) => IMMUTABLE_UPDATE_FIELDS.has(name));
        const closedDynamicPatch =
          path === ISSUE_CONTROL_OWNER &&
          isInsideNamedFunction(node, "updateControlState") &&
          hasClosedControlPatchContract(sourceText);
        if (
          forbidden.length > 0 ||
          (fields.dynamic && !fields.objectLiteral && !closedDynamicPatch)
        ) {
          violations.push(makeViolation(
            sourceFile,
            path,
            node,
            forbidden.length > 0 ? "immutable-update" : "generic-update-payload",
            forbidden.length > 0
              ? `Immutable issue fields cannot be updated: ${forbidden.sort().join(", ")}.`
              : "A generic issue update payload can carry immutable request/creator fields.",
          ));
        }
      }

      const method = callMethodName(node.expression);
      const calledExpression = unwrap(node.expression);
      const calledName = method ?? (ts.isIdentifier(calledExpression) ? calledExpression.text : "");
      if (
        node.arguments.some((argument) => bindings.isTable(argument)) &&
        !SAFE_TABLE_ARGUMENT_METHODS.has(method ?? "") &&
        GENERIC_WRITER_NAME.test(calledName)
      ) {
        violations.push(makeViolation(
          sourceFile,
          path,
          node,
          "table-wrapper",
          "The issues table cannot escape through a generic writer wrapper.",
        ));
      }

      const issueObject = canonicalCallIssueObject(node, bindings.initializers);
      if (issueObject) {
        const fields = objectPropertyNames(issueObject, bindings.initializers).names;
        const pairCount = CREATOR_PAIR.filter((field) => fields.has(field)).length;
        if (pairCount === 1) {
          violations.push(makeViolation(
            sourceFile,
            path,
            issueObject,
            "partial-creator-pair",
            "Agent-execution creator authority and originating adapter revision must be supplied together.",
          ));
        }
      }
    }

    const text = literalText(node);
    if (text) {
      const operation = rawSqlMutation(text);
      if (operation) {
        violations.push(makeViolation(
          sourceFile,
          path,
          node,
          operation,
          "Raw SQL cannot bypass canonical issue creation or immutable request/creator fields.",
        ));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const call of allowedInsertCalls.slice(1)) {
    violations.push(makeViolation(
      sourceFile,
      path,
      call,
      "second-owner-insert",
      `${ISSUE_INSERT_FUNCTION} must contain exactly one issues insert.`,
    ));
  }

  const unique = new Map();
  for (const item of violations) {
    unique.set(`${item.path}:${item.line}:${item.column}:${item.operation}`, item);
  }
  return [...unique.values()];
}

export function inspectMigrationText(relativePath, sourceText) {
  const violations = [];
  const statements = sourceText.split(/;(?=(?:[^']|'[^']*')*$)/);
  for (let index = 0; index < statements.length; index += 1) {
    const operation = rawSqlMutation(statements[index]);
    if (operation === "insert" || operation === "immutable-update") {
      violations.push({
        path: toPosix(relativePath),
        line: sourceText.slice(0, sourceText.indexOf(statements[index])).split("\n").length,
        column: 1,
        operation: "migration-mutation",
        message: "A migration cannot insert issue rows or mutate immutable request/creator fields.",
      });
    }
  }
  return violations;
}

export function requiredOwnershipViolations(files) {
  const violations = [];
  const requireFile = (path) => {
    const content = files.get(path);
    if (typeof content !== "string") {
      violations.push({ path, line: 1, column: 1, operation: "missing-owner", message: "Required canonical owner is missing." });
      return "";
    }
    return content;
  };
  const aggregate = requireFile(ISSUE_INSERT_OWNER);
  const issueService = requireFile(ISSUE_CONTROL_OWNER);
  const compiler = requireFile(COMPILER_OWNER);
  const actionPort = requireFile(ACTION_PORT_OWNER);
  const schema = requireFile(ISSUE_SCHEMA_OWNER);

  const requireMarkers = (path, content, markers, operation) => {
    for (const marker of markers) {
      if (!content.includes(marker)) {
        violations.push({ path, line: 1, column: 1, operation, message: `Missing canonical marker: ${marker}` });
      }
    }
  };
  requireMarkers(ISSUE_INSERT_OWNER, aggregate, [
    `export async function ${ISSUE_INSERT_FUNCTION}`,
    "await assertAgentExecutionCreator(tx, issue);",
    ".insert(issues)",
  ], "aggregate-owner");
  if (
    aggregate.indexOf("await assertAgentExecutionCreator(tx, issue);") >
    aggregate.indexOf(".insert(issues)")
  ) {
    violations.push({ path: ISSUE_INSERT_OWNER, line: 1, column: 1, operation: "authority-order", message: "Creator authority must be checked before the sole issue insert." });
  }
  requireMarkers(ISSUE_CONTROL_OWNER, issueService, [
    "type IssueControlStateUpdate",
    "data: IssueControlStateUpdate",
    '| "request"',
    '| "creatorAuthorityId"',
    '| "creatorAdapterConfigRevisionId"',
  ], "closed-update-contract");
  requireMarkers(COMPILER_OWNER, compiler, [
    'input.actionGrants.issue_create === true',
    "issueCreateDescriptor(input.issueCreateDirectChildren)",
  ], "compiler-authority");
  requireMarkers(ACTION_PORT_OWNER, actionPort, [
    'lockRuntimeActionAuthority(',
    '"issue_create"',
    "if (!input.capability.issueExecutionAuthorityId)",
    "creatorAuthorityId: input.capability.issueExecutionAuthorityId",
    "creatorAdapterConfigRevisionId:",
    "input.capability.adapterConfigIdentity",
    `${ISSUE_INSERT_FUNCTION}(tx,`,
  ], "action-port-authority");
  requireMarkers(ISSUE_SCHEMA_OWNER, schema, [
    'request: text("request").notNull()',
    'creatorAuthorityId: uuid("creator_authority_id")',
    'creatorAdapterConfigRevisionId: uuid("creator_adapter_config_revision_id")',
  ], "schema-contract");
  return violations;
}

export function checkCanonicalIssueWriters(repoRoot = DEFAULT_REPO_ROOT) {
  const { sourceFiles, sqlFiles } = listCanonicalIssueWriterInputs(repoRoot);
  const violations = [];
  const contents = new Map();
  for (const absolutePath of sourceFiles) {
    const path = toPosix(relative(repoRoot, absolutePath));
    const content = readFileSync(absolutePath, "utf8");
    contents.set(path, content);
    violations.push(...inspectSourceText(path, content));
  }
  for (const absolutePath of sqlFiles) {
    const path = toPosix(relative(repoRoot, absolutePath));
    violations.push(...inspectMigrationText(path, readFileSync(absolutePath, "utf8")));
  }
  violations.push(...requiredOwnershipViolations(contents));
  return violations.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column || a.operation.localeCompare(b.operation),
  );
}

function main() {
  const violations = checkCanonicalIssueWriters();
  if (violations.length === 0) {
    console.log("Canonical issue writer check passed: one aggregate insert owner, immutable request/creator fields, and compiler/action-port authority are structurally locked.");
    return;
  }
  console.error(`Canonical issue writer check failed with ${violations.length} violation(s):`);
  for (const item of violations) {
    console.error(`  ${item.path}:${item.line}:${item.column} [${item.operation}] ${item.message}`);
  }
  process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
