import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  basename,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SELF_PATHS = new Set([
  "scripts/check-cross-issue-memory-removal.ts",
  "scripts/check-cross-issue-memory-removal.test.ts",
]);
const SCAN_ROOTS = [
  ".agents",
  ".claude",
  ".github",
  "cli",
  "design",
  "doc",
  "docker",
  "docs",
  "evals",
  "packages",
  "patches",
  "releases",
  "report",
  "scripts",
  "server",
  "skills",
  "tests",
  "tools",
  "ui",
] as const;
const ROOT_FILES = [
  ".env.example",
  "AGENTS.md",
  "Dockerfile",
  "README.md",
  "ROADMAP.md",
  "adapter-plugin.md",
  "opencode-donor.lock.json",
  "package.json",
  "pnpm-lock.yaml",
] as const;
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "screenshots",
  "storybook-static",
]);
const REMOVAL_FIXTURE_MARKER = "PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE:";

export const DIRECT_RETIRED_TOKENS = Object.freeze([
  "para-memory-files",
  "/api/skills/para-memory-files",
  "phase5_memory",
  "phase5-memory-control-surfaces",
  "MEMORY.md",
  "AGENT_HOME",
  "agent_home",
  "agentHome",
  "resolveDefaultAgentWorkspaceDir",
  "paperclipWorkspace.agentHome",
  "fallback_agent_home_cwd",
  "git_worktree_base_agent_home",
  "stateJson",
  "sessionParams",
  "sessionDisplayId",
  "acpSessionId",
  "ProviderCliFreshSessionControl",
  "freshSessionControl",
  "incompatibleResumeArgs",
  "buildResumeArgs",
  "freshSessionHandle",
  "providerSessionId",
  "sessionKeyStrategy",
  "persistSession",
  "runtime.heartbeat.sessionCompaction",
  "heartbeat.sessionRotation",
  "runtime.sessionCompaction",
  "AdapterSessionManagement",
  "sessionManagement",
  "forceFreshSession",
  "/agents/:id/task-sessions",
  "/agents/:id/runtime-state/reset-session",
  "agent_task_sessions",
  "agentTaskSessions",
  "taskKey",
  "codexHome",
  "createAcpRuntime",
  "AcpxRuntime",
  "AcpRuntimeHandle",
  "AcpRuntimeOptions",
  "AcpSessionRecord",
  "AcpSessionStore",
  "createFileSessionStore",
  "createRuntimeStore",
  "warmHandles",
  "warmHandleIdleMs",
  "DEFAULT_AGENT_NAME",
] as const);

export const ACPX_STATE_TERMS = Object.freeze([
  "stateDir",
  "defaultAgent",
  "sessionKey",
  "persistent",
] as const);

const ALLOWED_ACPX_RUNTIME_IMPORTS = new Set([
  "createAgentRegistry",
  "AcpAgentRegistry",
]);
const MEMORY_CONTRACT_PATTERNS = [
  /\bmemory[ \t_-]+providers?\b/gi,
  /\bmemory[ \t_-]+hooks?\b/gi,
  /\bmemory[ \t_-]+bindings?\b/gi,
  /\bMemoryProvider\w*\b/g,
  /\bMemoryHook\w*\b/g,
] as const;
const REMOVED_ASSET_PATH_PATTERNS = [
  /(?:^|\/)memory-landscape\.md$/i,
  /(?:^|\/)2026-03-17-memory-service-surface-api\.md$/i,
  /(?:^|\/)phase5-memory-control-surfaces\.ya?ml$/i,
  /(?:^|\/)para-memory-files(?:\/|$)/i,
] as const;
const PROVIDER_NAMES = [
  "openclaw",
  "hermes",
  "cursor",
  "grok",
  "gemini",
  "claude",
  "pi",
  "opencode",
  "codex",
] as const;

export interface CrossIssueMemoryRemovalFile {
  readonly path: string;
  readonly source: string;
}

