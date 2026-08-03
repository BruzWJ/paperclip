import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DONOR_COMMIT = "2b2aacc93975330f9fd045d4306f698b0c6a8f8f";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DONOR_ROOT = path.resolve(
  process.env.OPENCODE_SESSION_DONOR ??
    path.join(REPO_ROOT, "../../reference/opencode"),
);
const LOCK_PATH = path.join(REPO_ROOT, "opencode-donor.lock.json");
const RETIRED_PACKAGE = path.join(REPO_ROOT, "packages/issue-session");
const SCHEMA_ROOT = "packages/schema/src";

const SCHEMA_ROOTS = [
  "packages/schema/src/session.ts",
  "packages/schema/src/session-id.ts",
  "packages/schema/src/session-message.ts",
  "packages/schema/src/session-event.ts",
  "packages/schema/src/session-input.ts",
  "packages/schema/src/session-delivery.ts",
] as const;

const SCHEMA_EXCLUSIONS = [
  "packages/schema/src/session-compaction-event.ts",
  "packages/schema/src/session-status-event.ts",
  "packages/schema/src/session-todo.ts",
  "packages/schema/src/session-v1.ts",
  "packages/schema/src/v1/legacy-event.ts",
  "packages/schema/src/v1/permission.ts",
  "packages/schema/src/v1/question.ts",
  "packages/schema/src/v1/session.ts",
] as const;

const CORE_PATHS = [
  "packages/core/src/session.ts",
  "packages/core/src/session/context-epoch.ts",
  "packages/core/src/session/error.ts",
  "packages/core/src/session/event.ts",
  "packages/core/src/session/history.ts",
  "packages/core/src/session/info.ts",
  "packages/core/src/session/input.ts",
  "packages/core/src/session/message.ts",
  "packages/core/src/session/message-updater.ts",
  "packages/core/src/session/projector.ts",
  "packages/core/src/session/prompt.ts",
  "packages/core/src/session/revert.ts",
  "packages/core/src/session/schema.ts",
  "packages/core/src/session/sql.ts",
  "packages/core/src/session/store.ts",
] as const;

const CORE_EXCLUDED_PATHS = [
  "packages/core/src/session/execution.ts",
  "packages/core/src/session/execution/local.ts",
  "packages/core/src/session/run-coordinator.ts",
  "packages/core/src/session/runner/index.ts",
  "packages/core/src/session/runner/llm.ts",
  "packages/core/src/session/runner/max-steps.ts",
  "packages/core/src/session/runner/model.ts",
  "packages/core/src/session/runner/publish-llm-event.ts",
  "packages/core/src/session/runner/to-llm-message.ts",
  "packages/core/src/session/todo.ts",
  "packages/core/src/session/compaction.ts except SUMMARY_TEMPLATE and buildPrompt",
  "all SessionV1, V1 table/event/create/project spans in mixed files",
] as const;

const PRODUCTION_COMPACTION_PATHS = [
  "packages/opencode/src/session/overflow.ts",
  "packages/opencode/src/session/compaction.ts",
  "packages/opencode/src/session/message-v2.ts",
  "packages/opencode/src/util/media.ts",
  "packages/opencode/src/provider/transform.ts",
  "packages/core/src/util/token.ts",
  "packages/core/src/session/compaction.ts",
  "packages/core/src/v1/config/config.ts",
] as const;

const POLICY_PATH =
  "server/src/services/issue-session-compaction/policy.ts";
const ALGORITHMS_PATH =
  "server/src/services/issue-session-compaction/algorithms.ts";
const P1_BINDINGS = [
  "experimentalSessionCompacting",
  "experimentalChatMessagesTransform",
  "experimentalCompactionAutocontinue",
] as const;

// These hashes seal the reviewed path/symbol/span manifests. Whole-file and
// individual-span hashes below separately detect donor byte drift.
const CORE_MANIFEST_SHA256 =
  "c000f9f75ba6ec5650b071a01db81b0455996e15555e817a923c0be2e3a3875e";
const PRODUCTION_MANIFEST_SHA256 =
  "d25718833807ca944906a65d692049d50011d902846be711cd3e4ac04e4a4a23";

type SpanEvidence = {
  readonly symbol?: string;
  readonly kind?: string;
  readonly start: number;
  readonly end: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly sha256: string;
};

