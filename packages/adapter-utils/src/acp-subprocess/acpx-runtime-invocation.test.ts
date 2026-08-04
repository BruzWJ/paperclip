import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareAcpxRuntimeInvocation,
} from "./acpx-runtime-invocation.js";

const temporaryRoots: string[] = [];

async function localWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-runtime-invocation-"),
  );
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  return workspace;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

describe("ACPX-only runtime invocation preparation", () => {
  it("materializes request files without exposing launch argv or a subprocess starter", async () => {
    const targetCwd = await localWorkspace();
    const prepared = await prepareAcpxRuntimeInvocation({
      target: { kind: "local" },
      targetCwd,
      companySkills: { channel: "operator_native" },
      invocationFiles: [
        { fileName: "run-tools-proxy.mjs", contents: "export {};\n" },
        { fileName: "run-tools.json", contents: '{"bearer":"secret"}\n' },
      ],
    });

    expect(prepared).toMatchObject({
      targetCwd,
      targetNodeExecutable: process.execPath,
      selectedCompanySkillMaterialization: null,
    });
    expect("launch" in prepared).toBe(false);
    expect("startSubprocess" in prepared).toBe(false);
    expect(
      await fs.readFile(prepared.invocationFilePaths["run-tools.json"]!, "utf8"),
    ).toBe('{"bearer":"secret"}\n');

    await prepared.disposeBeforeStart();
    await prepared.disposeBeforeStart();
    await expect(
      fs.access(prepared.invocationFilePaths["run-tools.json"]!),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a remote target before any invocation materialization", async () => {
    const targetCwd = await localWorkspace();

    await expect(
      prepareAcpxRuntimeInvocation({
        target: {
          kind: "remote",
          transport: "ssh",
          remoteCwd: "/srv/paperclip",
          spec: {
            host: "ssh.example.test",
            port: 22,
            username: "paperclip",
            remoteWorkspacePath: "/srv/paperclip",
            remoteCwd: "/srv/paperclip",
            privateKey: null,
            knownHosts: null,
            strictHostKeyChecking: true,
          },
        },
        targetCwd,
        companySkills: { channel: "operator_native" },
        invocationFiles: [{ fileName: "must-not-write", contents: "secret" }],
      }),
    ).rejects.toThrow("only a local execution target");
  });

  it("rejects isolated skills explicitly because ACPX has no generic skills-home API", async () => {
    const targetCwd = await localWorkspace();

    await expect(
      prepareAcpxRuntimeInvocation({
        target: { kind: "local" },
        targetCwd,
        companySkills: {
          channel: "isolated_skills_home",
          identity: {
            companyId: "company",
            agentId: "agent",
            executionTargetIdentity: "target",
            adapterConfigRevisionId: "revision",
          },
          entries: [],
        },
        invocationFiles: [{ fileName: "must-not-write", contents: "secret" }],
      }),
    ).rejects.toThrow("does not support isolated_skills_home");
  });

  it("accepts no invocation files without constructing a launcher", async () => {
    const targetCwd = await localWorkspace();
    const prepared = await prepareAcpxRuntimeInvocation({
      target: { kind: "local" },
      targetCwd,
      companySkills: { channel: "operator_native" },
    });

    expect(prepared.invocationFilePaths).toEqual({});
    expect("launch" in prepared).toBe(false);
    expect("startSubprocess" in prepared).toBe(false);
    await expect(prepared.disposeBeforeStart()).resolves.toBeUndefined();
  });
});
