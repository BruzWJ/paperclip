import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACP_DIRECTORY = "packages/adapter-utils/src/acp-subprocess";
const ADAPTER_UTILS_MANIFEST = "packages/adapter-utils/package.json";
const ROOT_MANIFEST = "package.json";
const LOCKFILE = "pnpm-lock.yaml";
const CODEX_ACP_CONFORMANCE_TEST =
  `${ACP_DIRECTORY}/codex-acp.conformance.test.ts`;
const CODEX_APP_SERVER_CONFORMANCE_FIXTURE =
  `${ACP_DIRECTORY}/fixtures/codex-app-server-conformance.mjs`;

const REQUIRED_ACP_PRODUCTION_FILES = Object.freeze([
  `${ACP_DIRECTORY}/agent-registry.ts`,
  `${ACP_DIRECTORY}/client.ts`,
  `${ACP_DIRECTORY}/contract.ts`,
  `${ACP_DIRECTORY}/correlation.ts`,
  `${ACP_DIRECTORY}/execution-target.ts`,
  `${ACP_DIRECTORY}/events.ts`,
  `${ACP_DIRECTORY}/index.ts`,
  `${ACP_DIRECTORY}/process.ts`,
  `${ACP_DIRECTORY}/run-tools.ts`,
  `${ACP_DIRECTORY}/tool-output.ts`,
]);

const PRODUCTION_SCAN_ROOTS = Object.freeze([
  "packages/adapter-utils/src",
  "packages/adapters",
  "server/src",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const EXACT_DEPENDENCIES = Object.freeze({
  "@agentclientprotocol/codex-acp": "1.1.7",
  "@agentclientprotocol/sdk": "1.3.0",
  acpx: "0.13.0",
});

const FORBIDDEN_ACPX_RUNTIME_SYMBOLS = Object.freeze([
  ["create", "AcpRuntime"].join(""),
  ["Acpx", "Runtime"].join(""),
  ["Acp", "RuntimeHandle"].join(""),
  ["Acp", "SessionStore"].join(""),
  ["createFile", "SessionStore"].join(""),
  ["create", "RuntimeStore"].join(""),
  ["DEFAULT_AGENT", "_NAME"].join(""),
  ["default", "Agent"].join(""),
  ["warm", "Handles"].join(""),
  ["warmHandle", "IdleMs"].join(""),
]);

const FORBIDDEN_PROVIDER_PARSER_PATTERNS = Object.freeze([
  {
    expression: /\bcreateProviderCliAdapter\b/,
    message: "provider CLI adapter factories are forbidden in the canonical ACP directory",
  },
  {
    expression: /\bexecuteProviderCli\b|\bnormalizeProviderCli\w*\b/,
    message: "provider CLI execution/event normalization is forbidden in the canonical ACP directory",
  },
  {
    expression:
      /\b(?:parse|extract|normalize)(?:Codex|Claude|Gemini|OpenCode|Grok|Hermes|Cursor|Pi|Kimi|Qwen)\w*/i,
    message: "provider-specific parsers or extractors are forbidden in the canonical ACP directory",
  },
  {
    expression:
      /\b(?:Codex|Claude|Gemini|OpenCode|Grok|Hermes|Cursor|Pi|Kimi|Qwen)\w*(?:Parser|Extractor|Codec|EventMapper)\b/i,
    message: "provider-specific codecs are forbidden in the canonical ACP directory",
  },
  {
    expression: /\bjsonl\b/i,
    message: "JSONL provider parsing is forbidden in the canonical ACP directory",
  },
  {
    expression:
      /from\s+["'](?:openai|ai|@anthropic-ai\/sdk|@google\/generative-ai)["']/,
    message: "provider/model SDK imports are forbidden in the canonical ACP directory",
  },
]);

export interface AcpRegistryAdmissionFile {
  readonly path: string;
  readonly source: string;
}

export interface AcpRegistryAdmissionViolation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly kind:
    | "dependency"
    | "registry_import"
    | "registry_admission"
    | "raw_command"
    | "official_client"
    | "client_capability"
    | "execution_target"
    | "stream_bridge"
    | "tool_output"
    | "experimental_plan"
    | "provider_parser"
    | "installed_runtime";
  readonly message: string;
}

interface MutableViolation {
  path: string;
  kind: AcpRegistryAdmissionViolation["kind"];
  message: string;
  offset?: number;
}

interface RegistryLike {
  list(): string[];
  resolve(name: string): string | string[];
}

interface ApprovedLaunchLike {
  readonly registryName: string;
  readonly targetNativeCli: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly frontendPackage: string;
  readonly frontendVersion: string;
  readonly frontendDigest: string;
}

interface RegistryModule {
  listApprovedAcpLaunchNames(): readonly string[];
  resolveApprovedAcpLaunch(
    requestedName: string,
    registry?: RegistryLike,
  ): ApprovedLaunchLike;
  readApprovedAcpFrontendArtifact(
    launch: ApprovedLaunchLike,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly targetFileName: string;
  }>;
  resolveApprovedAcpNativeAuthentication(
    launch: ApprovedLaunchLike,
  ): {
    readonly statusArgs: readonly string[];
    readonly loginGuidance: string;
  };
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineAndColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, offset));
  const line = before.split("\n").length;
  const priorNewline = before.lastIndexOf("\n");
  return { line, column: offset - priorNewline };
}

function finalizedViolation(
  violation: MutableViolation,
  sources: ReadonlyMap<string, string>,
): AcpRegistryAdmissionViolation {
  const source = sources.get(violation.path) ?? "";
  const location = lineAndColumn(source, violation.offset ?? 0);
  return {
    path: violation.path,
    kind: violation.kind,
    message: violation.message,
    ...location,
  };
}

function isTestOrFixturePath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return (
    normalized.includes("/__tests__/") ||
    normalized.includes("/fixtures/") ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function parseSource(filePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  if (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.expression.getText() === "Object" &&
    expression.expression.name.text === "freeze"
  ) {
    return unwrapExpression(expression.arguments[0]!);
  }
  return expression;
}

function findVariableInitializer(
  sourceFile: ts.SourceFile,
  variableName: string,
): ts.Expression | undefined {
  let result: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      result = node.initializer;
      return;
    }
    if (!result) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  const name = property.name;
  if (!name) return null;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function findFunction(
  sourceFile: ts.SourceFile,
  functionName: string,
): ts.FunctionDeclaration | undefined {
  return sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName,
  );
}