type SourceSpanEvidence = SpanEvidence & { readonly source: string };

type DonorFileEvidence = {
  readonly sourcePath: string;
  readonly gitBlob: string;
  readonly sha256: string;
  readonly role?: string;
  readonly roots?: boolean;
  readonly staticRelativeImports?: readonly string[];
  readonly adoptedExports?: readonly SpanEvidence[];
  readonly adoptedSpans?: readonly SpanEvidence[];
  readonly excludedSpans?: readonly SpanEvidence[];
  readonly explicitExcludedSymbolsOrSpans?: readonly string[];
};

export type P1TargetBindingEvidence = {
  readonly name: (typeof P1_BINDINGS)[number];
  readonly policyDeclaration: SpanEvidence;
  readonly algorithmsCallsite: SpanEvidence;
};

export type P1TargetEvidence = {
  readonly policyPath: typeof POLICY_PATH;
  readonly algorithmsPath: typeof ALGORITHMS_PATH;
  readonly algorithmsImport: SpanEvidence;
  readonly bindings: readonly P1TargetBindingEvidence[];
};

type DonorLock = {
  readonly version: number;
  readonly donor: {
    readonly repository: string;
    readonly commit: string;
  };
  readonly schema: {
    readonly roots: readonly string[];
    readonly staticRelativeClosure: readonly DonorFileEvidence[];
    readonly exclusions: readonly string[];
  };
  readonly coreV2: {
    readonly files: readonly DonorFileEvidence[];
    readonly excludedFiles: readonly string[];
  };
  readonly productionCompaction: {
    readonly files: readonly DonorFileEvidence[];
    readonly replacedEventCut: {
      readonly excludedImport: readonly SourceSpanEvidence[];
      readonly excludedExpression: readonly SourceSpanEvidence[];
      readonly replacement: string;
    };
    readonly p1Target: P1TargetEvidence;
  };
};

export type TargetSourceReader = (
  relativePath: string,
) => Promise<string>;

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const git = (args: readonly string[]): string =>
  execFileSync("git", ["-C", DONOR_ROOT, ...args], {
    encoding: "utf8",
  }).trim();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} keys changed: ${actual.join(", ")}`,
  );
}

const donorSourceCache = new Map<string, string>();

function donorSource(sourcePath: string): string {
  const cached = donorSourceCache.get(sourcePath);
  if (cached !== undefined) return cached;
  const source = execFileSync(
    "git",
    ["-C", DONOR_ROOT, "show", `${DONOR_COMMIT}:${sourcePath}`],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  donorSourceCache.set(sourcePath, source);
  return source;
}

function donorPathExists(sourcePath: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", DONOR_ROOT, "cat-file", "-e", `${DONOR_COMMIT}:${sourcePath}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function parseTypeScript(sourcePath: string, source: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const diagnostics = (sourceFile as ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  assert(
    diagnostics.length === 0,
    `TypeScript parse failed for ${sourcePath}`,
  );
  return sourceFile;
}

function syntaxNodes(sourceFile: ts.SourceFile): ts.Node[] {
  const output: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    output.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return output;
}

function line(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function nodeEvidence(
  source: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  symbol?: string,
): SpanEvidence {
  const start = node.getStart(sourceFile);
  const end = node.end;
  return {
    ...(symbol === undefined ? {} : { symbol }),
    kind: ts.SyntaxKind[node.kind],
    start,
    end,
    startLine: line(sourceFile, start),
    endLine: line(sourceFile, end),
    sha256: sha256(source.slice(start, end)),
  };
}

function checkSpan(
  sourcePath: string,
  source: string,
  span: SpanEvidence,
): void {
  assert(
    Number.isInteger(span.start) &&
      Number.isInteger(span.end) &&
      span.start >= 0 &&
      span.end > span.start &&
      span.end <= source.length,
    `Invalid donor span ${sourcePath}:${span.start}-${span.end}`,
  );
  assert(
    sha256(source.slice(span.start, span.end)) === span.sha256,
    `Donor span changed ${sourcePath}:${span.symbol ?? span.kind ?? "span"}`,
  );
}

function checkDonorFile(record: DonorFileEvidence): void {
  const source = donorSource(record.sourcePath);
  assert(
    sha256(source) === record.sha256,
    `Donor file changed ${record.sourcePath}`,
  );
  assert(
    git(["rev-parse", `${DONOR_COMMIT}:${record.sourcePath}`]) ===
      record.gitBlob,
    `Donor blob changed ${record.sourcePath}`,
  );
  for (const span of record.adoptedExports ?? []) {
    checkSpan(record.sourcePath, source, span);
  }
  for (const span of record.adoptedSpans ?? []) {
    checkSpan(record.sourcePath, source, span);
  }
  for (const span of record.excludedSpans ?? []) {
    checkSpan(record.sourcePath, source, span);
  }
}

function resolveDonorRelativeImport(
  sourcePath: string,
  specifier: string,
): string {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePath), specifier),
  );
  const candidates = path.posix.extname(base)
    ? [
        base,
        base.replace(/\.[cm]?js$/, ".ts"),
        base.replace(/\.[cm]?js$/, ".tsx"),
      ]
    : [`${base}.ts`, `${base}.tsx`, path.posix.join(base, "index.ts")];
  const resolved = candidates.find(donorPathExists);
  assert(
    resolved !== undefined,
    `Cannot resolve donor relative import ${sourcePath} -> ${specifier}`,
  );
  assert(
    resolved === SCHEMA_ROOT || resolved.startsWith(`${SCHEMA_ROOT}/`),
    `Schema closure escaped ${SCHEMA_ROOT}: ${sourcePath} -> ${resolved}`,
  );
  return resolved;
}

