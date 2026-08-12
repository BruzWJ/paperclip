import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACPX_RUNTIME_DIRECTORY = "packages/adapter-utils/src/acpx-runtime";
const ADAPTER_UTILS_MANIFEST = "packages/adapter-utils/package.json";
const ROOT_MANIFEST = "package.json";
const LOCKFILE = "pnpm-lock.yaml";
const REGISTRY_PATH = `${ACPX_RUNTIME_DIRECTORY}/agent-registry.ts`;
const DISCOVERY_PATH = `${ACPX_RUNTIME_DIRECTORY}/acpx-discovery.ts`;
const RUNTIME_EXECUTION_PATH = `${ACPX_RUNTIME_DIRECTORY}/acpx-runtime-execution.ts`;
const RUNTIME_INVOCATION_PATH = `${ACPX_RUNTIME_DIRECTORY}/acpx-runtime-invocation.ts`;
const RUNTIME_READINESS_PATH = `${ACPX_RUNTIME_DIRECTORY}/acpx-runtime-readiness.ts`;
const SERVER_CATALOG_PATH = "apps/server/src/adapters/acpx-catalog.ts";
const SERVER_REGISTRY_PATH = "apps/server/src/adapters/registry.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const EXACT_RUNTIME_DEPENDENCIES = Object.freeze({
  acpx: "0.13.0",
});
const EXACT_FIXTURE_DEV_DEPENDENCIES = Object.freeze({
  "@agentclientprotocol/sdk": "1.3.0",
});
const RETIRED_STATIC_CATALOG_MARKERS = Object.freeze([
  "APPROVED_ACP_LAUNCHES",
  "BUILTIN_ADAPTER_CATALOG",
  "resolveApprovedAcpLaunch",
  "listApprovedAcpLaunchNames",
]);
const RAW_ACP_INVOCATION_SYMBOLS = Object.freeze([
  "executeAcpSubprocessPrompt",
  "prepareAcpExecutionTargetSubprocess",
  "spawnPreparedAcpSubprocess",
  "createInitializeOnlyClient",
  "PaperclipAcpClient",
  "AcpSubprocess",
  "AcpSubprocessLaunch",
  "AcpSubprocessStarter",
  "AcpSubprocessHostLaunch",
  "resolveAcpRegistryLaunch",
  "sameAcpRegistryLaunch",
  "AcpRegistryLaunch",
]);
const RAW_ACP_INVOCATION_MODULE =
  /^@paperclipai\/adapter-utils\/acp-subprocess\/(?:client|execution-target|process)$/;