function addMissing(
  violations: MutableViolation[],
  path: string,
  kind: AcpRegistryAdmissionViolation["kind"],
  message: string,
): void {
  violations.push({ path, kind, message, offset: 0 });
}

function scanDependencyPins(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  const manifestSource = sources.get(ADAPTER_UTILS_MANIFEST);
  if (!manifestSource) {
    addMissing(
      violations,
      ADAPTER_UTILS_MANIFEST,
      "dependency",
      "adapter-utils manifest is required",
    );
    return;
  }

  let manifest: {
    dependencies?: Record<string, unknown>;
    bundleDependencies?: unknown;
  };
  try {
    manifest = JSON.parse(manifestSource) as typeof manifest;
  } catch {
    addMissing(
      violations,
      ADAPTER_UTILS_MANIFEST,
      "dependency",
      "adapter-utils manifest must be valid JSON",
    );
    return;
  }

  for (const [packageName, expectedVersion] of Object.entries(
    EXACT_DEPENDENCIES,
  )) {
    const actual = manifest.dependencies?.[packageName];
    if (actual !== expectedVersion) {
      violations.push({
        path: ADAPTER_UTILS_MANIFEST,
        kind: "dependency",
        message: `${packageName} must be pinned exactly to ${expectedVersion}`,
        offset: manifestSource.indexOf(packageName),
      });
    }
  }

  const bundled = manifest.bundleDependencies;
  if (
    !Array.isArray(bundled) ||
    !Object.keys(EXACT_DEPENDENCIES).every((name) => bundled.includes(name))
  ) {
    addMissing(
      violations,
      ADAPTER_UTILS_MANIFEST,
      "dependency",
      "the official SDK, ACPX registry, and pinned Codex frontend must be bundled",
    );
  }

  const rootSource = sources.get(ROOT_MANIFEST);
  if (!rootSource) {
    addMissing(
      violations,
      ROOT_MANIFEST,
      "dependency",
      "root manifest is required",
    );
  } else {
    try {
      const root = JSON.parse(rootSource) as {
        pnpm?: { patchedDependencies?: Record<string, unknown> };
      };
      const patched = Object.keys(root.pnpm?.patchedDependencies ?? {});
      if (patched.some((name) => name === "acpx" || name.startsWith("acpx@"))) {
        violations.push({
          path: ROOT_MANIFEST,
          kind: "dependency",
          message: "ACPX must be exact and unpatched",
          offset: rootSource.indexOf("patchedDependencies"),
        });
      }
    } catch {
      addMissing(
        violations,
        ROOT_MANIFEST,
        "dependency",
        "root manifest must be valid JSON",
      );
    }
  }

  const lockfile = sources.get(LOCKFILE);
  if (!lockfile) {
    addMissing(violations, LOCKFILE, "dependency", "pnpm lockfile is required");
    return;
  }
  const importerStart = lockfile.search(/^  packages\/adapter-utils:\s*$/m);
  const importerTail =
    importerStart < 0 ? "" : lockfile.slice(importerStart + 1);
  const nextImporterOffset = importerTail.search(/^  \S.*:\s*$/m);
  const importer =
    importerStart < 0
      ? ""
      : lockfile.slice(
          importerStart,
          nextImporterOffset < 0
            ? lockfile.length
            : importerStart + 1 + nextImporterOffset,
        );
  if (!importer) {
    addMissing(
      violations,
      LOCKFILE,
      "dependency",
      "pnpm lockfile must contain the adapter-utils importer",
    );
    return;
  }
  for (const [packageName, expectedVersion] of Object.entries(
    EXACT_DEPENDENCIES,
  )) {
    const quotedName = packageName.includes("/")
      ? `'${packageName}'`
      : packageName;
    const expression = new RegExp(
      `^      ${escapeRegExp(quotedName)}:\\n` +
        `        specifier: ${escapeRegExp(expectedVersion)}\\n` +
        `        version: ${escapeRegExp(expectedVersion)}(?:\\([^\\n]+\\))?$`,
      "m",
    );
    if (!expression.test(importer)) {
      violations.push({
        path: LOCKFILE,
        kind: "dependency",
        message: `lockfile importer must resolve ${packageName} at exact ${expectedVersion}`,
        offset: lockfile.indexOf(packageName, importerStart),
      });
    }
  }
}

function scanAcpxImports(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  const registryPath = `${ACP_DIRECTORY}/agent-registry.ts`;
  let exactRegistryImportCount = 0;

  for (const [filePath, source] of sources) {
    if (
      isTestOrFixturePath(filePath) ||
      !SOURCE_EXTENSIONS.has(path.extname(filePath))
    ) {
      continue;
    }
    if (
      !source.includes("acpx") &&
      !FORBIDDEN_ACPX_RUNTIME_SYMBOLS.some((symbol) =>
        source.includes(symbol)
      )
    ) {
      continue;
    }
    const sourceFile = parseSource(filePath, source);
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const moduleName = statement.moduleSpecifier.text;
      if (moduleName !== "acpx/runtime" && !moduleName.startsWith("acpx/")) {
        if (moduleName !== "acpx") continue;
      }
      const offset = statement.getStart(sourceFile);
      if (filePath !== registryPath || moduleName !== "acpx/runtime") {
        violations.push({
          path: filePath,
          kind: "registry_import",
          message: "ACPX may be imported only from acp-subprocess/agent-registry.ts",
          offset,
        });
        continue;
      }

      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      const elements =
        bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
      const exact =
        clause != null &&
        !clause.isTypeOnly &&
        clause.name == null &&
        elements.length === 2 &&
        elements.some(
          (element) =>
            !element.isTypeOnly &&
            !element.propertyName &&
            element.name.text === "createAgentRegistry",
        ) &&
        elements.some(
          (element) =>
            element.isTypeOnly &&
            !element.propertyName &&
            element.name.text === "AcpAgentRegistry",
        );
      if (!exact) {
        violations.push({
          path: filePath,
          kind: "registry_import",
          message:
            "the ACPX registry wrapper may import only createAgentRegistry and type AcpAgentRegistry",
          offset,
        });
      } else {
        exactRegistryImportCount += 1;
      }
    }

    if (filePath !== registryPath) {
      for (const symbol of FORBIDDEN_ACPX_RUNTIME_SYMBOLS) {
        const match = new RegExp(`\\b${escapeRegExp(symbol)}\\b`).exec(source);
        if (match) {
          violations.push({
            path: filePath,
            kind: "registry_import",
            message: `ACPX runtime symbol ${symbol} is forbidden outside the registry wrapper`,
            offset: match.index,
          });
        }
      }
    }
  }

  if (exactRegistryImportCount !== 1) {
    addMissing(
      violations,
      registryPath,
      "registry_import",
      "exactly one registry-only ACPX import is required",
    );
  }
}

