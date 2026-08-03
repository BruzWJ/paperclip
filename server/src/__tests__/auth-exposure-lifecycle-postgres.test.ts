import { getCookies } from "better-auth/cookies";
import type { BetterAuthOptions } from "better-auth";
import { describe, expect, it } from "vitest";
import {
  buildBetterAuthAdvancedOptions,
  shouldDisableSecureAuthCookies,
} from "../auth/better-auth.js";
import {
  assertRequestAuthorityAllowed,
  canonicalizeAuthority,
  createRequestAuthorityPolicy,
} from "../http/request-authority.js";

type ExposureProfile = {
  name: "loopback" | "lan" | "tailnet" | "public_https_proxy";
  deploymentExposure: "private" | "public";
  canonicalPublicUrl?: string;
  origin: string;
  allowedHostnames: string[];
  bindHost: string;
  expectSecureCookie: boolean;
};

const profiles: readonly ExposureProfile[] = [
  {
    name: "loopback",
    deploymentExposure: "private",
    origin: "http://127.0.0.1:3100",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    expectSecureCookie: false,
  },
  {
    name: "lan",
    deploymentExposure: "private",
    origin: "http://paperclip.lan:3100",
    allowedHostnames: ["paperclip.lan"],
    bindHost: "0.0.0.0",
    expectSecureCookie: false,
  },
  {
    name: "tailnet",
    deploymentExposure: "private",
    origin: "http://paperclip-tailnet:3100",
    allowedHostnames: ["paperclip-tailnet"],
    bindHost: "0.0.0.0",
    expectSecureCookie: false,
  },
  {
    name: "public_https_proxy",
    deploymentExposure: "public",
    canonicalPublicUrl: "https://paperclip.example.test",
    origin: "https://paperclip.example.test",
    allowedHostnames: [],
    bindHost: "0.0.0.0",
    expectSecureCookie: true,
  },
];

describe.each(profiles)("canonical Better Auth $name exposure", (profile) => {
  it("uses the canonical authority and cookie security policy", () => {
    const policy = createRequestAuthorityPolicy({
      deploymentExposure: profile.deploymentExposure,
      canonicalPublicUrl: profile.canonicalPublicUrl,
      allowedHostnames: profile.allowedHostnames,
      bindHost: profile.bindHost,
    });
    const url = new URL(profile.origin);
    const authority = {
      ...canonicalizeAuthority(
        url.host,
        url.protocol.slice(0, -1) as "http" | "https",
      ),
      immediatePeerTrusted: profile.deploymentExposure === "public",
    };

    expect(() => assertRequestAuthorityAllowed(authority, policy)).not.toThrow();

    const disableSecureCookies = shouldDisableSecureAuthCookies({
      deploymentExposure: profile.deploymentExposure,
    });
    const advanced = buildBetterAuthAdvancedOptions({ disableSecureCookies });
    const sessionCookie = getCookies({
      baseURL: profile.origin,
      advanced,
    } as BetterAuthOptions).sessionToken;
    expect(sessionCookie.attributes.secure ?? false).toBe(
      profile.expectSecureCookie,
    );
    expect(advanced.trustedProxyHeaders).toBe(false);
  });

  it("rejects an authority outside the exposure profile", () => {
    const policy = createRequestAuthorityPolicy({
      deploymentExposure: profile.deploymentExposure,
      canonicalPublicUrl: profile.canonicalPublicUrl,
      allowedHostnames: profile.allowedHostnames,
      bindHost: profile.bindHost,
    });
    const attacker = {
      ...canonicalizeAuthority("attacker.example:3100", "http"),
      immediatePeerTrusted: false,
    };

    expect(() => assertRequestAuthorityAllowed(attacker, policy)).toThrow();
  });
});
