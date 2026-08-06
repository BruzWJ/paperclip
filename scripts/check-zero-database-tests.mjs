#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";

const ignoredDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const testDatabaseEnvironmentNames = Object.freeze([
  ["PAPERCLIP", "TEST", "DATABASE", "URL"].join("_"),
  ["PAPERCLIP", "E2E", "DATABASE", "URL"].join("_"),
  ["SMOKE", "DATABASE", "URL"].join("_"),
]);
const productionTestDatabaseEnvironmentSuffixes = Object.freeze([
  ["TEST", "DATABASE", "URL"].join("_"),
  ["E2E", "DATABASE", "URL"].join("_"),
]);
const retiredLiveSmokePaths = Object.freeze([
  ["scripts", "smoke", "pipelines-tutorial-smoke.sh"].join("/"),
  ["scripts", "docker-onboard-smoke.sh"].join("/"),
  ["docker", "Dockerfile.onboard-smoke"].join("/"),
]);
const liveHarnessSymbol = ["start", "External", "Postgres", "Test", "Database"].join("");
const liveHarnessFile = ["test", "postgres"].join("-");
const embeddedDatabaseTerms = Object.freeze([
  ["@electric-sql", ["pg", "lite"].join("")].join("/"),
  ["PG", "lite"].join(""),
  ["pg", "-mem"].join(""),
  "better-sqlite3",
  "sqlite3",
  "node:sqlite",
]);
const databaseRuntimeExportsByOwner = Object.freeze({
  client: Object.freeze(["createDb"]),
  "database-identity": Object.freeze([
    "probeDatabaseIdentity",
    "revalidateDatabaseIdentity",
  ]),
});
const databaseRuntimeExports = Object.freeze([
  ...new Set(Object.values(databaseRuntimeExportsByOwner).flat()),
]);
const postgresClientModules = new Set(["postgres", "pg"]);
const drizzlePostgresModules = new Set([
  "drizzle-orm/postgres-js",
  "drizzle-orm/postgres-js/migrator",
]);
const safeDockerEnvironmentReinclusions = Object.freeze([
  ".env.example",
  ".env.*.example",
  "**/.env.example",
  "**/.env.*.example",
]);
const moduleExtensions = Object.freeze([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return [];
    if (entry.isFile() && isPrivateEnvironmentFile(entry.name)) return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

function isPrivateEnvironmentFile(name) {
  const normalized = name.toLowerCase();
  if (normalized === ".env") return true;
  if (!normalized.startsWith(".env.")) return false;
  return !/(?:^|\.)(?:example|sample|template|dist)$/.test(normalized);
}

function repoPath(repoRoot, absolute) {
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

function isTestEntrySource(relativePath) {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath) ||
    relativePath.startsWith("tests/") ||
    /(?:^|\/)vitest\.(?:config|setup)\.[cm]?[jt]s$/.test(relativePath) ||
    /(?:^|\/)playwright[^/]*\.config\.[cm]?[jt]s$/.test(relativePath) ||
    relativePath === "scripts/run-vitest-stable.mjs" ||
    relativePath === "scripts/run-vitest-watch.mjs"
  );
}

function isVitestConfig(relativePath) {
  return /(?:^|\/)vitest\.config\.[cm]?[jt]s$/.test(relativePath);
}

function isAuthoredViteConfig(relativePath) {
  return /(?:^|\/)vite(?:[._-][^/]*)?\.config\.[cm]?[jt]s$/.test(relativePath);
}

function isTestSupportSource(relativePath) {
  const normalized = `/${relativePath.replaceAll("\\", "/")}`;
  if (
    /\/(?:__tests__|tests|testing|test-support|test-utils|test-helpers|fixtures|helpers)\//.test(
      normalized,
    )
  ) {
    return true;
  }

  const basename = path.posix.basename(normalized);
  if (/^(?:vitest|playwright)(?:[._-].*)?\.[cm]?[jt]s$/i.test(basename)) {
    return true;
  }
  return /(?:^|[._-])(?:fixture|fixtures|helper|helpers|setup|test-support|test-utils)(?:[._-]|$)/i.test(
    basename,
  );
}

function moduleCandidates(importerRelativePath, specifier) {
  const withoutQuery = specifier.replace(/[?#].*$/, "");
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerRelativePath), withoutQuery),
  );
  const extension = path.posix.extname(resolved);
  const candidates = [resolved];

  if (extension) {
    const stem = resolved.slice(0, -extension.length);
    for (const candidateExtension of moduleExtensions) {
      candidates.push(`${stem}${candidateExtension}`);
    }
  } else {
    for (const candidateExtension of moduleExtensions) {
      candidates.push(`${resolved}${candidateExtension}`);
    }
  }
  for (const candidateExtension of moduleExtensions) {
    candidates.push(path.posix.join(resolved, `index${candidateExtension}`));
  }
  return [...new Set(candidates)];
}

function staticStringExpression(sourceFile, expression, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return undefined;
    const initializer = topLevelVariableInitializer(sourceFile, current.text);
    if (!initializer) return undefined;
    seen.add(current.text);
    return staticStringExpression(sourceFile, initializer, seen);
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringExpression(sourceFile, current.left, new Set(seen));
    const right = staticStringExpression(sourceFile, current.right, new Set(seen));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(current)) {
    let result = current.head.text;
    for (const span of current.templateSpans) {
      const value = staticStringExpression(sourceFile, span.expression, new Set(seen));
      if (value === undefined) return undefined;
      result += value + span.literal.text;
    }
    return result;
  }
  return undefined;
}

