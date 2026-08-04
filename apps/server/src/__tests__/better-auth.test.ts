import { afterEach, describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";
import {
  buildBetterAuthAdvancedOptions,
  buildBetterAuthRateLimitOptions,
  deriveAuthCookiePrefix,
  shouldDisableSecureAuthCookies,
} from "../auth/better-auth.js";

const ORIGINAL_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (ORIGINAL_INSTANCE_ID === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_INSTANCE_ID;
});

describe("Better Auth cookie scoping", () => {
  it("derives an instance-scoped cookie prefix", () => {
    expect(deriveAuthCookiePrefix("default")).toBe("paperclip-default");
    expect(deriveAuthCookiePrefix("PAP-1601-worktree")).toBe("paperclip-PAP-1601-worktree");
  });

  it("uses PAPERCLIP_INSTANCE_ID for the Better Auth cookie prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "sat-worktree";

    const advanced = buildBetterAuthAdvancedOptions({ disableSecureCookies: false });

    expect(advanced).toEqual({
      cookiePrefix: "paperclip-sat-worktree",
      trustedProxyHeaders: false,
    });
    expect(getCookies({ advanced } as BetterAuthOptions).sessionToken.name).toMatch(
      /paperclip-sat-worktree\.session_token$/,
    );
  });

  it("keeps local http auth cookies non-secure while preserving the scoped prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "pap-worktree";

    expect(buildBetterAuthAdvancedOptions({ disableSecureCookies: true })).toEqual({
      cookiePrefix: "paperclip-pap-worktree",
      trustedProxyHeaders: false,
      useSecureCookies: false,
    });
    expect(getCookies({
      advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies: true }),
    } as BetterAuthOptions).sessionToken.name).toBe("paperclip-pap-worktree.session_token");
  });

  it("enables Better Auth rate limiting for authenticated private instances by default", () => {
    expect(buildBetterAuthRateLimitOptions({
      deploymentExposure: "private",
    })).toEqual({ enabled: true });
  });

  it("keeps Better Auth rate limiting enabled for authenticated public instances", () => {
    expect(buildBetterAuthRateLimitOptions({
      deploymentExposure: "public",
    })).toEqual({ enabled: true });
  });

  it("allows an explicit Better Auth rate-limit override", () => {
    expect(buildBetterAuthRateLimitOptions({
      deploymentExposure: "private",
      override: "true",
    })).toEqual({ enabled: true });

    expect(buildBetterAuthRateLimitOptions({
      deploymentExposure: "public",
      override: "false",
    })).toEqual({ enabled: false });
  });

  it("disables secure cookies for private request-derived dev servers", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentExposure: "private",
    })).toBe(true);
  });

  it("keeps secure cookies for public HTTPS origins", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentExposure: "public",
    })).toBe(false);
  });

  it("allows private request-derived auth to use HTTP cookies", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentExposure: "private",
    })).toBe(true);
  });

  it("keeps public cookies secure unconditionally", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentExposure: "public",
    })).toBe(false);
    expect(shouldDisableSecureAuthCookies({
      deploymentExposure: "public",
    })).toBe(false);
  });

  it("never delegates proxy-header trust to Better Auth", () => {
    expect(buildBetterAuthAdvancedOptions({ disableSecureCookies: false }))
      .toMatchObject({ trustedProxyHeaders: false });
  });
});
