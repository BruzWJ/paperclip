import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-create-paperclip-plugin-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("create-paperclip-plugin entrypoints", () => {
  it("keeps src/index.ts import-safe when process.argv points at another bundled CLI", async () => {
    const originalArgv = process.argv;
    const outputRoot = makeTempDir();

    try {
      process.argv = [process.execPath, path.resolve("packages/cli/dist/index.js"), "demo-plugin", "--output", outputRoot];
      const library = await import("./index.js");

      expect(library.scaffoldPluginProject).toBeTypeOf("function");
      expect(fs.existsSync(path.join(outputRoot, "demo-plugin"))).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("runs scaffolding from src/bin.ts", async () => {
    const { runCli } = await import("./bin.js");
    const outputRoot = makeTempDir();
    const stdout: string[] = [];
    const outputDir = path.join(outputRoot, "demo-plugin");

    const result = runCli(
      [
        process.execPath,
        "create-paperclip-plugin",
        "demo-plugin",
        "--category",
        "connector",
        "--output",
        outputRoot,
        "--sdk-path",
        path.resolve("packages/plugins/sdk"),
      ],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => {
          throw new Error(message);
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
    );

    expect(result).toBe(outputDir);
    expect(stdout).toEqual([`Created plugin scaffold at ${outputDir}`]);
    const packageJson = JSON.parse(fs.readFileSync(path.join(outputDir, "package.json"), "utf8"));
    expect(packageJson).toMatchObject({
      name: "demo-plugin",
      paperclipPlugin: {
        manifest: "./dist/manifest.js",
      },
    });
    expect(packageJson).not.toHaveProperty("private");
    expect(packageJson.devDependencies).not.toHaveProperty("@paperclipai/shared");
    const test = fs.readFileSync(path.join(outputDir, "tests", "plugin.spec.ts"), "utf8");
    expect(test).toContain(
      'import { pluginManifestV1Schema } from "@paperclipai/plugin-sdk"',
    );
    expect(test).not.toContain('from "@paperclipai/shared"');
    expect(test).toContain('pluginManifestV1Schema.parse(manifest)');
    expect(test).toContain(
      '{ actor: { type: "user", userId: "user-1", companyId: "company-1" } }',
    );
  });

  it("requires an explicit category in the standalone CLI", async () => {
    const { runCli } = await import("./bin.js");
    const stderr: string[] = [];

    expect(() =>
      runCli(
        [process.execPath, "create-paperclip-plugin", "demo-plugin"],
        {
          stderr: (message) => stderr.push(message),
          exit: (code) => {
            throw new Error(`exit ${code}`);
          },
        },
      )).toThrow("exit 1");
    expect(stderr).toEqual(["--category is required"]);
  });

  it("uses one standard template for every category", async () => {
    const { pluginPackageDirectoryName, scaffoldPluginProject } = await import("./index.js");
    const outputRoot = makeTempDir();
    const outputDir = path.join(outputRoot, "workspace-plugin");

    expect(pluginPackageDirectoryName("@acme/workspace-plugin")).toBe("workspace-plugin");

    scaffoldPluginProject({
      pluginName: "@acme/workspace-plugin",
      outputDir,
      template: "standard",
      category: "workspace",
      sdkPath: path.resolve("packages/plugins/sdk"),
    });

    const manifest = fs.readFileSync(path.join(outputDir, "src", "manifest.ts"), "utf8");
    const worker = fs.readFileSync(path.join(outputDir, "src", "worker.ts"), "utf8");
    expect(manifest).toContain('categories: ["workspace"]');
    expect(manifest).not.toContain("events.subscribe");
    expect(manifest).not.toContain("plugin.state");
    expect(worker).not.toContain("ctx.events");
    expect(worker).not.toContain("ctx.state");
  });

  it("rejects removed template aliases", async () => {
    const { scaffoldPluginProject } = await import("./index.js");
    const outputRoot = makeTempDir();

    expect(() =>
      scaffoldPluginProject({
        pluginName: "@acme/connector-plugin",
        outputDir: path.join(outputRoot, "connector-plugin"),
        template: "connector" as never,
        category: "connector",
        sdkPath: path.resolve("packages/plugins/sdk"),
      })).toThrow("Expected one of: standard");
  });

  it("rejects categories outside the canonical manifest contract", async () => {
    const { scaffoldPluginProject } = await import("./index.js");
    const outputRoot = makeTempDir();

    expect(() =>
      scaffoldPluginProject({
        pluginName: "@acme/category-plugin",
        outputDir: path.join(outputRoot, "category-plugin"),
        template: "standard",
        category: "invalid" as never,
        sdkPath: path.resolve("packages/plugins/sdk"),
      })).toThrow("Expected one of: connector, workspace, automation, ui");
  });

  it("uses the canonical shared npm package-name contract", async () => {
    const { scaffoldPluginProject } = await import("./index.js");
    const outputRoot = makeTempDir();

    for (const pluginName of [
      "-invalid",
      "@-invalid/plugin",
      "Invalid",
      `p${"a".repeat(214)}`,
    ]) {
      expect(() =>
        scaffoldPluginProject({
          pluginName,
          outputDir: path.join(outputRoot, "invalid"),
          category: "connector",
          sdkPath: path.resolve("packages/plugins/sdk"),
        }),
      ).toThrow("packageName");
    }
  });
});
