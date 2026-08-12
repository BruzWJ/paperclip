#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, "..");

const SOURCE_ROOTS = ["apps/server/src", "packages"];
const SQL_ROOTS = [
  "packages/db/migrations",
  "packages/db/migrations",
  "packages/db/drizzle",
];
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const TASK_INSERT_OWNER =
  "apps/server/src/services/canonical-task-aggregate.ts";
const TASK_INSERT_FUNCTION = "persistCanonicalTaskAggregateInTx";
const TASK_DELETE_OWNER = "apps/server/src/services/task-session-lifecycle.ts";
const TASK_DELETE_FUNCTION = "purgeCompanySessionGraphInTx";
const TASK_CONTROL_OWNER = "apps/server/src/services/tasks.ts";
const MANAGED_TOOL_REGISTRY_OWNER =
  "apps/server/src/services/paperclip-managed-tool-registry.ts";
const ACTION_PORT_OWNER =
  "apps/server/src/services/runtime-task-action-port.ts";
const TASK_SCHEMA_OWNER = "packages/db/schema/tasks.ts";

const IMMUTABLE_UPDATE_FIELDS = new Set([
  "parentId",
  "parentOwnershipEpoch",
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
const CANONICAL_TASK_IDENTITY_FIELDS = ["taskNumber", "identifier"];
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
const GENERIC_WRITER_NAME =
  /(?:insert|create|persist|write|save|upsert|store|mutat)/i;

function toPosix(value) {
  return value.split("\\").join("/");
}

function shouldSkip(relativePath) {
  const path = toPosix(relativePath);
  const segments = path.split("/");
  const base = segments.at(-1) ?? "";
  if (segments.includes("node_modules") || segments.includes("dist"))
    return true;
  if (segments.includes("__tests__")) return true;
  if (path.includes("/fixtures/") || path.includes("/test-support/"))
    return true;
  return /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(base);
}

function walk(directory, repoRoot, output, extensions) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(repoRoot, absolutePath);
    if (entry.isDirectory()) {
      if (!shouldSkip(`${relativePath}/`))
        walk(absolutePath, repoRoot, output, extensions);
      continue;
    }
    if (!extensions.has(extname(entry.name)) || shouldSkip(relativePath))
      continue;
    output.push(absolutePath);
  }
}

export function listCanonicalTaskWriterInputs(repoRoot = DEFAULT_REPO_ROOT) {
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
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    return name.text;
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
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
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
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        namespaces.add(bindings.name.text);
    }
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName?.text === "tasks" ||
        (!node.propertyName && node.name.text === "tasks"))
    ) {
      aliases.add(node.name.text);
    }
    if (ts.isBindingElement(node)) {
      const imported =
        propertyNameText(node.propertyName) ?? propertyNameText(node.name);
      const local = propertyNameText(node.name);
      if (imported === "tasks" && local) aliases.add(local);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
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
      return (
        node.name.text === "tasks" &&
        ts.isIdentifier(unwrap(node.expression)) &&
        namespaces.has(unwrap(node.expression).text)
      );
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const key = unwrap(node.argumentExpression);
      return ts.isStringLiteralLike(key) && key.text === "tasks";
    }
    return (
      ts.isCallExpression(node) &&
      ts.isIdentifier(unwrap(node.expression)) &&
      factories.has(unwrap(node.expression).text)
    );
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
      if (
        ts.isArrowFunction(expression) &&
        !ts.isBlock(expression.body) &&
        isTable(expression.body) &&
        !factories.has(name)
      ) {
        factories.add(name);
        changed = true;
      }
    }
    const findFactories = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const returnsTable = node.body.statements.some(
          (statement) =>
            ts.isReturnStatement(statement) &&
            statement.expression &&
            isTable(statement.expression),
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
    if (seen.has(node.text))
      return { names: new Set(), dynamic: true, objectLiteral: false };
    const initializer = initializers.get(node.text);
    if (!initializer)
      return { names: new Set(), dynamic: true, objectLiteral: false };
    seen.add(node.text);
    return objectPropertyNames(initializer, initializers, seen);
  }
  if (!ts.isObjectLiteralExpression(node))
    return { names: new Set(), dynamic: true, objectLiteral: false };
  const names = new Set();
  let dynamic = false;
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const nested = objectPropertyNames(
        property.expression,
        initializers,
        new Set(seen),
      );
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
  if (
    !ts.isPropertyAccessExpression(expression) &&
    !ts.isElementAccessExpression(expression)
  )
    return null;
  const receiver = unwrap(expression.expression);
  if (
    !ts.isCallExpression(receiver) ||
    callMethodName(receiver.expression) !== "update"
  )
    return null;
  return receiver.arguments[0] && bindings.isTable(receiver.arguments[0])
    ? receiver
    : null;
}