export interface CrossIssueMemoryRemovalViolation {
  readonly path: string;
  readonly line: number;
  readonly term: string;
  readonly reason: string;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function lineNumberAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function isNegativeFixturePath(path: string): boolean {
  return (
    path.includes("/__tests__/") ||
    /(?:^|\/)__fixtures__(?:\/|$)/.test(path) ||
    /\.(?:test|spec)\.[^.]+$/.test(path)
  );
}

function declaredFixtureTerms(
  path: string,
  source: string,
): ReadonlySet<string> {
  if (!isNegativeFixturePath(path)) return new Set();
  const terms = new Set<string>();
  for (const line of source.split("\n")) {
    const marker = line.indexOf(REMOVAL_FIXTURE_MARKER);
    if (marker === -1) continue;
    const declaration = line.slice(marker + REMOVAL_FIXTURE_MARKER.length);
    for (const term of declaration.split(",")) {
      const normalized = term.trim().replace(/^[`'"]|[`'"]$/g, "");
      if (normalized.length > 0) terms.add(normalized);
    }
  }
  return terms;
}

function addViolation(
  violations: CrossIssueMemoryRemovalViolation[],
  file: CrossIssueMemoryRemovalFile,
  fixtureTerms: ReadonlySet<string>,
  input: {
    readonly offset: number;
    readonly term: string;
    readonly reason: string;
  },
): void {
  if (fixtureTerms.has(input.term)) return;
  violations.push({
    path: file.path,
    line: lineNumberAt(file.source, input.offset),
    term: input.term,
    reason: input.reason,
  });
}

function occurrences(source: string, token: string): number[] {
  const offsets: number[] = [];
  let offset = source.indexOf(token);
  while (offset !== -1) {
    offsets.push(offset);
    offset = source.indexOf(token, offset + token.length);
  }
  return offsets;
}

function scanDirectRetiredTokens(
  file: CrossIssueMemoryRemovalFile,
  fixtureTerms: ReadonlySet<string>,
  violations: CrossIssueMemoryRemovalViolation[],
): void {
  for (const token of DIRECT_RETIRED_TOKENS) {
    for (const offset of occurrences(file.source, token)) {
      addViolation(violations, file, fixtureTerms, {
        offset,
        term: token,
        reason: "retired cross-issue memory/session identifier",
      });
    }
  }
}

function scanMemoryContracts(
  file: CrossIssueMemoryRemovalFile,
  fixtureTerms: ReadonlySet<string>,
  violations: CrossIssueMemoryRemovalViolation[],
): void {
  for (const expression of MEMORY_CONTRACT_PATTERNS) {
    expression.lastIndex = 0;
    for (let match = expression.exec(file.source); match; match = expression.exec(file.source)) {
      addViolation(violations, file, fixtureTerms, {
        offset: match.index,
        term: "memory-provider-contract",
        reason: `retired memory provider/hook contract ${JSON.stringify(match[0])}`,
      });
    }
  }
  const agentFileMemory =
    /(?:\$?[A-Z_]*HOME|agent[ \t_-]*home)[^\n]{0,160}(?:memory[ \t_-]*files?|daily[ \t_-]*notes?|life\/)|(?:memory[ \t_-]*files?|daily[ \t_-]*notes?|life\/)[^\n]{0,160}(?:\$?[A-Z_]*HOME|agent[ \t_-]*home)/i.exec(
      file.source,
    );
  if (agentFileMemory) {
      addViolation(violations, file, fixtureTerms, {
        offset: agentFileMemory.index,
        term: "agent-file-memory",
        reason: "retired per-agent life/daily-memory path contract",
      });
  }
}

function scanAgentMandate(
  file: CrossIssueMemoryRemovalFile,
  fixtureTerms: ReadonlySet<string>,
  violations: CrossIssueMemoryRemovalViolation[],
): void {
  if (!/(?:^|\/)(?:AGENTS|HEARTBEAT)\.md$/i.test(file.path)) return;
  const lines = file.source.split("\n");
  lines.forEach((line, index) => {
    if (
      /(?:memory|remember|recall|daily\s+notes?|life\/)/i.test(line) &&
      /(?:must|always|required|before|after|read|write|update|persist|save)/i.test(
        line,
      ) &&
      !fixtureTerms.has("memory-mandate")
    ) {
      violations.push({
        path: file.path,
        line: index + 1,
        term: "memory-mandate",
        reason: "AGENTS/HEARTBEAT text mandates conversational memory or recall",
      });
    }
  });
}

function acpxImports(source: string): string[] {
  const imported: string[] = [];
  const namedImport = /import\s*\{([^}]*)\}\s*from\s*["']acpx\/runtime["']/g;
  for (let match = namedImport.exec(source); match; match = namedImport.exec(source)) {
    for (const raw of match[1]!.split(",")) {
      const value = raw.trim().replace(/^type\s+/, "");
      if (value.length === 0) continue;
      imported.push(value.split(/\s+as\s+/)[0]!.trim());
    }
  }
  return imported;
}

function scanAcpxRuntimeGraph(
  file: CrossIssueMemoryRemovalFile,
  fixtureTerms: ReadonlySet<string>,
  violations: CrossIssueMemoryRemovalViolation[],
): void {
  const importsRuntime = /["']acpx\/runtime["']/.test(file.source);
  const namespaceOrDefaultImport =
    /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+["']acpx\/runtime["']/.exec(
      file.source,
    );
  if (namespaceOrDefaultImport) {
    addViolation(violations, file, fixtureTerms, {
      offset: namespaceOrDefaultImport.index,
      term: "acpx-runtime-import",
      reason: "ACPX runtime may be consumed only through its two registry exports",
    });
  }
  for (const imported of acpxImports(file.source)) {
    if (ALLOWED_ACPX_RUNTIME_IMPORTS.has(imported)) continue;
    const offset = file.source.indexOf(imported);
    addViolation(violations, file, fixtureTerms, {
      offset: Math.max(0, offset),
      term: imported,
      reason: "forbidden ACPX stateful runtime import",
    });
  }

  const hardGraphScope =
    importsRuntime || /(?:^|\/)acpx-engine(?:\/|$)/i.test(file.path);
  for (const term of ACPX_STATE_TERMS) {
    const expression = new RegExp(`\\b${term}\\b`, "g");
    for (let match = expression.exec(file.source); match; match = expression.exec(file.source)) {
      const context = file.source.slice(
        Math.max(0, match.index - 180),
        Math.min(file.source.length, match.index + term.length + 180),
      );
      const participatesInStatefulRuntime =
        term === "persistent"
          ? /(?:runtime[ \t_-]*(?:options|store|handle)|session[ \t_-]*(?:store|mode|key)|warm[ \t_-]*handle)/i.test(
              context,
            )
          : /(?:ACPX|AcpxRuntime|AcpRuntime|ensureSession|runtime[ \t_-]*(?:options|store|handle)|session[ \t_-]*(?:store|mode|key)|warm[ \t_-]*handle)/i.test(
              context,
            );
      if (
        !hardGraphScope &&
        !participatesInStatefulRuntime
      ) {
        continue;
      }
      addViolation(violations, file, fixtureTerms, {
        offset: match.index,
        term,
        reason: "ACPX runtime/options/cache/session-store state",
      });
    }
  }
}

function providerFrom(file: CrossIssueMemoryRemovalFile): string | null {
  const path = file.path.toLowerCase();
  const providerInPath = PROVIDER_NAMES.find((provider) =>
    new RegExp(`(?:^|[\\/_.-])${provider}(?:[\\/_.-]|$)`).test(path),
  );
  if (providerInPath) return providerInPath;
  if (!/\.(?:md|txt|ya?ml)$/.test(path)) return null;
  const source = file.source.toLowerCase();
  return PROVIDER_NAMES.find((provider) => source.includes(provider)) ?? null;
}

function scanProviderContinuation(
  file: CrossIssueMemoryRemovalFile,
  fixtureTerms: ReadonlySet<string>,
  violations: CrossIssueMemoryRemovalViolation[],
): void {
  const provider = providerFrom(file);
  if (!provider) return;
  const forbiddenFlags =
    provider === "pi" || provider === "opencode"
      ? ["--session"]
      : provider === "claude"
        ? ["--resume", "--session-id"]
        : provider === "codex"
          ? []
          : ["--resume"];
  if (provider === "openclaw") forbiddenFlags.push("sessionKey");
  for (const flag of forbiddenFlags) {
    for (const offset of occurrences(file.source, flag)) {
      addViolation(violations, file, fixtureTerms, {
        offset,
        term: flag,
        reason: `${provider} provider-specific continuation lowering`,
      });
    }
  }
  if (provider === "codex") {
    const expression = /["'`]resume["'`]\s*,?\s*(?:[A-Za-z_$][\w$]*session|[A-Za-z_$][\w$]*id)/gi;
    const match = expression.exec(file.source);
    if (match) {
      addViolation(violations, file, fixtureTerms, {
        offset: match.index,
        term: "codex-positional-resume",
        reason: "Codex provider-specific positional continuation lowering",
      });
    }
  }
  const renamedBuilder = /\b(?:build|create|resolve|append|lower)\w*(?:Resume|Session)\w*(?:Args|Arguments|Handle)\b/g;
  for (let match = renamedBuilder.exec(file.source); match; match = renamedBuilder.exec(file.source)) {
    addViolation(violations, file, fixtureTerms, {
      offset: match.index,
      term: "provider-continuation-builder",
      reason: `renamed ${provider} provider continuation builder`,
    });
  }

  if (!/\.(?:[cm]?[jt]sx?)$/.test(file.path)) return;
  const parsedProviderSession =
    /(?:JSON\.parse|parse\w*(?:Output|Response|Result|Event)|\bstdout\b|\bresultJson\b)[\s\S]{0,500}(?:session|conversation|thread|chat|agent)[_$.-]*(?:id|key)|(?:session|conversation|thread|chat|agent)[_$.-]*(?:id|key)[\s\S]{0,500}(?:return\s*\{|correlation|continuation|runtimeState|result)/i.exec(
      file.source,
    );
  if (parsedProviderSession) {
    addViolation(violations, file, fixtureTerms, {
      offset: parsedProviderSession.index,
      term: "provider-parsed-session-result",
      reason: `${provider} parses provider output into Paperclip continuation state`,
    });
  }
}

function scanManagedCodexHome(
  file: CrossIssueMemoryRemovalFile,
  fixtureTerms: ReadonlySet<string>,
  violations: CrossIssueMemoryRemovalViolation[],
): void {
  for (const offset of occurrences(file.source, "CODEX_HOME")) {
    const context = file.source.slice(
      Math.max(0, offset - 240),
      Math.min(file.source.length, offset + 300),
    );
    const documentation = /\.(?:md|txt)$/.test(file.path);
    const contextWithoutVariable = context.replaceAll("CODEX_HOME", "");
    const mutatesProviderHome =
      /(?:mkdir|writeFile|copyFile|symlink|rename|stage|sync|reconcil|provision|materializ|seed)/i.test(
        contextWithoutVariable,
      );
    const paperclipOwnsMutation =
      !documentation ||
      /(?:Paperclip|adapter|runtime)[^\n]{0,100}(?:manage|mutat|write|copy|link|stage|sync|provision|materializ|seed)|(?:manage|mutat|write|copy|link|stage|sync|provision|materializ|seed)[^\n]{0,100}(?:Paperclip|adapter|runtime)/i.test(
        contextWithoutVariable,
      );
    const managed = mutatesProviderHome && paperclipOwnsMutation;
    if (!managed) continue;
    addViolation(violations, file, fixtureTerms, {
      offset,
      term: "CODEX_HOME",
      reason: "Paperclip-managed provider home/staging/copy-back contract",
    });
  }
}

function scanAgentRuntimeStateAbi(
  file: CrossIssueMemoryRemovalFile,
  fixtureTerms: ReadonlySet<string>,
  violations: CrossIssueMemoryRemovalViolation[],
): void {
  const expression =
    /agent_runtime_state[\s\S]{0,240}\b(?:state_json|session_id|sessionId)\b|\b(?:state_json|session_id|sessionId)\b[\s\S]{0,240}agent_runtime_state/g;
  for (let match = expression.exec(file.source); match; match = expression.exec(file.source)) {
    addViolation(violations, file, fixtureTerms, {
      offset: match.index,
      term: "agent-runtime-conversation-state",
      reason: "agent_runtime_state may retain accounting only, not conversation correlation",
    });
  }
}

function scanResultCorrelationAbi(
  file: CrossIssueMemoryRemovalFile,
  fixtureTerms: ReadonlySet<string>,
  violations: CrossIssueMemoryRemovalViolation[],
): void {
  const expression =
    /AdapterExecutionResult[\s\S]{0,400}nativeCorrelation|nativeCorrelation[\s\S]{0,400}AdapterExecutionResult/g;
  const match = expression.exec(file.source);
  if (!match) return;
  addViolation(violations, file, fixtureTerms, {
    offset: match.index,
    term: "AdapterExecutionResult.nativeCorrelation",
    reason: "return-based provider correlation ABI",
  });
}

function scanRemovedAssetPath(
  file: CrossIssueMemoryRemovalFile,
  fixtureTerms: ReadonlySet<string>,
  violations: CrossIssueMemoryRemovalViolation[],
): void {
  const match = REMOVED_ASSET_PATH_PATTERNS.find((pattern) =>
    pattern.test(file.path),
  );
  if (!match || fixtureTerms.has("removed-memory-asset")) return;
  violations.push({
    path: file.path,
    line: 1,
    term: "removed-memory-asset",
    reason: "retired memory skill/eval/design asset remains in the tree",
  });
}

export function scanCrossIssueMemoryRemovalFiles(
  inputFiles: readonly CrossIssueMemoryRemovalFile[],
): CrossIssueMemoryRemovalViolation[] {
  const violations: CrossIssueMemoryRemovalViolation[] = [];
  for (const rawFile of inputFiles) {
    const file = {
      path: normalizePath(rawFile.path),
      source: rawFile.source,
    };
    if (SELF_PATHS.has(file.path)) continue;
    const fixtureTerms = declaredFixtureTerms(file.path, file.source);
    scanRemovedAssetPath(file, fixtureTerms, violations);
    scanDirectRetiredTokens(file, fixtureTerms, violations);
    scanMemoryContracts(file, fixtureTerms, violations);
    scanAgentMandate(file, fixtureTerms, violations);
    scanAcpxRuntimeGraph(file, fixtureTerms, violations);
    scanProviderContinuation(file, fixtureTerms, violations);
    scanManagedCodexHome(file, fixtureTerms, violations);
    scanAgentRuntimeStateAbi(file, fixtureTerms, violations);
    scanResultCorrelationAbi(file, fixtureTerms, violations);
  }
  return violations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.term.localeCompare(right.term) ||
      left.reason.localeCompare(right.reason),
  );
}

function isTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path)) || basename(path) === "Dockerfile";
}

function walk(
  absolutePath: string,
  repositoryRoot: string,
  files: CrossIssueMemoryRemovalFile[],
): void {
  if (!existsSync(absolutePath)) return;
  const stats = statSync(absolutePath);
  if (stats.isFile()) {
    if (!isTextFile(absolutePath)) return;
    const path = normalizePath(relative(repositoryRoot, absolutePath));
    if (SELF_PATHS.has(path)) return;
    files.push({ path, source: readFileSync(absolutePath, "utf8") });
    return;
  }
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    walk(join(absolutePath, entry.name), repositoryRoot, files);
  }
}

export function listCrossIssueMemoryRemovalFiles(
  repositoryRoot = REPOSITORY_ROOT,
): CrossIssueMemoryRemovalFile[] {
  const files: CrossIssueMemoryRemovalFile[] = [];
  for (const root of SCAN_ROOTS) {
    walk(resolve(repositoryRoot, root), repositoryRoot, files);
  }
  for (const path of ROOT_FILES) {
    walk(resolve(repositoryRoot, path), repositoryRoot, files);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function canonicalOwnershipViolations(repositoryRoot: string): string[] {
  const violations = [
    ...requireFileTokens(
      repositoryRoot,
      "packages/db/schema/agent_runtime_state.ts",
      [
        '"agent_runtime_state"',
        "lastRunId",
        "lastContextUsedTokens",
        "lastContextWindowTokens",
        "peakContextUsedTokens",
        "aggregateKnownCostAmount",
        "unpricedPromptCount",
      ],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "packages/shared/src/validators/agent-adapter-revision.ts",
      [
        "agentAdapterAcpConfigurationSchema",
        'z.literal("acp-subprocess/v1")',
        "sessionConfigSelections",
        ".strict()",
      ],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "packages/adapter-utils/src/acp-subprocess/agent-registry.ts",
      [
        "createAgentRegistry",
        "AcpAgentRegistry",
        "resolveApprovedAcpLaunch",
      ],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "packages/adapter-utils/src/acp-subprocess/correlation.ts",
      ["acp-session/v1", "AcpSessionCorrelation", "sessionId"],
    ),
  ];
  return violations;
}

export function crossIssueMemoryRemovalViolations(
  repositoryRoot = REPOSITORY_ROOT,
): string[] {
  const scanned = scanCrossIssueMemoryRemovalFiles(
    listCrossIssueMemoryRemovalFiles(repositoryRoot),
  ).map(
    (violation) =>
      `${violation.path}:${violation.line}: ${violation.reason} (${violation.term})`,
  );
  return [...scanned, ...canonicalOwnershipViolations(repositoryRoot)].sort();
}

export function assertCrossIssueMemoryRemoval(
  repositoryRoot = REPOSITORY_ROOT,
): void {
  assertNoGateViolations(
    "Cross-issue-memory removal check",
    crossIssueMemoryRemovalViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertCrossIssueMemoryRemoval();
    console.log("Cross-issue-memory removal check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
