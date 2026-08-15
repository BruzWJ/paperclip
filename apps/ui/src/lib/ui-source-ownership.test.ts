// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const componentsRoot = path.join(sourceRoot, "components");
const featuresRoot = path.join(sourceRoot, "features");
const routesRoot = path.join(sourceRoot, "routes");

const protectedComponentDirectories = new Set(["ai-elements", "kibo-ui", "ui"]);

function sourceFiles(directory: string, ignoredDirectories = new Set<string>()): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(absolutePath)
        ? []
        : sourceFiles(absolutePath, ignoredDirectories);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolutePath] : [];
  });
}

function moduleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  function addSpecifier(node: ts.Expression | undefined) {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addSpecifier(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isMock =
        ts.isPropertyAccessExpression(node.expression) &&
        ["doMock", "mock", "unmock"].includes(node.expression.name.text);

      if (isDynamicImport || isRequire || isMock) addSpecifier(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return specifiers;
}

function isWithin(candidate: string, directory: string) {
  const relativePath = path.relative(directory, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
  );
}

function targetsSourceArea(file: string, specifier: string, area: string) {
  if (specifier === `@/${area}` || specifier.startsWith(`@/${area}/`)) return true;
  if (!specifier.startsWith(".")) return false;
  return isWithin(path.resolve(path.dirname(file), specifier), path.join(sourceRoot, area));
}

function forbiddenImports(files: string[], areas: string[]) {
  return files
    .flatMap((file) =>
      moduleSpecifiers(file)
        .filter((specifier) => areas.some((area) => targetsSourceArea(file, specifier, area)))
        .map((specifier) => `${path.relative(sourceRoot, file)} -> ${specifier}`),
    )
    .sort();
}

function isTestFile(file: string) {
  return /\.(?:test|spec)\.(?:ts|tsx)$/.test(path.basename(file));
}

describe("UI source ownership", () => {
  it("keeps only protected component libraries and generic patterns under components", () => {
    const allowedDirectories = new Set([...protectedComponentDirectories, "patterns"]);
    const unexpectedEntries = readdirSync(componentsRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          !(entry.isDirectory() && allowedDirectories.has(entry.name)) &&
          !(entry.isFile() && entry.name === "README.md"),
      )
      .map((entry) => entry.name)
      .sort();

    expect(unexpectedEntries).toEqual([]);
  });

  it("keeps generic component patterns independent of features, routes, and plugins", () => {
    const ignoredDirectories = new Set(
      [...protectedComponentDirectories].map((directory) => path.join(componentsRoot, directory)),
    );

    expect(
      forbiddenImports(sourceFiles(componentsRoot, ignoredDirectories), [
        "features",
        "routes",
        "plugins",
      ]),
    ).toEqual([]);
  });

  it("keeps features independent of route modules", () => {
    expect(forbiddenImports(sourceFiles(featuresRoot), ["routes"])).toEqual([]);
  });

  it("marks non-route production files so TanStack Router ignores them", () => {
    const routeModuleNames = new Set(["__root", "index", "route"]);
    const unignoredHelpers = sourceFiles(routesRoot)
      .filter((file) => !routeModuleNames.has(path.basename(file, path.extname(file))))
      .filter((file) => !isTestFile(file))
      .filter((file) => {
        const segments = path.relative(routesRoot, file).split(path.sep);
        return !segments.some((segment) => segment.startsWith("-"));
      })
      .map((file) => path.relative(sourceRoot, file))
      .sort();

    expect(unignoredHelpers).toEqual([]);
  });
});
