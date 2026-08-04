import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const REMOVAL_PROOF_MARKER =
  "paperclip:canonical-human-auth-removal-proof";

const CHECKER_FILES = new Set([
  "scripts/check-canonical-human-auth.ts",
  "scripts/check-canonical-human-auth.test.ts",
]);

const SOURCE_ROOTS = [
  ".github",
  "apps",
  "doc",
  "docker",
  "packages",
  "scripts",
  "tests",
] as const;

const ROOT_FILES = [
  ".env.example",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "Dockerfile",
  "README.md",
  "SECURITY.md",
  "package.json",
] as const;

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const SCANNED_TEXT_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  ".bash",
  ".env",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".sh",
  ".toml",
  ".yaml",
  ".yml",
]);

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".paperclip",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "reference",
  "releases",
]);

const ARCHIVED_DOCUMENT_PREFIXES = [
  "doc/logs/",
  "doc/plans/",
] as const;

const AUTH_TABLES = new Set([
  "authAccounts",
  "authSessions",
  "authUsers",
  "authVerifications",
]);

type AuthTable = "authAccounts" | "authSessions" | "authUsers"
  | "authVerifications";

const ROUTE_METHODS = new Set([
  "all",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "route",
  "use",
]);

const FORBIDDEN_RULES = [
  ["local_trusted", /\blocal_trusted\b/g],
  ["local_implicit", /\blocal_implicit\b/g],
  ["local-board", /\blocal-board\b/g],
  ["cloud_tenant", /\bcloud_tenant\b/g],
  ["deploymentMode", /\bdeploymentMode\b/g],
  ["DeploymentMode", /\bDeploymentMode\b/g],
  ["DEPLOYMENT_MODES", /\bDEPLOYMENT_MODES\b/g],
  [
    "PAPERCLIP_DEPLOYMENT_MODE",
    /\bPAPERCLIP_DEPLOYMENT_MODE\b/g,
  ],
  [
    "retired auth/public URL alias",
    /\b(?:BETTER_AUTH_(?:BASE_)?URL|BETTER_AUTH_TRUSTED_ORIGINS|NEXT_PUBLIC_BETTER_AUTH_URL|PUBLIC_BETTER_AUTH_URL|NUXT_PUBLIC_BETTER_AUTH_URL|NUXT_PUBLIC_AUTH_URL|PAPERCLIP_AUTH_PUBLIC_BASE_URL|NEXT_PUBLIC_URL)\b/g,
  ],
  [
    "ambient Better Auth BASE_URL",
    /(?:^\s*(?:ENV\s+)?BASE_URL\s*(?:=|:)|\b(?:process\.env|env)(?:\.|\?\.)BASE_URL\b)/gm,
  ],
  [
    "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN",
    /\bPAPERCLIP_CLOUD_TENANT_SERVER_TOKEN\b/g,
  ],
  [
    "retired Cloud identity header",
    /\bx-paperclip-cloud-(?:stack-(?:id|role)|tenant-token|user-(?:email|id))\b/gi,
  ],
  [
    "retired Cloud identity environment variable",
    /\bPAPERCLIP_CLOUD_(?:STACK|TENANT|USER)_[A-Z0-9_]+\b/g,
  ],
  [
    "ensureLocalTrustedBoardPrincipal",
    /\bensureLocalTrustedBoardPrincipal\b/g,
  ],
  ["resolveCloudTenantActor", /\bresolveCloudTenantActor\b/g],
  ["isCloudManagedInstance", /\bisCloudManagedInstance\b/g],
  [
    "Board Claim",
    /\b(?:BoardClaim|board_claim|board-claim|Board Claim)\b/g,
  ],
  [
    "synthetic paperclip auth session",
    /paperclip:(?:\$\{\s*(?:actor\.source|authSource|source|userId)\b|(?:board|cloud_tenant|local_implicit|local_trusted|session):)/g,
  ],
  ["custom auth profile route", /\/api\/auth\/profile\b/g],
  ["paperclip-seed", /\bpaperclip-seed\b/g],
  ["bootstrap_ceo", /\bbootstrap_ceo\b/g],
  ["bootstrapCeo", /\bbootstrapCeo\b/g],
  [
    "legacy bootstrap invitation helper",
    /\b(?:createAuthBootstrapInvite|create-auth-bootstrap-invite)\b/g,
  ],
  [
    "fake system inviter",
    /\binvitedByUserId\s*[:=]\s*["'`]system["'`]/g,
  ],
  [
    "fake system inviter SQL",
    /\binvited_by_user_id\b[^\n]{0,80}["'`]system["'`]/gi,
  ],
] as const satisfies ReadonlyArray<readonly [string, RegExp]>;

const CANONICAL_RETIRED_INPUT_REJECTION_LINES = new Map<
  string,
  ReadonlySet<string>
>([
  [
    "packages/cli/src/commands/onboard.ts:PAPERCLIP_DEPLOYMENT_MODE",
    new Set([
      "if (process.env.PAPERCLIP_DEPLOYMENT_MODE !== undefined) {",
      '"PAPERCLIP_DEPLOYMENT_MODE is unsupported. Configure PAPERCLIP_BIND and PAPERCLIP_DEPLOYMENT_EXPOSURE instead.",',
    ]),
  ],
]);
const CANONICAL_RETIRED_INPUT_REJECTION_BLOCKS = new Map<
  string,
  RegExp
>([
  [
    "packages/cli/src/commands/onboard.ts:PAPERCLIP_DEPLOYMENT_MODE",
    /if\s*\(\s*process\.env\.PAPERCLIP_DEPLOYMENT_MODE\s*!==\s*undefined\s*\)\s*\{\s*throw\s+new\s+Error\s*\(\s*"PAPERCLIP_DEPLOYMENT_MODE is unsupported\. Configure PAPERCLIP_BIND and PAPERCLIP_DEPLOYMENT_EXPOSURE instead\."\s*,?\s*\)\s*;?\s*\}/g,
  ],
]);

export interface CanonicalHumanAuthFile {
  path: string;
  source: string;
}

export interface CanonicalHumanAuthViolation {
  path: string;
  line: number;
  column: number;
  kind:
    | "auth_namespace_owner"
    | "auth_secret"
    | "auth_table_writer"
    | "http_actor"
    | "production_test_import"
    | "removal_proof"
    | "retired_identity";
  message: string;
}

interface ParsedModule {
  file: CanonicalHumanAuthFile;
  sourceFile: ts.SourceFile;
  bindings: Map<string, AuthTable>;
  namespaceTargets: Map<string, string | null>;
  exports: Map<string, AuthTable>;
  exportStars: string[];
  imports: Array<{
    node: ts.Node;
    specifier: string;
    target: string | null;
  }>;
  stringBindings: Map<string, string>;
}

interface WorkspacePackage {
  root: string;
  exports: Record<string, string>;
}

function normalized(value: string): string {
  return value.replaceAll(path.sep, "/").replace(/^\.\/+/, "");
}

function sourceExtension(file: string): string {
  const extension = path.posix.extname(file);
  return SOURCE_EXTENSIONS.has(extension) ? extension : ".ts";
}

function scriptKind(file: string): ts.ScriptKind {
  switch (sourceExtension(file)) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function isCodeFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(path.posix.extname(file));
}

function isE2ePath(file: string): boolean {
  return /^(?:tests\/(?:e2e|release-smoke|storybook-visual)\/)/.test(
    normalized(file),
  );
}

export function isTestSourcePath(file: string): boolean {
  const value = normalized(file);
  if (isE2ePath(value)) return false;
  const basename = path.posix.basename(value);
  return (
    /(?:^|\/)(?:__tests__|fixtures?|tests?|testing)(?:\/|$)/.test(
      value,
    )
    || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(basename)
    || /^(?:test-|.*-test-fixture\.)/.test(basename)
  );
}

function shouldScanRetiredTokens(file: string): boolean {
  const value = normalized(file);
  if (CHECKER_FILES.has(value)) return false;
  if (
    /^scripts\/check-[^/]+\.(?:[cm]?[jt]s)$/.test(value)
  ) {
    return false;
  }
  if (
    ARCHIVED_DOCUMENT_PREFIXES.some((prefix) =>
      value.startsWith(prefix)
    )
  ) {
    return false;
  }
  const extension = path.posix.extname(value);
  return (
    SCANNED_TEXT_EXTENSIONS.has(extension)
    || path.posix.basename(value) === ".env.example"
    || path.posix.basename(value) === "Dockerfile"
  );
}

function locationOf(
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

function nodeLocation(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { line: number; column: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

function addViolation(
  violations: CanonicalHumanAuthViolation[],
  input: CanonicalHumanAuthViolation,
): void {
  if (
    violations.some((entry) =>
      entry.path === input.path
      && entry.line === input.line
      && entry.column === input.column
      && entry.kind === input.kind
      && entry.message === input.message
    )
  ) {
    return;
  }
  violations.push(input);
}

export function scanRetiredHumanIdentityTokens(
  files: readonly CanonicalHumanAuthFile[],
): CanonicalHumanAuthViolation[] {
  const violations: CanonicalHumanAuthViolation[] = [];
  for (const file of files) {
    const filePath = normalized(file.path);
    if (!shouldScanRetiredTokens(filePath)) continue;
    const lines = file.source.split("\n");
    const usedRemovalProofLines = new Set<number>();
    for (const [label, pattern] of FORBIDDEN_RULES) {
      const matcher = new RegExp(pattern.source, pattern.flags);
      for (
        let match = matcher.exec(file.source);
        match;
        match = matcher.exec(file.source)
      ) {
        const offset = match.index;
        const location = locationOf(file.source, offset);
        const lineText = lines[location.line - 1] ?? "";
        const rejectionKey = `${filePath}:${label}`;
        const rejectionBlock =
          CANONICAL_RETIRED_INPUT_REJECTION_BLOCKS.get(rejectionKey);
        const canonicalRetiredInputRejection =
          CANONICAL_RETIRED_INPUT_REJECTION_LINES.get(
            rejectionKey,
          )?.has(lineText.trim()) === true
          && rejectionBlock !== undefined
          && [...file.source.matchAll(
            new RegExp(rejectionBlock.source, rejectionBlock.flags),
          )].length === 1;
        const removalProof =
          isTestSourcePath(filePath)
          && lineText.includes(REMOVAL_PROOF_MARKER);
        if (canonicalRetiredInputRejection) {
          // A retired environment input is named only to reject it before
          // configuration is read. Every other spelling or call site fails.
        } else if (removalProof) {
          usedRemovalProofLines.add(location.line);
        } else {
          addViolation(violations, {
            path: filePath,
            ...location,
            kind: "retired_identity",
            message: `retired human-identity contract remains: ${label}`,
          });
        }
        if (match[0].length === 0) matcher.lastIndex += 1;
      }
    }

    lines.forEach((lineText, index) => {
      if (!lineText.includes(REMOVAL_PROOF_MARKER)) return;
      const line = index + 1;
      if (!isTestSourcePath(filePath)) {
        addViolation(violations, {
          path: filePath,
          line,
          column: lineText.indexOf(REMOVAL_PROOF_MARKER) + 1,
          kind: "removal_proof",
          message:
            "canonical-human-auth removal-proof markers are allowed only in test source",
        });
      } else if (!usedRemovalProofLines.has(line)) {
        addViolation(violations, {
          path: filePath,
          line,
          column: lineText.indexOf(REMOVAL_PROOF_MARKER) + 1,
          kind: "removal_proof",
          message:
            "canonical-human-auth removal-proof marker must share a line with a rejected fixture token",
        });
      }
    });
  }
  return violations;
}

function isGeneratedOrPlaceholderSecret(value: string): boolean {
  const normalizedValue = value
    .trim()
    .replace(/\\\s*$/, "")
    .trim()
    .replace(/^(["'`])([\s\S]*)\1$/, "$2")
    .trim();
  if (!normalizedValue) return true;
  if (/^<[^>]+>$/.test(normalizedValue)) return true;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(normalizedValue)) {
    return true;
  }
  if (
    /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::\?[^}]*)?\}$/.test(
      normalizedValue,
    )
  ) {
    return true;
  }
  if (/^\$\(\s*openssl\s+rand\s+-hex\s+32\s*\)$/.test(normalizedValue)) {
    return true;
  }
  return false;
}

/**
 * Rejects committed, directly usable Better Auth secret values. Deployment
 * examples may leave the value empty, reference an externally supplied
 * variable, or show a generation command, but may not ship a shared secret or
 * a shell/source fallback that becomes one.
 */
export function scanBetterAuthSecretBoundary(
  files: readonly CanonicalHumanAuthFile[],
): CanonicalHumanAuthViolation[] {
  const violations: CanonicalHumanAuthViolation[] = [];
  for (const file of files) {
    const filePath = normalized(file.path);
    if (
      CHECKER_FILES.has(filePath)
      || isTestSourcePath(filePath)
      || ARCHIVED_DOCUMENT_PREFIXES.some((prefix) =>
        filePath.startsWith(prefix)
      )
    ) {
      continue;
    }

    const codeFile = isCodeFile(filePath);
    const patterns: RegExp[] = codeFile
      ? [
          /\b(?:process\.env\.)?(?:DEFAULT_BETTER_AUTH_SECRET|BETTER_AUTH_SECRET(?:_DEFAULT)?)\s*(?:\?\?=|\|\|=|\?\?|\|\||=(?!=))\s*(["'`])([^"'`\r\n]+)\1/g,
        ]
      : [
          /\bBETTER_AUTH_SECRET[\t ]*=(?!=)[\t ]*([^\r\n#]*)/g,
        ];
    if (/\.(?:jsonc?|ya?ml)$/.test(filePath)) {
      patterns.push(
        /^[\t ]*["']?BETTER_AUTH_SECRET["']?[\t ]*:[\t ]*([^\r\n#]*)/gm,
      );
    }

    for (const pattern of patterns) {
      const matcher = new RegExp(pattern.source, pattern.flags);
      for (
        let match = matcher.exec(file.source);
        match;
        match = matcher.exec(file.source)
      ) {
        const candidate = codeFile ? match[2] ?? "" : match[1] ?? "";
        if (isGeneratedOrPlaceholderSecret(candidate)) continue;
        addViolation(violations, {
          path: filePath,
          ...locationOf(file.source, match.index),
          kind: "auth_secret",
          message:
            "usable BETTER_AUTH_SECRET example or default remains; leave examples empty or generate/load a deployment-specific secret",
        });
        if (match[0].length === 0) matcher.lastIndex += 1;
      }
    }
  }
  return violations;
}

const HTTP_ACTOR_FALLBACK_RULES = [
  [
    "nullable request-actor user fallback",
    /\breq\.actor\.userId\s*(?:\?\?|\|\|)\s*(?:["'`](?:board|unknown-user|local-board)["'`]|null)/g,
  ],
  [
    "synthetic request-actor agent fallback",
    /\breq\.actor\.agentId\s*(?:\?\?|\|\|)\s*["'`]unknown-agent["'`]/g,
  ],
] as const satisfies ReadonlyArray<readonly [string, RegExp]>;

const GENERIC_ROUTE_AGENT_ACTOR_RULES = [
  [
    "generic REST route reads runtime-agent identity",
    /\breq\.actor(?:\.|\?\.)(?:agentId|runId|companyId)\b/g,
  ],
  [
    "generic REST route branches on runtime-agent identity",
    /\breq\.actor(?:\.|\?\.)type\s*(?:===|!==)\s*["'`]agent["'`]/g,
  ],
  [
    "generic REST route retains a board-or-agent authorization helper",
    /\b(?:assertBoardOrAgent|getRuntimeAgentInfo)\b/g,
  ],
] as const satisfies ReadonlyArray<readonly [string, RegExp]>;

function addHttpActorViolation(
  violations: CanonicalHumanAuthViolation[],
  file: CanonicalHumanAuthFile,
  offset: number,
  message: string,
): void {
  addViolation(violations, {
    path: normalized(file.path),
    ...locationOf(file.source, offset),
    kind: "http_actor",
    message,
  });
}

function unwrappedExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyChain(node: ts.Expression): string[] {
  const current = unwrappedExpression(node);
  if (ts.isIdentifier(current)) return [current.text];
  if (ts.isPropertyAccessExpression(current)) {
    return [...propertyChain(current.expression), current.name.text];
  }
  if (
    ts.isElementAccessExpression(current)
    && current.argumentExpression
    && ts.isStringLiteralLike(current.argumentExpression)
  ) {
    return [
      ...propertyChain(current.expression),
      current.argumentExpression.text,
    ];
  }
  return [];
}

function isAgentLiteral(node: ts.Expression): boolean {
  const current = unwrappedExpression(node);
  return ts.isStringLiteralLike(current) && current.text === "agent";
}

function isRequestActorExpression(
  node: ts.Expression,
  actorObjectAliases: ReadonlySet<string>,
): boolean {
  const current = unwrappedExpression(node);
  if (ts.isIdentifier(current)) {
    return actorObjectAliases.has(current.text);
  }
  const chain = propertyChain(current);
  return (
    chain.length === 2
    && chain[0] === "req"
    && chain[1] === "actor"
  );
}

function isActorDiscriminant(
  node: ts.Expression,
  actorTypeAliases: ReadonlySet<string>,
  actorObjectAliases: ReadonlySet<string>,
): boolean {
  const current = unwrappedExpression(node);
  if (ts.isIdentifier(current)) {
    return actorTypeAliases.has(current.text);
  }
  if (!ts.isPropertyAccessExpression(current)) return false;
  return (
    (current.name.text === "type" || current.name.text === "actorType")
    && isRequestActorExpression(
      current.expression,
      actorObjectAliases,
    )
  );
}

function objectProperty(
  node: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return node.properties.find((property) =>
    ts.isPropertyAssignment(property)
    && propertyName(property.name) === name
  ) as ts.PropertyAssignment | undefined;
}

function scanGenericHttpActorAst(
  file: CanonicalHumanAuthFile,
  violations: CanonicalHumanAuthViolation[],
): void {
  const sourceFile = ts.createSourceFile(
    normalized(file.path),
    file.source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file.path),
  );
  const actorObjectAliases = new Set<string>();
  const actorTypeAliases = new Set<string>();

  const collectActorObjectAliases = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && isRequestActorExpression(node.initializer, actorObjectAliases)
    ) {
      actorObjectAliases.add(node.name.text);
    }
    if (
      ts.isParameter(node)
      && ts.isIdentifier(node.name)
      && node.type
      && /(?:\bRequestActor\b|Request\s*\[\s*["'`]actor["'`]\s*\])/.test(
        node.type.getText(sourceFile),
      )
    ) {
      actorObjectAliases.add(node.name.text);
    }
    ts.forEachChild(node, collectActorObjectAliases);
  };
  collectActorObjectAliases(sourceFile);

  const collectActorTypeAliases = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && isActorDiscriminant(
        node.initializer,
        actorTypeAliases,
        actorObjectAliases,
      )
    ) {
      actorTypeAliases.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && isRequestActorExpression(node.initializer, actorObjectAliases)
    ) {
      for (const element of node.name.elements) {
        if (
          ts.isIdentifier(element.name)
          && propertyName(element.propertyName ?? element.name) === "type"
        ) {
          actorTypeAliases.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, collectActorTypeAliases);
  };
  collectActorTypeAliases(sourceFile);

  const report = (node: ts.Node, message: string) => {
    addHttpActorViolation(
      violations,
      file,
      node.getStart(sourceFile),
      message,
    );
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node)
      && node.text === "getActorInfo"
    ) {
      report(
        node,
        "generic REST route retains the obsolete mixed HTTP actor compatibility wrapper",
      );
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      const equality =
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken
        || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
        || operator === ts.SyntaxKind.EqualsEqualsToken
        || operator === ts.SyntaxKind.ExclamationEqualsToken;
      if (
        equality
        && (
          (
            isAgentLiteral(node.right)
            && isActorDiscriminant(
              node.left,
              actorTypeAliases,
              actorObjectAliases,
            )
          )
          || (
            isAgentLiteral(node.left)
            && isActorDiscriminant(
              node.right,
              actorTypeAliases,
              actorObjectAliases,
            )
          )
        )
      ) {
        report(
          node,
          "generic REST route retains an aliased runtime-agent actor branch; productive agents are owned only by paperclip.run-tools/v1",
        );
      }
    }
    if (
      ts.isCaseClause(node)
      && isAgentLiteral(node.expression)
      && ts.isSwitchStatement(node.parent.parent)
      && isActorDiscriminant(
        node.parent.parent.expression,
        actorTypeAliases,
        actorObjectAliases,
      )
    ) {
      report(
        node,
        "generic REST route retains a runtime-agent actor switch branch; productive agents are owned only by paperclip.run-tools/v1",
      );
    }
    if (
      ts.isPropertyAccessExpression(node)
      && (node.name.text === "agentId" || node.name.text === "runId")
      && isRequestActorExpression(
        node.expression,
        actorObjectAliases,
      )
    ) {
      report(
        node,
        "generic REST route reads runtime-agent identity through an alias; productive agents are owned only by paperclip.run-tools/v1",
      );
    }
    if (ts.isObjectLiteralExpression(node)) {
      const actorType = objectProperty(node, "actorType");
      const hasUserActorType =
        actorType !== undefined
        && ts.isStringLiteralLike(
          unwrappedExpression(actorType.initializer),
        )
        && (
          unwrappedExpression(actorType.initializer) as ts.StringLiteral
        ).text === "user";
      if (
        hasUserActorType
        && (
          objectProperty(node, "agentId") !== undefined
          || objectProperty(node, "runId") !== undefined
        )
      ) {
        report(
          node,
          "board HTTP actor context must omit agentId and runId instead of retaining null compatibility fields",
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * Enforces the closed HTTP actor contract separately from domain-level
 * user/board owner kinds. The runtime agent variant exists only so the app can
 * reject it at the boundary after the isolated run-tools mount.
 */
export function scanHttpActorBoundary(
  files: readonly CanonicalHumanAuthFile[],
): CanonicalHumanAuthViolation[] {
  const violations: CanonicalHumanAuthViolation[] = [];
  const byPath = new Map(
    files.map((file) => [normalized(file.path), file]),
  );

  for (const file of files) {
    const filePath = normalized(file.path);
    if (
      !isCodeFile(filePath)
      || isTestSourcePath(filePath)
      || CHECKER_FILES.has(filePath)
    ) {
      continue;
    }
    for (const [label, pattern] of HTTP_ACTOR_FALLBACK_RULES) {
      const matcher = new RegExp(pattern.source, pattern.flags);
      for (
        let match = matcher.exec(file.source);
        match;
        match = matcher.exec(file.source)
      ) {
        addHttpActorViolation(
          violations,
          file,
          match.index,
          `${label} violates the canonical Better Auth actor boundary`,
        );
        if (match[0].length === 0) matcher.lastIndex += 1;
      }
    }
    const genericHttpOwner =
      (
        filePath.startsWith("apps/server/src/routes/")
        || filePath.startsWith("apps/server/src/middleware/")
      )
      && filePath !== "apps/server/src/routes/compiled-interface-only.ts";
    if (genericHttpOwner) {
      for (const [label, pattern] of GENERIC_ROUTE_AGENT_ACTOR_RULES) {
        const matcher = new RegExp(pattern.source, pattern.flags);
        for (
          let match = matcher.exec(file.source);
          match;
          match = matcher.exec(file.source)
        ) {
          addHttpActorViolation(
            violations,
            file,
            match.index,
            `${label}; productive agents are owned only by paperclip.run-tools/v1`,
          );
          if (match[0].length === 0) matcher.lastIndex += 1;
        }
      }
      scanGenericHttpActorAst(file, violations);
    }
    const retiredInviteAgentSource =
      /(?:\bsource\b|\binviteSources\b|\bINVITE_SOURCES\b)[^\n]{0,120}\bagent_api\b|\bagent_api\b[^\n]{0,120}(?:\bsource\b|\binviteSources\b|\bINVITE_SOURCES\b)/.exec(
        file.source,
      );
    if (
      filePath !== "packages/db/migrations"
      && !filePath.startsWith("packages/db/migrations/")
      && retiredInviteAgentSource
    ) {
      addHttpActorViolation(
        violations,
        file,
        retiredInviteAgentSource.index,
        "retired agent_api invite provenance remains outside historical migration artifacts",
      );
    }
  }

  for (const ownerPath of [
    "apps/server/src/routes/change-consents.ts",
    "apps/server/src/routes/openapi.ts",
  ]) {
    const owner = byPath.get(ownerPath);
    if (!owner) continue;
    const genericConsentRequest =
      /(?:router|registerCurrentRoute)[\s\S]{0,180}\bpost\b[\s\S]{0,180}\/(?:api\/)?companies\/(?::companyId|\{companyId\})\/change-consents["'`]/g
        .exec(owner.source);
    if (genericConsentRequest) {
      addHttpActorViolation(
        violations,
        owner,
        genericConsentRequest.index,
        "change-consent requests cannot be exposed as generic agent REST; the run-scoped compiled action owner must create them",
      );
    }
  }

  const runtimeAgentActionPort = byPath.get(
    "apps/server/src/services/runtime-agent-action-port.ts",
  );
  if (
    runtimeAgentActionPort
    && (
      !/\bRuntimeAgentConfigurationConsentRequired\b/.test(
        runtimeAgentActionPort.source,
      )
      || !/\brequestChangeConsent\b/.test(runtimeAgentActionPort.source)
      || !/\bchange_consent_requested\b/.test(
        runtimeAgentActionPort.source,
      )
    )
  ) {
    addHttpActorViolation(
      violations,
      runtimeAgentActionPort,
      0,
      "compiled agent_configure must own the active-run change-consent request path",
    );
  }

  const serverEntry = byPath.get("apps/server/src/index.ts");
  if (
    serverEntry
    && (
      !/\bchangeConsentGateService\s*\(/.test(serverEntry.source)
      || !/\brequestChangeConsent\s*\(/.test(serverEntry.source)
    )
  ) {
    addHttpActorViolation(
      violations,
      serverEntry,
      0,
      "server assembly must bind change-consent requests to compiled agent_configure",
    );
  }

  const declaration = byPath.get("apps/server/src/types/express.d.ts");
  if (
    declaration
    && !/\bactor\s*:\s*RequestActor\s*;/.test(declaration.source)
  ) {
    addHttpActorViolation(
      violations,
      declaration,
      0,
      "Express.Request.actor must use the canonical RequestActor union",
    );
  }

  const contract = byPath.get("apps/server/src/http/request-actor.ts");
  if (contract) {
    const requiredFragments = [
      /\buserId\s*:\s*string\s*;/,
      /\bsource\s*:\s*"session"\s*;/,
      /\bsessionId\s*:\s*string\s*;/,
      /\bsource\s*:\s*"board_key"\s*;/,
      /\bkeyId\s*:\s*string\s*;/,
      /\btype\s*:\s*"agent"\s*;/,
      /\bagentId\s*:\s*string\s*;/,
      /\bcompanyId\s*:\s*string\s*;/,
      /\brunId\s*:\s*string\s*;/,
      /\btype\s*:\s*"none"\s*;/,
      /\bsource\s*:\s*"none"\s*;/,
    ];
    for (const fragment of requiredFragments) {
      if (fragment.test(contract.source)) continue;
      addHttpActorViolation(
        violations,
        contract,
        0,
        `canonical RequestActor is missing required fragment ${fragment.source}`,
      );
    }
  }

  const middleware = byPath.get("apps/server/src/middleware/auth.ts");
  if (middleware) {
    const agentAssignment =
      /req\.actor\s*=\s*\{[^}]*\btype\s*:\s*["'`]agent["'`]/gs.exec(
        middleware.source,
      );
    if (agentAssignment) {
      addHttpActorViolation(
        violations,
        middleware,
        agentAssignment.index,
        "generic actor middleware must never mint runtime-agent identity",
      );
    }
  }

  const liveEvents = byPath.get(
    "apps/server/src/realtime/live-events-ws.ts",
  );
  if (liveEvents) {
    const authorizeStart = liveEvents.source.indexOf(
      "async function authorizeUpgrade(",
    );
    const authorizeEnd = liveEvents.source.indexOf(
      "export function setupLiveEventsWebSocketServer(",
    );
    const authorizeSource = (
      authorizeStart >= 0
      && authorizeEnd > authorizeStart
    )
      ? liveEvents.source.slice(authorizeStart, authorizeEnd)
      : "";
    const exactSessionBindingGuard =
      /if\s*\(\s*!\s*\(\s*isNonEmptyActorId\s*\(\s*session\?\.user\?\.id\s*\)\s*&&\s*isNonEmptyActorId\s*\(\s*session\.session\?\.id\s*\)\s*&&\s*isNonEmptyActorId\s*\(\s*session\.session\.userId\s*\)\s*&&\s*session\.session\.userId\s*===\s*session\.user\.id\s*\)\s*\)\s*\{\s*return\s+null\s*;?\s*\}/m;
    const guard = exactSessionBindingGuard.exec(authorizeSource);
    const authorizationRead = authorizeSource.indexOf(
      "const [roleRow, memberships] = await Promise.all([",
    );
    if (
      !guard
      || authorizationRead < 0
      || guard.index >= authorizationRead
    ) {
      addHttpActorViolation(
        violations,
        liveEvents,
        Math.max(authorizeStart, 0),
        "live-events WebSocket authorization must reject unless nonblank session.session.userId exactly equals session.user.id before role or membership reads",
      );
    }
  }

  const app = byPath.get("apps/server/src/app.ts");
  if (app) {
    const runTools = app.source.indexOf(
      'app.use("/api", runToolsRoutes(',
    );
    const actorMiddleware = app.source.indexOf(
      "actorMiddleware(db, {",
    );
    const runBearerWall = app.source.indexOf(
      'app.use("/api", rejectRunInterfaceBearerFromGenericApi());',
    );
    const authOwner = app.source.indexOf(
      'app.all("/api/auth/{*authPath}", opts.betterAuthHandler);',
    );
    const genericAgentDeny = app.source.indexOf(
      'app.use("/api", denyGenericAgentRest("REST"));',
    );
    if (
      runTools < 0
      || actorMiddleware < 0
      || runBearerWall < 0
      || authOwner < 0
      || genericAgentDeny < 0
      || !(runTools < actorMiddleware)
      || !(runTools < runBearerWall)
      || !(runBearerWall < actorMiddleware)
      || !(actorMiddleware < authOwner)
      || !(authOwner < genericAgentDeny)
    ) {
      addHttpActorViolation(
        violations,
        app,
        0,
        "run tools must mount before the generic run-bearer wall and actor middleware, with Better Auth followed by the generic-agent REST denial",
      );
    }
  }

  const namedGatewayRoutes = byPath.get(
    "apps/server/src/routes/tool-gateway.ts",
  );
  if (
    namedGatewayRoutes
    && !/\bassertRunBearerRejectedByNamedGateway\b/.test(
      namedGatewayRoutes.source,
    )
  ) {
    addHttpActorViolation(
      violations,
      namedGatewayRoutes,
      0,
      "named MCP gateway routes must categorically reject run-interface bearer credentials",
    );
  }

  return violations;
}

function propertyName(node: ts.Node): string | null {
  if (
    ts.isIdentifier(node)
    || ts.isStringLiteral(node)
    || ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return null;
}

function callPropertyName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node)
    && node.argumentExpression
  ) {
    return propertyName(node.argumentExpression);
  }
  return null;
}

function collectWorkspacePackages(
  files: readonly CanonicalHumanAuthFile[],
): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const file of files) {
    const filePath = normalized(file.path);
    if (!filePath.endsWith("package.json")) continue;
    try {
      const parsed = JSON.parse(file.source) as {
        name?: unknown;
        exports?: unknown;
        main?: unknown;
      };
      if (typeof parsed.name !== "string") continue;
      const packageRoot = path.posix.dirname(filePath);
      const packageExports: Record<string, string> = {};
      if (
        parsed.exports
        && typeof parsed.exports === "object"
        && !Array.isArray(parsed.exports)
      ) {
        for (
          const [key, value] of Object.entries(
            parsed.exports as Record<string, unknown>,
          )
        ) {
          if (typeof value === "string") packageExports[key] = value;
        }
      } else if (typeof parsed.main === "string") {
        packageExports["."] = parsed.main;
      }
      packages.set(parsed.name, {
        root: packageRoot === "." ? "" : packageRoot,
        exports: packageExports,
      });
    } catch {
      // Invalid package metadata is owned by other repository validation.
    }
  }
  return packages;
}

function candidateSourcePaths(base: string): string[] {
  const value = normalized(base);
  const extension = path.posix.extname(value);
  const candidates = [value];
  if (extension) {
    const withoutExtension = value.slice(0, -extension.length);
    candidates.push(
      `${withoutExtension}.ts`,
      `${withoutExtension}.tsx`,
      `${withoutExtension}.mts`,
      `${withoutExtension}.cts`,
      `${withoutExtension}.js`,
      `${withoutExtension}.jsx`,
      `${withoutExtension}.mjs`,
      `${withoutExtension}.cjs`,
    );
  } else {
    for (const sourceExtensionValue of SOURCE_EXTENSIONS) {
      candidates.push(`${value}${sourceExtensionValue}`);
      candidates.push(
        `${value}/index${sourceExtensionValue}`,
      );
    }
  }
  return [...new Set(candidates)];
}

function resolveModuleSpecifier(
  importer: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
  workspacePackages: ReadonlyMap<string, WorkspacePackage>,
): string | null {
  let base: string | null = null;
  if (specifier.startsWith(".")) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(importer), specifier),
    );
  } else {
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0]!;
    const packageInfo = workspacePackages.get(packageName);
    if (packageInfo) {
      const subpath = specifier.slice(packageName.length);
      const exportKey = subpath ? `.${subpath}` : ".";
      let target = packageInfo.exports[exportKey];
      if (!target) {
        const wildcard = Object.entries(packageInfo.exports).find(
          ([key]) => key.includes("*")
          && exportKey.startsWith(key.slice(0, key.indexOf("*"))),
        );
        if (wildcard) {
          const [key, pattern] = wildcard;
          const wildcardValue = exportKey.slice(
            key.indexOf("*"),
            exportKey.length - (key.length - key.indexOf("*") - 1),
          );
          target = pattern.replace("*", wildcardValue);
        }
      }
      if (target) {
        base = path.posix.join(
          packageInfo.root,
          target.replace(/^\.\//, ""),
        );
      }
    }
  }
  if (!base) return null;
  return (
    candidateSourcePaths(base).find((candidate) =>
      knownPaths.has(candidate)
    ) ?? null
  );
}

function moduleSpecifiers(
  sourceFile: ts.SourceFile,
): Array<{ node: ts.Node; specifier: string }> {
  const imports: Array<{ node: ts.Node; specifier: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({
        node,
        specifier: node.moduleSpecifier.text,
      });
    } else if (
      ts.isCallExpression(node)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (
          ts.isIdentifier(node.expression)
          && node.expression.text === "require"
        )
      )
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0]!)
    ) {
      imports.push({
        node,
        specifier: node.arguments[0]!.text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function parseModules(
  files: readonly CanonicalHumanAuthFile[],
): Map<string, ParsedModule> {
  const codeFiles = files.filter((file) =>
    isCodeFile(normalized(file.path))
    && !CHECKER_FILES.has(normalized(file.path))
  );
  const knownPaths = new Set(
    files.map((file) => normalized(file.path)),
  );
  const workspacePackages = collectWorkspacePackages(files);
  const modules = new Map<string, ParsedModule>();

  for (const file of codeFiles) {
    const filePath = normalized(file.path);
    const sourceFile = ts.createSourceFile(
      filePath,
      file.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(filePath),
    );
    const bindings = new Map<string, AuthTable>();
    const namespaceTargets = new Map<string, string | null>();
    const stringBindings = new Map<string, string>();

    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement)
        && statement.importClause?.namedBindings
      ) {
        const target = ts.isStringLiteral(statement.moduleSpecifier)
          ? resolveModuleSpecifier(
              filePath,
              statement.moduleSpecifier.text,
              knownPaths,
              workspacePackages,
            )
          : null;
        const namedBindings = statement.importClause.namedBindings;
        if (ts.isNamespaceImport(namedBindings)) {
          namespaceTargets.set(namedBindings.name.text, target);
        } else {
          for (const element of namedBindings.elements) {
            const importedName =
              element.propertyName?.text ?? element.name.text;
            if (AUTH_TABLES.has(importedName)) {
              bindings.set(
                element.name.text,
                importedName as AuthTable,
              );
            }
          }
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name)
            && AUTH_TABLES.has(declaration.name.text)
          ) {
            bindings.set(
              declaration.name.text,
              declaration.name.text as AuthTable,
            );
          }
          if (
            ts.isIdentifier(declaration.name)
            && declaration.initializer
            && (
              ts.isStringLiteral(declaration.initializer)
              || ts.isNoSubstitutionTemplateLiteral(
                declaration.initializer,
              )
            )
          ) {
            stringBindings.set(
              declaration.name.text,
              declaration.initializer.text,
            );
          }
        }
      }
    }

    modules.set(filePath, {
      file: { path: filePath, source: file.source },
      sourceFile,
      bindings,
      namespaceTargets,
      exports: new Map(),
      exportStars: [],
      imports: moduleSpecifiers(sourceFile).map((entry) => ({
        ...entry,
        target: resolveModuleSpecifier(
          filePath,
          entry.specifier,
          knownPaths,
          workspacePackages,
        ),
      })),
      stringBindings,
    });
  }

  const resolveOrigin = (
    module: ParsedModule,
    expression: ts.Expression,
  ): AuthTable | undefined => {
    if (ts.isParenthesizedExpression(expression)) {
      return resolveOrigin(module, expression.expression);
    }
    if (ts.isIdentifier(expression)) {
      return module.bindings.get(expression.text);
    }
    if (
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    ) {
      const member = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : expression.argumentExpression
          ? propertyName(expression.argumentExpression)
          : null;
      const owner = expression.expression;
      if (!member || !ts.isIdentifier(owner)) return undefined;
      if (AUTH_TABLES.has(member)) return member as AuthTable;
      const target = module.namespaceTargets.get(owner.text);
      if (target) return modules.get(target)?.exports.get(member);
    }
    return undefined;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const module of modules.values()) {
      for (const statement of module.sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
          const target = ts.isStringLiteral(statement.moduleSpecifier)
            ? module.imports.find((entry) =>
                entry.node === statement
              )?.target
            : null;
          const namedBindings =
            statement.importClause?.namedBindings;
          if (
            target
            && namedBindings
            && ts.isNamedImports(namedBindings)
          ) {
            for (const element of namedBindings.elements) {
              const imported =
                element.propertyName?.text ?? element.name.text;
              const origin = modules.get(target)?.exports.get(imported);
              if (
                origin
                && module.bindings.get(element.name.text) !== origin
              ) {
                module.bindings.set(element.name.text, origin);
                changed = true;
              }
            }
          }
        }

        if (ts.isVariableStatement(statement)) {
          for (
            const declaration of statement.declarationList.declarations
          ) {
            if (!declaration.initializer) continue;
            if (ts.isIdentifier(declaration.name)) {
              const origin = resolveOrigin(
                module,
                declaration.initializer,
              );
              if (
                origin
                && module.bindings.get(declaration.name.text) !== origin
              ) {
                module.bindings.set(declaration.name.text, origin);
                changed = true;
              }
              if (
                ts.isIdentifier(declaration.initializer)
                && module.namespaceTargets.has(
                  declaration.initializer.text,
                )
                && !module.namespaceTargets.has(declaration.name.text)
              ) {
                module.namespaceTargets.set(
                  declaration.name.text,
                  module.namespaceTargets.get(
                    declaration.initializer.text,
                  ) ?? null,
                );
                changed = true;
              }
            } else if (
              ts.isObjectBindingPattern(declaration.name)
              && ts.isIdentifier(declaration.initializer)
              && module.namespaceTargets.has(
                declaration.initializer.text,
              )
            ) {
              const target = module.namespaceTargets.get(
                declaration.initializer.text,
              );
              for (const element of declaration.name.elements) {
                if (!ts.isIdentifier(element.name)) continue;
                const imported =
                  propertyName(element.propertyName ?? element.name);
                if (!imported) continue;
                const origin = AUTH_TABLES.has(imported)
                  ? imported as AuthTable
                  : target
                    ? modules.get(target)?.exports.get(imported)
                    : undefined;
                if (
                  origin
                  && module.bindings.get(element.name.text) !== origin
                ) {
                  module.bindings.set(element.name.text, origin);
                  changed = true;
                }
              }
            }
          }
        }

        if (ts.isExportDeclaration(statement)) {
          const target = statement.moduleSpecifier
            ? module.imports.find((entry) =>
                entry.node === statement
              )?.target
            : null;
          if (
            statement.exportClause
            && ts.isNamedExports(statement.exportClause)
          ) {
            for (const element of statement.exportClause.elements) {
              const localName =
                element.propertyName?.text ?? element.name.text;
              const origin = target
                ? (
                    AUTH_TABLES.has(localName)
                      ? localName as AuthTable
                      : modules.get(target)?.exports.get(localName)
                  )
                : module.bindings.get(localName);
              if (
                origin
                && module.exports.get(element.name.text) !== origin
              ) {
                module.exports.set(element.name.text, origin);
                changed = true;
              }
            }
          } else if (target) {
            if (!module.exportStars.includes(target)) {
              module.exportStars.push(target);
            }
            for (
              const [exportName, origin] of
              modules.get(target)?.exports ?? []
            ) {
              if (module.exports.get(exportName) !== origin) {
                module.exports.set(exportName, origin);
                changed = true;
              }
            }
          }
        }

        if (
          ts.isVariableStatement(statement)
          && statement.modifiers?.some(
            (modifier) =>
              modifier.kind === ts.SyntaxKind.ExportKeyword,
          )
        ) {
          for (
            const declaration of statement.declarationList.declarations
          ) {
            if (!ts.isIdentifier(declaration.name)) continue;
            const origin = module.bindings.get(declaration.name.text);
            if (
              origin
              && module.exports.get(declaration.name.text) !== origin
            ) {
              module.exports.set(declaration.name.text, origin);
              changed = true;
            }
          }
        }
      }
    }
  }
  return modules;
}

function expressionOrigin(
  modules: ReadonlyMap<string, ParsedModule>,
  module: ParsedModule,
  expression: ts.Expression,
): AuthTable | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return expressionOrigin(modules, module, expression.expression);
  }
  if (ts.isIdentifier(expression)) {
    return module.bindings.get(expression.text);
  }
  if (
    ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression)
  ) {
    const member = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : expression.argumentExpression
        ? propertyName(expression.argumentExpression)
        : null;
    if (!member || !ts.isIdentifier(expression.expression)) {
      return undefined;
    }
    if (AUTH_TABLES.has(member)) return member as AuthTable;
    const target = module.namespaceTargets.get(
      expression.expression.text,
    );
    return target ? modules.get(target)?.exports.get(member) : undefined;
  }
  return undefined;
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current)
      || ts.isMethodDeclaration(current)
      || ts.isFunctionExpression(current)
    ) {
      return current.name ? propertyName(current.name) : null;
    }
    if (
      ts.isArrowFunction(current)
      && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return null;
}

function isAllowedAuthWriterOwner(
  file: string,
  node: ts.Node,
): boolean {
  if (file === "apps/server/src/auth/better-auth.ts") return true;
  if (file !== "packages/db/backup-lib.ts") return false;
  return new Set([
    "restoreCompleteArchive",
    "runDatabaseRestore",
  ]).has(enclosingFunctionName(node) ?? "");
}

const RAW_AUTH_MUTATION =
  /\b(insert\s+into|merge\s+into|update|delete\s+from)\s+(?:(?:"?[a-z0-9_]+"?)\.)?"?(user|account|session|verification)"?\b/gi;

interface AuthMutation {
  node: ts.Node;
  message: string;
}

function sqlCallName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  return callPropertyName(expression);
}

function sqlStringBindings(module: ParsedModule): Set<string> {
  const bindings = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callName = sqlCallName(node.expression);
      if (
        callName
        && ["execute", "query", "raw", "unsafe"].includes(callName)
      ) {
        for (const argument of node.arguments) {
          if (ts.isIdentifier(argument)) bindings.add(argument.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module.sourceFile);
  return bindings;
}

function isSqlTextNode(
  module: ParsedModule,
  node:
    | ts.StringLiteral
    | ts.NoSubstitutionTemplateLiteral
    | ts.TaggedTemplateExpression,
  referencedSqlStrings: ReadonlySet<string>,
): boolean {
  if (ts.isTaggedTemplateExpression(node)) {
    const tagName = sqlCallName(node.tag);
    return tagName === "sql" || tagName === "raw";
  }
  if (
    ts.isCallExpression(node.parent)
    && node.parent.arguments.includes(node)
  ) {
    const callName = sqlCallName(node.parent.expression);
    return Boolean(
      callName
      && ["execute", "query", "raw", "unsafe"].includes(callName),
    );
  }
  return Boolean(
    ts.isVariableDeclaration(node.parent)
    && ts.isIdentifier(node.parent.name)
    && referencedSqlStrings.has(node.parent.name.text),
  );
}

function collectAuthMutations(
  modules: ReadonlyMap<string, ParsedModule>,
  module: ParsedModule,
): AuthMutation[] {
  const mutations: AuthMutation[] = [];
  const referencedSqlStrings = sqlStringBindings(module);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const operation = callPropertyName(node.expression);
      if (
        operation
        && ["delete", "insert", "update", "upsert"].includes(operation)
        && node.arguments[0]
        && ts.isExpression(node.arguments[0])
      ) {
        const table = expressionOrigin(
          modules,
          module,
          node.arguments[0],
        );
        if (table) {
          mutations.push({
            node,
            message:
              `direct ${operation}(${table}) bypasses Better Auth`,
          });
        }
      }
    }

    if (
      ts.isStringLiteral(node)
      || (
        ts.isNoSubstitutionTemplateLiteral(node)
        && !ts.isTaggedTemplateExpression(node.parent)
      )
      || ts.isTaggedTemplateExpression(node)
    ) {
      if (!isSqlTextNode(module, node, referencedSqlStrings)) {
        ts.forEachChild(node, visit);
        return;
      }
      const value = ts.isTaggedTemplateExpression(node)
        ? node.template.getText(module.sourceFile)
        : node.text;
      const matcher = new RegExp(
        RAW_AUTH_MUTATION.source,
        RAW_AUTH_MUTATION.flags,
      );
      for (
        let match = matcher.exec(value);
        match;
        match = matcher.exec(value)
      ) {
        mutations.push({
          node,
          message:
            `raw SQL ${match[1]!.toLowerCase()} of Better Auth table ${match[2]!.toLowerCase()} bypasses Better Auth`,
        });
        if (match[0].length === 0) matcher.lastIndex += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module.sourceFile);
  return mutations;
}

export function scanBetterAuthTableWriters(
  files: readonly CanonicalHumanAuthFile[],
): CanonicalHumanAuthViolation[] {
  const modules = parseModules(files);
  const violations: CanonicalHumanAuthViolation[] = [];
  for (const module of modules.values()) {
    const file = module.file.path;
    if (isTestSourcePath(file)) continue;
    for (const mutation of collectAuthMutations(modules, module)) {
      if (isAllowedAuthWriterOwner(file, mutation.node)) continue;
      addViolation(violations, {
        path: file,
        ...nodeLocation(module.sourceFile, mutation.node),
        kind: "auth_table_writer",
        message: mutation.message,
      });
    }
  }
  return violations;
}

export function scanProductionImportsOfTestSetup(
  files: readonly CanonicalHumanAuthFile[],
): CanonicalHumanAuthViolation[] {
  const modules = parseModules(files);
  const violations: CanonicalHumanAuthViolation[] = [];
  const authSetupFiles = new Set(
    [...modules.values()]
      .filter((module) =>
        isTestSourcePath(module.file.path)
        && collectAuthMutations(modules, module).length > 0
      )
      .map((module) => module.file.path),
  );

  const reachesAuthSetup = (
    target: string,
    seen = new Set<string>(),
  ): string | null => {
    if (authSetupFiles.has(target)) return target;
    if (seen.has(target)) return null;
    seen.add(target);
    const targetModule = modules.get(target);
    if (!targetModule) return null;
    for (const nested of targetModule.imports) {
      if (!nested.target) continue;
      const reached = reachesAuthSetup(nested.target, seen);
      if (reached) return reached;
    }
    return null;
  };

  for (const module of modules.values()) {
    if (isTestSourcePath(module.file.path)) continue;
    for (const imported of module.imports) {
      if (!imported.target) continue;
      const authSetup = reachesAuthSetup(imported.target);
      if (!authSetup) continue;
      addViolation(violations, {
        path: module.file.path,
        ...nodeLocation(module.sourceFile, imported.node),
        kind: "production_test_import",
        message:
          `shipped code imports test-local account setup ${authSetup} through ${imported.specifier}`,
      });
    }
  }
  return violations;
}

function routePath(
  module: ParsedModule,
  expression: ts.Expression | undefined,
): string | null {
  if (!expression) return null;
  if (
    ts.isStringLiteral(expression)
    || ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) {
    return module.stringBindings.get(expression.text) ?? null;
  }
  return null;
}

function isAuthNamespacePath(value: string): boolean {
  return /^\/api\/auth(?:\/|$|\{|\*)/.test(value)
    || /^\/auth(?:\/|$|\{|\*)/.test(value);
}

function isBetterAuthHandlerExpression(
  expression: ts.Expression | undefined,
): boolean {
  if (!expression) return false;
  if (ts.isIdentifier(expression)) {
    return expression.text === "betterAuthHandler";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "betterAuthHandler";
  }
  return false;
}

function hasConditionalAncestor(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isIfStatement(current)
      || ts.isConditionalExpression(current)
      || (
        ts.isBinaryExpression(current)
        && (
          current.operatorToken.kind
            === ts.SyntaxKind.AmpersandAmpersandToken
          || current.operatorToken.kind
            === ts.SyntaxKind.BarBarToken
          || current.operatorToken.kind
            === ts.SyntaxKind.QuestionQuestionToken
        )
      )
    ) {
      return true;
    }
    if (
      ts.isFunctionDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current)
      || ts.isMethodDeclaration(current)
    ) {
      return false;
    }
  }
  return false;
}

function betterAuthHandlerFactoryCount(
  modules: ReadonlyMap<string, ParsedModule>,
): number {
  const index = modules.get("apps/server/src/index.ts");
  if (!index) return 0;
  const importsCanonicalModule = index.imports.some(
    (entry) => entry.specifier === "./auth/better-auth.js",
  );
  if (!importsCanonicalModule) return 0;

  let count = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "betterAuthHandler"
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === "createBetterAuthHandler"
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(index.sourceFile);
  return count;
}

function betterAuthHandlerInjectionCount(
  modules: ReadonlyMap<string, ParsedModule>,
): number {
  const index = modules.get("apps/server/src/index.ts");
  if (!index) return 0;
  let count = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "createApp"
    ) {
      for (const argument of node.arguments) {
        if (!ts.isObjectLiteralExpression(argument)) continue;
        for (const property of argument.properties) {
          if (
            ts.isShorthandPropertyAssignment(property)
            && property.name.text === "betterAuthHandler"
          ) {
            count += 1;
          } else if (
            ts.isPropertyAssignment(property)
            && propertyName(property.name) === "betterAuthHandler"
            && isBetterAuthHandlerExpression(property.initializer)
          ) {
            count += 1;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(index.sourceFile);
  return count;
}

export function scanAuthNamespaceOwnership(
  files: readonly CanonicalHumanAuthFile[],
): CanonicalHumanAuthViolation[] {
  const modules = parseModules(files);
  const violations: CanonicalHumanAuthViolation[] = [];
  const registrations: Array<{
    file: string;
    node: ts.CallExpression;
    method: string;
    route: string;
    canonical: boolean;
  }> = [];

  for (const module of modules.values()) {
    if (
      isTestSourcePath(module.file.path)
      || !module.file.path.startsWith("apps/server/src/")
    ) {
      continue;
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const method = callPropertyName(node.expression);
        const route = routePath(module, node.arguments[0]);
        if (
          method
          && ROUTE_METHODS.has(method)
          && route
          && isAuthNamespacePath(route)
        ) {
          registrations.push({
            file: module.file.path,
            node,
            method,
            route,
            canonical:
              module.file.path === "apps/server/src/app.ts"
              && method === "all"
              && route === "/api/auth/{*authPath}"
              && isBetterAuthHandlerExpression(node.arguments[1])
              && !hasConditionalAncestor(node),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
  }

  for (const registration of registrations) {
    if (registration.canonical) continue;
    const module = modules.get(registration.file)!;
    addViolation(violations, {
      path: registration.file,
      ...nodeLocation(module.sourceFile, registration.node),
      kind: "auth_namespace_owner",
      message:
        `${registration.method}(${JSON.stringify(registration.route)}) competes with the Better Auth namespace owner`,
    });
  }

  const canonical = registrations.filter((entry) => entry.canonical);
  if (registrations.length !== 1 || canonical.length !== 1) {
    addViolation(violations, {
      path: "apps/server/src/app.ts",
      line: 1,
      column: 1,
      kind: "auth_namespace_owner",
      message:
        `expected exactly one unconditional /api/auth/* registration owned by app.all("/api/auth/{*authPath}", betterAuthHandler); found ${registrations.length} registration(s), ${canonical.length} canonical`,
    });
  }
  const factoryCount = betterAuthHandlerFactoryCount(modules);
  const injectionCount = betterAuthHandlerInjectionCount(modules);
  if (factoryCount !== 1 || injectionCount !== 1) {
    addViolation(violations, {
      path: "apps/server/src/index.ts",
      line: 1,
      column: 1,
      kind: "auth_namespace_owner",
      message:
        `expected one createBetterAuthHandler(auth) owner imported from ./auth/better-auth.js and one createApp injection; found ${factoryCount} factory assignment(s), ${injectionCount} injection(s)`,
    });
  }
  return violations;
}

export function scanCanonicalHumanAuthFiles(
  files: readonly CanonicalHumanAuthFile[],
): CanonicalHumanAuthViolation[] {
  return [
    ...scanRetiredHumanIdentityTokens(files),
    ...scanBetterAuthSecretBoundary(files),
    ...scanHttpActorBoundary(files),
    ...scanBetterAuthTableWriters(files),
    ...scanProductionImportsOfTestSetup(files),
    ...scanAuthNamespaceOwnership(files),
  ].sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.line - right.line
    || left.column - right.column
    || left.kind.localeCompare(right.kind)
    || left.message.localeCompare(right.message)
  );
}

function shouldSkipDirectory(relativePath: string, name: string): boolean {
  const value = normalized(relativePath);
  return (
    SKIPPED_DIRECTORY_NAMES.has(name)
    || value === "packages/db/migrations"
    || ARCHIVED_DOCUMENT_PREFIXES.some((prefix) =>
      `${value}/`.startsWith(prefix)
    )
  );
}

async function walkRepository(
  directory: string,
  repositoryRoot: string,
  files: CanonicalHumanAuthFile[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = normalized(path.relative(repositoryRoot, absolute));
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(relative, entry.name)) {
        await walkRepository(absolute, repositoryRoot, files);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (
      !SCANNED_TEXT_EXTENSIONS.has(path.extname(entry.name))
      && entry.name !== "Dockerfile"
    ) {
      continue;
    }
    files.push({
      path: relative,
      source: await fs.readFile(absolute, "utf8"),
    });
  }
}

export async function listCanonicalHumanAuthFiles(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<CanonicalHumanAuthFile[]> {
  const files: CanonicalHumanAuthFile[] = [];
  for (const root of SOURCE_ROOTS) {
    await walkRepository(
      path.resolve(repositoryRoot, root),
      repositoryRoot,
      files,
    );
  }
  for (const rootFile of ROOT_FILES) {
    const absolute = path.resolve(repositoryRoot, rootFile);
    try {
      files.push({
        path: rootFile,
        source: await fs.readFile(absolute, "utf8"),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files.sort((left, right) =>
    left.path.localeCompare(right.path)
  );
}

export async function checkCanonicalHumanAuth(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<CanonicalHumanAuthViolation[]> {
  return scanCanonicalHumanAuthFiles(
    await listCanonicalHumanAuthFiles(repositoryRoot),
  );
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const violations = await checkCanonicalHumanAuth();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `${violation.path}:${violation.line}:${violation.column} [${violation.kind}] ${violation.message}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      "Canonical Better Auth human-account boundary check passed.",
    );
  }
}
