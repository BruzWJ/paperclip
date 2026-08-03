import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_ACP_FRONTEND_PACKAGE,
  CODEX_ACP_FRONTEND_SHA256,
  CODEX_ACP_FRONTEND_VERSION,
  listApprovedAcpLaunchNames,
  readApprovedAcpFrontendArtifact,
  resolveApprovedAcpNativeAuthentication,
  resolveApprovedAcpLaunch,
} from "./agent-registry.js";

describe("approved ACP launch registry", () => {
  it("resolves only the exact pinned codex frontend", () => {
    const launch = resolveApprovedAcpLaunch("codex");
    expect(launch.registryName).toBe("codex");
    expect(launch.targetNativeCli).toBe("codex");
    expect(launch.frontendPackage).toBe(CODEX_ACP_FRONTEND_PACKAGE);
    expect(launch.frontendVersion).toBe(CODEX_ACP_FRONTEND_VERSION);
    expect(launch.frontendDigest).toBe(CODEX_ACP_FRONTEND_SHA256);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(1);
    expect(launch.args[0]).toMatch(/codex-acp\/dist\/index\.js$/);
    expect(listApprovedAcpLaunchNames()).toEqual(["codex"]);
  });

  it("binds exact native authentication to the complete approved launch", () => {
    const launch = resolveApprovedAcpLaunch("codex");
    expect(resolveApprovedAcpNativeAuthentication(launch)).toEqual({
      statusArgs: ["login", "status"],
      loginGuidance: "codex login",
    });
    expect(() =>
      resolveApprovedAcpNativeAuthentication({
        ...launch,
        targetNativeCli: "codex-other",
      }),
    ).toThrow(/approved artifact/);
  });

  it("verifies the exact bundled frontend bytes before target materialization", async () => {
    const artifact = await readApprovedAcpFrontendArtifact(
      resolveApprovedAcpLaunch("codex"),
    );
    expect(artifact.sha256).toBe(CODEX_ACP_FRONTEND_SHA256);
    expect(createHash("sha256").update(artifact.bytes).digest("hex")).toBe(
      CODEX_ACP_FRONTEND_SHA256,
    );
    expect(artifact.targetFileName).toBe("codex-acp-1.1.7.mjs");
  });

  it("rejects any persisted artifact identity drift", async () => {
    const launch = resolveApprovedAcpLaunch("codex");
    await expect(
      readApprovedAcpFrontendArtifact({
        ...launch,
        frontendDigest: "f".repeat(64),
      }),
    ).rejects.toThrow(/approved artifact/);
  });

  it("rejects target-native selector drift as persisted identity drift", async () => {
    const launch = resolveApprovedAcpLaunch("codex");
    await expect(
      readApprovedAcpFrontendArtifact({
        ...launch,
        targetNativeCli: "codex-other",
      }),
    ).rejects.toThrow(/approved artifact/);
  });

  it.each(["unknown", " codex", "codex ", "CODEX", "code-x", ""])(
    "rejects %j before registry resolution",
    (name) => {
      const resolve = vi.fn(() => "forbidden-command");
      const candidate = {
        list: () => [name, "codex"],
        resolve,
      };
      expect(() => resolveApprovedAcpLaunch(name, candidate)).toThrow();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("rejects a drifted registry argv", () => {
    const resolve = vi.fn(() => [process.execPath, "/tmp/not-codex-acp.js"]);
    expect(() =>
      resolveApprovedAcpLaunch("codex", {
        list: () => ["codex"],
        resolve,
      }),
    ).toThrow(/drifted/);
    expect(resolve).toHaveBeenCalledOnce();
  });
});