function rawSqlMutation(text) {
  const table = String.raw`(?:"?[\w-]+"?\.)?"?tasks"?`;
  if (new RegExp(String.raw`\binsert\s+into\s+${table}\b`, "i").test(text))
    return "insert";
  if (new RegExp(String.raw`\bdelete\s+from\s+${table}\b`, "i").test(text))
    return "delete";
  const update = text.match(
    new RegExp(String.raw`\bupdate\s+${table}\s+set\s+([\s\S]*)`, "i"),
  );
  if (!update) return null;
  const normalized = update[1].toLowerCase();
  const immutable = [...IMMUTABLE_UPDATE_FIELDS].some((field) => {
    const snake = field.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
    return new RegExp(
      `(?:"${snake}"|\\b${snake}\\b|"${field}"|\\b${field}\\b)`,
      "i",
    ).test(normalized);
  });
  return immutable ? "immutable-update" : null;
}

function literalText(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ].join("${…}");
  }
  return null;
}

function canonicalCallTaskObject(call, initializers) {
  const expression = unwrap(call.expression);
  const calledName = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : null;
  if (calledName !== TASK_INSERT_FUNCTION || call.arguments.length === 0)
    return null;
  let input = unwrap(call.arguments.at(-1));
  if (ts.isIdentifier(input))
    input = unwrap(initializers.get(input.text) ?? input);
  if (!ts.isObjectLiteralExpression(input)) return null;
  const taskProperty = input.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === "task",
  );
  if (!taskProperty || !ts.isPropertyAssignment(taskProperty)) return null;
  let task = unwrap(taskProperty.initializer);
  if (ts.isIdentifier(task)) task = unwrap(initializers.get(task.text) ?? task);
  return ts.isObjectLiteralExpression(task) ? task : null;
}