const PROVIDER_PARSER_PATTERNS = Object.freeze([
  {
    expression:
      /\b(?:parse|extract|normalize)(?:Codex|Claude|Gemini|OpenCode|Grok|Hermes|Cursor|Pi|Kimi|Qwen)\w*/i,
    message:
      "provider-specific codecs are forbidden in the canonical ACP directory",
  },
  {
    expression:
      /\b(?:Codex|Claude|Gemini|OpenCode|Grok|Hermes|Cursor|Pi|Kimi|Qwen)\w*(?:Parser|Extractor|Codec|EventMapper)\b/i,
    message:
      "provider-specific codecs are forbidden in the canonical ACP directory",
  },
  {
    expression: /\bjsonl\b/i,
    message:
      "JSONL provider parsing is forbidden in the canonical ACP directory",
  },
  {
    expression:
      /from\s+["'](?:openai|ai|@anthropic-ai\/sdk|@google\/generative-ai)["']/,
    message:
      "provider/model SDK imports are forbidden in the canonical ACP directory",
  },
  {
    expression: /from\s+["']@agentclientprotocol\/sdk["']/,
    message:
      "production Paperclip ACP code must consume ACPX public runtime types only",
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
    | "discovery"
    | "catalog"
    | "runtime_execution"
    | "runtime_invocation"
    | "runtime_readiness"
    | "raw_invocation"
    | "tool_output"
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
}

interface RegistryModule {
  loadAcpxAgentRegistry(cwd: string): Promise<RegistryLike>;
  listAcpRegistryAgentNames(registry: RegistryLike): readonly string[];
  assertAcpRegistryAgentName(
    requestedName: string,
    registry: RegistryLike,
  ): string;
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

function addMissing(
  violations: MutableViolation[],
  path: string,
  kind: AcpRegistryAdmissionViolation["kind"],
  message: string,
): void {
  violations.push({ path, kind, message, offset: 0 });
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

function requireFragments(input: {
  readonly sources: ReadonlyMap<string, string>;
  readonly violations: MutableViolation[];
  readonly path: string;
  readonly kind: AcpRegistryAdmissionViolation["kind"];
  readonly contract: string;
  readonly fragments: readonly string[];
}): string {
  const source = input.sources.get(input.path);
  if (source === undefined) {
    addMissing(
      input.violations,
      input.path,
      input.kind,
      `${input.contract} is required`,
    );
    return "";
  }
  for (const fragment of input.fragments) {
    if (!source.includes(fragment)) {
      input.violations.push({
        path: input.path,
        kind: input.kind,
        message: `${input.contract} is missing ${JSON.stringify(fragment)}`,
        offset: 0,
      });
    }
  }
  return source;
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
    devDependencies?: Record<string, unknown>;
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
    EXACT_RUNTIME_DEPENDENCIES,
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
  for (const [packageName, expectedVersion] of Object.entries(
    EXACT_FIXTURE_DEV_DEPENDENCIES,
  )) {
    const actual = manifest.devDependencies?.[packageName];
    if (actual !== expectedVersion) {
      violations.push({
        path: ADAPTER_UTILS_MANIFEST,
        kind: "dependency",
        message: `${packageName} fixture dependency must be pinned exactly to ${expectedVersion}`,
        offset: manifestSource.indexOf(packageName),
      });
    }
    if (manifest.dependencies?.[packageName] !== undefined) {
      violations.push({
        path: ADAPTER_UTILS_MANIFEST,
        kind: "dependency",
        message: `${packageName} must not be a production adapter-utils dependency`,
        offset: manifestSource.indexOf(packageName),
      });
    }
  }
  const selectedFrontend = Object.keys(manifest.dependencies ?? {}).find(
    (name) => name.startsWith("@agentclientprotocol/"),
  );
  if (selectedFrontend) {
    violations.push({
      path: ADAPTER_UTILS_MANIFEST,
      kind: "dependency",
      message:
        "adapter-utils must not bundle a Paperclip-selected ACP frontend",
      offset: manifestSource.indexOf(selectedFrontend),
    });
  }

  const bundled = manifest.bundleDependencies;
  if (
    !Array.isArray(bundled) ||
    !Object.keys(EXACT_RUNTIME_DEPENDENCIES).every((name) =>
      bundled.includes(name),
    ) ||
    bundled.some(
      (name) =>
        typeof name === "string" && name.startsWith("@agentclientprotocol/"),
    )
  ) {
    addMissing(
      violations,
      ADAPTER_UTILS_MANIFEST,
      "dependency",
      "ACPX must be bundled without a direct ACP SDK or selected frontend",
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
  for (const [packageName, expectedVersion] of Object.entries({
    ...EXACT_RUNTIME_DEPENDENCIES,
    ...EXACT_FIXTURE_DEV_DEPENDENCIES,
  })) {
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
  const allowedValueImports = new Map<string, ReadonlySet<string>>([
    [REGISTRY_PATH, new Set(["createAgentRegistry"])],
    [
      RUNTIME_EXECUTION_PATH,
      new Set(["createAcpRuntime", "createRuntimeStore"]),
    ],
    [
      RUNTIME_READINESS_PATH,
      new Set(["createAcpRuntime", "createRuntimeStore"]),
    ],
  ]);

  for (const [filePath, source] of sources) {
    if (
      isTestOrFixturePath(filePath) ||
      !SOURCE_EXTENSIONS.has(path.extname(filePath))
    ) {
      continue;
    }
    const sourceFile = parseSource(filePath, source);
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "acpx/runtime"
      ) {
        continue;
      }
      const offset = statement.getStart(sourceFile);
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      if (!clause || clause.name || !bindings || !ts.isNamedImports(bindings)) {
        violations.push({
          path: filePath,
          kind: "registry_import",
          message: "ACPX runtime imports must be named imports",
          offset,
        });
        continue;
      }
      if (clause.isTypeOnly) continue;
      const allowed = allowedValueImports.get(filePath);
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        if (!allowed?.has(element.name.text) || element.propertyName) {
          violations.push({
            path: filePath,
            kind: "registry_import",
            message:
              "only the dynamic ACPX registry, discovery, readiness, and runtime owners may use ACPX runtime values",
            offset: element.getStart(sourceFile),
          });
        }
      }
    }
  }
}

function scanRegistryOwner(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  const source = requireFragments({
    sources,
    violations,
    path: REGISTRY_PATH,
    kind: "registry_admission",
    contract: "dynamic ACPX registry bridge",
    fragments: [
      "createAgentRegistry",
      "loadAcpxAgentRegistry",
      "listAcpRegistryAgentNames",
      "listLocallyAvailableAcpRegistryAgentNames",
      "isAcpRegistryAgentLocallyAvailable",
      "assertAcpRegistryAgentName",
      "candidateRegistry.list()",
      "includes(registryName)",
    ],
  });
  if (!source) return;
  for (const marker of RETIRED_STATIC_CATALOG_MARKERS) {
    const offset = source.indexOf(marker);
    if (offset >= 0) {
      violations.push({
        path: REGISTRY_PATH,
        kind: "registry_admission",
        message: `Paperclip static agent catalog marker is forbidden: ${marker}`,
        offset,
      });
    }
  }
  const assertionOffset = source.indexOf(
    "export function assertAcpRegistryAgentName",
  );
  const assertionBody = source.slice(Math.max(0, assertionOffset));
  if (
    assertionOffset < 0 ||
    !assertionBody.includes("includes(registryName)") ||
    assertionBody.includes("candidateRegistry.resolve(")
  ) {
    violations.push({
      path: REGISTRY_PATH,
      kind: "registry_admission",
      message:
        "the public ACPX admission helper must check exact membership without resolving a launch argv",
      offset: Math.max(0, assertionOffset),
    });
  }
}

function scanDiscoveryAndCatalog(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  requireFragments({
    sources,
    violations,
    path: DISCOVERY_PATH,
    kind: "discovery",
    contract: "local ACPX discovery",
    fragments: [
      "listAcpxAgentNames",
      "probeAcpxAgent",
      "probeAcpxRuntimeReadiness",
      "configOptions",
    ],
  });
  const catalog = requireFragments({
    sources,
    violations,
    path: SERVER_CATALOG_PATH,
    kind: "catalog",
    contract: "ACPX dynamic catalog projection",
    fragments: [
      "listAcpxAgentNames",
      "probeAcpxAgent",
      "acpxDiscoveryToServerAdapter",
      "discoverLocalAcpxAdapterCatalog",
      "configOptions",
      "registryName: discovery.agentName",
      "modelConfigOptionId: selectedModelOption?.source.id ?? null",
      "models,",
    ],
  });
  if (catalog) {
    for (const marker of RETIRED_STATIC_CATALOG_MARKERS) {
      const offset = catalog.indexOf(marker);
      if (offset >= 0) {
        violations.push({
          path: SERVER_CATALOG_PATH,
          kind: "catalog",
          message: `Paperclip static agent catalog marker is forbidden: ${marker}`,
          offset,
        });
      }
    }
  }
  requireFragments({
    sources,
    violations,
    path: SERVER_REGISTRY_PATH,
    kind: "catalog",
    contract: "ACPX-only selectable adapter registry",
    fragments: [
      "discoverLocalAcpxAdapterCatalog",
      "refreshAcpxAdapters",
      "const currentByType = new Map<string, ServerAdapterModule>()",
      "next.set(adapter.type, adapter)",
      "snapshot.adapters",
    ],
  });
}

function scanAcpxRuntimeBridge(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  requireFragments({
    sources,
    violations,
    path: RUNTIME_EXECUTION_PATH,
    kind: "runtime_execution",
    contract: "disposable ACPX one-shot execution bridge",
    fragments: [
      "executeAcpxOneShotPrompt",
      "createAcpRuntime",
      "createRuntimeStore",
      "ensureSession",
      "startTurn",
      "const setConfigOption = runtime.setConfigOption.bind(runtime)",
      "close",
      "assertAcpRegistryAgentName",
      "isAcpRegistryAgentLocallyAvailable",
      "readonly onSessionEvent:",
      "readonly activatePrompt:",
      "readonly beginPromptTransmission:",
      "await input.activatePrompt({ sessionId })",
      "await input.beginPromptTransmission({ sessionId })",
      "await input.onSessionEvent(",
    ],
  });
  requireFragments({
    sources,
    violations,
    path: RUNTIME_INVOCATION_PATH,
    kind: "runtime_invocation",
    contract: "ACPX-only local invocation preparation",
    fragments: [
      "prepareAcpxRuntimeInvocation",
      "requireLocalTarget",
      "materializeAcpxInvocationFiles",
    ],
  });
  requireFragments({
    sources,
    violations,
    path: RUNTIME_READINESS_PATH,
    kind: "runtime_readiness",
    contract: "disposable ACPX readiness bridge",
    fragments: [
      "probeAcpxRuntimeReadiness",
      "createAcpRuntime",
      "createRuntimeStore",
      "ensureSession",
      "getStatus",
      "await runtime.setConfigOption!({",
      "close",
      "isAcpRegistryAgentLocallyAvailable",
    ],
  });
  requireFragments({
    sources,
    violations,
    path: `${ACPX_RUNTIME_DIRECTORY}/tool-output.ts`,
    kind: "tool_output",
    contract: "canonical ACP tool-output encoding",
    fragments: ["Object.keys(record).sort(codeUnitCompare)", 'join("\\n")'],
  });
}

function scanProductionRawInvocationImports(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  for (const [filePath, source] of sources) {
    if (
      !filePath.startsWith("apps/server/src/") ||
      isTestOrFixturePath(filePath)
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
      const moduleSpecifier = statement.moduleSpecifier.text;
      const offset = statement.getStart(sourceFile);
      if (RAW_ACP_INVOCATION_MODULE.test(moduleSpecifier)) {
        violations.push({
          path: filePath,
          kind: "raw_invocation",
          message:
            "production code must not import a retired raw ACP subprocess module",
          offset,
        });
        continue;
      }
      if (
        moduleSpecifier !== "@paperclipai/adapter-utils/acpx-runtime" &&
        moduleSpecifier !== "@paperclipai/adapter-utils/acp-subprocess"
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const importedName = (element.propertyName ?? element.name).text;
        if (!RAW_ACP_INVOCATION_SYMBOLS.includes(importedName as never)) {
          continue;
        }
        violations.push({
          path: filePath,
          kind: "raw_invocation",
          message: `production code must not import retired raw ACP invocation ${importedName}`,
          offset: element.getStart(sourceFile),
        });
      }
    }
  }
}

function scanProviderParsers(
  sources: ReadonlyMap<string, string>,
  violations: MutableViolation[],
): void {
  for (const [filePath, source] of sources) {
    if (
      !filePath.startsWith(`${ACPX_RUNTIME_DIRECTORY}/`) ||
      isTestOrFixturePath(filePath)
    ) {
      continue;
    }
    for (const pattern of PROVIDER_PARSER_PATTERNS) {
      const match = pattern.expression.exec(source);
      if (!match) continue;
      violations.push({
        path: filePath,
        kind: "provider_parser",
        message: pattern.message,
        offset: match.index,
      });
    }
  }
}

export function scanAcpRegistryAdmissionFiles(
  inputFiles: readonly AcpRegistryAdmissionFile[],
): AcpRegistryAdmissionViolation[] {
  const sources = new Map(
    inputFiles.map((file) => [normalizePath(file.path), file.source]),
  );
  const violations: MutableViolation[] = [];
  scanDependencyPins(sources, violations);
  scanAcpxImports(sources, violations);
  scanRegistryOwner(sources, violations);
  scanDiscoveryAndCatalog(sources, violations);
  scanAcpxRuntimeBridge(sources, violations);
  scanProductionRawInvocationImports(sources, violations);
  scanProviderParsers(sources, violations);
  return violations
    .map((violation) => finalizedViolation(violation, sources))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.column - right.column ||
        left.message.localeCompare(right.message),
    );
}

async function walk(
  absolutePath: string,
  repositoryRoot: string,
  files: AcpRegistryAdmissionFile[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(absolutePath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") {
          await walk(candidate, repositoryRoot, files);
        }
        return;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) return;
      files.push({
        path: normalizePath(path.relative(repositoryRoot, candidate)),
        source: await fs.readFile(candidate, "utf8"),
      });
    }),
  );
}

export async function listAcpRegistryAdmissionFiles(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<AcpRegistryAdmissionFile[]> {
  const files: AcpRegistryAdmissionFile[] = [];
  await Promise.all([
    walk(
      path.resolve(repositoryRoot, "packages/adapter-utils/src"),
      repositoryRoot,
      files,
    ),
    walk(
      path.resolve(repositoryRoot, "apps/server/src"),
      repositoryRoot,
      files,
    ),
  ]);
  for (const filePath of [ADAPTER_UTILS_MANIFEST, ROOT_MANIFEST, LOCKFILE]) {
    try {
      files.push({
        path: filePath,
        source: await fs.readFile(
          path.resolve(repositoryRoot, filePath),
          "utf8",
        ),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Test model for the closed dynamic admission rule. ACPX's registry is the
 * only catalog: a submitted name must be byte-exactly present before ACPX's
 * runtime receives it.
 */
export function assertExactRegistryCandidate(input: {
  readonly submittedName: string;
  readonly registryNames: readonly string[];
}): string {
  if (!input.registryNames.includes(input.submittedName)) {
    throw new Error("ACP registry name is not listed by ACPX");
  }
  return input.submittedName;
}

async function packageManifestForResolvedEntry(
  resolvedEntry: string,
  packageName: string,
): Promise<{ name: string; version: string }> {
  let directory = path.dirname(resolvedEntry);
  while (true) {
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
    directory = parent;
  }
}

async function inspectInstalledRuntime(
  repositoryRoot: string,
): Promise<AcpRegistryAdmissionViolation[]> {
  const violations: AcpRegistryAdmissionViolation[] = [];
  const add = (message: string): void => {
    violations.push({
      path: REGISTRY_PATH,
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
    for (const [packageName, expectedVersion] of Object.entries(
      EXACT_RUNTIME_DEPENDENCIES,
    )) {
      const resolved = anchoredRequire.resolve(
        packageName === "acpx" ? "acpx/runtime" : packageName,
      );
      const installed = await packageManifestForResolvedEntry(
        resolved,
        packageName,
      );
      if (installed.version !== expectedVersion) {
        add(
          `installed ${packageName} must be ${expectedVersion}, found ${installed.version}`,
        );
      }
    }

    const moduleUrl = pathToFileURL(
      path.resolve(repositoryRoot, REGISTRY_PATH),
    ).href;
    const registryModule = (await import(moduleUrl)) as RegistryModule;
    const registry = await registryModule.loadAcpxAgentRegistry(repositoryRoot);
    const names = registryModule.listAcpRegistryAgentNames(registry);
    if (
      !Array.isArray(names) ||
      names.some(
        (name) =>
          typeof name !== "string" || name.length === 0 || name !== name.trim(),
      )
    ) {
      add("ACPX registry must expose exact non-empty dynamic names");
    }

    let rawResolveCalls = 0;
    const admittedName = registryModule.assertAcpRegistryAgentName(
      "local-agent",
      {
        list: () => ["local-agent"],
        resolve: () => {
          rawResolveCalls += 1;
          return ["must-not-run"];
        },
      } as RegistryLike,
    );
    if (admittedName !== "local-agent" || rawResolveCalls !== 0) {
      add(
        "exact ACPX admission must preserve the submitted name without resolving argv",
      );
    }

    for (const submittedName of [
      "unknown",
      " local-agent",
      "local-agent ",
      "Local-Agent",
    ]) {
      let resolveCalls = 0;
      let rejected = false;
      try {
        registryModule.assertAcpRegistryAgentName(submittedName, {
          // ACPX is allowed to publish arbitrary future names. This negative
          // case proves only that a name absent from its list (or malformed
          // whitespace) cannot reach the raw-command resolver.
          list: () => ["local-agent"],
          resolve: () => {
            resolveCalls += 1;
            return ["must-not-run"];
          },
        } as RegistryLike);
      } catch {
        rejected = true;
      }
      if (!rejected || resolveCalls !== 0) {
        add(
          `${JSON.stringify(submittedName)} must reject before ACPX launch resolution`,
        );
      }
    }
  } catch (error) {
    add(
      `installed ACPX registry/runtime inspection failed: ${
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
    console.log("Dynamic ACPX registry and runtime boundary check passed.");
  }
}
