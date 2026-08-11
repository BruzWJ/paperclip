import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface DurableWriterViolation {
  file: string;
  line: number;
  message: string;
}

const DURABLE_FUNCTIONS = new Set([
  "appendTaskSessionEvent",
  "makeDurableTaskSessionEvent",
  "projectTaskSessionEventInTx",
  "projectTaskSessionFinalCommentInTx",
  "insertOrAssertTaskSessionSourceUserExecution",
]);

const DURABLE_TABLES = new Set([
  "taskSessionEvents",
  "taskSessionMessages",
  "taskComments",
  "taskSessionSourceUserExecutions",
]);

const PUBLICATION_FILE =
  "apps/server/src/services/task-session/publication.ts";
const EVENT_STORE_FILE =
  "apps/server/src/services/task-session/event-store.ts";
const PROJECTOR_FILE =
  "apps/server/src/services/task-session/projector.ts";
const LIFECYCLE_FILE =
  "apps/server/src/services/task-session-lifecycle.ts";
const SOURCE_USER_EXECUTION_FILE =
  "apps/server/src/services/task-session/source-user-execution.ts";

function normalized(file: string): string {
  return file.replaceAll(path.sep, "/");
}

function propertyName(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node)) return node.text;
  return null;
}

function rootIdentifier(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) {
    return rootIdentifier(node.expression);
  }
  return null;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isAllowedDurableFunction(
  file: string,
  symbol: string,
): boolean {
  if (file === PUBLICATION_FILE) return true;
  if (
    file === EVENT_STORE_FILE &&
    (symbol === "appendTaskSessionEvent" ||
      symbol === "makeDurableTaskSessionEvent")
  ) {
    return true;
  }
  if (
    file === PROJECTOR_FILE &&
    (symbol === "projectTaskSessionEventInTx" ||
      symbol === "projectTaskSessionFinalCommentInTx" ||
      symbol === "insertOrAssertTaskSessionSourceUserExecution")
  ) {
    return true;
  }
  return false;
}

function isAllowedTableMutation(
  file: string,
  table: string,
  operation: string,
): boolean {
  if (
    file === EVENT_STORE_FILE &&
    table === "taskSessionEvents" &&
    operation === "insert"
  ) {
    return true;
  }
  if (
    file === PROJECTOR_FILE &&
    (table === "taskSessionMessages" || table === "taskComments") &&
    (operation === "insert" ||
      operation === "update" ||
      operation === "delete")
  ) {
    return true;
  }
  if (
    file === SOURCE_USER_EXECUTION_FILE &&
    table === "taskSessionSourceUserExecutions" &&
    operation === "insert"
  ) {
    return true;
  }
  if (
    file === LIFECYCLE_FILE &&
    operation === "delete"
  ) {
    return true;
  }
  return false;
}

/**
 * AST scan used both by the repository gate and adversarial fixtures.
 * Import renames, namespace imports, and local aliases are resolved before
 * calls/mutations are inspected, so a wrapper cannot hide a direct writer.
 */
