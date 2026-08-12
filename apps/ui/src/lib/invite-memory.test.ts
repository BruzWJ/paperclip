// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingInviteToken,
  getRememberedInviteToken,
  rememberPendingInviteToken,
} from "./invite-memory";

describe("pending invite token memory", () => {
  beforeEach(() => localStorage.clear());

  it("preserves opaque token bytes and requires an exact token to clear", () => {
    const token = " pcp_invite_exact ";
    rememberPendingInviteToken(token);

    expect(getRememberedInviteToken()).toBe(token);
    clearPendingInviteToken("pcp_invite_exact");
    expect(getRememberedInviteToken()).toBe(token);
    clearPendingInviteToken(token);
    expect(getRememberedInviteToken()).toBeNull();
  });

  it.each(["", " ", "\n\t"])("does not remember blank token %j", (token) => {
    rememberPendingInviteToken(token);
    expect(getRememberedInviteToken()).toBeNull();
  });
});
