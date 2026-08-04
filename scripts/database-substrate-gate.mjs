import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const retiredRuntime = ["embed", "ded"].join("");
const postgresName = ["post", "gres"].join("");
const optionalSqliteDriver = ["pg", "lite"].join("");
const checkScriptName = ["check:no-", retiredRuntime, "-", postgresName].join("");

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "ui-dist",
  "coverage",
  ".turbo",
]);

function isPrivateEnvironmentFile(name) {
  const normalized = name.toLowerCase();
  if (normalized === ".env") return true;
  if (!normalized.startsWith(".env.")) return false;
  return !/(?:^|\.)(?:example|sample|template|dist)$/.test(normalized);
}

const rules = [
  {
    id: "retired-runtime",
    pattern: new RegExp(`${retiredRuntime}[-_ ]?${postgresName}`, "i"),
  },
  {
    id: "retired-driver",
    pattern: new RegExp(optionalSqliteDriver, "i"),
  },
  {
    id: "local-cluster-lifecycle",
    pattern: new RegExp(
      ["init", "db"].join("") +
        "|" +
        ["pg", "_ctl"].join("") +
        "|" +
        ["post", "master"].join(""),
      "i",
    ),
  },
  {
    id: "local-cluster-state",
    pattern: new RegExp(["PG", "_VERSION"].join(""), "i"),
  },
];

const localTargetPattern = /postgres(?:ql)?:\/\/[^\s"'`]*@(?:localhost|127\.0\.0\.1|\[::1\])(?::5432)?\//i;
const directRuntimeCategories = new Set(["source", "script", "configuration"]);

export function categoryForPath(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, "/");
  const basename = path.posix.basename(normalized).toLowerCase();

  if (normalized === "pnpm-lock.yaml" || basename === "package.json" || normalized.startsWith("patches/")) {
    return "package-resolution";
  }
  if (normalized.startsWith(".github/workflows/")) return "ci";
  if (normalized.startsWith("docker/")) return "container";
  if (
    normalized.startsWith("doc/") ||
    normalized.startsWith("apps/docs/") ||
    normalized.startsWith("releases/") ||
    normalized.startsWith("report/") ||
    /\.mdx?$/i.test(basename) ||
    basename === "readme.md" ||
    basename === "agents.md"
  ) {
    return "documentation";
  }
  if (
    normalized.includes("/__tests__/") ||
    normalized.includes("/tests/") ||
    normalized.startsWith("tests/") ||
    /(?:^|\.)test\.[cm]?[jt]sx?$/.test(basename)
  ) {
    return "test";
  }
  if (normalized.startsWith("scripts/")) return "script";
  if (
    basename === ".npmrc" ||
    /(?:^|\/)(?:\.env|.*config\.(?:json|ya?ml))$/i.test(normalized)
  ) {
    return "configuration";
  }
  return "source";
}

function removeOwnCommandReferences(relativePath, source) {
  if (relativePath === "package.json") {
    try {
      const manifest = JSON.parse(source);
      if (manifest.scripts && typeof manifest.scripts === "object") {
        delete manifest.scripts[checkScriptName];
      }
      source = JSON.stringify(manifest);
    } catch {
      // The repository's normal JSON validation will report malformed metadata.
    }
  }

  if (relativePath === "scripts/run-production-boundaries.mjs") {
    source = source.replaceAll(`"${checkScriptName}"`, "");
  }

  for (const invocation of [
    `pnpm run ${checkScriptName}`,
    `pnpm ${checkScriptName}`,
    `npm run ${checkScriptName}`,
  ]) {
    source = source.replaceAll(invocation, "");
  }
  return source;
}

function packageResolutionSource(source) {
  const lines = source.split(/\r?\n/);
  const retained = [];
  let withinPackages = false;
  let skippedDeclarationIndent = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (trimmed && indent === 0) {
      withinPackages = trimmed === "packages:";
      skippedDeclarationIndent = null;
    }

    if (skippedDeclarationIndent !== null) {
      if (!trimmed || indent > skippedDeclarationIndent) {
        continue;
      }
      skippedDeclarationIndent = null;
    }

    if (
      withinPackages &&
      indent === 4 &&
      /^(?:peerDependencies|peerDependenciesMeta):$/.test(trimmed)
    ) {
      skippedDeclarationIndent = indent;
      continue;
    }

    retained.push(line);
  }

  return retained.join("\n");
}

function sourceForScan(relativePath, source) {
  let normalized = removeOwnCommandReferences(relativePath, source);
  if (relativePath === "pnpm-lock.yaml") {
    normalized = packageResolutionSource(normalized);
  }
  return normalized;
}

function lineNumber(source, matchIndex) {
  return source.slice(0, matchIndex).split("\n").length;
}

/**
 * Pure scanner used by the executable gate and focused tests. pnpm's
 * `packages` section copies unresolved upstream peer declarations from package
 * manifests; those declarations are not dependency-graph edges. Importers,
 * package resolutions, optional dependencies, and resolved peer bindings all
 * remain in the scanned source.
 */
export function scanDatabaseSubstrateFiles(files) {
  const violations = [];
  for (const file of files) {
    const relativePath = file.path.replaceAll(path.sep, "/");
    const category = categoryForPath(relativePath);
    const source = sourceForScan(relativePath, file.source);

    if (
      (relativePath === ".npmrc" &&
        /^\s*auto-install-peers\s*=\s*true\s*$/im.test(source)) ||
      (relativePath === "pnpm-lock.yaml" &&
        /^\s*autoInstallPeers:\s*true\s*$/m.test(source))
    ) {
      violations.push({
        category,
        path: relativePath,
        line: lineNumber(source, source.search(/auto-?install-?peers/i)),
        rule: "optional-peer-auto-install",
      });
    }

    for (const rule of rules) {
      const match = rule.pattern.exec(source);
      if (match) {
        violations.push({
          category,
          path: relativePath,
          line: lineNumber(source, match.index),
          rule: rule.id,
        });
      }
    }

    if (directRuntimeCategories.has(category)) {
      const match = localTargetPattern.exec(source);
      if (match) {
        violations.push({
          category,
          path: relativePath,
          line: lineNumber(source, match.index),
          rule: "default-local-target",
        });
      }
    }
  }
  return violations;
}

async function filesAt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    if (entry.isFile() && isPrivateEnvironmentFile(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesAt(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

export async function scanDatabaseSubstrateRepository(root) {
  const paths = await filesAt(root);
  const files = [];
  for (const file of paths) {
    const bytes = await readFile(file);
    if (bytes.includes(0)) continue;
    files.push({
      path: path.relative(root, file),
      source: bytes.toString("utf8"),
    });
  }
  return scanDatabaseSubstrateFiles(files);
}

export async function assertExternalDatabaseSubstrate(root) {
  const violations = await scanDatabaseSubstrateRepository(root);
  if (violations.length > 0) {
    const details = violations
      .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line)
      .map((violation) =>
        `- [${violation.category}] ${violation.path}:${violation.line} (${violation.rule})`,
      )
      .join("\n");
    throw new Error(`External PostgreSQL-only boundary violations:\n${details}`);
  }
}
