import { describe, expect, it } from "vitest";
import express from "express";
import { applyTrustProxy, parseTrustProxyEnv } from "../middleware/trust-proxy.js";

function appWithEnv(raw: string | undefined): express.Express {
  const app = express();
  applyTrustProxy(app, parseTrustProxyEnv(raw));
  return app;
}

describe("parseTrustProxyEnv", () => {
  it("unset leaves Express at its safe default (trust nothing)", () => {
    // Express's default trust-proxy setting is `false`. We verify the
    // setting is unchanged by comparing against a vanilla express()
    // instance that never had `applyTrustProxy` called on it.
    const baseline = express().get("trust proxy");
    const app = appWithEnv(undefined);
    expect(parseTrustProxyEnv(undefined)).toBeUndefined();
    expect(app.get("trust proxy")).toBe(baseline);
  });

  it.each(["", "false", "0"])(
    "rejects the disabled-value alias %j; omission is the only disabled form",
    (raw) => {
      expect(() => parseTrustProxyEnv(raw)).toThrow(/TRUST_PROXY/);
    },
  );

  it.each([" ", " 2 ", "loopback, uniquelocal", "loopback\t"])(
    "rejects whitespace-normalized alias %j",
    (raw) => {
      expect(() => parseTrustProxyEnv(raw)).toThrow(/whitespace/);
    },
  );

  it.each(["loopback,", ",loopback", "loopback,,uniquelocal"])(
    "rejects empty list token in %j",
    (raw) => {
      expect(() => parseTrustProxyEnv(raw)).toThrow(/empty subnet token/);
    },
  );

  it("rejects duplicate subnet tokens", () => {
    expect(() => parseTrustProxyEnv("loopback,loopback")).toThrow(
      /duplicate subnet token/,
    );
  });

  it("'true' yields boolean true and sets app accordingly", () => {
    expect(parseTrustProxyEnv("true")).toBe(true);
    expect(appWithEnv("true").get("trust proxy")).toBe(true);
  });

  it("positive integer is parsed as a number", () => {
    expect(parseTrustProxyEnv("2")).toBe(2);
    expect(appWithEnv("2").get("trust proxy")).toBe(2);
  });

  it("'01' throws (strict integer, no leading zeros)", () => {
    expect(() => parseTrustProxyEnv("01")).toThrow(/invalid integer/);
  });

  it("integer with internal whitespace throws", () => {
    expect(() => parseTrustProxyEnv("1 2")).toThrow(/whitespace/);
  });

  it("'loopback' yields a single-element array", () => {
    const v = parseTrustProxyEnv("loopback");
    expect(v).toEqual(["loopback"]);
    const app = appWithEnv("loopback");
    expect(app.get("trust proxy")).toEqual(["loopback"]);
  });

  it("'loopback,uniquelocal' yields a 2-element array", () => {
    expect(parseTrustProxyEnv("loopback,uniquelocal")).toEqual([
      "loopback",
      "uniquelocal",
    ]);
  });

  it("IPv4 CIDR is accepted", () => {
    expect(parseTrustProxyEnv("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
  });

  it("mixed IPv4 + IPv6 CIDR list is accepted", () => {
    expect(parseTrustProxyEnv("10.0.0.0/8,fd00::/8")).toEqual([
      "10.0.0.0/8",
      "fd00::/8",
    ]);
  });

  it.each(["999.0.0.1", "10.0.0.0/33", "fd00::/129", ":::", "10.0.0/8"])(
    "strictly rejects malformed IP or CIDR %j",
    (raw) => {
      expect(() => parseTrustProxyEnv(raw)).toThrow(/unrecognized token/);
    },
  );

  it("'bogus' throws with a helpful message naming the bad token", () => {
    expect(() => parseTrustProxyEnv("bogus")).toThrow(/bogus/);
    expect(() => parseTrustProxyEnv("bogus")).toThrow(/loopback/);
  });

  it("partial-garbage list throws on the bad token, not silently dropped", () => {
    expect(() => parseTrustProxyEnv("loopback,not-a-cidr")).toThrow(
      /not-a-cidr/,
    );
  });
});