const directImportCache = new Map<string, readonly string[]>();

function directStaticRelativeImports(sourcePath: string): string[] {
  const cached = directImportCache.get(sourcePath);
  if (cached) return [...cached];
  const source = donorSource(sourcePath);
  const sourceFile = parseTypeScript(sourcePath, source);
  const specifiers = sourceFile.statements.flatMap((statement) => {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith(".")
    ) {
      return [statement.moduleSpecifier.text];
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteralLike(statement.moduleReference.expression) &&
      statement.moduleReference.expression.text.startsWith(".")
    ) {
      return [statement.moduleReference.expression.text];
    }
    return [];
  });
  const result = [
    ...new Set(
      specifiers.map((specifier) =>
        resolveDonorRelativeImport(sourcePath, specifier),
      ),
    ),
  ].sort();
  directImportCache.set(sourcePath, result);
  return [...result];
}

function staticRelativeClosure(): string[] {
  const found = new Set<string>(SCHEMA_ROOTS);
  const visit = (sourcePath: string): void => {
    for (const dependency of directStaticRelativeImports(sourcePath)) {
      if (found.has(dependency)) continue;
      found.add(dependency);
      visit(dependency);
    }
  };
  for (const root of SCHEMA_ROOTS) visit(root);
  return [...found].sort();
}

function exportedStatementSymbol(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isExportDeclaration(statement)) {
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      return statement.exportClause.elements
        .map((item) => item.name.text)
        .join(",");
    }
    if (
      statement.exportClause &&
      ts.isNamespaceExport(statement.exportClause)
    ) {
      return statement.exportClause.name.text;
    }
    return statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
      ? `*:${statement.moduleSpecifier.text}`
      : "*";
  }
  if (
    (ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.length === 1 &&
      ts.isIdentifier(statement.declarationList.declarations[0]!.name))
  ) {
    return statement.declarationList.declarations[0]!.name.text;
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.getText(sourceFile);
  }
  throw new Error(
    `Exported donor statement must have one named symbol ${sourceFile.fileName}:${statement.getStart(sourceFile)}`,
  );
}

function exportedStatementEvidence(sourcePath: string): SpanEvidence[] {
  const source = donorSource(sourcePath);
  const sourceFile = parseTypeScript(sourcePath, source);
  return sourceFile.statements
    .filter((statement) =>
      ts.isExportDeclaration(statement) ||
      (ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ) === true),
    )
    .map((statement) =>
      nodeEvidence(
        source,
        sourceFile,
        statement,
        exportedStatementSymbol(statement, sourceFile),
      ),
    );
}

function comparableEvidence(value: unknown): string {
  return JSON.stringify(value);
}