function staticModuleName(sourceFile, node) {
  return staticStringExpression(sourceFile, node);
}

function propertyNameText(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function isInsideTypeNode(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function namespaceUsesLiveExport(sourceFile, declarationName, liveExports) {
  let live = false;
  const visit = (node) => {
    if (live || isInsideTypeNode(node)) return;
    if (ts.isIdentifier(node) && node.text === declarationName.text) {
      if (node === declarationName) return;
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (liveExports.has(parent.name.text)) live = true;
        return;
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const member = parent.argumentExpression;
        if (!ts.isStringLiteralLike(member) || liveExports.has(member.text)) live = true;
        return;
      }
      if (ts.isQualifiedName(parent) && parent.left === node) return;
      live = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return live;
}

function importDeclarationEdge(sourceFile, declaration) {
  const moduleName = staticModuleName(sourceFile, declaration.moduleSpecifier);
  if (!moduleName) return undefined;
  const clause = declaration.importClause;
  if (clause?.isTypeOnly) return undefined;
  const names = [];
  let namespaceName;
  let opaque = !clause || Boolean(clause?.name);
  if (clause?.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      namespaceName = clause.namedBindings.name;
    } else {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
      }
    }
  }
  return {
    moduleName,
    names,
    namespaceName,
    opaque,
    exportAll: false,
    position: declaration.getStart(sourceFile),
  };
}

function exportDeclarationEdge(sourceFile, declaration) {
  const moduleName = declaration.moduleSpecifier
    ? staticModuleName(sourceFile, declaration.moduleSpecifier)
    : undefined;
  if (!moduleName || declaration.isTypeOnly) return undefined;
  const names = [];
  let namespaceName;
  let exportAll = !declaration.exportClause;
  let opaque = false;
  if (declaration.exportClause) {
    if (ts.isNamedExports(declaration.exportClause)) {
      for (const element of declaration.exportClause.elements) {
        if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
      }
    } else {
      namespaceName = declaration.exportClause.name;
      opaque = true;
    }
  }
  return {
    moduleName,
    names,
    namespaceName,
    opaque,
    exportAll,
    position: declaration.getStart(sourceFile),
  };
}

function mockFactoryIsDeterministic(factory) {
  if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) return false;
  const factoryParameters = new Set(
    factory.parameters.flatMap((parameter) =>
      ts.isIdentifier(parameter.name) ? [parameter.name.text] : [],
    ),
  );
  let unsafe = false;
  const visit = (node) => {
    if (unsafe) return;
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        unsafe = true;
        return;
      }
      if (ts.isIdentifier(node.expression)) {
        if (
          node.expression.text === "require" ||
          node.expression.text === "requireActual" ||
          node.expression.text === "importOriginal" ||
          factoryParameters.has(node.expression.text)
        ) {
          unsafe = true;
          return;
        }
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ["importActual", "requireActual"].includes(node.expression.name.text)
      ) {
        unsafe = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(factory.body);
  return !unsafe;
}

function topLevelHoistedMock(sourceFile, statement) {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const expression = statement.expression;
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return undefined;
  }
  const owner = expression.expression.expression;
  if (
    !ts.isIdentifier(owner) ||
    !["vi", "jest"].includes(owner.text) ||
    expression.expression.name.text !== "mock"
  ) {
    return undefined;
  }
  const moduleName = expression.arguments[0]
    ? staticModuleName(sourceFile, expression.arguments[0])
    : undefined;
  if (!moduleName) return undefined;
  const factory = expression.arguments[1];
  return {
    moduleName,
    factory,
    deterministic: Boolean(factory && mockFactoryIsDeterministic(factory)),
    position: expression.getStart(sourceFile),
  };
}

