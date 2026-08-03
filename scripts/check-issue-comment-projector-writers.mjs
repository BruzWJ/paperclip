#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, "..");

const SOURCE_ROOTS = [
  "server/src",
  "packages",
  "cli/src",
];

const PROJECTOR_PATH = "server/src/services/issue-session/projector.ts";
const PURGE_PATH = "server/src/services/issue-session-lifecycle.ts";
const PROJECTOR_WRITER_FUNCTION = "materializeComment";
const LIFECYCLE_PURGE_FUNCTION =
  "purgeCompanySessionGraphInTx";

const MUTATOR_METHODS = new Set(["insert", "update", "delete"]);
const GENERIC_COMMENT_MUTATOR_NAMES =
  /^(?:addComment|removeComment|tombstoneComment|persistDerivedIssueCommentAttribution)$/;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function toPosix(value) {
  return value.split("\\").join("/");
}

function shouldSkip(relativePath) {
  const path = toPosix(relativePath);
  const segments = path.split("/");
  const base = segments.at(-1) ?? "";

  if (segments.includes("node_modules") || segments.includes("dist") || segments.includes("generated")) {
    return true;
  }
  if (path.startsWith("packages/db/migrations/")) return true;
  if (path.includes("/fixtures/") || path.includes("/test-support/")) return true;
  if (/\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(base)) return true;
  return false;
}

function walk(directory, repoRoot, output) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(repoRoot, absolutePath);
    if (entry.isDirectory()) {
      if (!shouldSkip(`${relativePath}/`)) walk(absolutePath, repoRoot, output);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name)) || shouldSkip(relativePath)) continue;
    output.push(absolutePath);
  }
}

export function listProductionSourceFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const files = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    walk(resolve(repoRoot, sourceRoot), repoRoot, files);
  }
  return files.sort();
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

function expressionIsIssueComments(expression, aliases) {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return aliases.has(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "issueComments" || aliases.has(node.name.text);
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const argument = unwrap(node.argumentExpression);
    return ts.isStringLiteralLike(argument) && argument.text === "issueComments";
  }
  return false;
}

function collectIssueCommentAliases(sourceFile) {
  const aliases = new Set(["issueComments"]);
  let changed = true;

  const inspect = (node) => {
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName?.text === "issueComments" || (!node.propertyName && node.name.text === "issueComments"))
    ) {
      aliases.add(node.name.text);
    }
    if (
      ts.isBindingElement(node) &&
      (propertyNameText(node.propertyName) === "issueComments" ||
        (!node.propertyName && propertyNameText(node.name) === "issueComments"))
    ) {
      const name = propertyNameText(node.name);
      if (name) aliases.add(name);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);

  while (changed) {
    changed = false;
    const inspectAssignments = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        expressionIsIssueComments(node.initializer, aliases) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        expressionIsIssueComments(node.right, aliases) &&
        !aliases.has(node.left.text)
      ) {
        aliases.add(node.left.text);
        changed = true;
      }
      ts.forEachChild(node, inspectAssignments);
    };
    inspectAssignments(sourceFile);
  }

  return aliases;
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
    (ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
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

function operationAllowed(relativePath, operation, node) {
  const path = toPosix(relativePath);
  const owner = enclosingFunctionName(node);
  if (path === PROJECTOR_PATH) {
    return (
      owner === PROJECTOR_WRITER_FUNCTION &&
      (operation === "insert" || operation === "update")
    );
  }
  if (path === PURGE_PATH) {
    return (
      owner === LIFECYCLE_PURGE_FUNCTION &&
      operation === "delete"
    );
  }
  return false;
}

function lineAndColumn(sourceFile, position) {
  const result = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: result.line + 1, column: result.character + 1 };
}

function violation(sourceFile, relativePath, node, operation, message) {
  const { line, column } = lineAndColumn(sourceFile, node.getStart(sourceFile));
  return {
    path: toPosix(relativePath),
    line,
    column,
    operation,
    message,
  };
}

function rawSqlMutation(text) {
  const match = text.match(/\b(insert\s+into|update|delete\s+from)\s+(?:"?[\w-]+"?\.)?"?issue_comments"?\b/i);
  if (!match) return null;
  const keyword = match[1].toLowerCase();
  if (keyword.startsWith("insert")) return "insert";
  if (keyword.startsWith("delete")) return "delete";
  return "update";
}

function literalText(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("${…}");
  }
  return null;
}

export function inspectSourceText(relativePath, sourceText) {
  const scriptKind = relativePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : relativePath.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : relativePath.endsWith(".js") ||
          relativePath.endsWith(".mjs") ||
          relativePath.endsWith(".cjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const aliases = collectIssueCommentAliases(sourceFile);
  const violations = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const operation = callMethodName(node.expression);
      if (
        operation &&
        MUTATOR_METHODS.has(operation) &&
        node.arguments.length > 0 &&
        expressionIsIssueComments(node.arguments[0], aliases) &&
        !operationAllowed(relativePath, operation, node)
      ) {
        violations.push(
          violation(
            sourceFile,
            relativePath,
            node,
            operation,
            `Only ${PROJECTOR_PATH} may insert/update issue_comments and only ${PURGE_PATH} may delete it.`,
          ),
        );
      }
    }

    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node)) &&
      node.name &&
      GENERIC_COMMENT_MUTATOR_NAMES.test(propertyNameText(node.name) ?? "") &&
      !operationAllowed(relativePath, "insert", node) &&
      toPosix(relativePath) !== PURGE_PATH
    ) {
      violations.push(
        violation(
          sourceFile,
          relativePath,
          node,
          "generic-mutator",
          "Generic issue comment mutators are forbidden; publish a canonical Session event and let the projector write.",
        ),
      );
    }

    const text = literalText(node);
    if (text) {
      const operation = rawSqlMutation(text);
      if (
        operation &&
        !operationAllowed(relativePath, operation, node)
      ) {
        violations.push(
          violation(
            sourceFile,
            relativePath,
            node,
            operation,
            "Raw SQL mutation of issue_comments bypasses the canonical Session projector.",
          ),
        );
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const unique = new Map();
  for (const item of violations) {
    unique.set(`${item.path}:${item.line}:${item.column}:${item.operation}`, item);
  }
  return [...unique.values()];
}

export function checkIssueCommentProjectorWriters(repoRoot = DEFAULT_REPO_ROOT) {
  const violations = [];
  for (const absolutePath of listProductionSourceFiles(repoRoot)) {
    const relativePath = toPosix(relative(repoRoot, absolutePath));
    violations.push(
      ...inspectSourceText(relativePath, readFileSync(absolutePath, "utf8")),
    );
  }
  return violations.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column ||
      a.operation.localeCompare(b.operation),
  );
}

function main() {
  const violations = checkIssueCommentProjectorWriters();
  if (violations.length === 0) {
    console.log("Issue comment projector writer check passed.");
    return;
  }

  console.error(
    `Issue comment projector writer check failed with ${violations.length} violation(s):`,
  );
  for (const item of violations) {
    console.error(
      `  ${item.path}:${item.line}:${item.column} [${item.operation}] ${item.message}`,
    );
  }
  process.exitCode = 1;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