function assertSchemaClosure(lock: DonorLock): void {
  assert(
    comparableEvidence(lock.schema.roots) === comparableEvidence(SCHEMA_ROOTS),
    "Session donor schema roots are not the exact six-root manifest",
  );
  assert(
    comparableEvidence(lock.schema.exclusions) ===
      comparableEvidence(SCHEMA_EXCLUSIONS),
    "Session donor schema exclusion manifest changed",
  );
  const records = [...lock.schema.staticRelativeClosure].sort((a, b) =>
    a.sourcePath.localeCompare(b.sourcePath),
  );
  const expectedPaths = staticRelativeClosure();
  assert(
    comparableEvidence(records.map((record) => record.sourcePath)) ===
      comparableEvidence(expectedPaths),
    "Session donor schema static relative closure changed",
  );
  for (const record of records) {
    assert(
      !SCHEMA_EXCLUSIONS.includes(
        record.sourcePath as (typeof SCHEMA_EXCLUSIONS)[number],
      ),
      `Excluded schema entered the adoption closure: ${record.sourcePath}`,
    );
    assert(
      record.roots === SCHEMA_ROOTS.includes(
        record.sourcePath as (typeof SCHEMA_ROOTS)[number],
      ),
      `Schema root marker changed ${record.sourcePath}`,
    );
    assert(
      comparableEvidence(record.staticRelativeImports ?? []) ===
        comparableEvidence(directStaticRelativeImports(record.sourcePath)),
      `Schema static relative imports changed ${record.sourcePath}`,
    );
    assert(
      comparableEvidence(record.adoptedExports ?? []) ===
        comparableEvidence(exportedStatementEvidence(record.sourcePath)),
      `Schema adopted export closure changed ${record.sourcePath}`,
    );
  }
}

function manifestSpan(span: SpanEvidence) {
  return {
    symbol: span.symbol,
    kind: span.kind,
    start: span.start,
    end: span.end,
    startLine: span.startLine,
    endLine: span.endLine,
    sha256: span.sha256,
  };
}

function manifestFiles(files: readonly DonorFileEvidence[]) {
  return files.map((record) => ({
    sourcePath: record.sourcePath,
    role: record.role,
    adoptedSpans: (record.adoptedSpans ?? []).map(manifestSpan),
    excludedSpans: (record.excludedSpans ?? []).map(manifestSpan),
    explicitExcludedSymbolsOrSpans:
      record.explicitExcludedSymbolsOrSpans ?? [],
  }));
}

function assertSourceManifest(lock: DonorLock): void {
  assert(
    comparableEvidence(lock.coreV2.files.map((record) => record.sourcePath)) ===
      comparableEvidence(CORE_PATHS),
    "OpenCode V2 core file manifest changed",
  );
  assert(
    comparableEvidence(lock.coreV2.excludedFiles) ===
      comparableEvidence(CORE_EXCLUDED_PATHS),
    "OpenCode V2 exact excluded-file manifest changed",
  );
  assert(
    sha256(comparableEvidence(manifestFiles(lock.coreV2.files))) ===
      CORE_MANIFEST_SHA256,
    "OpenCode V2 adopted/excluded span manifest changed",
  );
  assert(
    comparableEvidence(
      lock.productionCompaction.files.map((record) => record.sourcePath),
    ) === comparableEvidence(PRODUCTION_COMPACTION_PATHS),
    "Production compaction exact file manifest changed",
  );
  const productionManifest = {
    files: manifestFiles(lock.productionCompaction.files),
    replacedEventCut: lock.productionCompaction.replacedEventCut,
  };
  assert(
    sha256(comparableEvidence(productionManifest)) ===
      PRODUCTION_MANIFEST_SHA256,
    "Production compaction adopted/excluded span manifest changed",
  );
  for (const record of [
    ...lock.schema.staticRelativeClosure,
    ...lock.coreV2.files,
    ...lock.productionCompaction.files,
  ]) {
    assert(
      !record.sourcePath.includes("*"),
      `Donor source globs are forbidden: ${record.sourcePath}`,
    );
  }
}

