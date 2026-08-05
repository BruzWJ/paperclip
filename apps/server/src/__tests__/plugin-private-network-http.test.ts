import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";

function eventBusStub() {
  return {
    forPlugin() {
      return { emit() {}, subscribe() {}, clear() {} };
    },
  } as never;
}

function manifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.private-network-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Private Network Test",
    description: "Tests managed private-network HTTP access.",
    author: "Paperclip",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/health`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function host(pluginManifest: PaperclipPluginManifestV1) {
  return buildHostServices(
    {} as never,
    "plugin-installation-id",
    pluginManifest.id,
    eventBusStub(),
    undefined,
    {
      manifest: pluginManifest,
      ordinaryIssues: {} as never,
      pluginIssueControlPlane: {} as never,
      issueExecutionCancellation: {} as never,
    },
  );
}

describe("plugin private-network HTTP capability", () => {
  it("keeps private addresses blocked for ordinary outbound plugins", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    const url = await listen(server);
    const services = host(manifest(["http.outbound"]));
    try {
      await expect(services.http.fetch({ url })).rejects.toThrow(
        "private/reserved ranges",
      );
    } finally {
      services.dispose();
      await close(server);
    }
  });

  it("permits DNS-pinned loopback access only for the elevated capability", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
    });
    const url = await listen(server);
    const services = host(manifest(["http.outbound", "http.private-network"]));
    try {
      await expect(services.http.fetch({ url })).resolves.toMatchObject({
        status: 200,
        body: '{"status":"ok"}',
      });
    } finally {
      services.dispose();
      await close(server);
    }
  });
});