function collectSourceFacts(relativePath, absolutePath, cache) {
  const existing = cache.get(relativePath);
  if (existing) return existing;
  const source = readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const hoistedMocks = sourceFile.statements
    .map((statement) => topLevelHoistedMock(sourceFile, statement))
    .filter(Boolean);
  const mockFactories = new Set(
    hoistedMocks.map((mock) => mock.factory).filter(Boolean),
  );
  const edges = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const edge = importDeclarationEdge(sourceFile, statement);
      if (edge) edges.push(edge);
    } else if (ts.isExportDeclaration(statement)) {
      const edge = exportDeclarationEdge(sourceFile, statement);
      if (edge) edges.push(edge);
    }
  }
  const visit = (node, insideMockFactory = false) => {
    const insideFactory = insideMockFactory || mockFactories.has(node);
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isActualImport =
        (ts.isIdentifier(node.expression) &&
          ["importActual", "requireActual"].includes(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ["importActual", "requireActual"].includes(node.expression.name.text));
      if ((isDynamicImport || isRequire || isActualImport) && node.arguments[0]) {
        const moduleName = staticModuleName(sourceFile, node.arguments[0]);
        if (moduleName) {
          edges.push({
            moduleName,
            names: [],
            opaque: true,
            exportAll: false,
            actualImplementation: isActualImport,
            insideMockFactory: insideFactory,
            position: node.getStart(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, insideFactory));
  };
  visit(sourceFile);
  edges.sort((left, right) => left.position - right.position);
  const facts = { source, sourceFile, hoistedMocks, edges };
  cache.set(relativePath, facts);
  return facts;
}

function databaseOwnerForEdge(moduleName, localTarget) {
  if (moduleName === "@paperclipai/db") return "root";
  const packageSubpath = moduleName.match(
    /^@paperclipai\/db\/([^/]+?)(?:\.[cm]?[jt]s)?$/,
  )?.[1];
  if (packageSubpath && databaseRuntimeExportsByOwner[packageSubpath]) {
    return packageSubpath;
  }
  const localOwner = localTarget?.match(
    /^packages\/db\/([^/]+?)(?:\.[cm]?[jt]s)?$/,
  )?.[1];
  return localOwner && databaseRuntimeExportsByOwner[localOwner]
    ? localOwner
    : undefined;
}

function edgeUsesLiveDatabaseRuntime(edge, facts, localTarget) {
  const owner = databaseOwnerForEdge(edge.moduleName, localTarget);
  if (!owner) return false;
  const liveExports = new Set(
    owner === "root" ? databaseRuntimeExports : databaseRuntimeExportsByOwner[owner],
  );
  if (edge.opaque || edge.exportAll) return true;
  if (edge.names.some((name) => liveExports.has(name))) return true;
  return Boolean(
    edge.namespaceName &&
      namespaceUsesLiveExport(facts.sourceFile, edge.namespaceName, liveExports),
  );
}

function resolveLocalTarget(importer, moduleName, relativeToAbsolute) {
  if (!moduleName.startsWith(".")) return undefined;
  return moduleCandidates(importer, moduleName).find((candidate) =>
    relativeToAbsolute.has(candidate),
  );
}

function addMockBinding(state, importer, moduleName, relativeToAbsolute) {
  state.moduleMocks.add(moduleName);
  const localTarget = resolveLocalTarget(importer, moduleName, relativeToAbsolute);
  if (localTarget) state.localMocks.add(localTarget);
}

function edgeIsExplicitlyMocked(state, edge, localTarget) {
  if (edge.insideMockFactory || edge.actualImplementation) return false;
  return state.moduleMocks.has(edge.moduleName) || Boolean(localTarget && state.localMocks.has(localTarget));
}

function graphViolation(entry, owner, edge, message) {
  const line = lineNumber(owner.facts.source, edge.position);
  if (owner.relative === entry || isTestSupportSource(owner.relative)) {
    return `${owner.relative}:${line} ${message}`;
  }
  return `${entry}:1 reaches ${owner.relative}:${line}, which ${message}`;
}

function scanOrderedTestGraph(entry, relativeToAbsolute, factsCache) {
  const violations = new Set();
  const state = {
    evaluated: new Set(),
    visiting: new Set(),
    moduleMocks: new Set(),
    localMocks: new Set(),
  };

  const evaluate = (relative) => {
    if (state.evaluated.has(relative) || state.visiting.has(relative)) return;
    state.visiting.add(relative);
    const facts = collectSourceFacts(relative, relativeToAbsolute.get(relative), factsCache);
    for (const mock of facts.hoistedMocks) {
      const localTarget = resolveLocalTarget(
        relative,
        mock.moduleName,
        relativeToAbsolute,
      );
      if (mock.deterministic) {
        addMockBinding(state, relative, mock.moduleName, relativeToAbsolute);
      }
    }

    for (const edge of facts.edges) {
      const localTarget = resolveLocalTarget(relative, edge.moduleName, relativeToAbsolute);
      if (edgeIsExplicitlyMocked(state, edge, localTarget)) continue;

      if (postgresClientModules.has(edge.moduleName)) {
        violations.add(
          graphViolation(entry, { relative, facts }, edge, "imports the PostgreSQL client without an explicit test-boundary module mock"),
        );
      }
      if (
        edgeUsesLiveDatabaseRuntime(edge, facts, localTarget) &&
        ![...postgresClientModules].some((moduleName) =>
          state.moduleMocks.has(moduleName),
        )
      ) {
        violations.add(
          graphViolation(entry, { relative, facts }, edge, "imports a live database client or lifecycle entrypoint without an explicit test-boundary module or PostgreSQL client mock"),
        );
      }
      if (
        drizzlePostgresModules.has(edge.moduleName) &&
        ![...postgresClientModules].some((moduleName) =>
          state.moduleMocks.has(moduleName),
        ) &&
        !state.moduleMocks.has(edge.moduleName)
      ) {
        violations.add(
          graphViolation(entry, { relative, facts }, edge, "imports the PostgreSQL migrator without an explicit test-boundary module or client mock"),
        );
      }
      if (edge.moduleName === "dotenv/config") {
        violations.add(
          graphViolation(entry, { relative, facts }, edge, "loads dotenv from an automated test graph instead of using explicit test-owned environment input"),
        );
      }
      if (localTarget) evaluate(localTarget);
    }
    state.visiting.delete(relative);
    state.evaluated.add(relative);
  };

  evaluate(entry);
  return violations;
}

function collectTestBoundarySources(relativeToAbsolute, factsCache) {
  const selected = new Set(
    [...relativeToAbsolute.keys()].filter(isTestEntrySource),
  );
  const pending = [...selected];
  while (pending.length > 0) {
    const importer = pending.pop();
    if (!importer) continue;
    const facts = collectSourceFacts(
      importer,
      relativeToAbsolute.get(importer),
      factsCache,
    );
    for (const edge of facts.edges) {
      const target = resolveLocalTarget(importer, edge.moduleName, relativeToAbsolute);
      if (!target || selected.has(target) || !isTestSupportSource(target)) continue;
      selected.add(target);
      pending.push(target);
    }
  }
  return selected;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function topLevelVariableInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer
      ) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

function resolveStaticExpression(sourceFile, expression, seen = new Set()) {
  let current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return undefined;
    const initializer = topLevelVariableInitializer(sourceFile, current.text);
    if (!initializer) return undefined;
    seen.add(current.text);
    return resolveStaticExpression(sourceFile, initializer, seen);
  }
  if (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === "defineConfig" &&
    current.arguments[0]
  ) {
    return resolveStaticExpression(sourceFile, current.arguments[0], seen);
  }
  return current;
}

function exportedConfigObject(sourceFile) {
  const assignment = sourceFile.statements.find(
    (statement) => ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (!assignment || !ts.isExportAssignment(assignment)) return undefined;
  const resolved = resolveStaticExpression(sourceFile, assignment.expression);
  return resolved && ts.isObjectLiteralExpression(resolved) ? resolved : undefined;
}

function objectProperties(object, name) {
  return object.properties.filter((property) =>
    propertyNameText(property.name) === name,
  );
}

function propertyInitializer(sourceFile, property) {
  if (ts.isPropertyAssignment(property)) {
    return resolveStaticExpression(sourceFile, property.initializer);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    const initializer = topLevelVariableInitializer(sourceFile, property.name.text);
    return initializer
      ? resolveStaticExpression(sourceFile, initializer)
      : undefined;
  }
  return undefined;
}

function configHasExactEnvDirFalse(sourceFile) {
  const config = exportedConfigObject(sourceFile);
  if (!config || config.properties.some(ts.isSpreadAssignment)) return false;
  const envDirProperties = objectProperties(config, "envDir");
  if (envDirProperties.length !== 1) return false;
  const initializer = propertyInitializer(sourceFile, envDirProperties[0]);
  return initializer?.kind === ts.SyntaxKind.FalseKeyword;
}

function callInstallsMiddleware(node) {
  let found = false;
  const accessedName = (expression) => {
    const current = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(current)) return current.name.text;
    if (
      ts.isElementAccessExpression(current) &&
      ts.isStringLiteralLike(current.argumentExpression)
    ) {
      return current.argumentExpression.text;
    }
    return undefined;
  };
  const visit = (current) => {
    if (found) return;
    if (ts.isCallExpression(current)) {
      const callee = unwrapExpression(current.expression);
      if (accessedName(callee) === "use") {
        const receiver = unwrapExpression(
          ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
            ? callee.expression
            : callee,
        );
        if (
          accessedName(receiver) === "middlewares"
        ) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function configDefinesConfigureServer(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
      propertyNameText(node.name) === "configureServer"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function configInstallsRequestInterceptor(sourceFile) {
  let unsafe = false;
  const visit = (node) => {
    if (unsafe) return;
    if (
      (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
      propertyNameText(node.name) === "configureServer"
    ) {
      const implementation = ts.isMethodDeclaration(node) ? node.body : node.initializer;
      const inlineImplementation =
        ts.isMethodDeclaration(node) ||
        (implementation &&
          (ts.isArrowFunction(unwrapExpression(implementation)) ||
            ts.isFunctionExpression(unwrapExpression(implementation))));
      if (
        !implementation ||
        !inlineImplementation ||
        callInstallsMiddleware(implementation)
      ) {
        unsafe = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return unsafe || (configDefinesConfigureServer(sourceFile) && callInstallsMiddleware(sourceFile));
}

function e2eConfigHasBackendProxy(sourceFile) {
  const config = exportedConfigObject(sourceFile);
  if (!config || config.properties.some(ts.isSpreadAssignment)) return true;
  const serverProperties = objectProperties(config, "server");
  if (serverProperties.length === 0) return false;
  if (serverProperties.length !== 1) return true;
  const server = propertyInitializer(sourceFile, serverProperties[0]);
  if (!server || !ts.isObjectLiteralExpression(server)) return true;
  if (server.properties.some(ts.isSpreadAssignment)) return true;
  return objectProperties(server, "proxy").length > 0;
}

function staticCommandText(sourceFile, expression, seen = new Set()) {
  const resolved = resolveStaticExpression(sourceFile, expression, seen);
  if (!resolved) return undefined;
  if (ts.isStringLiteralLike(resolved)) return resolved.text;
  if (ts.isTemplateExpression(resolved)) {
    return [
      resolved.head.text,
      ...resolved.templateSpans.map((span) => `\${dynamic}${span.literal.text}`),
    ].join("");
  }
  if (
    ts.isBinaryExpression(resolved) &&
    resolved.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticCommandText(sourceFile, resolved.left, new Set(seen));
    const right = staticCommandText(sourceFile, resolved.right, new Set(seen));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function playwrightWebServerCommands(sourceFile) {
  const config = exportedConfigObject(sourceFile);
  if (!config) return [];
  const webServerProperties = objectProperties(config, "webServer");
  const commands = [];
  for (const property of webServerProperties) {
    const value = propertyInitializer(sourceFile, property);
    const servers = value && ts.isArrayLiteralExpression(value)
      ? value.elements.map((element) => resolveStaticExpression(sourceFile, element))
      : [value];
    for (const server of servers) {
      if (!server || !ts.isObjectLiteralExpression(server)) {
        commands.push(undefined);
        continue;
      }
      const commandProperties = objectProperties(server, "command");
      if (commandProperties.length !== 1) {
        commands.push(undefined);
        continue;
      }
      const commandProperty = commandProperties[0];
      if (!ts.isPropertyAssignment(commandProperty)) {
        commands.push(undefined);
        continue;
      }
      commands.push(staticCommandText(sourceFile, commandProperty.initializer));
    }
  }
  return commands;
}

function commandLaunchesVite(command) {
  return command
    .split(/[\s;&|]+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .some((token) => /(?:^|\/)vite(?:\.js|\.cmd)?$/.test(token));
}

function commandSelectsE2eViteConfig(command) {
  return /--config(?:=|\s+)(?:["']?)(?:[^\s"']*\/)?vite\.e2e\.config\.ts(?:["']?)(?=\s|$)/.test(
    command,
  );
}

function dockerPatternRegex(pattern) {
  const normalized = pattern.replace(/^\//, "").replace(/\/$/, "");
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(normalized.includes("/") ? `^${expression}$` : `(?:^|.*/)${expression}$`);
}

function parseDockerignore(source) {
  return source
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, value: line.trim() }))
    .filter(({ value }) => value && !value.startsWith("#"))
    .map(({ line, value }) => {
      const negated = value.startsWith("!");
      const pattern = negated ? value.slice(1) : value;
      return { line, negated, pattern, matcher: dockerPatternRegex(pattern) };
    });
}

function dockerignoreExcludes(rules, target) {
  let excluded = false;
  for (const rule of rules) {
    if (rule.matcher.test(target)) excluded = !rule.negated;
  }
  return excluded;
}

function yamlPair(map, key) {
  if (!isMap(map)) return undefined;
  return map.items.find(
    (pair) => isScalar(pair.key) && String(pair.key.value) === key,
  );
}

function yamlLine(lineCounter, node) {
  const offset = node?.range?.[0];
  return typeof offset === "number" ? lineCounter.linePos(offset).line : 1;
}

function postgresImage(value) {
  return /(?:^|\/)postgres(?::[^\s]+|@[^\s]+)?$/i.test(
    value.trim().replace(/^['"]|['"]$/g, ""),
  );
}

function commandRunsPostgresContainer(command) {
  for (const line of command.split(/\r?\n/)) {
    if (!/\bdocker\s+run\b/i.test(line)) continue;
    const tokens = line
      .split(/\s+/)
      .map((token) => token.replace(/^["']|["',;]$/g, ""));
    if (tokens.some(postgresImage)) return true;
  }
  return false;
}

function automatedCommandViolations(command, owner) {
  const messages = [];
  if (
    /(?:^|[\s;&|])(?:export\s+)?(?:DATABASE_URL|DATABASE_MIGRATION_URL|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD)\s*=/im.test(
      command,
    )
  ) {
    messages.push(`supplies database connectivity from ${owner} shell command`);
  }
  if (
    /\b(?:pnpm|npm|yarn)\b[^\n;&|]*(?:db:migrate|\brun\s+migrate\b)/i.test(
      command,
    )
  ) {
    messages.push(`runs a database migration from ${owner}`);
  }
  const lifecycleCommand = new RegExp(
    `\\b(?:${[
      "create" + "db",
      "drop" + "db",
      "pg" + "_isready",
      "p" + "sql",
      "pg" + "_dump",
      "pg" + "_restore",
      "init" + "db",
    ].join("|")})\\b`,
    "i",
  );
  if (lifecycleCommand.test(command)) {
    messages.push(`runs a database lifecycle/client command in ${owner}`);
  }
  if (commandRunsPostgresContainer(command)) {
    messages.push(`starts a PostgreSQL service/container in ${owner}`);
  }
  return messages;
}

function scanWorkflow(relative, source) {
  const violations = [];
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, prettyErrors: false });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    return [`${relative}:1 cannot be structurally parsed for zero-database workflow enforcement`];
  }
  const databaseEnvironmentNames = new Set([
    ...testDatabaseEnvironmentNames,
    "DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
  ]);

  const inspectEnvironment = (map) => {
    if (!isMap(map)) return;
    for (const pair of map.items) {
      if (
        isScalar(pair.key) &&
        databaseEnvironmentNames.has(String(pair.key.value))
      ) {
        violations.push(
          `${relative}:${yamlLine(lineCounter, pair.key)} supplies database connectivity to an automated workflow`,
        );
      }
    }
  };

  const inspectServices = (services) => {
    if (!isMap(services)) return;
    for (const service of services.items) {
      const image = yamlPair(service.value, "image")?.value;
      if (isScalar(image) && postgresImage(String(image.value))) {
        violations.push(
          `${relative}:${yamlLine(lineCounter, image)} starts a PostgreSQL service/container in an automated workflow`,
        );
      }
    }
  };

  inspectEnvironment(yamlPair(document.contents, "env")?.value);
  const jobs = yamlPair(document.contents, "jobs")?.value;
  if (!isMap(jobs)) return violations;
  for (const job of jobs.items) {
    if (!isMap(job.value)) continue;
    inspectEnvironment(yamlPair(job.value, "env")?.value);
    inspectServices(yamlPair(job.value, "services")?.value);
    const container = yamlPair(job.value, "container")?.value;
    const containerImage = isMap(container)
      ? yamlPair(container, "image")?.value
      : container;
    if (isScalar(containerImage) && postgresImage(String(containerImage.value))) {
      violations.push(
        `${relative}:${yamlLine(lineCounter, containerImage)} starts a PostgreSQL service/container in an automated workflow`,
      );
    }
    const steps = yamlPair(job.value, "steps")?.value;
    if (!isSeq(steps)) continue;
    for (const step of steps.items) {
      if (!isMap(step)) continue;
      inspectEnvironment(yamlPair(step, "env")?.value);
      const run = yamlPair(step, "run")?.value;
      if (!isScalar(run) || typeof run.value !== "string") continue;
      for (const message of automatedCommandViolations(run.value, "an automated workflow")) {
        violations.push(`${relative}:${yamlLine(lineCounter, run)} ${message}`);
      }
    }
  }
  return violations;
}

function productionSourceBranchesOnTest(sourceFile) {
  let violation = false;
  const expressionText = (node) => node.getText(sourceFile).replace(/\s+/g, "");
  const isTestEnvironmentExpression = (node) => {
    if (ts.isIdentifier(node)) {
      return ["NODE_ENV", "nodeEnv", "VITEST"].includes(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      return (
        ["NODE_ENV", "nodeEnv", "VITEST"].includes(node.name.text) ||
        (node.name.text === "MODE" && expressionText(node.expression) === "import.meta.env")
      );
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      return ["NODE_ENV", "nodeEnv", "VITEST"].includes(
        node.argumentExpression.text,
      );
    }
    return false;
  };
  const visit = (node) => {
    if (violation) return;
    if (ts.isBinaryExpression(node)) {
      const equality = [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind);
      if (equality) {
        const leftTest = ts.isStringLiteralLike(node.left) && node.left.text === "test";
        const rightTest = ts.isStringLiteralLike(node.right) && node.right.text === "test";
        if (
          (leftTest && isTestEnvironmentExpression(node.right)) ||
          (rightTest && isTestEnvironmentExpression(node.left))
        ) {
          violation = true;
          return;
        }
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      /process\.env(?:\.|\[)["']?VITEST/.test(expressionText(node))
    ) {
      violation = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violation;
}

function isFirstPartyProductionSource(relative) {
  if (!/\.[cm]?[jt]sx?$/.test(relative) || /\.d\.[cm]?ts$/.test(relative)) return false;
  if (
    !/^apps\/(?:server|ui)\/src\//.test(relative) &&
    !/^packages\/.*\/src\//.test(relative) &&
    // The DB package intentionally follows TradingGoose's root-owned Drizzle
    // layout instead of placing its production modules under src/.
    !/^packages\/db\/(?!tests\/)/.test(relative)
  ) {
    return false;
  }
  return !isTestEntrySource(relative) && !isTestSupportSource(relative);
}

function collectRelativeModuleGraph(entry, relativeToAbsolute, factsCache) {
  const selected = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const relative = pending.pop();
    if (!relative || selected.has(relative)) continue;
    selected.add(relative);
    const facts = collectSourceFacts(
      relative,
      relativeToAbsolute.get(relative),
      factsCache,
    );
    for (const edge of facts.edges) {
      const target = resolveLocalTarget(relative, edge.moduleName, relativeToAbsolute);
      if (target && !selected.has(target)) pending.push(target);
    }
  }
  return selected;
}

function isWorkflow(relativePath) {
  return /^\.github\/workflows\/.*\.ya?ml$/.test(relativePath);
}

function isPackageManifest(relativePath) {
  return relativePath === "package.json" || relativePath.endsWith("/package.json");
}

function isAutomatedValidationScript(name) {
  return /^(?:check|ci|smoke|test|verify)(?::|$)/.test(name);
}

function packageScriptLine(source, name) {
  const index = source.indexOf(JSON.stringify(name));
  return lineNumber(source, Math.max(0, index));
}

function scanPackageValidationScripts(relative, source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    return [`${relative}:1 cannot be structurally parsed for zero-database package-script enforcement`];
  }
  if (!manifest.scripts || typeof manifest.scripts !== "object") return [];

  const violations = [];
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (typeof command !== "string" || !isAutomatedValidationScript(name)) continue;
    const line = packageScriptLine(source, name);
    if (
      name.startsWith("smoke:") &&
      /(?:^|[\s;&|'\"])(?:bash|sh)(?:[\s;&|'\"]|$)|\.sh(?:[\s;&|'\"]|$)/.test(command)
    ) {
      violations.push(
        `${relative}:${line} registers smoke validation through a shell target; use the canonical mocked test or artifact owner directly`,
      );
    }
    for (const message of automatedCommandViolations(
      command,
      `automated package script ${JSON.stringify(name)}`,
    )) {
      violations.push(`${relative}:${line} ${message}`);
    }
  }
  return violations;
}

function isActiveDocumentation(relativePath) {
  return (
    /^(?:doc|apps\/docs)\/.*\.mdx?$/.test(relativePath) ||
    /^\.agents\/skills\/.*\.mdx?$/.test(relativePath)
  );
}

function isRepositoryContractSource(relativePath) {
  const basename = path.posix.basename(relativePath);
  return (
    /\.(?:[cm]?[jt]sx?|json|ya?ml|mdx?|sh|txt)$/.test(relativePath) ||
    /^Dockerfile(?:\.|$)/.test(basename) ||
    basename === ".npmrc"
  );
}

function isGateFixtureSource(relativePath) {
  return [
    "scripts/check-zero-database-tests.mjs",
    "scripts/check-zero-database-tests.test.mjs",
  ].includes(relativePath);
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function addMatches(violations, relativePath, source, pattern, message) {
  for (const match of source.matchAll(pattern)) {
    violations.push(
      `${relativePath}:${lineNumber(source, match.index ?? 0)} ${message}`,
    );
  }
}

export function scanZeroDatabaseTests(repoRoot) {
  const violations = [];
  const allFiles = walk(repoRoot);
  const relativeToAbsolute = new Map(
    allFiles.map((absolute) => [repoPath(repoRoot, absolute), absolute]),
  );
  const factsCache = new Map();
  const testBoundarySources = collectTestBoundarySources(
    relativeToAbsolute,
    factsCache,
  );

  for (const [relative, absolute] of relativeToAbsolute) {
    if (isPackageManifest(relative)) {
      violations.push(
        ...scanPackageValidationScripts(relative, readFileSync(absolute, "utf8")),
      );
    }
    if (!isRepositoryContractSource(relative) || isGateFixtureSource(relative)) {
      continue;
    }
    const source = readFileSync(absolute, "utf8");
    for (const name of testDatabaseEnvironmentNames) {
      addMatches(
        violations,
        relative,
        source,
        new RegExp(name, "g"),
        `retains the retired test database environment contract ${name}`,
      );
    }
    for (const retiredPath of retiredLiveSmokePaths) {
      addMatches(
        violations,
        relative,
        source,
        new RegExp(retiredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        `references the retired live validation path ${retiredPath}`,
      );
    }
    if (isActiveDocumentation(relative)) {
      addMatches(
        violations,
        relative,
        source,
        /(?:\.\/)?scripts\/[^\s`'\"]*smoke[^\s`'\"]*\.sh/g,
        "documents a shell smoke path instead of the canonical mocked or artifact validation owner",
      );
    }
  }

  for (const retiredPath of retiredLiveSmokePaths) {
    if (relativeToAbsolute.has(retiredPath)) {
      violations.push(`${retiredPath}:1 retains a retired live validation harness`);
    }
  }

  for (const absolute of allFiles) {
    const relative = repoPath(repoRoot, absolute);
    if (!testBoundarySources.has(relative) && !isWorkflow(relative)) continue;
    const source = readFileSync(absolute, "utf8");

    if (isWorkflow(relative)) {
      violations.push(...scanWorkflow(relative, source));
      continue;
    }

    addMatches(
      violations,
      relative,
      source,
      new RegExp(liveHarnessSymbol, "g"),
      "uses the removed live PostgreSQL test harness",
    );
    addMatches(
      violations,
      relative,
      source,
      new RegExp(`(?:helpers/)?${liveHarnessFile}`, "g"),
      "imports the removed live PostgreSQL test helper",
    );
    addMatches(
      violations,
      relative,
      source,
      new RegExp(
        embeddedDatabaseTerms
          .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|"),
        "g",
      ),
      "uses a prohibited embedded or in-memory database engine",
    );
    addMatches(
      violations,
      relative,
      source,
      /\b(?:CREATE|DROP)\s+DATABASE\b/gi,
      "creates or drops a database from a test",
    );

    addMatches(
      violations,
      relative,
      source,
      /\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*["'](?:createdb|dropdb|pg_isready|psql)["']/g,
      "invokes a PostgreSQL lifecycle/client executable from a test boundary",
    );

    if (
      relative.startsWith("tests/e2e/") &&
      /paperclipai\s+onboard|@paperclipai\/server|server\/src\/(?:index|server)/.test(source)
    ) {
      violations.push(
        `${relative}:1 boots the real Paperclip server from a browser test`,
      );
    }

    if (relative.startsWith("tests/e2e/")) {
      addMatches(
        violations,
        relative,
        source,
        /\bpage\s*\.\s*request\b/g,
        "uses Playwright page.request, which bypasses the test-owned API fixture",
      );
    }

    if (
      /(?:^|\/)playwright[^/]*\.config\.[cm]?[jt]s$/.test(relative)
      && /\benv\s*:\s*\{[^}]*\.\.\.process\.env/s.test(source)
    ) {
      violations.push(
        `${relative}:1 forwards the ambient process environment into a browser-test server`,
      );
    }
  }

  const graphViolations = new Set();
  for (const entry of [...relativeToAbsolute.keys()].filter(
    (relative) =>
      isTestEntrySource(relative) && /\.[cm]?[jt]sx?$/.test(relative),
  )) {
    for (const violation of scanOrderedTestGraph(
      entry,
      relativeToAbsolute,
      factsCache,
    )) {
      graphViolations.add(violation);
    }
  }
  violations.push(...graphViolations);

  const forbiddenHarnessPaths = [
    path.join(repoRoot, "packages", "db", `${liveHarnessFile}.ts`),
    path.join(repoRoot, "apps", "server", "src", "__tests__", "helpers", "external-postgres.ts"),
  ];
  for (const forbiddenHarnessPath of forbiddenHarnessPaths) {
    if (existsSync(forbiddenHarnessPath)) {
      violations.push(
        `${repoPath(repoRoot, forbiddenHarnessPath)}:1 retains the live PostgreSQL test harness`,
      );
    }
  }

  const viteInterceptorViolations = new Set();
  for (const relative of [...relativeToAbsolute.keys()].filter(isAuthoredViteConfig)) {
    const graph = collectRelativeModuleGraph(
      relative,
      relativeToAbsolute,
      factsCache,
    );
    const graphDefinesServerHook = [...graph].some((reachable) =>
      configDefinesConfigureServer(
        collectSourceFacts(
          reachable,
          relativeToAbsolute.get(reachable),
          factsCache,
        ).sourceFile,
      ),
    );
    for (const reachable of graph) {
      const facts = collectSourceFacts(
        reachable,
        relativeToAbsolute.get(reachable),
        factsCache,
      );
      if (
        configInstallsRequestInterceptor(facts.sourceFile) ||
        (graphDefinesServerHook && callInstallsMiddleware(facts.sourceFile))
      ) {
        viteInterceptorViolations.add(
          `${relative}:1 reaches ${reachable}, which installs a Vite request interceptor; browser tests must use explicit Playwright mocks`,
        );
      }
    }
  }
  violations.push(...viteInterceptorViolations);

  for (const [relative, absolute] of relativeToAbsolute) {
    if (!isVitestConfig(relative)) continue;
    const facts = collectSourceFacts(relative, absolute, factsCache);
    if (!configHasExactEnvDirFalse(facts.sourceFile)) {
      violations.push(
        `${relative}:1 permits Vite/Vitest dotenv auto-loading; every Vitest config must set envDir: false`,
      );
    }
  }

  const e2eViteConfigPath = path.join(repoRoot, "apps", "ui", "vite.e2e.config.ts");
  if (!existsSync(e2eViteConfigPath)) {
    violations.push(
      "apps/ui/vite.e2e.config.ts:1 is required so browser tests use a dotenv-free, backend-free UI server",
    );
  } else {
    const relative = "apps/ui/vite.e2e.config.ts";
    const facts = collectSourceFacts(relative, e2eViteConfigPath, factsCache);
    if (!configHasExactEnvDirFalse(facts.sourceFile)) {
      violations.push(
        "apps/ui/vite.e2e.config.ts:1 must set envDir: false",
      );
    }
    if (e2eConfigHasBackendProxy(facts.sourceFile)) {
      violations.push(
        "apps/ui/vite.e2e.config.ts:1 must not configure a backend proxy",
      );
    }
  }

  for (const [relative, absolute] of relativeToAbsolute) {
    if (!/(?:^|\/)playwright[^/]*\.config\.[cm]?[jt]s$/.test(relative)) continue;
    const facts = collectSourceFacts(relative, absolute, factsCache);
    for (const command of playwrightWebServerCommands(facts.sourceFile)) {
      if (command === undefined) {
        violations.push(
          `${relative}:1 uses a non-static browser-test webServer command`,
        );
      } else if (
        commandLaunchesVite(command) &&
        !commandSelectsE2eViteConfig(command)
      ) {
        violations.push(
          `${relative}:1 starts Vite without the dotenv-free browser-test config`,
        );
      }
    }
  }

  const dockerignorePath = path.join(repoRoot, ".dockerignore");
  if (!existsSync(dockerignorePath)) {
    violations.push(
      ".dockerignore:1 is required to keep private dotenv files out of Docker build contexts",
    );
  } else {
    const rules = parseDockerignore(readFileSync(dockerignorePath, "utf8"));
    for (const target of [
      ".env",
      ".env.local",
      ".env.production.local",
      "nested/.env",
      "nested/.env.local",
      "nested/deeper/.env.secret",
    ]) {
      if (!dockerignoreExcludes(rules, target)) {
        violations.push(
          `.dockerignore:1 must exclude ${target} after ordered rule evaluation so private dotenv files never enter Docker build contexts`,
        );
      }
    }
    const allowedReinclusions = new Set(safeDockerEnvironmentReinclusions);
    for (const rule of rules.filter((candidate) => candidate.negated)) {
      const touchesEnvironmentFile = [
        ".env",
        ".env.local",
        ".env.example",
        ".env.local.example",
        "nested/.env",
        "nested/.env.local",
        "nested/.env.example",
        "nested/.env.local.example",
      ].some((target) => rule.matcher.test(target));
      if (touchesEnvironmentFile && !allowedReinclusions.has(rule.pattern)) {
        violations.push(
          `.dockerignore:${rule.line} re-includes dotenv files outside the exact .example allowlist`,
        );
      }
    }
    const configuredReinclusions = new Set(
      rules.filter((rule) => rule.negated).map((rule) => rule.pattern),
    );
    for (const rule of safeDockerEnvironmentReinclusions) {
      if (!configuredReinclusions.has(rule)) {
        violations.push(
          `.dockerignore:1 must preserve the exact !${rule} public example-file exception`,
        );
      }
    }
    for (const target of [
      ".env.example",
      ".env.local.example",
      "nested/.env.example",
      "nested/.env.local.example",
    ]) {
      if (dockerignoreExcludes(rules, target)) {
        violations.push(
          `.dockerignore:1 must keep the public ${target} example outside the private dotenv exclusion`,
        );
      }
    }
  }

  for (const [relative, absolute] of relativeToAbsolute) {
    if (!isFirstPartyProductionSource(relative)) continue;
    const facts = collectSourceFacts(relative, absolute, factsCache);
    if (productionSourceBranchesOnTest(facts.sourceFile)) {
      violations.push(
        `${relative}:1 branches production database/config loading on test mode; tests must use explicit mocks and inputs instead`,
      );
    }
    for (const suffix of productionTestDatabaseEnvironmentSuffixes) {
      addMatches(
        violations,
        relative,
        facts.source,
        new RegExp(`(?:^|[^A-Za-z0-9_])${suffix}(?=[^A-Za-z0-9_]|$)`, "g"),
        `retains the retired production test-database environment tombstone ${suffix}`,
      );
    }
  }

  const serverConfigPath = path.join(repoRoot, "apps", "server", "src", "config.ts");
  if (existsSync(serverConfigPath)) {
    const source = readFileSync(serverConfigPath, "utf8");
    if (
      /from\s+["']dotenv["']/.test(source)
      || /\brequire\s*\(\s*["']dotenv["']\s*\)/.test(source)
      || /\bloadRuntimeEnvironmentFiles\s*\(/.test(source)
    ) {
      violations.push(
        "apps/server/src/config.ts:1 loads environment files from an importable configuration module; dotenv loading belongs only at an explicit process startup boundary",
      );
    }
  }

  return violations.sort();
}

export function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = scanZeroDatabaseTests(repoRoot);
  if (violations.length > 0) {
    console.error("Zero-database test boundary violations:\n");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log("Zero-database test boundary passed.");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