function assertNoRemovedPositiveEvidence(lock: DonorLock): void {
  const corePaths = lock.coreV2.files.map((record) => record.sourcePath);
  for (const excluded of CORE_EXCLUDED_PATHS.slice(0, 10)) {
    assert(
      !corePaths.includes(excluded),
      `Excluded execution source entered the core donor closure: ${excluded}`,
    );
  }
  const messageV2 = lock.productionCompaction.files.find(
    (record) =>
      record.sourcePath === "packages/opencode/src/session/message-v2.ts",
  );
  assert(messageV2, "message-v2 donor record is missing");
  const forbiddenAdoptedSymbols = new Set([
    "providerMeta",
    "toModelMessagesEffect",
    "toModelMessages",
    "filterCompactedEffect",
    "stream",
    "page",
    "parts",
    "get",
    "fromError",
    "node",
    "Event",
    "cursor",
    "SubtaskPart",
    "handleSubtask",
  ]);
  for (const span of messageV2.adoptedSpans ?? []) {
    assert(
      !span.symbol || !forbiddenAdoptedSymbols.has(span.symbol),
      `Provider/V1 message span entered production compaction: ${span.symbol}`,
    );
  }
}

export function assertDonorLockStructure(lock: DonorLock): void {
  exactKeys(lock, [
    "version",
    "donor",
    "schema",
    "coreV2",
    "productionCompaction",
  ], "donor lock");
  assert(lock.version === 6, "Session donor lock must use exact-closure version 6");
  exactKeys(lock.donor, ["repository", "commit"], "donor identity");
  assert(
    lock.donor.repository === "reference/opencode" &&
      lock.donor.commit === DONOR_COMMIT,
    "Session donor identity changed",
  );
  exactKeys(
    lock.schema,
    ["roots", "staticRelativeClosure", "exclusions"],
    "schema lock",
  );
  exactKeys(lock.coreV2, ["files", "excludedFiles"], "core V2 lock");
  exactKeys(
    lock.productionCompaction,
    ["files", "replacedEventCut", "p1Target"],
    "production compaction lock",
  );
  exactKeys(
    lock.productionCompaction.replacedEventCut,
    ["excludedImport", "excludedExpression", "replacement"],
    "compaction event cut",
  );
  exactKeys(
    lock.productionCompaction.p1Target,
    ["policyPath", "algorithmsPath", "algorithmsImport", "bindings"],
    "P1 target lock",
  );
  assertSchemaClosure(lock);
  assertSourceManifest(lock);
  assertNoRemovedPositiveEvidence(lock);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function variableDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): { statement: ts.VariableStatement; declaration: ts.VariableDeclaration } {
  const matches = sourceFile.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name
        ? [{ statement, declaration }]
        : [],
    );
  });
  assert(matches.length === 1, `P1 policy must define ${name} exactly once`);
  return matches[0]!;
}

function arrowInitializer(
  declaration: ts.VariableDeclaration,
  name: string,
): ts.ArrowFunction {
  assert(
    declaration.initializer && ts.isArrowFunction(declaration.initializer),
    `${name} must be one fixed arrow binding`,
  );
  return declaration.initializer;
}

function exactObjectProperties(
  expression: ts.Expression,
  names: readonly string[],
  label: string,
): ts.PropertyAssignment[] {
  const object = unwrapExpression(expression);
  assert(ts.isObjectLiteralExpression(object), `${label} must return an object literal`);
  assert(
    object.properties.every(ts.isPropertyAssignment),
    `${label} must contain only fixed property assignments`,
  );
  const properties = object.properties as ts.NodeArray<ts.PropertyAssignment>;
  const actual = properties.map((property) =>
    property.name.getText(object.getSourceFile()),
  );
  assert(
    comparableEvidence(actual) === comparableEvidence(names),
    `${label} return keys changed`,
  );
  return [...properties];
}

function assertConstAssertion(
  expression: ts.Expression,
  predicate: (value: ts.Expression) => boolean,
  label: string,
): void {
  assert(ts.isAsExpression(expression), `${label} must be an as-const literal`);
  assert(
    expression.type.kind === ts.SyntaxKind.TypeReference &&
      expression.type.getText() === "const",
    `${label} must use an exact const assertion`,
  );
  assert(predicate(expression.expression), `${label} literal changed`);
}