export function scanTaskSessionDurableWriterSource(
  file: string,
  text: string,
): DurableWriterViolation[] {
  const relativeFile = normalized(file);
  const source = ts.createSourceFile(
    relativeFile,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const origins = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const violations: DurableWriterViolation[] = [];

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : "";
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) origins.set(clause.name.text, "default");
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.set(clause.namedBindings.name.text, specifier);
    }
    if (
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings)
    ) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (
          DURABLE_TABLES.has(imported)
        ) {
          origins.set(element.name.text, imported);
        }
        if (
          DURABLE_FUNCTIONS.has(imported)
        ) {
          origins.set(element.name.text, imported);
        }
      }
    }
    if (specifier.includes("run-log-store")) {
      violations.push({
        file: relativeFile,
        line: lineOf(source, statement),
        message:
          "legacy local_file/S3 run-log store imports are forbidden",
      });
    }
  }

  // Resolve local aliases to a fixed point: `const write = append`, followed
  // by another alias, remains attributable to the imported durable symbol.
  const originForExpression = (
    expression: ts.Expression,
  ): string | undefined => {
    if (ts.isParenthesizedExpression(expression)) {
      return originForExpression(expression.expression);
    }
    if (ts.isIdentifier(expression)) {
      return origins.get(expression.text);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const namespace = rootIdentifier(expression.expression);
      const specifier = namespace
        ? namespaces.get(namespace)
        : undefined;
      const member = expression.name.text;
      if (
        specifier &&
        DURABLE_TABLES.has(member)
      ) {
        return member;
      }
      if (
        specifier &&
        DURABLE_FUNCTIONS.has(member)
      ) {
        return member;
      }
    }
    return undefined;
  };

  let changed = true;
  while (changed) {
    changed = false;
    const visitAlias = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const origin = originForExpression(node.initializer);
        if (origin && origins.get(node.name.text) !== origin) {
          origins.set(node.name.text, origin);
          changed = true;
        }
        const namespaceName = rootIdentifier(node.initializer);
        const namespaceSpecifier = namespaceName
          ? namespaces.get(namespaceName)
          : undefined;
        if (
          namespaceSpecifier &&
          namespaces.get(node.name.text) !== namespaceSpecifier
        ) {
          namespaces.set(node.name.text, namespaceSpecifier);
          changed = true;
        }
      }
      ts.forEachChild(node, visitAlias);
    };
    visitAlias(source);
  }

  const add = (node: ts.Node, message: string) => {
    violations.push({
      file: relativeFile,
      line: lineOf(source, node),
      message,
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      let durableFunction: string | null = null;
      if (ts.isIdentifier(node.expression)) {
        const origin = origins.get(node.expression.text);
        if (origin && DURABLE_FUNCTIONS.has(origin)) {
          durableFunction = origin;
        }
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const namespace = rootIdentifier(node.expression.expression);
        const member = node.expression.name.text;
        const specifier = namespace
          ? namespaces.get(namespace)
          : undefined;
        if (
          specifier &&
          DURABLE_FUNCTIONS.has(member)
        ) {
          durableFunction = member;
        }
      }
      if (
        durableFunction &&
        !isAllowedDurableFunction(relativeFile, durableFunction)
      ) {
        add(
          node,
          `direct ${durableFunction} call bypasses the durable publication boundary`,
        );
      }

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ["insert", "update", "delete"].includes(
          node.expression.name.text,
        )
      ) {
        const operation = node.expression.name.text;
        const argument = node.arguments[0];
        const table =
          argument && ts.isExpression(argument)
            ? originForExpression(argument)
            : undefined;
        if (
          table &&
          DURABLE_TABLES.has(table) &&
          !isAllowedTableMutation(relativeFile, table, operation)
        ) {
          add(
            node,
            `direct ${operation}(${table}) bypasses the durable publication/projector boundary`,
          );
        }
      }
    }

    if (
      ts.isTaggedTemplateExpression(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isStringLiteral(node)
    ) {
      const sqlText = (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
          ? node.text
          : node.getText(source)
      ).toLowerCase();
      const match =
        /\b(insert\s+into|update|delete\s+from)\s+(?:(?:"?[a-z0-9_]+"?)\.)?"?(task_session_events|task_session_messages|task_comments|task_session_source_user_executions)"?\b/.exec(
          sqlText,
        );
      if (match) {
        const operation = match[1]!.startsWith("insert")
          ? "insert"
          : match[1]!.startsWith("delete")
            ? "delete"
            : "update";
        const table =
          match[2] === "task_session_events"
            ? "taskSessionEvents"
            : match[2] === "task_session_messages"
              ? "taskSessionMessages"
              : match[2] === "task_comments"
                ? "taskComments"
                : "taskSessionSourceUserExecutions";
        if (
          !isAllowedTableMutation(relativeFile, table, operation)
        ) {
          add(
            node,
            `raw SQL ${operation} of ${match[2]} bypasses the durable publication/projector boundary`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const mirrorContext = `${relativeFile}\n${text}`;
  const nearbyRunMirrorPersistence = new RegExp(
    [
      "(?:run[-_ ]?log|heartbeatRun|taskSession|task_session)",
      "[\\s\\S]{0,800}",
      "(?:\\.ndjson\\b|\\.jsonl\\b|local_file|PutObjectCommand|RUN_LOG_S3_|RUN_LOG_BASE_PATH)",
      "|",
      "(?:\\.ndjson\\b|\\.jsonl\\b|local_file|PutObjectCommand|RUN_LOG_S3_|RUN_LOG_BASE_PATH)",
      "[\\s\\S]{0,800}",
      "(?:run[-_ ]?log|heartbeatRun|taskSession|task_session)",
    ].join(""),
    "i",
  ).test(mirrorContext);
  if (
    /(?:RUN_LOG_S3_|RUN_LOG_BASE_PATH)/.test(text) ||
    nearbyRunMirrorPersistence
  ) {
    violations.push({
      file: relativeFile,
      line: 1,
      message:
        "independent local_file/S3 NDJSON run-log persistence is forbidden",
    });
  }

  return violations;
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === "coverage" ||
        entry.name === ".turbo"
      ) {
        continue;
      }
      files.push(...(await walk(full)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !full.includes(`${path.sep}__tests__${path.sep}`)
    ) {
      files.push(full);
    }
  }
  return files;
}

export async function checkTaskSessionDurableWriters(
  repositoryRoot: string,
): Promise<DurableWriterViolation[]> {
  const roots = [
    path.join(repositoryRoot, "apps", "server", "src"),
    path.join(repositoryRoot, "packages"),
  ];
  const violations: DurableWriterViolation[] = [];
  for (const root of roots) {
    for (const file of await walk(root)) {
      const relative = normalized(path.relative(repositoryRoot, file));
      violations.push(
        ...scanTaskSessionDurableWriterSource(
          relative,
          await fs.readFile(file, "utf8"),
        ),
      );
    }
  }
  return violations;
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const violations = await checkTaskSessionDurableWriters(
    repositoryRoot,
  );
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `${violation.file}:${violation.line} ${violation.message}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      "Task Session durable writers are closed behind the publication boundary.",
    );
  }
}
