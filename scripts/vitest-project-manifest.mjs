import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

export const generalServerLane = "general-server";
export const generalWorkspacesALane = "general-workspaces-a";
export const generalWorkspacesBLane = "general-workspaces-b";
export const serializedWorkspaceLane = "serialized-workspace";

export const vitestProjectSearchRoots = Object.freeze([
  "apps",
  "packages",
]);

const ignoredDirectoryNames = new Set([
  ".git",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const vitestFilePattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

function normalizedRepoPath(repoRoot, absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function collectPackageJsonPaths(absoluteRoot, output) {
  if (!existsSync(absoluteRoot)) return;

  const entries = readdirSync(absoluteRoot, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
    output.push(path.join(absoluteRoot, "package.json"));
  }

  // Keep walking after a package boundary. First-party standalone packages can
  // contain another independently testable package (the Cloudflare bridge is
  // one), and every such boundary must own its tests exactly once.
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      ignoredDirectoryNames.has(entry.name)
    ) {
      continue;
    }
    collectPackageJsonPaths(path.join(absoluteRoot, entry.name), output);
  }
}

function collectOwnedTestFiles(repoRoot, projectRoot) {
  const files = [];

  function visit(currentDirectory) {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolute = path.join(currentDirectory, entry.name);
      if (entry.isFile() && vitestFilePattern.test(entry.name)) {
        files.push(normalizedRepoPath(repoRoot, absolute));
        continue;
      }
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        ignoredDirectoryNames.has(entry.name)
      ) {
        continue;
      }
      if (existsSync(path.join(absolute, "package.json"))) continue;
      visit(absolute);
    }
  }

  visit(projectRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function parseWorkspaceEntries(workspaceText) {
  return workspaceText
    .split("\n")
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] ?? null)
    .map((entry) => entry?.replace(/^(['"])(.*)\1$/, "$2") ?? null)
    .filter(Boolean)
    .map((entry) => ({
      pattern: entry.startsWith("!") ? entry.slice(1) : entry,
      negated: entry.startsWith("!"),
    }));
}

function globToRegExp(pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += /[|\\{}()[\]^$+?.]/.test(character)
        ? `\\${character}`
        : character;
    }
  }
  return new RegExp(`^${expression}$`);
}

function isWorkspacePackage(projectPath, workspaceEntries) {
  let included = false;
  for (const entry of workspaceEntries) {
    if (globToRegExp(entry.pattern).test(projectPath)) {
      included = !entry.negated;
    }
  }
  return included;
}

function laneForProject(projectPath) {
  if (projectPath === "apps/server") return generalServerLane;
  if (projectPath === "packages/db") return serializedWorkspaceLane;
  if (projectPath === "apps/ui" || projectPath === "packages/cli") {
    return generalWorkspacesALane;
  }
  return generalWorkspacesBLane;
}

/**
 * Pure, filesystem-derived owner of every first-party Vitest project, its
 * checked-in suites, its execution lane, and its pnpm topology.
 */
export function discoverVitestProjectManifest(repoRoot) {
  const packageJsonPaths = [];
  for (const searchRoot of vitestProjectSearchRoots) {
    collectPackageJsonPaths(path.join(repoRoot, searchRoot), packageJsonPaths);
  }

  const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) {
    throw new Error("Vitest project discovery requires pnpm-workspace.yaml");
  }
  const workspaceEntries = parseWorkspaceEntries(readFileSync(workspacePath, "utf8"));

  const projects = [];
  for (const packageJsonPath of packageJsonPaths) {
    const projectRoot = path.dirname(packageJsonPath);
    const projectPath = normalizedRepoPath(repoRoot, projectRoot);
    const testFiles = collectOwnedTestFiles(repoRoot, projectRoot);
    if (testFiles.length === 0) continue;

    const configPath = path.join(projectRoot, "vitest.config.ts");
    if (!existsSync(configPath)) {
      throw new Error(
        `Vitest project ${projectPath} has Vitest test files but no vitest.config.ts`,
      );
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof packageJson.name !== "string" || packageJson.name.trim() === "") {
      throw new Error(`Vitest project ${projectPath} must have a package name`);
    }

    const workspace = isWorkspacePackage(projectPath, workspaceEntries);
    const dependencySpecs = Object.values({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.optionalDependencies,
    });
    projects.push({
      name: packageJson.name,
      path: projectPath,
      lane: laneForProject(projectPath),
      workspace,
      requiresStandaloneInstall:
        !workspace &&
        !dependencySpecs.some(
          (dependencySpec) =>
            typeof dependencySpec === "string" && dependencySpec.startsWith("workspace:"),
        ),
      testFiles,
    });
  }

  projects.sort((left, right) => left.path.localeCompare(right.path));
  const names = new Set();
  const testFiles = new Set();
  for (const project of projects) {
    if (names.has(project.name)) {
      throw new Error(`Vitest project name is duplicated: ${project.name}`);
    }
    names.add(project.name);
    for (const testFile of project.testFiles) {
      if (testFiles.has(testFile)) {
        throw new Error(`Vitest suite is assigned to multiple projects: ${testFile}`);
      }
      testFiles.add(testFile);
    }
  }

  return Object.freeze({ projects: Object.freeze(projects) });
}