function scanRegistryOwner(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  const filePath = `${ACP_DIRECTORY}/agent-registry.ts`;
  const source = sources.get(filePath);
  if (!source) {
    addMissing(
      violations,
      filePath,
      "registry_admission",
      "canonical ACP registry owner is required",
    );
    return;
  }
  const sourceFile = parseSource(filePath, source);
  const catalogInitializer = findVariableInitializer(
    sourceFile,
    "APPROVED_ACP_LAUNCHES",
  );
  const catalog = catalogInitializer
    ? unwrapExpression(catalogInitializer)
    : undefined;
  const catalogKeys =
    catalog && ts.isObjectLiteralExpression(catalog)
      ? catalog.properties.map(propertyName).filter((value): value is string => value != null)
      : [];
  if (catalogKeys.length !== 1 || catalogKeys[0] !== "codex") {
    violations.push({
      path: filePath,
      kind: "registry_admission",
      message: "the initial immutable production catalog must contain only exact codex",
      offset: catalogInitializer?.getStart(sourceFile) ?? 0,
    });
  }

  for (const [constantName, expected] of [
    ["ACPX_REGISTRY_VERSION", "0.13.0"],
    ["CODEX_ACP_FRONTEND_VERSION", "1.1.7"],
    [
      "CODEX_ACP_FRONTEND_SHA256",
      "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a",
    ],
  ] as const) {
    const initializer = findVariableInitializer(sourceFile, constantName);
    const value = initializer ? unwrapExpression(initializer) : undefined;
    if (!value || !ts.isStringLiteral(value) || value.text !== expected) {
      violations.push({
        path: filePath,
        kind: "registry_admission",
        message: `${constantName} must be exact ${expected}`,
        offset: initializer?.getStart(sourceFile) ?? 0,
      });
    }
  }

  const functionNode = findFunction(sourceFile, "resolveApprovedAcpLaunch");
  const parameter = functionNode?.parameters[0]?.name;
  if (!functionNode?.body || !parameter || !ts.isIdentifier(parameter)) {
    addMissing(
      violations,
      filePath,
      "registry_admission",
      "resolveApprovedAcpLaunch must directly receive the submitted name",
    );
    return;
  }
  const rawName = parameter.text;
  const bodyStart = functionNode.body.getStart(sourceFile);
  const body = functionNode.body.getText(sourceFile);
  const listMatch = new RegExp(
    `candidateRegistry\\.list\\(\\)`,
  ).exec(body);
  const listedMembership = new RegExp(
    `listed\\.includes\\(${escapeRegExp(rawName)}\\)`,
  ).exec(body);
  const catalogMembership = new RegExp(
    `hasOwnProperty\\.call\\(\\s*APPROVED_ACP_LAUNCHES,\\s*${escapeRegExp(rawName)}\\s*,?\\s*\\)`,
  ).exec(body);
  const resolveMatches = [
    ...body.matchAll(/candidateRegistry\.resolve\s*\(([^)]*)\)/g),
  ];
  const exactResolve =
    resolveMatches.length === 1 &&
    resolveMatches[0]![1]!.trim() === rawName;
  const resolveOffset = resolveMatches[0]?.index ?? -1;
  const rejectingGuard = new RegExp(
    `if\\s*\\(\\s*!listed\\.includes\\(${escapeRegExp(rawName)}\\)\\s*\\|\\|\\s*!approved\\s*\\)\\s*\\{\\s*throw\\b`,
    "s",
  ).exec(body);
  if (
    !listMatch ||
    !listedMembership ||
    !catalogMembership ||
    !rejectingGuard ||
    !exactResolve ||
    listMatch.index >= resolveOffset ||
    listedMembership.index >= resolveOffset ||
    catalogMembership.index >= resolveOffset
  ) {
    violations.push({
      path: filePath,
      kind: "registry_admission",
      message:
        "the unchanged submitted name must pass registry.list and approved-catalog membership before exactly one registry.resolve call",
      offset: bodyStart + Math.max(0, resolveOffset),
    });
  }

  const allowedTrimComparison = new RegExp(
    `${escapeRegExp(rawName)}\\s*!==\\s*${escapeRegExp(rawName)}\\.trim\\(\\)`,
    "g",
  );
  const withoutValidation = body.replace(allowedTrimComparison, "");
  const normalization = new RegExp(
    `(?:${escapeRegExp(rawName)}\\.(?:trim|toLowerCase|toUpperCase|normalize|replace)\\s*\\(|normalizeAgentName\\s*\\(|normalizeName\\s*\\()`,
  ).exec(withoutValidation);
  if (normalization) {
    violations.push({
      path: filePath,
      kind: "registry_admission",
      message: "registry admission must not normalize or substitute the submitted name",
      offset: bodyStart + normalization.index,
    });
  }

  const requiredLaunchFragments = [
    "require.resolve(CODEX_ACP_FRONTEND_PACKAGE)",
    "process.execPath",
    "createAgentRegistry({",
    "overrides:",
    "codex:",
    "sameArgv(resolved, expected)",
    "readApprovedAcpFrontendArtifact",
    'createHash("sha256")',
    'targetNativeCli: "codex"',
    "left.targetNativeCli === right.targetNativeCli",
    "APPROVED_ACP_NATIVE_AUTHENTICATION",
    'statusArgs: Object.freeze(["login", "status"])',
    'loginGuidance: "codex login"',
    "resolveApprovedAcpNativeAuthentication",
  ];
  for (const fragment of requiredLaunchFragments) {
    if (!source.includes(fragment)) {
      violations.push({
        path: filePath,
        kind: "registry_admission",
        message: `installed Codex argv resolution is missing ${fragment}`,
        offset: 0,
      });
    }
  }

  for (const expression of [
    /["']npx["']/,
    /\bshell\s*:\s*true\b/,
    /\bexec(?:File|Sync)?\s*\(/,
    /\bspawn\s*\(/,
    /\b(?:rawCommand|raw_command)\b/i,
  ]) {
    const match = expression.exec(source);
    if (match) {
      violations.push({
        path: filePath,
        kind: "raw_command",
        message: "registry launches must not use npx, shells, raw commands, or fallback execution",
        offset: match.index,
      });
    }
  }
}

function scanOfficialClient(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  const filePath = `${ACP_DIRECTORY}/client.ts`;
  const source = sources.get(filePath);
  if (!source) {
    addMissing(
      violations,
      filePath,
      "official_client",
      "official ACP client owner is required",
    );
    return;
  }

  for (const fragment of [
    "client(",
    "PROTOCOL_VERSION",
    "methods.agent.initialize",
    "methods.agent.session.new",
    "methods.agent.session.resume",
    "methods.agent.session.setConfigOption",
    "methods.agent.session.prompt",
    "methods.agent.session.cancel",
    "if (values.length === 0)",
    "this.#configSelections = sortedConfigOptions(input.launch.configOptions)",
    "this.#initialConfigOptions = validateConfigOptions(",
    "this.#lastPromptEvent = event",
    'event?.kind === "usage"',
    "readonly startSubprocess: AcpSubprocessStarter",
    "readonly activatePrompt:",
    "subprocess = await input.startSubprocess(input.launch",
    'phase = "prompt_activation"',
    "await input.activatePrompt({ sessionId })",
    "readonly beginPromptTransmission:",
    'phase = "prompt_transmission"',
    "await input.beginPromptTransmission({ sessionId })",
    "promptTransmitted = true",
    "readonly closePrompt:",
    "await input.closePrompt(spawnFailure)",
    "await input.closePrompt(closureOutcome)",
    "cancellationNotificationError",
    "DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS",
    'acpClient.state === "prompt_active"',
    "cancellationForceTimer = setTimeout",
    "AcpSubprocessTeardownOutcome",
    "return { ...closureOutcome, closureError, teardown, stderr }",
  ]) {
    if (!source.includes(fragment)) {
      violations.push({
        path: filePath,
        kind: "official_client",
        message: `official modern ACP client surface is missing ${fragment}`,
        offset: 0,
      });
    }
  }

  for (const expression of [
    /\bClientSideConnection\b/,
    /methods\.agent\.session\.(?:load|fork)\b/,
    /["']session\/(?:load|fork)["']/,
    /\b(?:loadSession|forkSession)\s*\(/,
    /\bspawnAcpSubprocess\s*\(/,
  ]) {
    const match = expression.exec(source);
    if (match) {
      violations.push({
        path: filePath,
        kind: "official_client",
        message:
          "deprecated session methods and a hard-coded local ACP spawn are forbidden",
        offset: match.index,
      });
    }
  }

  if (
    !/await input\.beginPromptTransmission\(\{ sessionId \}\);\s*promptTransmitted = true;\s*if \(input\.signal\?\.aborted\)[\s\S]*?phase = "prompt";\s*const settlement = await acpClient\.prompt\(input\.request\.message\);/.test(
      source,
    )
  ) {
    violations.push({
      path: filePath,
      kind: "official_client",
      message:
        "durable prompt transmission must precede the transmitted flag, cancellation recheck, and sole ACP prompt request",
      offset: Math.max(0, source.indexOf("beginPromptTransmission")),
    });
  }

  const processPath = `${ACP_DIRECTORY}/process.ts`;
  const processSource = sources.get(processPath);
  const localOnlyStarter = processSource?.match(
    /export\s+function\s+spawnAcpSubprocess\b/,
  );
  if (localOnlyStarter) {
    violations.push({
      path: processPath,
      kind: "official_client",
      message:
        "a public local-only ACP subprocess starter is forbidden; execution must enter through target preparation",
      offset: localOnlyStarter.index,
    });
  }

  const sourceFile = parseSource(filePath, source);
  const officialSdkImports = sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@agentclientprotocol/sdk",
  );
  const importedSdkNames = new Set<string>();
  for (const declaration of officialSdkImports) {
    const bindings = declaration.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly && !element.propertyName) {
          importedSdkNames.add(element.name.text);
        }
      }
    }
  }
  for (const requiredImport of ["PROTOCOL_VERSION", "client", "methods"]) {
    if (!importedSdkNames.has(requiredImport)) {
      violations.push({
        path: filePath,
        kind: "official_client",
        message: `client.ts must import ${requiredImport} directly from the official ACP SDK`,
        offset: 0,
      });
    }
  }
  const capabilities: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node) === "clientCapabilities"
    ) {
      capabilities.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (capabilities.length !== 1) {
    addMissing(
      violations,
      filePath,
      "client_capability",
      "initialize must advertise exactly one explicit clientCapabilities object",
    );
  } else {
    const initializer = unwrapExpression(capabilities[0]!.initializer);
    if (!ts.isObjectLiteralExpression(initializer)) {
      violations.push({
        path: filePath,
        kind: "client_capability",
        message:
          "Paperclip must advertise no filesystem, terminal, or experimental plan capability",
        offset: capabilities[0]!.getStart(sourceFile),
      });
    } else {
      const sessionProperty = initializer.properties.find(
        (property) => propertyName(property) === "session",
      );
      const sessionInitializer =
        sessionProperty && ts.isPropertyAssignment(sessionProperty)
          ? unwrapExpression(sessionProperty.initializer)
          : undefined;
      const configProperty =
        sessionInitializer && ts.isObjectLiteralExpression(sessionInitializer)
          ? sessionInitializer.properties.find(
              (property) => propertyName(property) === "configOptions",
            )
          : undefined;
      const configInitializer =
        configProperty && ts.isPropertyAssignment(configProperty)
          ? unwrapExpression(configProperty.initializer)
          : undefined;
      const booleanProperty =
        configInitializer && ts.isObjectLiteralExpression(configInitializer)
          ? configInitializer.properties.find(
              (property) => propertyName(property) === "boolean",
            )
          : undefined;
      const booleanInitializer =
        booleanProperty && ts.isPropertyAssignment(booleanProperty)
          ? unwrapExpression(booleanProperty.initializer)
          : undefined;
      const exactSessionConfigCapability =
        initializer.properties.length === 1 &&
        sessionInitializer != null &&
        ts.isObjectLiteralExpression(sessionInitializer) &&
        sessionInitializer.properties.length === 1 &&
        configInitializer != null &&
        ts.isObjectLiteralExpression(configInitializer) &&
        configInitializer.properties.length === 1 &&
        booleanInitializer != null &&
        ts.isObjectLiteralExpression(booleanInitializer) &&
        booleanInitializer.properties.length === 0;
      if (!exactSessionConfigCapability) {
        violations.push({
          path: filePath,
          kind: "client_capability",
          message:
            "Paperclip must advertise only stable session config boolean support, with no filesystem, terminal, or plan capability",
          offset: capabilities[0]!.getStart(sourceFile),
        });
      }
    }
  }
  for (const expression of [
    /methods\.client\.fs\b/,
    /methods\.client\.terminal\b/,
    /clientCapabilities\s*:\s*[^\n]*(?:plan|terminal|fs|fileSystem)/i,
  ]) {
    const match = expression.exec(source);
    if (match) {
      violations.push({
        path: filePath,
        kind: "client_capability",
        message: "client filesystem, terminal, and plan support must not be advertised or implemented",
        offset: match.index,
      });
    }
  }
}