function hasClosedControlPatchContract(sourceText) {
  const required = [
    "type TaskControlStateUpdate",
    "data: TaskControlStateUpdate",
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
        const allowed =
          operation === "insert"
            ? path === TASK_INSERT_OWNER &&
              functionName === TASK_INSERT_FUNCTION
            : path === TASK_DELETE_OWNER &&
              functionName === TASK_DELETE_FUNCTION;
        if (operation === "insert" && allowed) allowedInsertCalls.push(node);
        if (!allowed) {
          violations.push(
            makeViolation(
              sourceFile,
              path,
              node,
              operation,
              operation === "insert"
                ? `Only ${TASK_INSERT_OWNER}::${TASK_INSERT_FUNCTION} may insert tasks.`
                : `Only ${TASK_DELETE_OWNER}::${TASK_DELETE_FUNCTION} may delete tasks.`,
            ),
          );
        }
      }

      const updateCall = tableMutationCallFromSet(node, bindings);
      if (updateCall && node.arguments[0]) {
        const fields = objectPropertyNames(
          node.arguments[0],
          bindings.initializers,
        );
        const forbidden = [...fields.names].filter((name) =>
          IMMUTABLE_UPDATE_FIELDS.has(name),
        );
        const closedDynamicPatch =
          path === TASK_CONTROL_OWNER &&
          isInsideNamedFunction(node, "updateControlState") &&
          hasClosedControlPatchContract(sourceText);
        if (
          forbidden.length > 0 ||
          (fields.dynamic && !fields.objectLiteral && !closedDynamicPatch)
        ) {
          violations.push(
            makeViolation(
              sourceFile,
              path,
              node,
              forbidden.length > 0
                ? "immutable-update"
                : "generic-update-payload",
              forbidden.length > 0
                ? `Immutable task fields cannot be updated: ${forbidden.sort().join(", ")}.`
                : "A generic task update payload can carry immutable request/creator fields.",
            ),
          );
        }
      }

      const method = callMethodName(node.expression);
      const calledExpression = unwrap(node.expression);
      const calledName =
        method ??
        (ts.isIdentifier(calledExpression) ? calledExpression.text : "");
      if (
        node.arguments.some((argument) => bindings.isTable(argument)) &&
        !SAFE_TABLE_ARGUMENT_METHODS.has(method ?? "") &&
        GENERIC_WRITER_NAME.test(calledName)
      ) {
        violations.push(
          makeViolation(
            sourceFile,
            path,
            node,
            "table-wrapper",
            "The tasks table cannot escape through a generic writer wrapper.",
          ),
        );
      }

      const taskObject = canonicalCallTaskObject(node, bindings.initializers);
      if (taskObject) {
        const fields = objectPropertyNames(
          taskObject,
          bindings.initializers,
        ).names;
        const missingIdentityFields = CANONICAL_TASK_IDENTITY_FIELDS.filter(
          (field) => !fields.has(field),
        );
        if (missingIdentityFields.length > 0) {
          violations.push(
            makeViolation(
              sourceFile,
              path,
              taskObject,
              "missing-canonical-identity",
              `Canonical task creation must supply: ${missingIdentityFields.join(", ")}.`,
            ),
          );
        }
        const pairCount = CREATOR_PAIR.filter((field) =>
          fields.has(field),
        ).length;
        if (pairCount === 1) {
          violations.push(
            makeViolation(
              sourceFile,
              path,
              taskObject,
              "partial-creator-pair",
              "Agent-execution creator authority and originating adapter revision must be supplied together.",
            ),
          );
        }
      }
    }

    const text = literalText(node);
    if (text) {
      const operation = rawSqlMutation(text);
      if (operation) {
        violations.push(
          makeViolation(
            sourceFile,
            path,
            node,
            operation,
            "Raw SQL cannot bypass canonical task creation or immutable request/creator fields.",
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const call of allowedInsertCalls.slice(1)) {
    violations.push(
      makeViolation(
        sourceFile,
        path,
        call,
        "second-owner-insert",
        `${TASK_INSERT_FUNCTION} must contain exactly one tasks insert.`,
      ),
    );
  }

  const unique = new Map();
  for (const item of violations) {
    unique.set(
      `${item.path}:${item.line}:${item.column}:${item.operation}`,
      item,
    );
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
        line: sourceText
          .slice(0, sourceText.indexOf(statements[index]))
          .split("\n").length,
        column: 1,
        operation: "migration-mutation",
        message:
          "A migration cannot insert task rows or mutate immutable request/creator fields.",
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
      violations.push({
        path,
        line: 1,
        column: 1,
        operation: "missing-owner",
        message: "Required canonical owner is missing.",
      });
      return "";
    }
    return content;
  };
  const aggregate = requireFile(TASK_INSERT_OWNER);
  const taskService = requireFile(TASK_CONTROL_OWNER);
  const registry = requireFile(MANAGED_TOOL_REGISTRY_OWNER);
  const actionPort = requireFile(ACTION_PORT_OWNER);
  const schema = requireFile(TASK_SCHEMA_OWNER);

  const requireMarkers = (path, content, markers, operation) => {
    for (const marker of markers) {
      if (!content.includes(marker)) {
        violations.push({
          path,
          line: 1,
          column: 1,
          operation,
          message: `Missing canonical marker: ${marker}`,
        });
      }
    }
  };
  requireMarkers(
    TASK_INSERT_OWNER,
    aggregate,
    [
      `export async function ${TASK_INSERT_FUNCTION}`,
      "export async function allocateCanonicalTaskIdentityInTx",
      "await assertCanonicalTaskIdentity(tx, task);",
      "await assertAgentExecutionCreator(tx, task);",
      ".insert(tasks)",
    ],
    "aggregate-owner",
  );
  if (
    aggregate.indexOf("await assertAgentExecutionCreator(tx, task);") >
    aggregate.indexOf(".insert(tasks)")
  ) {
    violations.push({
      path: TASK_INSERT_OWNER,
      line: 1,
      column: 1,
      operation: "authority-order",
      message: "Creator authority must be checked before the sole task insert.",
    });
  }
  requireMarkers(
    TASK_CONTROL_OWNER,
    taskService,
    [
      "type TaskControlStateUpdate",
      "data: TaskControlStateUpdate",
      '| "request"',
      '| "creatorAuthorityId"',
      '| "creatorAdapterConfigRevisionId"',
    ],
    "closed-update-contract",
  );
  requireMarkers(
    MANAGED_TOOL_REGISTRY_OWNER,
    registry,
    [
      "export const PAPERCLIP_MANAGED_TOOL_NAMES",
      "export const boardMcpInputSchemas",
      "export const BOARD_MANAGED_TOOLS",
      "function projectRuntimeTaskCreate(",
      "input.actionGrants.task_create !== true",
      'name: "task_create"',
      'case "task_create": return projectRuntimeTaskCreate(input);',
    ],
    "registry-authority",
  );
  requireMarkers(
    ACTION_PORT_OWNER,
    actionPort,
    [
      "lockRuntimeActionAuthority(",
      '"task_create"',
      "if (!input.capability.taskExecutionAuthorityId)",
      "creatorAuthorityId: input.capability.taskExecutionAuthorityId",
      "creatorAdapterConfigRevisionId:",
      "input.capability.adapterConfigIdentity",
      `${TASK_INSERT_FUNCTION}(tx,`,
    ],
    "action-port-authority",
  );
  requireMarkers(
    TASK_SCHEMA_OWNER,
    schema,
    [
      'request: text("request").notNull()',
      'creatorAuthorityId: uuid("creator_authority_id")',
      'creatorAdapterConfigRevisionId: uuid("creator_adapter_config_revision_id")',
    ],
    "schema-contract",
  );
  return violations;
}

export function checkCanonicalTaskWriters(repoRoot = DEFAULT_REPO_ROOT) {
  const { sourceFiles, sqlFiles } = listCanonicalTaskWriterInputs(repoRoot);
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
    violations.push(
      ...inspectMigrationText(path, readFileSync(absolutePath, "utf8")),
    );
  }
  violations.push(...requiredOwnershipViolations(contents));
  return violations.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column ||
      a.operation.localeCompare(b.operation),
  );
}

function main() {
  const violations = checkCanonicalTaskWriters();
  if (violations.length === 0) {
    console.log(
      "Canonical task writer check passed: one aggregate insert owner, immutable request/creator fields, and registry-projection/action-port authority are structurally locked.",
    );
    return;
  }
  console.error(
    `Canonical task writer check failed with ${violations.length} violation(s):`,
  );
  for (const item of violations) {
    console.error(
      `  ${item.path}:${item.line}:${item.column} [${item.operation}] ${item.message}`,
    );
  }
  process.exitCode = 1;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
