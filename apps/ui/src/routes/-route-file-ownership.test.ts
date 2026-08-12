import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolutePath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolutePath] : [];
  });
}

function directoriesNamed(directory: string, name: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const absolutePath = path.join(directory, entry.name);
    return [
      ...(entry.name === name ? [absolutePath] : []),
      ...directoriesNamed(absolutePath, name),
    ];
  });
}

describe("TanStack Router source ownership", () => {
  it("has no parallel pages tree or imports", () => {
    expect(existsSync(path.join(sourceRoot, "pages"))).toBe(false);

    const retiredImport = ["@", "pages"].join("/");
    const staleImports = sourceFiles(sourceRoot)
      .filter((file) => readFileSync(file, "utf8").includes(retiredImport))
      .map((file) => path.relative(sourceRoot, file));

    expect(staleImports).toEqual([]);
  });

  it("keeps route screens in native index route modules", () => {
    const routesRoot = path.join(sourceRoot, "routes");
    expect(directoriesNamed(routesRoot, "-components")).toEqual([]);

    const namedPageModules = sourceFiles(routesRoot)
      .filter((file) => file.endsWith(".tsx"))
      .filter((file) => {
        const name = path.basename(file);
        return (
          !["__root.tsx", "index.tsx", "route.tsx"].includes(name) &&
          !name.startsWith("-") &&
          !name.endsWith(".test.tsx")
        );
      })
      .map((file) => path.relative(sourceRoot, file));

    expect(namedPageModules).toEqual([]);

    const invalidIndexRoutes = sourceFiles(routesRoot)
      .filter((file) => path.basename(file) === "index.tsx")
      .filter(
        (file) => !readFileSync(file, "utf8").includes("createFileRoute("),
      )
      .map((file) => path.relative(sourceRoot, file));

    expect(invalidIndexRoutes).toEqual([]);
  });
});
