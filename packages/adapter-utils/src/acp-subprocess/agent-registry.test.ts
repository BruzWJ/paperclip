import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AcpAgentRegistry } from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  assertAcpRegistryAgentName,
  configuredAcpRegistryView,
  listAcpRegistryAgentNames,
  loadConfiguredAcpRegistry,
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
  it("exposes only ACPX-configured names while delegating their resolution", () => {
    const resolve = vi.fn((name: string) => ["acpx-resolved", name]);
    const configured = configuredAcpRegistryView(
      registry({
        // Mirrors ACPX's public registry behavior: static built-ins are mixed
        // with configured overrides in its unfiltered list.
        names: ["codex", "kilocode", "mux", "custom-runner"],
        resolve,
      }),
      ["custom-runner"],
    );

    expect(listAcpRegistryAgentNames(configured)).toEqual(["custom-runner"]);
    expect(configured.resolve("custom-runner")).toEqual([
      "acpx-resolved",
      "custom-runner",
    ]);
    expect(() => configured.resolve("mux")).toThrow(
      "ACP registry name is not configured by ACPX",
    );
    expect(resolve).toHaveBeenCalledExactlyOnceWith("custom-runner");
  });

  it("loads a project-configured custom agent through ACPX's resolved config", async () => {
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
      const configured = await loadConfiguredAcpRegistry({ cwd });

      expect(listAcpRegistryAgentNames(configured)).toContain("custom-runner");
      expect(listAcpRegistryAgentNames(configured)).not.toContain("kilocode");
      expect(listAcpRegistryAgentNames(configured)).not.toContain("mux");
      expect(resolveAcpRegistryLaunch("custom-runner", configured)).toEqual({
        registryName: "custom-runner",
        command: "./bin/custom-acp",
        args: ["serve", "--stdio"],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("lists exact ACPX-configured names without assigning a Paperclip catalog", () => {
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
