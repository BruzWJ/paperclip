import { describe, expect, it } from "vitest";
import { resolveRuntimeBind, validateConfiguredBindMode } from "@paperclipai/shared";
import {
  buildPresetServerConfig,
  resolveQuickstartServerConfig,
} from "../config/server-bind.js";

const ORIGINAL_PATH = process.env.PATH;

describe("network bind helpers", () => {
  it("rejects public exposure on a tailnet-only bind", () => {
    expect(
      validateConfiguredBindMode({
        exposure: "public",
        bind: "tailnet",
        host: "100.64.0.8",
      }),
    ).toContain("server.bind=tailnet is only supported when server.exposure=private");

    expect(() =>
      resolveQuickstartServerConfig({
        bind: "tailnet",
        exposure: "public",
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
        publicBaseUrl: "https://paperclip.example.com",
      }),
    ).toThrow(
      "server.bind=tailnet is only supported when server.exposure=private",
    );
  });

  it("resolves tailnet bind using the detected tailscale address", () => {
    const resolved = resolveRuntimeBind({
      bind: "tailnet",
      host: "127.0.0.1",
      tailnetBindHost: "100.64.0.8",
    });

    expect(resolved.errors).toEqual([]);
    expect(resolved.host).toBe("100.64.0.8");
  });

  it("requires a custom bind host when bind=custom", () => {
    const resolved = resolveRuntimeBind({
      bind: "custom",
      host: "127.0.0.1",
    });

    expect(resolved.errors).toContain("server.customBindHost is required when server.bind=custom");
  });

  it("requires an explicit Better Auth URL for public exposure", () => {
    expect(() =>
      resolveQuickstartServerConfig({
        bind: "lan",
        exposure: "public",
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
      }),
    ).toThrow(
      "auth.publicBaseUrl is required when server.exposure=public",
    );
  });

  it("rejects an HTTP origin for public exposure", () => {
    expect(() =>
      resolveQuickstartServerConfig({
        bind: "lan",
        exposure: "public",
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
        publicBaseUrl: "http://paperclip.example.com",
      }),
    ).toThrow("Public origin must use https://");
  });

  it("stores the detected tailscale address for tailnet presets", () => {
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.8";

    const preset = buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("100.64.0.8");

    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
  });

  it("falls back to loopback when no tailscale address is available for tailnet presets", () => {
    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
    process.env.PATH = "";

    try {
      const preset = buildPresetServerConfig("tailnet", {
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
      });

      expect(preset.server.host).toBe("127.0.0.1");
    } finally {
      process.env.PATH = ORIGINAL_PATH;
    }
  });
});
