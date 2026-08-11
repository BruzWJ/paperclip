import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scaffoldPluginProject: vi.fn((options: { outputDir: string }) => options.outputDir),
}));

vi.mock("../../../plugins/create-paperclip-plugin/src/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../plugins/create-paperclip-plugin/src/index.js")>(
      "../../../plugins/create-paperclip-plugin/src/index.js",
    );
  return {
    ...actual,
    scaffoldPluginProject: mocks.scaffoldPluginProject,
  };
});

import {
  buildPluginInstallRequest,
  buildPluginInitNextCommands,
  buildPluginInitScaffoldOptions,
  formatTargetDiagnostics,
  probeTargetDiagnostics,
  registerPluginCommands,
} from "../commands/client/plugin.js";

describe("plugin init", () => {
  beforeEach(() => {
    mocks.scaffoldPluginProject.mockClear();
  });

  it("maps package name and flags to scaffolder options", () => {
    const cwd = path.resolve("/tmp/paperclip-cli-test");
    const options = buildPluginInitScaffoldOptions(
      "@acme/plugin-linear",
      {
        output: "plugins",
        template: "standard",
        category: "automation",
        displayName: "Linear Bridge",
        description: "Syncs Linear tickets",
        author: "Acme",
        sdkPath: "../paperclip/packages/plugins/sdk",
      },
      cwd,
    );

    expect(options).toEqual({
      pluginName: "@acme/plugin-linear",
      outputDir: path.resolve(cwd, "plugins", "plugin-linear"),
      template: "standard",
      category: "automation",
      displayName: "Linear Bridge",
      description: "Syncs Linear tickets",
      author: "Acme",
      sdkPath: "../paperclip/packages/plugins/sdk",
    });
  });

  it("builds exact next commands using the scaffold path", () => {
    expect(buildPluginInitNextCommands("/tmp/acme plugin")).toEqual([
      "cd '/tmp/acme plugin'",
      "pnpm install",
      "pnpm dev",
      "paperclipai plugin install --local '/tmp/acme plugin'",
    ]);
  });

  it("registers the CLI wrapper and invokes the existing scaffolder", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerPluginCommands(program);

    await program.parseAsync(
      [
        "plugin",
        "init",
        "demo-plugin",
        "--output",
        "/tmp/paperclip-init-output",
        "--template",
        "standard",
        "--category",
        "workspace",
        "--display-name",
        "Demo Plugin",
        "--description",
        "Demo description",
        "--author",
        "Paperclip",
        "--sdk-path",
        "/repo/packages/plugins/sdk",
      ],
      { from: "user" },
    );

    expect(mocks.scaffoldPluginProject).toHaveBeenCalledTimes(1);
    expect(mocks.scaffoldPluginProject).toHaveBeenCalledWith({
      pluginName: "demo-plugin",
      outputDir: path.resolve("/tmp/paperclip-init-output", "demo-plugin"),
      template: "standard",
      category: "workspace",
      displayName: "Demo Plugin",
      description: "Demo description",
      author: "Paperclip",
      sdkPath: "/repo/packages/plugins/sdk",
    });
  });

  it("exposes only local scaffold options", () => {
    const program = new Command();
    registerPluginCommands(program);

    const pluginCommand = program.commands.find((command) => command.name() === "plugin");
    const initCommand = pluginCommand?.commands.find((command) => command.name() === "init");
    const optionNames = initCommand?.options.map((option) => option.long) ?? [];

    expect(optionNames).toEqual([
      "--output",
      "--template",
      "--category",
      "--display-name",
      "--description",
      "--author",
      "--sdk-path",
      "--json",
    ]);
    for (const networkOption of ["--api-base", "--api-key", "--config", "--context", "--profile"]) {
      expect(optionNames).not.toContain(networkOption);
    }
  });
});

describe("plugin install", () => {
  it("builds an explicit local-source request and resolves its path", () => {
    const cwd = path.resolve("/tmp/paperclip-cli-plugin-test");

    expect(buildPluginInstallRequest("demo-plugin", { local: true }, { cwd })).toEqual({
      source: "local",
      path: path.join(cwd, "demo-plugin"),
    });
  });

  it("requires --local for filesystem paths", () => {
    expect(() => buildPluginInstallRequest("./demo-plugin")).toThrow(
      "Local plugin paths require --local",
    );
  });

  it("builds an exact npm-source request", () => {
    expect(buildPluginInstallRequest("@acme/plugin-linear", { version: "1.2.3" })).toEqual({
      source: "npm",
      packageName: "@acme/plugin-linear",
      version: "1.2.3",
    });
  });

  it("rejects an npm version on an explicit local install", () => {
    expect(() =>
      buildPluginInstallRequest("./demo-plugin", { local: true, version: "1.2.3" }),
    ).toThrow("--version is only supported for npm package installs");
  });
});

describe("plugin target diagnostics", () => {
  it("probes /api/health and reports the resolved api base on success", async () => {
    const get = vi.fn(async () => ({
      status: "ok",
      version: "1.2.3",
      deploymentExposure: "private",
    }));

    const diag = await probeTargetDiagnostics({ apiBase: "http://127.0.0.1:3100", get });

    expect(get).toHaveBeenCalledWith("/api/health");
    expect(diag).toEqual({
      apiBase: "http://127.0.0.1:3100",
      reachable: true,
      health: {
        status: "ok",
        version: "1.2.3",
        deploymentExposure: "private",
      },
    });
  });

  it("marks the target unreachable when the health probe throws", async () => {
    const get = vi.fn(async () => {
      throw new Error("Could not reach the Paperclip API.\nRequest: GET ...");
    });

    const diag = await probeTargetDiagnostics({ apiBase: "http://other-host:9999", get });

    expect(diag.apiBase).toBe("http://other-host:9999");
    expect(diag.reachable).toBe(false);
    expect(diag.error).toContain("Could not reach the Paperclip API.");
  });

  it("formats reachable diagnostics with version and exposure", () => {
    const rendered = formatTargetDiagnostics({
      apiBase: "http://127.0.0.1:3100",
      reachable: true,
      health: { status: "ok", version: "9.9.9", deploymentExposure: "private" },
    });

    expect(rendered).toContain("http://127.0.0.1:3100");
    expect(rendered).toContain("version=9.9.9");
    expect(rendered).toContain("exposure=private");
  });

  it("formats unreachable diagnostics with a remediation hint", () => {
    const rendered = formatTargetDiagnostics({
      apiBase: "http://127.0.0.1:3100",
      reachable: false,
      error: "ECONNREFUSED",
    });

    expect(rendered).toContain("unreachable");
    expect(rendered).toContain("--api-base");
    expect(rendered).toContain("PAPERCLIP_BOARD_API_URL");
  });
});
