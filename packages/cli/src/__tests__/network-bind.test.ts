import { describe, expect, it } from "vitest";
import {
  resolveRuntimeBind,
  validateConfiguredBindMode,
} from "@paperclipai/shared";
import {
  buildCustomServerConfig,
  buildPresetServerConfig,
} from "../config/server-bind.js";

describe("network bind helpers", () => {
  it("rejects public exposure on a tailnet-only bind", () => {
    expect(
      validateConfiguredBindMode({
        exposure: "public",
        bind: "tailnet",
      }),
    ).toContain(
      "server.bind=tailnet is only supported when server.exposure=private",
    );
  });

  it("resolves tailnet bind using the detected Tailscale address", () => {
    expect(
      resolveRuntimeBind({
        exposure: "private",
        bind: "tailnet",
        tailnetBindHost: "100.64.0.8",
      }),
    ).toEqual({ bind: "tailnet", host: "100.64.0.8" });
  });

  it("fails closed when a tailnet address is unavailable", () => {
    expect(() =>
      resolveRuntimeBind({ exposure: "private", bind: "tailnet" }),
    ).toThrow(
      "server.bind=tailnet requires one exact detected Tailscale address or PAPERCLIP_TAILNET_BIND_HOST",
    );
  });

  it("requires a custom bind host when bind=custom", () => {
    expect(() =>
      resolveRuntimeBind({ exposure: "private", bind: "custom" }),
    ).toThrow("server.customBindHost is required when server.bind=custom");
  });

  it("rejects duplicate special-host representations", () => {
    expect(
      validateConfiguredBindMode({
        exposure: "private",
        bind: "custom",
        customBindHost: "127.0.0.1",
      }),
    ).toContain(
      "Use server.bind=loopback instead of a loopback server.customBindHost",
    );
    expect(
      validateConfiguredBindMode({
        exposure: "private",
        bind: "lan",
        customBindHost: "10.0.0.2",
      }),
    ).toContain("server.customBindHost is only valid when server.bind=custom");
  });

  it("requires an explicit Better Auth URL for public exposure", () => {
    expect(() =>
      buildCustomServerConfig({
        exposure: "public",
        customBindHost: "192.0.2.10",
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
      }),
    ).toThrow("auth.publicBaseUrl is required when server.exposure=public");
  });

  it("rejects an HTTP origin for public exposure", () => {
    expect(() =>
      buildCustomServerConfig({
        exposure: "public",
        customBindHost: "192.0.2.10",
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
        publicBaseUrl: "http://paperclip.example.com",
      }),
    ).toThrow("Public origin must use https://");
  });

  it.each([
    ["127.0.0.1", "loopback bind mode"],
    ["localhost", "loopback bind mode"],
    ["0.0.0.0", "lan bind mode"],
    ["::", "lan bind mode"],
  ])("rejects custom bind alias %s", (customBindHost, message) => {
    expect(() =>
      buildCustomServerConfig({
        exposure: "private",
        customBindHost,
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
      }),
    ).toThrow(message);
  });

  it("persists only the canonical tailnet bind mode", () => {
    const preset = buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.bind).toBe("tailnet");
    expect(preset.server).not.toHaveProperty("host");
    expect(preset.server).not.toHaveProperty("customBindHost");
  });
});