function scanStreamBridge(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  const filePath = `${ACP_DIRECTORY}/process.ts`;
  const source = sources.get(filePath);
  if (!source) {
    addMissing(
      violations,
      filePath,
      "stream_bridge",
      "ACP subprocess stream owner is required",
    );
    return;
  }
  for (const [fragment, message] of [
    ["Writable.toWeb(child.stdin)", "Writable.toWeb(child.stdin) is required"],
    ["Readable.toWeb(child.stdout)", "Readable.toWeb(child.stdout) is required"],
    ["ndJsonStream(output, input)", "ndJsonStream(output, input) is required in output/input order"],
    ['stdio: ["pipe", "pipe", "pipe"]', "piped subprocess stdio is required"],
  ] as const) {
    if (!source.includes(fragment)) {
      violations.push({
        path: filePath,
        kind: "stream_bridge",
        message,
        offset: 0,
      });
    }
  }

  const sourceFile = parseSource(filePath, source);
  const sdkImport = sourceFile.statements.find(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@agentclientprotocol/sdk" &&
      !!statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          !element.propertyName &&
          element.name.text === "ndJsonStream",
      ),
  );
  if (!sdkImport) {
    addMissing(
      violations,
      filePath,
      "stream_bridge",
      "process.ts must import ndJsonStream directly from the official ACP SDK",
    );
  }
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const text = node.getText(sourceFile);
      if (
        /(?:Readable|Writable)\.toWeb|child\.(?:stdin|stdout)|(?:Readable|Writable)Stream/.test(
          text,
        )
      ) {
        violations.push({
          path: filePath,
          kind: "stream_bridge",
          message: "Node-to-WHATWG stream typing must not use a direct or double cast",
          offset: node.getStart(sourceFile),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const expression of [
    /ndJsonStream\s*\(\s*child\.(?:stdin|stdout)/,
    /ndJsonStream\s*\([^,]+,\s*child\.(?:stdin|stdout)/,
    /\bas\s+unknown\s+as\b/,
    /\bshell\s*:\s*true\b/,
    /["']npx["']/,
  ]) {
    const match = expression.exec(source);
    if (match) {
      violations.push({
        path: filePath,
        kind: "stream_bridge",
        message: "ACP stdio must use the direct no-shell WHATWG bridge without casts",
        offset: match.index,
      });
    }
  }
}

function scanToolOutput(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  const filePath = `${ACP_DIRECTORY}/tool-output.ts`;
  const source = sources.get(filePath);
  if (!source) {
    addMissing(
      violations,
      filePath,
      "tool_output",
      "canonical ACP tool-output normalization is required",
    );
    return;
  }

  for (const [fragment, message] of [
    [
      "export function normalizeAcpToolOutput",
      "the canonical ACP tool-output normalizer must be exported",
    ],
    [
      'typeof input.rawOutput === "string"',
      "present string raw output must be preserved exactly",
    ],
    [
      "canonicalJson(input.rawOutput)",
      "present non-string raw output must use canonical JSON",
    ],
    [
      'content.map((entry) => entry.content.text).join("\\n")',
      "ordered all-text fallback output must be newline-joined",
    ],
    [
      "canonicalJson(content, true)",
      "mixed ACP content must use metadata-stripped canonical JSON",
    ],
    [
      'if (!content || content.length === 0) return "";',
      "absent or empty ACP content must yield the empty string",
    ],
    [
      "Number.isFinite(value)",
      "non-finite JSON numbers must be rejected",
    ],
    [
      "Object.keys(record).sort(codeUnitCompare)",
      "canonical JSON object keys must use code-unit ordering",
    ],
  ] as const) {
    if (!source.includes(fragment)) {
      violations.push({
        path: filePath,
        kind: "tool_output",
        message,
        offset: 0,
      });
    }
  }
}

function scanPlanAndProviderBoundary(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  const eventsPath = `${ACP_DIRECTORY}/events.ts`;
  const events = sources.get(eventsPath);
  if (!events) {
    addMissing(
      violations,
      eventsPath,
      "experimental_plan",
      "provider-neutral ACP update mapper is required",
    );
  } else {
    if (!/case\s+["']plan["']\s*:/.test(events)) {
      addMissing(
        violations,
        eventsPath,
        "experimental_plan",
        "stable anonymous plan replacement handling is required",
      );
    }
    const rejection =
      /case\s+["']plan_update["']\s*:\s*case\s+["']plan_removed["']\s*:\s*throw\s+new\s+InvalidAcpSessionUpdate/s;
    if (!rejection.test(events)) {
      violations.push({
        path: eventsPath,
        kind: "experimental_plan",
        message: "experimental plan_update and plan_removed must be rejected together",
        offset: Math.max(0, events.indexOf("plan_update")),
      });
    }
  }

  const requiredSet = new Set(REQUIRED_ACP_PRODUCTION_FILES);
  for (const [filePath, source] of sources) {
    if (
      !filePath.startsWith(`${ACP_DIRECTORY}/`) ||
      isTestOrFixturePath(filePath) ||
      !SOURCE_EXTENSIONS.has(path.extname(filePath))
    ) {
      continue;
    }
    if (!requiredSet.has(filePath)) {
      violations.push({
        path: filePath,
        kind: "provider_parser",
        message: "unexpected production file in the closed canonical ACP directory",
        offset: 0,
      });
    }
    const deprecatedClient = /\bClientSideConnection\b/.exec(source);
    if (deprecatedClient) {
      violations.push({
        path: filePath,
        kind: "official_client",
        message: "deprecated ClientSideConnection is forbidden in the canonical ACP directory",
        offset: deprecatedClient.index,
      });
    }
    const forbiddenContinuation =
      /methods\.agent\.session\.(?:load|fork)\b|["']session\/(?:load|fork)["']/.exec(
        source,
      );
    if (forbiddenContinuation) {
      violations.push({
        path: filePath,
        kind: "official_client",
        message: "session load/fork is forbidden in the canonical ACP directory",
        offset: forbiddenContinuation.index,
      });
    }
    if (filePath.endsWith("/agent-registry.ts")) continue;
    for (const pattern of FORBIDDEN_PROVIDER_PARSER_PATTERNS) {
      const match = pattern.expression.exec(source);
      if (match) {
        violations.push({
          path: filePath,
          kind: "provider_parser",
          message: pattern.message,
          offset: match.index,
        });
      }
    }
    const backendSwitch = /switch\s*\(\s*(?:provider|backend|adapter(?:Type)?)\b/i.exec(
      source,
    );
    if (backendSwitch) {
      violations.push({
        path: filePath,
        kind: "provider_parser",
        message: "the canonical ACP implementation must not branch by provider/backend",
        offset: backendSwitch.index,
      });
    }
  }
}

function scanExecutionTargetBoundary(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  const filePath = `${ACP_DIRECTORY}/execution-target.ts`;
  const source = sources.get(filePath);
  if (!source) {
    addMissing(
      violations,
      filePath,
      "execution_target",
      "canonical execution-target ACP subprocess preparation is required",
    );
    return;
  }
  for (const [fragment, message] of [
    [
      "prepareAcpExecutionTargetSubprocess",
      "one canonical execution-target ACP subprocess factory is required",
    ],
    [
      "spawnPreparedAcpSubprocess",
      "target preparation must use the common official-SDK subprocess bridge",
    ],
    [
      "buildSshSpawnTarget",
      "SSH ACP launch must use the existing SSH execution target",
    ],
    [
      "buildLocalProcessSandboxSpawnTarget",
      "confined local ACP launch must use the existing local sandbox target",
    ],
    [
      "startAdapterExecutionTargetProcessSessionBridge",
      "sandbox/plugin ACP launch must use the existing process-session bridge",
    ],
    [
      "materializeAdapterExecutionTargetTextFiles",
      "invocation files must be materialized on the selected execution target",
    ],
    [
      "readApprovedAcpFrontendArtifact",
      "the pinned worker frontend bytes must be verified before materialization",
    ],
    [
      "resolveTargetNodeExecutable",
      "the execution target must resolve one exact absolute Node runtime",
    ],
    [
      "resolveAdapterExecutionTargetExecutable",
      "the execution target must resolve the immutable target-native selector",
    ],
    [
      "resolveAdapterExecutionTargetNativeIdentityEnvironment",
      "local frontend and readiness must share native identity roots",
    ],
    [
      "CODEX_PATH: input.targetNativeExecutable",
      "the prepared frontend must receive only the internally resolved native path",
    ],
    [
      "requiredExecutables: [input.targetNativeExecutable]",
      "local confinement must expose the target-native executable closure",
    ],
    [
      "requiredIdentityEnvironment: input.targetNativeIdentityEnvironment",
      "local confinement must fail closed around native identity roots",
    ],
    [
      "Object.keys(launch.environment).length !== 0",
      "productive launch environment must remain empty",
    ],
    [
      "verifyTargetFrontendArtifact",
      "the materialized frontend bytes must be verified on the target",
    ],
    [
      "targetArgs: [targetFrontendEntrypoint]",
      "the admitted launch must lower to the target-local frontend",
    ],
    [
      "launch.cwd !== targetCwd",
      "target-visible ACP cwd must be fenced from host wrapper cwd",
    ],
    [
      "launch.additionalDirectories",
      "target-visible ACP additional directories must be fenced",
    ],
    [
      "ACP execution-target cleanup timeout",
      "execution-target cleanup must be bounded",
    ],
    [
      "async function finishWithCleanup",
      "process reap and target cleanup must share one teardown boundary",
    ],
  ] as const) {
    if (!source.includes(fragment)) {
      violations.push({
        path: filePath,
        kind: "execution_target",
        message,
        offset: 0,
      });
    }
  }
  const forbiddenApprovedLaunchRewrite =
    /launch\.launch\s*=|launchIdentity\.(?:command|args|registryName)\s*=/g.exec(
      source,
    );
  if (forbiddenApprovedLaunchRewrite) {
    violations.push({
      path: filePath,
      kind: "execution_target",
      message: "execution-target preparation must not mutate approved launch identity",
      offset: forbiddenApprovedLaunchRewrite.index,
    });
  }
  const workerLocalExecution =
    /(?:launch\.launch|approvedLaunch|input\.sourceLaunch)\.(?:command|args)/.exec(
      source,
    );
  if (workerLocalExecution) {
    violations.push({
      path: filePath,
      kind: "execution_target",
      message: "worker-local approved argv cannot become execution-target argv",
      offset: workerLocalExecution.index,
    });
  }
  const injectableTransport =
    /AcpExecutionTargetSubprocessDependencies|defaultDependencies|dependencies\.(?:spawn|buildSsh|buildLocalSandbox|startCommandManagedBridge|materializeFiles)/.exec(
      source,
    );
  if (injectableTransport) {
    violations.push({
      path: filePath,
      kind: "execution_target",
      message: "canonical execution-target mechanics cannot be replaced through a production injection seam",
      offset: injectableTransport.index,
    });
  }

  const runToolsPath = `${ACP_DIRECTORY}/run-tools.ts`;
  const runTools = sources.get(runToolsPath);
  if (
    !runTools?.includes("input.nodeExecutable") ||
    runTools.includes("process.execPath")
  ) {
    violations.push({
      path: runToolsPath,
      kind: "execution_target",
      message: "run-tools MCP must use the exact execution-target Node path",
      offset: 0,
    });
  }
}

function scanPinnedCodexAcpConformance(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  const conformance = sources.get(CODEX_ACP_CONFORMANCE_TEST);
  if (!conformance) {
    addMissing(
      violations,
      CODEX_ACP_CONFORMANCE_TEST,
      "installed_runtime",
      "the distinct real codex-acp conformance suite is required",
    );
  } else {
    for (const [fragment, message] of [
      [
        'real codex-acp 1.1.7 target conformance',
        "the suite must name the exact installed frontend version",
      ],
      [
        "prepareAcpExecutionTargetSubprocess",
        "real frontend conformance must cross execution-target preparation",
      ],
      [
        "executeAcpSubprocessPrompt",
        "real frontend conformance must cross the canonical prompt lifecycle",
      ],
      [
        'resolveApprovedAcpLaunch("codex")',
        "real frontend conformance must use the immutable approved launch",
      ],
      [
        "codex-app-server-conformance.mjs",
        "real frontend conformance must use the controlled native app-server",
      ],
      [
        'start: { kind: "new" }',
        "real frontend conformance must cover session/new",
      ],
      [
        'kind: "resume"',
        "real frontend conformance must cover exact session/resume",
      ],
      [
        'configId: "reasoning_effort"',
        "real frontend conformance must cover ordered session configuration",
      ],
      [
        "paperclip_capability_server",
        "real frontend conformance must verify exact MCP replacement",
      ],
      [
        'requestTrace(execution.trace, "initialize")',
        "real frontend conformance must inspect native initialize",
      ],
      [
        'requestTrace(execution.trace, "turn/start")',
        "real frontend conformance must inspect native prompt start",
      ],
      [
        'kind: "message_chunk"',
        "real frontend conformance must observe normalized streamed updates",
      ],
      [
        'kind: "usage"',
        "real frontend conformance must observe terminal usage",
      ],
      [
        'settlement: { stopReason: "end_turn" }',
        "real frontend conformance must cover normal stop settlement",
      ],
      [
        'requestTrace(execution.trace, "turn/interrupt")',
        "real frontend conformance must prove native cancellation forwarding",
      ],
      [
        "without an immediately preceding terminal usage update",
        "real frontend cancellation must preserve incomplete accounting",
      ],
      [
        "targetFrontendEntrypoint",
        "real frontend conformance must prove target cleanup",
      ],
    ] as const) {
      if (!conformance.includes(fragment)) {
        violations.push({
          path: CODEX_ACP_CONFORMANCE_TEST,
          kind: "installed_runtime",
          message,
          offset: 0,
        });
      }
    }
  }

  const fixture = sources.get(CODEX_APP_SERVER_CONFORMANCE_FIXTURE);
  if (!fixture) {
    addMissing(
      violations,
      CODEX_APP_SERVER_CONFORMANCE_FIXTURE,
      "installed_runtime",
      "the controlled native Codex app-server fixture is required",
    );
    return;
  }
  for (const method of [
    "initialize",
    "thread/start",
    "thread/resume",
    "turn/start",
    "thread/tokenUsage/updated",
    "turn/interrupt",
    "turn/completed",
    "thread/unsubscribe",
  ]) {
    if (!fixture.includes(`"${method}"`)) {
      violations.push({
        path: CODEX_APP_SERVER_CONFORMANCE_FIXTURE,
        kind: "installed_runtime",
        message: `controlled native fixture must implement ${method}`,
        offset: 0,
      });
    }
  }
}

export function scanAcpRegistryAdmissionFiles(
  files: readonly AcpRegistryAdmissionFile[],
): AcpRegistryAdmissionViolation[] {
  const sources = new Map(
    files.map((file) => [normalizePath(file.path), file.source]),
  );
  const violations: MutableViolation[] = [];
  for (const filePath of REQUIRED_ACP_PRODUCTION_FILES) {
    if (!sources.has(filePath)) {
      addMissing(
        violations,
        filePath,
        "official_client",
        "required canonical ACP production file is missing",
      );
    }
  }
  scanDependencyPins(sources, violations);
  scanAcpxImports(sources, violations);
  scanRegistryOwner(sources, violations);
  scanOfficialClient(sources, violations);
  scanStreamBridge(sources, violations);
  scanToolOutput(sources, violations);
  scanExecutionTargetBoundary(sources, violations);
  scanPlanAndProviderBoundary(sources, violations);
  scanPinnedCodexAcpConformance(sources, violations);
  return violations
    .map((violation) => finalizedViolation(violation, sources))
    .sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      left.message.localeCompare(right.message),
    );
}

async function walkSources(
  absoluteDirectory: string,
  repositoryRoot: string,
  files: AcpRegistryAdmissionFile[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(absoluteDirectory, entry.name);
    const relative = normalizePath(path.relative(repositoryRoot, absolute));
    if (entry.isDirectory()) {
      if (!new Set(["node_modules", "dist", "generated"]).has(entry.name)) {
        await walkSources(absolute, repositoryRoot, files);
      }
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }
    files.push({ path: relative, source: await fs.readFile(absolute, "utf8") });
  }
}

export async function listAcpRegistryAdmissionFiles(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<AcpRegistryAdmissionFile[]> {
  const files: AcpRegistryAdmissionFile[] = [];
  for (const root of PRODUCTION_SCAN_ROOTS) {
    await walkSources(path.resolve(repositoryRoot, root), repositoryRoot, files);
  }
  for (const filePath of [ADAPTER_UTILS_MANIFEST, ROOT_MANIFEST, LOCKFILE]) {
    files.push({
      path: filePath,
      source: await fs.readFile(path.resolve(repositoryRoot, filePath), "utf8"),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function packageManifestForResolvedEntry(
  resolvedEntry: string,
  packageName: string,
): Promise<{ name: string; version: string }> {
  const visit = async (directory: string): Promise<{ name: string; version: string }> => {
    const candidate = path.join(directory, "package.json");
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === packageName && typeof parsed.version === "string") {
        return { name: parsed.name, version: parsed.version };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Cannot locate installed manifest for ${packageName}`);
    }
    return visit(parent);
  };
  return visit(path.dirname(resolvedEntry));
}

/**
 * Test model for the closed admission rule. Resolution is observably called
 * only after the submitted bytes independently belong to both sets.
 */
export function resolveExactRegistryCandidate<T>(input: {
  readonly submittedName: string;
  readonly registryNames: readonly string[];
  readonly approvedNames: readonly string[];
  readonly resolve: (unchangedName: string) => T;
}): T {
  if (
    !input.registryNames.includes(input.submittedName) ||
    !input.approvedNames.includes(input.submittedName)
  ) {
    throw new Error("ACP registry name is not admitted");
  }
  return input.resolve(input.submittedName);
}

async function inspectInstalledRuntime(
  repositoryRoot: string,
): Promise<AcpRegistryAdmissionViolation[]> {
  const violations: AcpRegistryAdmissionViolation[] = [];
  const add = (message: string): void => {
    violations.push({
      path: `${ACP_DIRECTORY}/agent-registry.ts`,
      line: 1,
      column: 1,
      kind: "installed_runtime",
      message,
    });
  };
  try {
    const anchoredRequire = createRequire(
      pathToFileURL(path.resolve(repositoryRoot, ADAPTER_UTILS_MANIFEST)),
    );
    const resolvedEntries = {
      "@agentclientprotocol/codex-acp": anchoredRequire.resolve(
        "@agentclientprotocol/codex-acp",
      ),
      "@agentclientprotocol/sdk": anchoredRequire.resolve(
        "@agentclientprotocol/sdk",
      ),
      acpx: anchoredRequire.resolve("acpx/runtime"),
    } as const;
    for (const [packageName, expectedVersion] of Object.entries(
      EXACT_DEPENDENCIES,
    )) {
      const installed = await packageManifestForResolvedEntry(
        resolvedEntries[packageName as keyof typeof resolvedEntries],
        packageName,
      );
      if (installed.version !== expectedVersion) {
        add(
          `installed ${packageName} must be ${expectedVersion}, found ${installed.version}`,
        );
      }
    }

    const moduleUrl = pathToFileURL(
      path.resolve(repositoryRoot, `${ACP_DIRECTORY}/agent-registry.ts`),
    ).href;
    const registryModule = (await import(moduleUrl)) as RegistryModule;
    const names = [...registryModule.listApprovedAcpLaunchNames()];
    if (names.length !== 1 || names[0] !== "codex") {
      add("runtime approved launch catalog must contain only exact codex");
    }

    const expectedArgv = [
      process.execPath,
      resolvedEntries["@agentclientprotocol/codex-acp"],
    ];
    let exactResolveCalls = 0;
    const exactLaunch = registryModule.resolveApprovedAcpLaunch("codex", {
      list: () => ["codex"],
      resolve: (name) => {
        exactResolveCalls += 1;
        if (name !== "codex") throw new Error("submitted name was rewritten");
        return expectedArgv;
      },
    });
    if (
      exactResolveCalls !== 1 ||
      exactLaunch.targetNativeCli !== "codex" ||
      exactLaunch.command !== expectedArgv[0] ||
      exactLaunch.args.length !== 1 ||
      exactLaunch.args[0] !== expectedArgv[1] ||
      exactLaunch.frontendPackage !== "@agentclientprotocol/codex-acp" ||
      exactLaunch.frontendVersion !== "1.1.7" ||
      exactLaunch.frontendDigest !== "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a"
    ) {
      add("exact codex admission must resolve the installed immutable frontend argv");
    }

    const nativeAuthentication =
      registryModule.resolveApprovedAcpNativeAuthentication(exactLaunch);
    if (
      nativeAuthentication.statusArgs.length !== 2 ||
      nativeAuthentication.statusArgs[0] !== "login" ||
      nativeAuthentication.statusArgs[1] !== "status" ||
      nativeAuthentication.loginGuidance !== "codex login"
    ) {
      add("exact codex admission must own its native authentication contract");
    }

    const installedLaunch = registryModule.resolveApprovedAcpLaunch("codex");
    if (
      installedLaunch.command !== expectedArgv[0] ||
      installedLaunch.targetNativeCli !== "codex" ||
      installedLaunch.args.length !== 1 ||
      installedLaunch.args[0] !== expectedArgv[1]
    ) {
      add("the real ACPX registry override did not resolve the installed Codex argv");
    }
    const artifact = await registryModule.readApprovedAcpFrontendArtifact(
      installedLaunch,
    );
    if (
      artifact.sha256 !== installedLaunch.frontendDigest ||
      createHash("sha256").update(artifact.bytes).digest("hex") !==
        installedLaunch.frontendDigest ||
      artifact.targetFileName !== "codex-acp-1.1.7.mjs"
    ) {
      add("installed Codex frontend bytes must match the immutable catalog digest");
    }

    for (const submittedName of [
      "unknown",
      " codex",
      "codex ",
      "Codex",
      "codex!",
      "code",
    ]) {
      let resolveCalls = 0;
      let rejected = false;
      try {
        registryModule.resolveApprovedAcpLaunch(submittedName, {
          list: () => ["codex", submittedName],
          resolve: () => {
            resolveCalls += 1;
            return expectedArgv;
          },
        });
      } catch {
        rejected = true;
      }
      if (!rejected || resolveCalls !== 0) {
        add(`${JSON.stringify(submittedName)} must reject before registry.resolve`);
      }
    }
  } catch (error) {
    add(
      `installed ACP registry/runtime inspection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return violations;
}

export async function checkAcpRegistryAdmission(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<AcpRegistryAdmissionViolation[]> {
  const files = await listAcpRegistryAdmissionFiles(repositoryRoot);
  const staticViolations = scanAcpRegistryAdmissionFiles(files);
  if (staticViolations.length > 0) return staticViolations;
  return inspectInstalledRuntime(repositoryRoot);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const violations = await checkAcpRegistryAdmission();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `${violation.path}:${violation.line}:${violation.column} [${violation.kind}] ${violation.message}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      "ACP registry admission and official-SDK subprocess boundary check passed.",
    );
  }
}
