import { describe, expect, it } from "vitest";
import {
  ALL_INTERFACES_BIND_HOST,
  DEFAULT_SERVER_PORT,
  LOOPBACK_BIND_HOST,
  parseExactHostname,
  parseExactHostnameCsv,
  parseExactHostnameList,
  parseExactNonEmptyHostnameCsv,
  resolveRuntimeBind,
  resolveServerPort,
} from "./network-bind.js";

describe("exact configured hostnames", () => {
  it.each(["paperclip.example.test", "localhost", "192.0.2.10", "2001:db8::1"])(
    "accepts canonical hostname %s",
    (hostname) => {
      expect(parseExactHostname(hostname)).toBe(hostname);
    },
  );

  it.each([
    "",
    " Paperclip.example.test",
    "paperclip.example.test ",
    "Paperclip.example.test",
    "https://paperclip.example.test",
    "paperclip.example.test:3100",
    "paperclip.example.test/",
    "paperclip.example.test.",
    "[2001:db8::1]",
    "2001:0db8::1",
    "192.168.001.1",
  ])("rejects hostname alias %j", (hostname) => {
    expect(() => parseExactHostname(hostname)).toThrow(
      /exact lowercase hostname/,
    );
  });

  it("requires one exact comma serialization with no duplicate aliases", () => {
    expect(parseExactHostnameCsv("paperclip.test,192.0.2.10")).toEqual([
      "paperclip.test",
      "192.0.2.10",
    ]);
    expect(parseExactHostnameCsv("")).toEqual([]);
    expect(() => parseExactNonEmptyHostnameCsv("")).toThrow(/at least one/);
    expect(() =>
      parseExactHostnameCsv("paperclip.test, paperclip.lan"),
    ).toThrow();
    expect(() =>
      parseExactHostnameCsv("paperclip.test,paperclip.test"),
    ).toThrow(/duplicates/);
    expect(() =>
      parseExactHostnameList(["paperclip.test", "paperclip.test"]),
    ).toThrow(/duplicates/);
  });
});

describe("resolveServerPort", () => {
  it("uses exact PORT, then persisted server.port, then the canonical default", () => {
    expect(
      resolveServerPort({ environmentValue: "4100", persistedValue: 4200 }),
    ).toBe(4100);
    expect(resolveServerPort({ persistedValue: 4200 })).toBe(4200);
    expect(resolveServerPort({})).toBe(DEFAULT_SERVER_PORT);
  });

  it.each(["", "0", "065", "65536", " 3100", "3100 ", "3.1", "abc"])(
    "rejects non-canonical PORT %j",
    (environmentValue) => {
      expect(() => resolveServerPort({ environmentValue })).toThrow(/PORT/);
    },
  );

  it.each([0, 65_536, 3.1, Number.NaN])(
    "rejects invalid persisted server.port %j",
    (persistedValue) => {
      expect(() => resolveServerPort({ persistedValue })).toThrow(
        /server\.port/,
      );
    },
  );
});

describe("resolveRuntimeBind", () => {
  it("validates and resolves each canonical private bind mode", () => {
    expect(
      resolveRuntimeBind({ exposure: "private", bind: "loopback" }),
    ).toEqual({ bind: "loopback", host: LOOPBACK_BIND_HOST });
    expect(resolveRuntimeBind({ exposure: "private", bind: "lan" })).toEqual({
      bind: "lan",
      host: ALL_INTERFACES_BIND_HOST,
    });
    expect(
      resolveRuntimeBind({
        exposure: "private",
        bind: "custom",
        customBindHost: "192.0.2.10",
      }),
    ).toEqual({
      bind: "custom",
      host: "192.0.2.10",
      customBindHost: "192.0.2.10",
    });
    expect(
      resolveRuntimeBind({
        exposure: "private",
        bind: "tailnet",
        tailnetBindHost: "100.64.0.1",
      }),
    ).toEqual({ bind: "tailnet", host: "100.64.0.1" });
  });

  it("rejects invalid bind configuration through the same resolver", () => {
    expect(() =>
      resolveRuntimeBind({ exposure: "private", bind: "custom" }),
    ).toThrow("server.customBindHost is required");
    expect(() =>
      resolveRuntimeBind({
        exposure: "private",
        bind: "custom",
        customBindHost: "localhost",
      }),
    ).toThrow("server.bind=loopback");
    expect(() =>
      resolveRuntimeBind({ exposure: "public", bind: "tailnet" }),
    ).toThrow("only supported when server.exposure=private");
    expect(() =>
      resolveRuntimeBind({ exposure: "private", bind: "tailnet" }),
    ).toThrow("requires one exact detected Tailscale address");
    expect(() =>
      resolveRuntimeBind({
        exposure: "private",
        bind: "custom",
        customBindHost: " 192.0.2.10 ",
      }),
    ).toThrow("must be exact and non-empty");
    expect(() =>
      resolveRuntimeBind({
        exposure: "private",
        bind: "tailnet",
        tailnetBindHost: "100.64.0.1 ",
      }),
    ).toThrow("requires one exact detected Tailscale address");
  });
});
