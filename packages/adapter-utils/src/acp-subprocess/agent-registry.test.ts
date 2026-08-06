import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AcpAgentRegistry } from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  assertAcpRegistryAgentName,
  isAcpRegistryAgentLocallyAvailable,
  listAcpRegistryAgentNames,
  listLocallyAvailableAcpRegistryAgentNames,
  loadAcpxAgentRegistry,
  resolveAcpRegistryLaunch,
  sameAcpRegistryLaunch,
} from "./agent-registry.js";

function registry(input: {
  readonly names: readonly string[];
  readonly resolve: (name: string) => string | string[];
}): AcpAgentRegistry {
  return {
    list: () => [...input.names],
    resolve: input.resolve,
  };
}

describe("ACPX launch registry", () => {
  it("treats project-configured agents as ACPX overrides within the complete registry", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "paperclip-acpx-config-"));
    try {
      await writeFile(
        path.join(cwd, ".acpxrc.json"),
        JSON.stringify({
          agents: {
            "custom-runner": {
              argv: ["./bin/custom-acp", "serve", "--stdio"],
            },
          },
        }),
        "utf8",
      );
      const configured = await loadAcpxAgentRegistry({ cwd });

      expect(listAcpRegistryAgentNames(configured)).toContain("custom-runner");
      expect(listAcpRegistryAgentNames(configured)).toContain("codex");
      expect(resolveAcpRegistryLaunch("custom-runner", configured)).toEqual({
        registryName: "custom-runner",
        command: "./bin/custom-acp",
        args: ["serve", "--stdio"],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("filters ACPX package-runner entries by the exact locally installed registry name", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "paperclip-acpx-path-"));
    try {
      const bin = path.join(cwd, "bin");
      await mkdir(bin);
      await Promise.all(
        ["codex", "direct-acp", "fast-agent"].map((name) =>
          writeFile(path.join(bin, name), "#!/bin/sh\nexit 0\n", {
            mode: 0o755,
          }),
        ),
      );
      const candidate = registry({
        names: [
          "codex",
          "kilocode",
          "direct-runtime",
          "fast-agent",
          "missing-fast-agent",
        ],
        resolve: (name) => {
          if (name === "codex" || name === "kilocode") {
            return ["npx", "-y", `@example/${name}`];
          }
          if (name === "fast-agent" || name === "missing-fast-agent") {
            return ["uvx", `${name}-package`];
          }
          return ["direct-acp", "--stdio"];
        },
      });

      await expect(
        listLocallyAvailableAcpRegistryAgentNames(candidate, {
          cwd,
          env: { PATH: bin },
        }),
      ).resolves.toEqual(["codex", "direct-runtime", "fast-agent"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    [["npx", "-y", "some-package"]],
    [["uvx", "some-package"]],
    [["pnpm", "dlx", "some-package"]],
    [["npm", "exec", "--", "some-package"]],
    [["yarn", "dlx", "some-package"]],
    [["bun", "x", "some-package"]],
    [["uv", "tool", "run", "some-package"]],
    [["pipx", "run", "some-package"]],
    [["corepack", "pnpm", "dlx", "some-package"]],
    [["corepack", "--install-directory", "/tmp/corepack", "pnpm", "dlx", "some-package"]],
    [["env", "npx", "-y", "some-package"]],
    [["env", "AGENT_MODE=stdio", "pnpm", "--silent", "dlx", "some-package"]],
    [["sh", "-c", "npx -y some-package"]],
    [["nice", "npx", "-y", "some-package"]],
    [["timeout", "30", "npx", "-y", "some-package"]],
    [["nohup", "pnpm", "dlx", "some-package"]],
    [["setsid", "wrapped", "uvx some-package"]],
    [["nice", "sh", "-c", "npx${IFS}-y${IFS}some-package"]],
  ])("does not mistake a materializing runner %j for an installed agent", async (argv) => {
    const candidate = registry({
      names: ["not-installed-agent"],
      resolve: () => argv,
    });

    await expect(
      isAcpRegistryAgentLocallyAvailable(
        "not-installed-agent",
        candidate,
        { cwd: process.cwd(), env: { PATH: "" } },
      ),
    ).resolves.toBe(false);
  });

  it("rejects an ACPX-configured relative executable that would change meaning in an execution workspace", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "paperclip-acpx-relative-"));
    try {
      await mkdir(path.join(cwd, "bin"));
      await writeFile(
        path.join(cwd, "bin", "custom-acp"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 },
      );
      const candidate = registry({
        names: ["custom-runtime"],
        resolve: () => ["./bin/custom-acp", "serve", "--stdio"],
      });

      await expect(
        isAcpRegistryAgentLocallyAvailable("custom-runtime", candidate, {
          cwd,
          env: { PATH: "" },
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("lists exact ACPX registry names without assigning a Paperclip catalog", () => {
    expect(
      listAcpRegistryAgentNames(
        registry({
          names: ["runner-b", "runner-a", "runner-b"],
          resolve: () => "not-used",
        }),
      ),
    ).toEqual(["runner-a", "runner-b"]);
  });

  it("admits only an exact ACPX name without reading its resolved argv", () => {
    const resolve = vi.fn(() => "must-not-resolve");
    const candidate = registry({ names: ["runner-a"], resolve });

    expect(assertAcpRegistryAgentName("runner-a", candidate)).toBe("runner-a");
    expect(resolve).not.toHaveBeenCalled();
    expect(() => assertAcpRegistryAgentName(" runner-a", candidate)).toThrow(
      /ACP registry name/,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves argv supplied by ACPX for an exact registry name", () => {
    const resolve = vi.fn((name: string) => ["npx", "--yes", name]);

    expect(
      resolveAcpRegistryLaunch(
        "runner-a",
        registry({ names: ["runner-a"], resolve }),
      ),
    ).toEqual({
      registryName: "runner-a",
      command: "npx",
      args: ["--yes", "runner-a"],
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("runner-a");
  });

  it.each(["unknown", " runner-a", "runner-a ", "RUNNER-A", ""]) (
    "rejects %j before ACPX can use its raw-command fallback",
    (name) => {
      const resolve = vi.fn(() => "forbidden-command");

      expect(() =>
        resolveAcpRegistryLaunch(
          name,
          registry({ names: ["runner-a"], resolve }),
        ),
      ).toThrow(/ACP registry name/);
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed argv returned by ACPX", () => {
    expect(() =>
      resolveAcpRegistryLaunch(
        "runner-a",
        registry({ names: ["runner-a"], resolve: () => ["npx", " "] }),
      ),
    ).toThrow(/invalid launch argv/);
  });

  it("compares the complete ACPX-resolved command identity", () => {
    const launch = {
      registryName: "runner-a",
      command: "npx",
      args: ["--yes", "runner-a"],
    } as const;

    expect(sameAcpRegistryLaunch(launch, launch)).toBe(true);
    expect(
      sameAcpRegistryLaunch(launch, { ...launch, args: ["runner-a"] }),
    ).toBe(false);
    expect(
      sameAcpRegistryLaunch(launch, { ...launch, command: "node" }),
    ).toBe(false);
  });
});
