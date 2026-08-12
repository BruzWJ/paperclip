import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  RequestAuthorityError,
  assertRequestAuthorityAllowed,
  canonicalRequestHeaders,
  canonicalizeAuthority,
  createRequestAuthorityPolicy,
  resolveRequestAuthority,
  type TrustProxyPredicate,
} from "../http/request-authority.js";

const trustNone: TrustProxyPredicate = () => false;
const trustLoopback: TrustProxyPredicate = (address) => address === "127.0.0.1";

function incoming(
  input: {
    host?: string;
    forwardedHost?: string;
    forwardedProto?: string;
    remoteAddress?: string;
    encrypted?: boolean;
  } = {},
): IncomingMessage {
  return {
    headers: {
      ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.forwardedHost === undefined
        ? {}
        : { "x-forwarded-host": input.forwardedHost }),
      ...(input.forwardedProto === undefined
        ? {}
        : { "x-forwarded-proto": input.forwardedProto }),
    },
    socket: {
      remoteAddress: input.remoteAddress,
      encrypted: input.encrypted,
    },
  } as unknown as IncomingMessage;
}

describe("request authority", () => {
  it("ignores spoofed forwarded authority from an untrusted direct peer", () => {
    const authority = resolveRequestAuthority(
      incoming({
        host: "localhost:3100",
        forwardedHost: "attacker.example",
        forwardedProto: "https",
        remoteAddress: "203.0.113.10",
      }),
      trustLoopback,
    );

    expect(authority).toMatchObject({
      scheme: "http",
      hostname: "localhost",
      port: 3100,
      origin: "http://localhost:3100",
      immediatePeerTrusted: false,
    });
  });

  it("honors canonical forwarded scheme and host for a trusted immediate peer", () => {
    const authority = resolveRequestAuthority(
      incoming({
        host: "paperclip.internal:3100",
        forwardedHost: "Paperclip.Example:8443, proxy.internal:3100",
        forwardedProto: "HTTPS, http",
        remoteAddress: "127.0.0.1",
      }),
      trustLoopback,
    );

    expect(authority).toMatchObject({
      scheme: "https",
      hostname: "paperclip.example",
      port: 8443,
      authority: "paperclip.example:8443",
      origin: "https://paperclip.example:8443",
      immediatePeerTrusted: true,
    });
  });

  it("canonicalizes default ports and IPv6 authority", () => {
    expect(canonicalizeAuthority("EXAMPLE.test:80", "http")).toMatchObject({
      hostname: "example.test",
      port: null,
      origin: "http://example.test",
    });
    expect(
      canonicalizeAuthority("[0:0:0:0:0:0:0:1]:443", "https"),
    ).toMatchObject({
      hostname: "::1",
      port: null,
      authority: "[::1]",
      origin: "https://[::1]",
    });
  });

  it.each([
    "user@example.test",
    "example.test/path",
    "example.test,attacker.test",
    "example.test:99999",
    "::1",
    "2130706433",
  ])("rejects malformed or non-canonical authority %s", (host) => {
    expect(() => canonicalizeAuthority(host, "http")).toThrow(
      RequestAuthorityError,
    );
  });

  it("rejects malformed trusted forwarded values but ignores them for an untrusted peer", () => {
    const trusted = incoming({
      host: "localhost:3100",
      forwardedHost: "bad host",
      forwardedProto: "ftp",
      remoteAddress: "127.0.0.1",
    });
    expect(() => resolveRequestAuthority(trusted, trustLoopback)).toThrow(
      RequestAuthorityError,
    );

    const direct = incoming({
      host: "localhost:3100",
      forwardedHost: "bad host",
      forwardedProto: "ftp",
      remoteAddress: "203.0.113.8",
    });
    expect(resolveRequestAuthority(direct, trustLoopback).origin).toBe(
      "http://localhost:3100",
    );
  });

  it("resolves only once even if raw headers are later changed", () => {
    const req = incoming({ host: "localhost:3100" });
    const first = resolveRequestAuthority(req, trustNone);
    req.headers.host = "attacker.example";
    expect(resolveRequestAuthority(req, trustNone)).toBe(first);
  });

  it("replaces raw proxy authority with the canonical Paperclip ingress values", () => {
    const authority = {
      ...canonicalizeAuthority("paperclip.example:8443", "https"),
      immediatePeerTrusted: true,
    };
    const headers = canonicalRequestHeaders(
      {
        ":authority": "attacker.example",
        host: "paperclip.internal:3100",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "ftp",
        cookie: "paperclip=session",
      },
      authority,
    );

    expect(headers.get("host")).toBe("paperclip.example:8443");
    expect(headers.get("x-forwarded-proto")).toBe("https");
    expect(headers.get("x-forwarded-host")).toBeNull();
    expect(Array.from(headers.keys())).not.toContain(":authority");
    expect(headers.get("cookie")).toBe("paperclip=session");
  });

  it("admits configured private hostnames and blocks unknown ones", () => {
    const policy = createRequestAuthorityPolicy({
      deploymentExposure: "private",
      allowedHostnames: ["paperclip-tailnet"],
      bindHost: "0.0.0.0",
    });
    expect(() =>
      assertRequestAuthorityAllowed(
        {
          ...canonicalizeAuthority("paperclip-tailnet:3100", "http"),
          immediatePeerTrusted: false,
        },
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      assertRequestAuthorityAllowed(
        {
          ...canonicalizeAuthority("attacker.example:3100", "http"),
          immediatePeerTrusted: false,
        },
        policy,
      ),
    ).toThrow(/not allowed/);
  });

  it.each([
    " Paperclip-tailnet",
    "paperclip-tailnet ",
    "Paperclip-tailnet",
    "https://paperclip-tailnet",
    "paperclip-tailnet:3100",
  ])("rejects configured hostname alias %j", (hostname) => {
    expect(() =>
      createRequestAuthorityPolicy({
        deploymentExposure: "private",
        allowedHostnames: [hostname],
        bindHost: "0.0.0.0",
      }),
    ).toThrow(/exact lowercase hostname/);
  });

  it.each([
    ["http://paperclip.example", "scheme"],
    ["https://other.example", "host"],
    ["https://paperclip.example:8443", "port"],
  ])("rejects a public request with a mismatched %s authority", (origin) => {
    const policy = createRequestAuthorityPolicy({
      deploymentExposure: "public",
      canonicalPublicUrl: "https://paperclip.example",
      allowedHostnames: [],
      bindHost: "0.0.0.0",
    });
    const url = new URL(origin);
    expect(() =>
      assertRequestAuthorityAllowed(
        {
          ...canonicalizeAuthority(
            url.host,
            url.protocol.slice(0, -1) as "http" | "https",
          ),
          immediatePeerTrusted: false,
        },
        policy,
      ),
    ).toThrow(/canonical public origin/);
  });

  it("rejects an explicit default-port alias in the configured public origin", () => {
    expect(() =>
      createRequestAuthorityPolicy({
        deploymentExposure: "public",
        canonicalPublicUrl: "https://paperclip.example:443",
        allowedHostnames: [],
        bindHost: "0.0.0.0",
      }),
    ).toThrow(/exact canonical HTTPS origin/);
  });

  it("requires HTTPS and ignores the private hostname allowlist in public exposure", () => {
    expect(() =>
      createRequestAuthorityPolicy({
        deploymentExposure: "public",
        canonicalPublicUrl: "http://paperclip.example",
        allowedHostnames: [],
        bindHost: "0.0.0.0",
      }),
    ).toThrow(/must use https:\/\//);

    const policy = createRequestAuthorityPolicy({
      deploymentExposure: "public",
      canonicalPublicUrl: "https://paperclip.example",
      allowedHostnames: ["not a valid hostname"],
      bindHost: "0.0.0.0",
    });
    expect(policy.privateAllowedHostnames).toEqual(new Set());
  });
});