function assertPolicySemantics(
  source: string,
  sourceFile: ts.SourceFile,
): Map<(typeof P1_BINDINGS)[number], ts.VariableStatement> {
  assert(
    sourceFile.statements.length === 3,
    "P1 policy must expose exactly three declarations and no registry/configuration owner",
  );
  const output = new Map<
    (typeof P1_BINDINGS)[number],
    ts.VariableStatement
  >();
  for (const name of P1_BINDINGS) {
    const { statement, declaration } = variableDeclaration(sourceFile, name);
    const modifiers = ts.getModifiers(statement) ?? [];
    assert(
      modifiers.length === 1 &&
        modifiers[0]!.kind === ts.SyntaxKind.ExportKeyword,
      `${name} must be a direct exported fixed binding`,
    );
    assert(
      statement.declarationList.declarations.length === 1,
      `${name} cannot share a configurable declaration`,
    );
    output.set(name, statement);
    const arrow = arrowInitializer(declaration, name);
    if (name === "experimentalSessionCompacting") {
      assert(arrow.parameters.length === 0, `${name} must accept no configuration`);
      assert(!ts.isBlock(arrow.body), `${name} must return its fixed value directly`);
      const properties = exactObjectProperties(
        arrow.body,
        ["context", "prompt"],
        name,
      );
      assertConstAssertion(
        properties[0]!.initializer,
        ts.isArrayLiteralExpression,
        `${name}.context`,
      );
      const context = unwrapExpression(properties[0]!.initializer);
      assert(
        ts.isArrayLiteralExpression(context) && context.elements.length === 0,
        `${name}.context must be byte-exact empty`,
      );
      assert(
        ts.isIdentifier(properties[1]!.initializer) &&
          properties[1]!.initializer.text === "undefined",
        `${name}.prompt must be exactly undefined`,
      );
      continue;
    }
    if (name === "experimentalChatMessagesTransform") {
      assert(
        arrow.parameters.length === 1 &&
          ts.isIdentifier(arrow.parameters[0]!.name) &&
          arrow.parameters[0]!.name.text === "messages",
        `${name} must accept only messages`,
      );
      assert(
        ts.isIdentifier(arrow.body) && arrow.body.text === "messages",
        `${name} must return the exact input array reference`,
      );
      continue;
    }
    assert(arrow.parameters.length === 0, `${name} must accept no configuration`);
    assert(!ts.isBlock(arrow.body), `${name} must return its fixed value directly`);
    const properties = exactObjectProperties(arrow.body, ["enabled"], name);
    assertConstAssertion(
      properties[0]!.initializer,
      (value) => value.kind === ts.SyntaxKind.TrueKeyword,
      `${name}.enabled`,
    );
  }
  assert(
    [...output.values()].every((statement) =>
      source.slice(statement.getStart(sourceFile), statement.end).trim().length > 0,
    ),
    "P1 policy declaration evidence is empty",
  );
  return output;
}

function nearestAncestor<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T,
): T | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function functionName(node: ts.FunctionLikeDeclaration): string | undefined {
  if ("name" in node && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return undefined;
}

function assertNoForbiddenCompactionTargetSyntax(
  policySource: string,
  algorithmSource: string,
): void {
  const joined = `${policySource}\n${algorithmSource}`;
  const forbidden = [
    ["MAX_STEPS_PROMPT", /\bMAX_STEPS_PROMPT\b/],
    ["finalStepPolicy", /\bfinalStepPolicy\b/],
    ["finalStepInvocation", /\bfinalStepInvocation\b/],
    ["finalStepPolicyRegions", /\bfinalStepPolicyRegions\b/],
    ["deleted max-step substitution", /p1-max-steps-prompt-omitted/],
    ["deleted provider-input substitution", /paperclip-ordered-typed-provider-input/],
    ["runner transition evidence", /exact-runner-transition-rewrite|runnerTransition/],
    ["model loop", /model[-_ ]loop/i],
    ["provider message conversion", /\b(?:toModelMessages(?:Effect)?|convertToModelMessages)\b/],
    ["Vercel model message", /\b(?:ModelMessage|UIMessage)\b/],
    ["Vercel ai import", /from\s+["']ai["']/],
    ["final-step tool choice", /\btoolChoice\b/],
    ["last/final-step state", /\b(?:isLastStep|lastStep|isFinalStep|finalStep)\b/],
    ["conditional local-tool suppression", /\b(?:disableLocalTools|localToolsEnabled|conditionalLocalTools)\b/],
    ["legacy runner path", /session-runner|provider-turn|native-events|\bstateless\b/],
    ["V1 subtask semantics", /\b(?:SubtaskPart|handleSubtask)\b/],
    ["donor compaction event", /\b(?:Event\.Compacted|SessionCompactionEvent)\b/],
    ["provider API branch", /\bapi\.npm\b/],
    ["provider metadata lowering", /\b(?:providerMetadata|callProviderMetadata)\b/],
    ["V1 message/database service", /\b(?:SessionV1|filterCompactedEffect|MessageTable|PartTable)\b/],
  ] as const;
  for (const [label, pattern] of forbidden) {
    assert(!pattern.test(joined), `Compaction target contains forbidden ${label}`);
  }
  const replaceableBindingOwner =
    /\b(?:compaction(?:Policy)?(?:Registry|Hook|Callback|Setter)|register(?:SessionCompacting|ChatMessagesTransform|CompactionAutocontinue)|set(?:SessionCompacting|ChatMessagesTransform|CompactionAutocontinue)|injectCompactionPolicy)\b/i;
  assert(
    !replaceableBindingOwner.test(joined),
    "P1 bindings cannot have a registry, callback, setter, or dependency-injection owner",
  );
  const forbiddenImports =
    /from\s+["'][^"']*(?:plugin|adapter|company-tool|selected-company-tool|skill-registry)[^"']*["']/i;
  assert(
    !forbiddenImports.test(joined),
    "P1 bindings cannot be replaced by plugin, skill, adapter, or company-tool imports",
  );
}

export async function computeP1TargetEvidence(
  targetSourceReader: TargetSourceReader = async (relativePath) =>
    readFile(path.join(REPO_ROOT, relativePath), "utf8"),
): Promise<P1TargetEvidence> {
  const [policySource, algorithmSource] = await Promise.all([
    targetSourceReader(POLICY_PATH),
    targetSourceReader(ALGORITHMS_PATH),
  ]);
  assertNoForbiddenCompactionTargetSyntax(policySource, algorithmSource);

  const policyFile = parseTypeScript(POLICY_PATH, policySource);
  const declarations = assertPolicySemantics(policySource, policyFile);
  const algorithmFile = parseTypeScript(ALGORITHMS_PATH, algorithmSource);
  const policyImports = algorithmFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./policy.js",
  );
  assert(
    policyImports.length === 1,
    "algorithms.ts must bind the P1 policy directly from ./policy.js",
  );
  const policyImport = policyImports[0]!;
  assert(
    policyImport.importClause?.namedBindings &&
      ts.isNamedImports(policyImport.importClause.namedBindings),
    "P1 policy import must use direct named bindings",
  );
  const imported = policyImport.importClause.namedBindings.elements;
  assert(
    imported.length === P1_BINDINGS.length &&
      imported.every((item) => !item.propertyName) &&
      comparableEvidence(imported.map((item) => item.name.text).sort()) ===
        comparableEvidence([...P1_BINDINGS].sort()),
    "algorithms.ts must import exactly the three unaliased P1 bindings",
  );
  const calls = syntaxNodes(algorithmFile).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      P1_BINDINGS.includes(
        node.expression.text as (typeof P1_BINDINGS)[number],
      ),
  );
  const bindingEvidence: P1TargetBindingEvidence[] = [];
  for (const name of P1_BINDINGS) {
    const matches = calls.filter(
      (call) => ts.isIdentifier(call.expression) && call.expression.text === name,
    );
    assert(matches.length === 1, `${name} must be invoked exactly once in algorithms.ts`);
    const call = matches[0]!;
    const owner = nearestAncestor(call, ts.isFunctionDeclaration);
    assert(
      owner && functionName(owner) === "createCompactionAlgorithms",
      `${name} must be consumed only by createCompactionAlgorithms`,
    );
    let callsite: ts.Node = call;
    if (name !== "experimentalCompactionAutocontinue") {
      const statement = nearestAncestor(call, ts.isVariableStatement);
      assert(statement, `${name} must initialize its copied donor callsite`);
      callsite = statement;
    }
    if (name === "experimentalSessionCompacting") {
      assert(call.arguments.length === 0, `${name} accepts no runtime input`);
      const declaration = nearestAncestor(call, ts.isVariableDeclaration);
      assert(
        declaration && ts.isIdentifier(declaration.name) &&
          declaration.name.text === "compacting",
        `${name} must bind the copied compacting result`,
      );
    } else if (name === "experimentalChatMessagesTransform") {
      assert(
        call.arguments.length === 1 &&
          ts.isIdentifier(call.arguments[0]!) &&
          call.arguments[0]!.text === "msgs",
        `${name} must receive the exact selected message array`,
      );
      const declaration = nearestAncestor(call, ts.isVariableDeclaration);
      assert(
        declaration && ts.isIdentifier(declaration.name) &&
          declaration.name.text === "transformed",
        `${name} must bind the identity-transformed array`,
      );
    } else {
      assert(call.arguments.length === 0, `${name} accepts no runtime input`);
      assert(
        ts.isPropertyAccessExpression(call.parent) &&
          call.parent.name.text === "enabled",
        `${name} must be consulted directly at the copied auto-continue branch`,
      );
    }
    bindingEvidence.push({
      name,
      policyDeclaration: nodeEvidence(
        policySource,
        policyFile,
        declarations.get(name)!,
        name,
      ),
      algorithmsCallsite: nodeEvidence(
        algorithmSource,
        algorithmFile,
        callsite,
        name,
      ),
    });
  }
  assert(
    bindingEvidence[0]!.algorithmsCallsite.start <
      bindingEvidence[1]!.algorithmsCallsite.start &&
      bindingEvidence[1]!.algorithmsCallsite.start <
        bindingEvidence[2]!.algorithmsCallsite.start,
    "P1 copied donor callsite order changed",
  );
  return {
    policyPath: POLICY_PATH,
    algorithmsPath: ALGORITHMS_PATH,
    algorithmsImport: nodeEvidence(
      algorithmSource,
      algorithmFile,
      policyImport,
      "policy-bindings",
    ),
    bindings: bindingEvidence,
  };
}

export async function assertPaperclipTargetParity(
  lock: DonorLock,
  targetSourceReader?: TargetSourceReader,
): Promise<void> {
  assertDonorLockStructure(lock);
  const actual = await computeP1TargetEvidence(targetSourceReader);
  assert(
    comparableEvidence(lock.productionCompaction.p1Target) ===
      comparableEvidence(actual),
    "Paperclip P1 fixed-binding target evidence changed",
  );
}

function assertReplacedEventCut(lock: DonorLock): void {
  const sourcePath = "packages/opencode/src/session/compaction.ts";
  const source = donorSource(sourcePath);
  for (const span of [
    ...lock.productionCompaction.replacedEventCut.excludedImport,
    ...lock.productionCompaction.replacedEventCut.excludedExpression,
  ]) {
    checkSpan(sourcePath, source, span);
    assert(
      source.slice(span.start, span.end) === span.source,
      `Replaced compaction event cut changed ${sourcePath}:${span.start}-${span.end}`,
    );
  }
  assert(
    lock.productionCompaction.replacedEventCut.excludedImport.length === 1 &&
      lock.productionCompaction.replacedEventCut.excludedExpression.length === 1,
    "Event.Compacted replacement must be one exact import and one exact expression cut",
  );
  assert(
    lock.productionCompaction.replacedEventCut.replacement ===
      "Atomic session.next.compaction.ended publication followed by Paperclip Session-controller re-evaluation.",
    "Event.Compacted replacement contract changed",
  );
}

async function assertRetiredConnectorAbsent(): Promise<void> {
  try {
    await access(RETIRED_PACKAGE);
    throw new Error(
      "packages/issue-session is retired; Session logic must be Paperclip-owned",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  const raw = await readFile(LOCK_PATH, "utf8");
  const lock = JSON.parse(raw) as DonorLock;
  assert(
    git(["rev-parse", "HEAD"]) === DONOR_COMMIT,
    `Session donor must be checked out at ${DONOR_COMMIT}`,
  );
  assertDonorLockStructure(lock);
  for (const record of lock.schema.staticRelativeClosure) checkDonorFile(record);
  for (const record of lock.coreV2.files) checkDonorFile(record);
  for (const record of lock.productionCompaction.files) checkDonorFile(record);
  assertReplacedEventCut(lock);
  await assertPaperclipTargetParity(lock);
  await assertRetiredConnectorAbsent();
  assert(
    raw === `${JSON.stringify(lock, null, 2)}\n`,
    "opencode-donor.lock.json must be canonical reviewed JSON",
  );
  console.log(
    "Exact OpenCode Session/compaction donor closure and three fixed Paperclip P1 bindings verified.",
  );
}

if (
  path.resolve(process.argv[1] ?? "") ===
  path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
